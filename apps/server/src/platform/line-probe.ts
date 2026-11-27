import { and, desc, eq } from 'drizzle-orm';
import { emit } from '../data/events.js';
import type { Db } from '../db/client.js';
import { opsEvents, type Club } from '../db/schema.js';
import type { AppContext } from '../http/context.js';
import { newId } from '../lib/util.js';
import { describeLineError, type SetupClients, type SetupReport } from '../line/setup.js';
import type { LineSetupDetail } from './health.js';

export type LineQuota = { used: number; limit: number };

/** The month's push quota and usage; null when LINE does not answer. `limit` 0 means no limit. */
export async function readQuota(clients: SetupClients): Promise<LineQuota | null> {
  try {
    const [quota, used] = await Promise.all([clients.api.getMessageQuota(), clients.api.getMessageQuotaConsumption()]);
    return { used: used.totalUsage, limit: quota.type === 'limited' ? (quota.value ?? 0) : 0 };
  } catch {
    return null;
  }
}

/** A failed 'LINE credentials' step, for a token or API error. */
export const credentialFailure = (err: unknown): SetupReport => ({ ok: false, steps: [{ name: 'LINE credentials', ok: false, detail: describeLineError(err) }] });

export const clubWebhookUrl = (publicUrl: string, club: Club) => `${publicUrl.replace(/\/$/, '')}/line/webhook/${club.slug}`;

/**
 * One `ops_events` row (kind 'line_setup') plus the `line.setup_run` event, in one transaction.
 * Direct insert until B3's `recordOps` merges.
 */
export async function recordLineSetup(
  db: Db,
  club: Club,
  detail: LineSetupDetail,
  actor: { type: 'platform' | 'system'; id?: string },
  check: 'setup' | 'status' | 'probe',
  now: Date,
) {
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.insert(opsEvents).values({ id: newId(), clubId: club.id, kind: 'line_setup', detail, at: now });
    await emit(tx, {
      clubId: club.id,
      type: 'line.setup_run',
      occurredAt: now,
      actorType: actor.type,
      actorId: actor.id,
      channel: 'line',
      dataOrigin: 'first_party',
      props: { ok: detail.report.ok, check },
      isTest: club.status === 'demo',
    });
  });
}

export type LineProbe =
  | { configured: false }
  | { configured: true; ok: true; report: SetupReport; quota: LineQuota | null; webhookActive: boolean; chatMode: string }
  | { configured: true; ok: false; report: SetupReport; quota: null; error: unknown };

/**
 * Reads the club's live LINE state: credentials (bot info), webhook endpoint and active flag, and
 * the push quota. Used by the wizard's status check and by the timed alert checks (A15), which
 * record the result as a `line_setup` row. Never throws.
 */
export async function probeLine(app: AppContext, club: Club): Promise<LineProbe> {
  let clients: SetupClients;
  let bot, hook;
  try {
    const creds = await app.credentials.line(club);
    if (!creds) return { configured: false };
    clients = app.lineSetupClients(creds.accessToken, await app.credentials.login(club));
    [bot, hook] = await Promise.all([clients.api.getBotInfo(), clients.api.getWebhookEndpoint()]);
  } catch (err) {
    return { configured: true, ok: false, report: credentialFailure(err), quota: null, error: err };
  }
  const expected = clubWebhookUrl(app.config.PUBLIC_URL, club);
  const webhookActive = Boolean(hook.active) && hook.endpoint === expected;
  const quota = await readQuota(clients);
  const report: SetupReport = {
    ok: webhookActive,
    steps: [
      { name: 'LINE credentials', ok: true, detail: `Connected to "${bot.displayName}" (${bot.basicId})` },
      { name: 'Chat mode', ok: true, detail: bot.chatMode },
      { name: 'Webhook', ok: webhookActive, detail: webhookActive ? `Active at ${expected}` : `Endpoint ${hook.endpoint || '(none)'}, active ${hook.active}; expected ${expected}` },
    ],
    bot: { displayName: bot.displayName, basicId: bot.basicId, chatMode: bot.chatMode, addFriendUrl: `https://line.me/R/ti/p/${encodeURIComponent(bot.basicId)}` },
  };
  return { configured: true, ok: true, report, quota, webhookActive, chatMode: bot.chatMode };
}

/** The club's `line_setup` rows, newest first. */
export async function recentLineSetups(db: Db, clubId: string, limit: number): Promise<{ at: Date; detail: LineSetupDetail }[]> {
  const rows = await db
    .select({ at: opsEvents.at, detail: opsEvents.detail })
    .from(opsEvents)
    .where(and(eq(opsEvents.clubId, clubId), eq(opsEvents.kind, 'line_setup')))
    .orderBy(desc(opsEvents.at))
    .limit(limit);
  return rows.map((r) => ({ at: r.at, detail: r.detail as LineSetupDetail }));
}

/**
 * The last quota reading: the newest `line_setup` row that has one. A row written without a
 * reading (a failed check) does not mean the quota recovered.
 */
export async function lastKnownQuota(db: Db, clubId: string): Promise<LineQuota | null> {
  for (const r of await recentLineSetups(db, clubId, 50)) if (r.detail?.quota) return r.detail.quota;
  return null;
}
