import { and, eq, isNull } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { auditLog, clubs, platformFlags, sessions, users, type Club } from '../../db/schema.js';
import { newId } from '../../lib/util.js';
import type { LineGateway, Message } from '../../line/gateway.js';
import { GLOBAL_STOP_FLAG } from '../../platform/support.js';
import { base32Decode, verifyTotp } from '../../platform/totp.js';
import { clientIp, MAX_AUTH_FAILURES, recordAuthFailure, type AuthEnv } from '../auth.js';
import type { AppContext } from '../context.js';

/** Reads a JSON body; null when it is missing or not JSON. */
export const jsonBody = (c: Context) => c.req.json().catch(() => null) as Promise<unknown>;

/**
 * Fresh second-factor check for the sensitive changes (spec §12.3: LINE credentials, PromptPay ID,
 * greeting and map link, and the platform login channel). The code comes in the body as `totp`.
 * Returns a 401 response to send, or null when the code is valid now.
 *
 * Wrong codes count against the user like failed logins (`recordAuthFailure`). After
 * MAX_AUTH_FAILURES the account is locked and the session that guessed is revoked, so a stolen
 * session cookie cannot brute-force the code. A locked account answers 401 `totp_locked`.
 * A correct code clears the failure count.
 */
export async function freshTotpRefusal(app: AppContext, c: Context<AuthEnv>, body: unknown): Promise<Response | null> {
  const { db } = app.deps;
  const code = typeof (body as { totp?: unknown } | null)?.totp === 'string' ? (body as { totp: string }).totp.replace(/\s/g, '') : '';
  if (!code) return c.json({ error: 'totp_required' }, 401);
  const now = app.deps.now();
  const user = await db.query.users.findFirst({ where: eq(users.id, c.var.user.id) });
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  if (user.lockedUntil && user.lockedUntil > now) return c.json({ error: 'totp_locked' }, 401);
  if (!user.totpSecret || !verifyTotp(base32Decode(user.totpSecret), code, now)) {
    const failures = await recordAuthFailure(db, user.id, now);
    if (failures >= MAX_AUTH_FAILURES) {
      await db
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.idHash, c.var.session.idHash), isNull(sessions.revokedAt)));
      return c.json({ error: 'totp_locked' }, 401);
    }
    return c.json({ error: 'invalid_totp' }, 401);
  }
  if (user.failedLoginCount > 0) await db.update(users).set({ failedLoginCount: 0 }).where(eq(users.id, user.id));
  return null;
}

/** One `audit_log` row for a console action, with the founder's session and IP. */
export async function adminAudit(
  db: Db,
  c: Context<AuthEnv>,
  row: { clubId: string | null; action: string; entity: string; entityId: string; before?: unknown; after?: unknown; reason?: string },
  now: Date,
) {
  await db.insert(auditLog).values({
    id: newId(),
    clubId: row.clubId,
    actor: 'platform',
    actorType: 'platform',
    actorId: c.var.user.id,
    sessionId: c.var.session.idHash,
    reason: row.reason ?? null,
    ip: clientIp(c) ?? null,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId,
    before: row.before ?? null,
    after: row.after ?? null,
    at: now,
  });
}

/**
 * One text message to the club's staff LINE group (logged in `messages` with target 'staff').
 * Called after a change is committed, so it never throws: when the club's LINE token cannot be
 * issued (e.g. a wrong channel secret), the `messages` row is still written, the push is skipped
 * and the failure is logged.
 */
export async function notifyStaffGroup(app: AppContext, club: Club, text: string) {
  const messages = [{ type: 'text', text } as Message];
  let gateway: LineGateway;
  try {
    gateway = await app.gateways.forClub(club);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Outbox.toStaff records the row first, then catches and logs this push failure.
    gateway = { push: async () => { throw new Error(`club LINE channel unavailable: ${reason}`); } } as unknown as LineGateway;
  }
  try {
    await app.deps.outbox.toStaff(gateway, club, messages);
  } catch (err) {
    app.deps.log(`Staff notice for club ${club.id} was not recorded`, err);
  }
}

export async function clubBySlug(db: Db, slug: string): Promise<Club | undefined> {
  return db.query.clubs.findFirst({ where: eq(clubs.slug, slug) });
}


const pauseBody = z.object({ paused: z.boolean() });
const stopBody = z.object({ stopped: z.boolean() });
const promptpayBody = z.object({ promptpayId: z.string().trim().min(1).max(40), promptpayName: z.string().trim().max(200).optional() });
const greetingBody = z
  .object({
    greeting: z.object({ en: z.string().max(2000), th: z.string().max(2000) }).optional(),
    mapUrl: z.string().url().max(2000).optional(),
  })
  .refine((b) => b.greeting !== undefined || b.mapUrl !== undefined, { message: 'nothing to change' });

/**
 * Controls (plan A5): pause one club's bot, the global stop, and the two sensitive club changes
 * the console makes (PromptPay ID; greeting and map link), each with a fresh TOTP, before/after
 * in `audit_log`, and one notice to the club's staff group. Mounted under /api/admin.
 */
export function controlsRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;

  r.post('/clubs/:slug/pause', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const parsed = pauseBody.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const { paused } = parsed.data;
    const now = app.deps.now();
    if (club.botPaused === paused) return c.json({ paused, botPausedAt: club.botPausedAt?.toISOString() ?? null, changed: false });
    const botPausedAt = paused ? now : null;
    await db.update(clubs).set({ botPaused: paused, botPausedAt }).where(eq(clubs.id, club.id));
    await adminAudit(db, c, { clubId: club.id, action: paused ? 'club.bot_paused' : 'club.bot_resumed', entity: 'clubs', entityId: club.id, before: { botPaused: club.botPaused }, after: { botPaused: paused } }, now);
    await notifyStaffGroup(
      app,
      club,
      paused
        ? 'Bot paused: automatic replies are off. Messages are still stored; please answer guests yourselves.'
        : 'Bot resumed: automatic replies are on again.',
    );
    return c.json({ paused, botPausedAt: botPausedAt?.toISOString() ?? null, changed: true });
  });

  r.get('/global-stop', async (c) => {
    const row = await db.query.platformFlags.findFirst({ where: eq(platformFlags.key, GLOBAL_STOP_FLAG) });
    const value = (row?.value ?? null) as { stopped?: boolean } | null;
    return c.json({ stopped: Boolean(value?.stopped), updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt?.toISOString() ?? null });
  });

  /** Sets `platform_flags['global_stop']` to `{ stopped }` (read by `isGloballyStopped`). */
  r.post('/global-stop', async (c) => {
    const parsed = stopBody.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const now = app.deps.now();
    const value = { stopped: parsed.data.stopped };
    await db
      .insert(platformFlags)
      .values({ key: GLOBAL_STOP_FLAG, value, updatedBy: c.var.user.id, updatedAt: now })
      .onConflictDoUpdate({ target: platformFlags.key, set: { value, updatedBy: c.var.user.id, updatedAt: now } });
    await adminAudit(db, c, { clubId: null, action: parsed.data.stopped ? 'platform.global_stop' : 'platform.global_resume', entity: 'platform_flags', entityId: GLOBAL_STOP_FLAG, after: value }, now);
    return c.json(value);
  });

  r.put('/clubs/:slug/promptpay', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const body = await jsonBody(c);
    const refused = await freshTotpRefusal(app, c, body);
    if (refused) return refused;
    const parsed = promptpayBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const now = app.deps.now();
    const after = { promptpayId: parsed.data.promptpayId, promptpayName: parsed.data.promptpayName ?? club.promptpayName };
    await db.update(clubs).set(after).where(eq(clubs.id, club.id));
    await adminAudit(db, c, { clubId: club.id, action: 'club.promptpay_changed', entity: 'clubs', entityId: club.id, before: { promptpayId: club.promptpayId, promptpayName: club.promptpayName }, after }, now);
    await notifyStaffGroup(app, club, `PromptPay ID changed by the platform team to ending ${after.promptpayId.slice(-4)}. Deposits now go to this account.`);
    return c.json({ ok: true });
  });

  r.put('/clubs/:slug/greeting', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const body = await jsonBody(c);
    const refused = await freshTotpRefusal(app, c, body);
    if (refused) return refused;
    const parsed = greetingBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const now = app.deps.now();
    const settings = { ...club.settings, ...(parsed.data.greeting ? { greeting: parsed.data.greeting } : {}), ...(parsed.data.mapUrl ? { mapUrl: parsed.data.mapUrl } : {}) };
    await db.update(clubs).set({ settings }).where(eq(clubs.id, club.id));
    await adminAudit(
      db,
      c,
      {
        clubId: club.id,
        action: 'club.greeting_changed',
        entity: 'clubs',
        entityId: club.id,
        before: { greeting: club.settings.greeting, mapUrl: club.settings.mapUrl },
        after: { greeting: settings.greeting, mapUrl: settings.mapUrl },
      },
      now,
    );
    await notifyStaffGroup(app, club, 'The greeting message or map link was changed by the platform team.');
    return c.json({ ok: true });
  });

  return r;
}
