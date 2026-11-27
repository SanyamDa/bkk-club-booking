import { and, asc, desc, eq, gte, isNull, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { auditLog, channels, clubs, messages, type Club } from '../../db/schema.js';
import { sampleMessages } from '../../line/samples.js';
import { describeLineError, rollbackRichMenu, runLineSetup, type RichMenuChange, type SetupReport } from '../../line/setup.js';
import { credentialSummary, setClubCredential } from '../../platform/credentials.js';
import { credentialFailure, probeLine, readQuota, recordLineSetup } from '../../platform/line-probe.js';
import { quotaView } from '../../platform/health.js';
import type { AuthEnv } from '../auth.js';
import type { AppContext } from '../context.js';
import { adminAudit, clubBySlug, freshTotpRefusal, jsonBody, notifyStaffGroup } from './controls.js';

const migrateBody = z.object({
  greeting: z.object({ en: z.string().trim().min(1).max(2000).optional(), th: z.string().trim().min(1).max(2000).optional() }).optional(),
});

const RICH_MENU_REPLACED = 'line.rich_menu_replaced';
const RICH_MENU_ROLLED_BACK = 'line.rich_menu_rolled_back';

/** The live test window (spec §12.2 step 4). */
export const LIVE_TEST_WINDOW_MS = 60_000;
/** An inbound message older than this with no reply fails the live test. */
const LIVE_TEST_REPLY_GRACE_MS = 15_000;

const credsBody = z
  .object({
    channelId: z.string().trim().min(1).max(40),
    channelSecret: z.string().trim().min(1).max(200),
    loginChannelId: z.string().trim().min(1).max(40).optional(),
    loginChannelSecret: z.string().trim().min(1).max(200).optional(),
    liffId: z.string().trim().min(1).max(100).optional(),
  })
  .refine((b) => Boolean(b.loginChannelId) === Boolean(b.loginChannelSecret), { message: 'login channel id and secret go together' });

const num = (v: string | undefined) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * LINE wizard backend (plan A5, spec §12.2 "On the call" steps 4–6, §11.1.2). Mounted under /api/admin.
 */
export function lineWizardRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  /** Live-test windows by club id (in memory: a wizard step, not durable state). */
  const liveTests = new Map<string, Date>();

  async function clientsFor(club: Club) {
    const creds = await app.credentials.line(club);
    if (!creds) return null;
    const login = await app.credentials.login(club);
    return { clients: app.lineSetupClients(creds.accessToken, login), login };
  }

  /** Stores the club's LINE credentials (fresh TOTP), notifies the staff group, then runs the LINE setup. */
  r.post('/clubs/:slug/line', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const body = await jsonBody(c);
    const refused = await freshTotpRefusal(app, c, body);
    if (refused) return refused;
    const parsed = credsBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const b = parsed.data;
    const now = app.deps.now();
    const setBy = c.var.user.id;

    // Check the new credentials with LINE before saving them, so a mistyped secret never replaces a working one.
    try {
      await app.lineTokens.accessToken(b.channelId, b.channelSecret);
    } catch (err) {
      return c.json(credentialFailure(err), 400);
    }

    const saved = await setClubCredential(db, app.config.CREDENTIALS_KEY, { clubId: club.id, kind: 'line_messaging', secret: { channelId: b.channelId, channelSecret: b.channelSecret }, setBy }, now);
    if (b.loginChannelId && b.loginChannelSecret) {
      await setClubCredential(
        db,
        app.config.CREDENTIALS_KEY,
        { clubId: club.id, kind: 'line_login', secret: { channelId: b.loginChannelId, channelSecret: b.loginChannelSecret, ...(b.liffId ? { liffId: b.liffId } : {}) }, setBy },
        now,
      );
    }
    const fresh = (await clubBySlug(db, club.slug))!;
    await notifyStaffGroup(app, fresh, `LINE credentials for ${fresh.name} were changed by the platform team (secret ending ${saved.last4}).`);

    let found: Awaited<ReturnType<typeof clientsFor>>;
    let report: SetupReport;
    try {
      found = await clientsFor(fresh);
      if (!found) return c.json({ error: 'line_not_configured' }, 409);
      report = await runLineSetup({
        club: fresh,
        clients: found.clients,
        login: found.login,
        publicUrl: app.config.PUBLIC_URL,
        sampleMessages: await sampleMessages(db, fresh, app.deps.links, now),
      });
    } catch (err) {
      report = credentialFailure(err);
      await recordLineSetup(db, fresh, { report, quota: null }, { type: 'platform', id: setBy }, 'setup', now);
      return c.json(report);
    }
    const quota = await readQuota(found.clients);
    await recordLineSetup(db, fresh, { report, quota }, { type: 'platform', id: setBy }, 'setup', now);
    if (report.bot) {
      await db
        .update(channels)
        .set({ externalId: report.bot.basicId, status: report.ok ? 'connected' : 'pending', connectedAt: report.ok ? now : null })
        .where(and(eq(channels.clubId, fresh.id), eq(channels.kind, 'line')));
    }
    return c.json(report);
  });

  /**
   * Re-checks the manual switches (webhook on, chat mode), quota and the plan check. Query params
   * `expectedBookings`, `hostReplies`, `staffAlerts`, `groupSize` are the wizard's monthly estimates.
   */
  r.get('/clubs/:slug/line/status', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const now = app.deps.now();
    const probe = await probeLine(app, club);
    if (!probe.configured) return c.json({ error: 'line_not_configured' }, 409);
    if (!probe.ok) {
      await recordLineSetup(db, club, { report: probe.report, quota: null }, { type: 'platform', id: c.var.user.id }, 'status', now);
      return c.json({ error: 'line_error', message: describeLineError(probe.error) }, 502);
    }
    const { webhookActive, chatMode, quota: rawQuota, report } = probe;
    await recordLineSetup(db, club, { report, quota: rawQuota }, { type: 'platform', id: c.var.user.id }, 'status', now);

    const quota = quotaView(rawQuota) ?? { limit: 0, used: 0, pct: 0, warn: false };
    const q = c.req.query();
    // §11.1.2 step 6: bookings × 2 pushes + host replies + staff-group alerts × group size.
    const expectedMonthlyPushes = num(q.expectedBookings) * 2 + num(q.hostReplies) + num(q.staffAlerts) * num(q.groupSize);
    return c.json({
      webhookActive,
      chatMode,
      quota,
      planCheck: { expectedMonthlyPushes, recommendUpgrade: quota.limit > 0 && expectedMonthlyPushes > quota.limit },
      liveTest: await liveTestState(club.id, now),
    });
  });

  /** Opens a 60 s live-test window. */
  r.post('/clubs/:slug/line/live-test', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const startedAt = app.deps.now();
    liveTests.set(club.id, startedAt);
    return c.json({ startedAt: startedAt.toISOString(), endsAt: new Date(startedAt.getTime() + LIVE_TEST_WINDOW_MS).toISOString() });
  });

  /**
   * `pass` when an inbound guest message in the window has exactly one outbound guest message
   * (before the next inbound); `fail` when one has none after a short grace; `pending` otherwise.
   */
  async function liveTestState(clubId: string, now: Date): Promise<'pending' | 'pass' | 'fail'> {
    const start = liveTests.get(clubId);
    if (!start) return 'pending';
    const end = new Date(start.getTime() + LIVE_TEST_WINDOW_MS);
    const rows = await db
      .select({ guestId: messages.guestId, direction: messages.direction, target: messages.target, at: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.clubId, clubId), gte(messages.createdAt, start), lt(messages.createdAt, new Date(end.getTime() + LIVE_TEST_WINDOW_MS)), isNull(messages.target)))
      .orderBy(asc(messages.createdAt));
    const inbound = rows.filter((m) => m.direction === 'in' && m.guestId && m.at < end);
    let failed = false;
    for (const m of inbound) {
      const next = inbound.find((n) => n.guestId === m.guestId && n.at > m.at);
      const replies = rows.filter((o) => o.direction === 'out' && o.guestId === m.guestId && o.at >= m.at && (!next || o.at < next.at)).length;
      if (replies === 1) return 'pass';
      if (replies === 0 && now.getTime() - m.at.getTime() >= LIVE_TEST_REPLY_GRACE_MS) failed = true;
    }
    return failed ? 'fail' : 'pending';
  }

  /**
   * Greeting and rich menu migration (plan A10, spec §10 Phase 1, §11.1.2 step 4). Imports the
   * club's existing greeting into settings (pasted text wins; otherwise the setup clients' reader,
   * which LINE's real API does not offer), then rebuilds the rich menu with `refreshRichMenu`,
   * keeping the old default menu for rollback. The greeting is a sensitive change (§12.3): fresh
   * TOTP, before/after in the audit log, and the staff group is told.
   */
  r.post('/clubs/:slug/line/migrate', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const body = await jsonBody(c);
    const refused = await freshTotpRefusal(app, c, body);
    if (refused) return refused;
    const parsed = migrateBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const now = app.deps.now();
    const actorId = c.var.user.id;

    let found: Awaited<ReturnType<typeof clientsFor>>;
    let imported;
    try {
      found = await clientsFor(club);
      if (!found) return c.json({ error: 'line_not_configured' }, 409);
      imported = parsed.data.greeting ?? (found.clients.readGreeting ? await found.clients.readGreeting() : null);
    } catch (err) {
      return c.json({ error: 'line_error', message: describeLineError(err) }, 502);
    }
    if (!imported || (!imported.en && !imported.th)) return c.json({ error: 'greeting_unreadable' }, 422);

    const greeting = { en: imported.en ?? club.settings.greeting.en, th: imported.th ?? club.settings.greeting.th };
    const settings = { ...club.settings, greeting };
    await db.update(clubs).set({ settings }).where(eq(clubs.id, club.id));
    await adminAudit(db, c, { clubId: club.id, action: 'club.greeting_imported', entity: 'clubs', entityId: club.id, before: { greeting: club.settings.greeting }, after: { greeting } }, now);
    const fresh = { ...club, settings };

    let report: SetupReport;
    // A run that reached LINE reads the quota as the setup route does; a credential failure records
    // no reading (readers fall back to the last known quota).
    let quota: Awaited<ReturnType<typeof readQuota>> = null;
    try {
      report = await runLineSetup({
        club: fresh,
        clients: found.clients,
        login: found.login,
        publicUrl: app.config.PUBLIC_URL,
        sampleMessages: await sampleMessages(db, fresh, app.deps.links, now),
        refreshRichMenu: true,
        keepOldRichMenu: true,
      });
      quota = await readQuota(found.clients);
    } catch (err) {
      report = credentialFailure(err);
    }
    await recordLineSetup(db, fresh, { report, quota }, { type: 'platform', id: actorId }, 'setup', now);
    if (report.richMenu) {
      await adminAudit(db, c, { clubId: club.id, action: RICH_MENU_REPLACED, entity: 'rich_menu', entityId: report.richMenu.richMenuId, after: report.richMenu }, now);
    }
    await notifyStaffGroup(app, fresh, 'The greeting message was imported and the LINE menu was replaced by the platform team.');
    return c.json({ greeting, report, richMenu: report.richMenu ?? null });
  });

  /** Puts back the rich menu the last migration replaced, and deletes the new one (plan A10). */
  r.post('/clubs/:slug/line/rich-menu/rollback', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const last = await db.query.auditLog.findFirst({
      where: and(eq(auditLog.clubId, club.id), eq(auditLog.action, RICH_MENU_REPLACED)),
      orderBy: [desc(auditLog.at)],
    });
    const change = (last?.after as RichMenuChange | undefined) ?? null;
    // A rollback row names the menu it removed, so a replacement is undone at most once.
    const undone = change
      ? await db.query.auditLog.findFirst({ where: and(eq(auditLog.clubId, club.id), eq(auditLog.action, RICH_MENU_ROLLED_BACK), eq(auditLog.entityId, change.richMenuId)) })
      : undefined;
    if (!change?.previousRichMenuId || undone) return c.json({ error: 'nothing_to_roll_back' }, 409);
    const now = app.deps.now();
    try {
      const found = await clientsFor(club);
      if (!found) return c.json({ error: 'line_not_configured' }, 409);
      await rollbackRichMenu(found.clients, change);
    } catch (err) {
      return c.json({ error: 'line_error', message: describeLineError(err) }, 502);
    }
    await adminAudit(db, c, { clubId: club.id, action: RICH_MENU_ROLLED_BACK, entity: 'rich_menu', entityId: change.richMenuId, before: change, after: { defaultRichMenuId: change.previousRichMenuId } }, now);
    return c.json({ ok: true, richMenuId: change.previousRichMenuId });
  });

  /** B6's `issueTesterCode` is not merged yet. */
  r.post('/clubs/:slug/tester-code', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    return c.json({ error: 'not_ready', message: 'Tester codes need Track B task B6.' }, 503);
  });

  /** What the console shows about stored secrets: kind, last 4, who and when. */
  r.get('/clubs/:slug/credentials', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    return c.json({ credentials: await credentialSummary(db, club.id) });
  });

  return r;
}
