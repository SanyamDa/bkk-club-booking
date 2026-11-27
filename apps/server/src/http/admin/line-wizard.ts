import { and, asc, eq, gte, isNull, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { channels, messages, opsEvents, type Club } from '../../db/schema.js';
import { emit } from '../../data/events.js';
import { newId } from '../../lib/util.js';
import { sampleMessages } from '../../line/samples.js';
import { describeLineError, runLineSetup, type SetupClients, type SetupReport } from '../../line/setup.js';
import { credentialSummary, setClubCredential } from '../../platform/credentials.js';
import { quotaView, type LineSetupDetail } from '../../platform/health.js';
import type { AuthEnv } from '../auth.js';
import type { AppContext } from '../context.js';
import { clubBySlug, freshTotpRefusal, jsonBody, notifyStaffGroup } from './controls.js';

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

async function readQuota(clients: SetupClients): Promise<{ used: number; limit: number } | null> {
  try {
    const [quota, used] = await Promise.all([clients.api.getMessageQuota(), clients.api.getMessageQuotaConsumption()]);
    return { used: used.totalUsage, limit: quota.type === 'limited' ? (quota.value ?? 0) : 0 };
  } catch {
    return null;
  }
}

/**
 * One `ops_events` row (kind 'line_setup') plus the `line.setup_run` event, in one transaction.
 * Direct insert until B3's `recordOps` merges.
 */
async function recordLineSetup(db: Db, club: Club, detail: LineSetupDetail, actorId: string, check: 'setup' | 'status', now: Date) {
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.insert(opsEvents).values({ id: newId(), clubId: club.id, kind: 'line_setup', detail, at: now });
    await emit(tx, {
      clubId: club.id,
      type: 'line.setup_run',
      occurredAt: now,
      actorType: 'platform',
      actorId,
      channel: 'line',
      dataOrigin: 'first_party',
      props: { ok: detail.report.ok, check },
      isTest: club.status === 'demo',
    });
  });
}

/**
 * LINE wizard backend (plan A5, spec §12.2 "On the call" steps 4–6, §11.1.2). Mounted under /api/admin.
 */
export function lineWizardRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  /** Live-test windows by club id (in memory: a wizard step, not durable state). */
  const liveTests = new Map<string, Date>();
  const webhookUrl = (club: Club) => `${app.config.PUBLIC_URL.replace(/\/$/, '')}/line/webhook/${club.slug}`;

  async function clientsFor(club: Club) {
    const creds = await app.credentials.line(club);
    if (!creds) return null;
    const login = await app.credentials.login(club);
    return { clients: app.lineSetupClients(creds.accessToken, login), login };
  }

  /** A failed 'LINE credentials' step, for a token or API error. */
  const credentialFailure = (err: unknown): SetupReport => ({ ok: false, steps: [{ name: 'LINE credentials', ok: false, detail: describeLineError(err) }] });

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
      await recordLineSetup(db, fresh, { report, quota: null }, setBy, 'setup', now);
      return c.json(report);
    }
    const quota = await readQuota(found.clients);
    await recordLineSetup(db, fresh, { report, quota }, setBy, 'setup', now);
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
    const expected = webhookUrl(club);
    let found: NonNullable<Awaited<ReturnType<typeof clientsFor>>>;
    let bot, hook;
    try {
      const f = await clientsFor(club);
      if (!f) return c.json({ error: 'line_not_configured' }, 409);
      found = f;
      [bot, hook] = await Promise.all([found.clients.api.getBotInfo(), found.clients.api.getWebhookEndpoint()]);
    } catch (err) {
      const report = credentialFailure(err);
      await recordLineSetup(db, club, { report, quota: null }, c.var.user.id, 'status', now);
      return c.json({ error: 'line_error', message: describeLineError(err) }, 502);
    }
    const webhookActive = Boolean(hook.active) && hook.endpoint === expected;
    const rawQuota = await readQuota(found.clients);
    const report: SetupReport = {
      ok: webhookActive,
      steps: [
        { name: 'LINE credentials', ok: true, detail: `Connected to "${bot.displayName}" (${bot.basicId})` },
        { name: 'Chat mode', ok: true, detail: bot.chatMode },
        { name: 'Webhook', ok: webhookActive, detail: webhookActive ? `Active at ${expected}` : `Endpoint ${hook.endpoint || '(none)'}, active ${hook.active}; expected ${expected}` },
      ],
      bot: { displayName: bot.displayName, basicId: bot.basicId, chatMode: bot.chatMode, addFriendUrl: `https://line.me/R/ti/p/${encodeURIComponent(bot.basicId)}` },
    };
    await recordLineSetup(db, club, { report, quota: rawQuota }, c.var.user.id, 'status', now);

    const quota = quotaView(rawQuota) ?? { limit: 0, used: 0, pct: 0, warn: false };
    const q = c.req.query();
    // §11.1.2 step 6: bookings × 2 pushes + host replies + staff-group alerts × group size.
    const expectedMonthlyPushes = num(q.expectedBookings) * 2 + num(q.hostReplies) + num(q.staffAlerts) * num(q.groupSize);
    return c.json({
      webhookActive,
      chatMode: bot.chatMode,
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
