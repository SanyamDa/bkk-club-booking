import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { endEpisode, HANDOFF_REALERT_KIND } from '../chat/episodes.js';
import type { Db } from '../db/client.js';
import { alerts, clubs, conversations, handoffEpisodes, messages } from '../db/schema.js';
import { raiseAlert } from '../platform/alerts.js';

export { HANDOFF_REALERT_KIND };

/**
 * Handoff timeout (plan B14b, spec §5.3, §6.3, §13.1 row 12). For each open takeover, counts from the
 * last staff activity (the later of the start and the newest staff reply). At half the club's
 * `handoffTimeoutMinutes` it re-alerts once (urgent); at the full timeout it ends the episode with
 * `endedBy='timeout'`, which gives the chat back to the bot. Runs every minute on the B2 Scheduler.
 */
export async function runHandoffTimeouts(db: Db, now: Date): Promise<{ realerted: string[]; ended: string[] }> {
  const open = await db
    .select({ episode: handoffEpisodes, guestId: conversations.guestId, settings: clubs.settings })
    .from(handoffEpisodes)
    .innerJoin(conversations, eq(conversations.id, handoffEpisodes.conversationId))
    .innerJoin(clubs, eq(clubs.id, handoffEpisodes.clubId))
    .where(isNull(handoffEpisodes.endedAt));
  const realerted: string[] = [];
  const ended: string[] = [];
  for (const { episode, guestId, settings } of open) {
    const timeoutMs = settings.handoffTimeoutMinutes * 60_000;
    const [staffReply] = await db
      .select({ at: sql<Date>`coalesce(${messages.occurredAt}, ${messages.createdAt})` })
      .from(messages)
      .where(
        and(
          eq(messages.clubId, episode.clubId),
          eq(messages.guestId, guestId),
          eq(messages.authorType, 'staff'),
          gte(sql`coalesce(${messages.occurredAt}, ${messages.createdAt})`, episode.startedAt),
        ),
      )
      .orderBy(desc(sql`coalesce(${messages.occurredAt}, ${messages.createdAt})`))
      .limit(1);
    const lastActivity = staffReply ? new Date(Math.max(episode.startedAt.getTime(), new Date(staffReply.at).getTime())) : episode.startedAt;
    const idleMs = now.getTime() - lastActivity.getTime();
    if (idleMs < timeoutMs / 2) continue;

    const [already] = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(
        and(
          eq(alerts.clubId, episode.clubId),
          eq(alerts.kind, HANDOFF_REALERT_KIND),
          eq(alerts.conversationId, episode.conversationId),
          gte(alerts.createdAt, lastActivity),
        ),
      )
      .limit(1);
    if (!already) {
      const minutes = Math.round(idleMs / 60_000);
      await raiseAlert(
        db,
        {
          clubId: episode.clubId,
          level: 'urgent',
          kind: HANDOFF_REALERT_KIND,
          conversationId: episode.conversationId,
          text: {
            en: `A guest is still waiting for a host (${minutes} min with no reply). The bot takes the chat back at ${settings.handoffTimeoutMinutes} min.`,
            th: `ลูกค้ายังรอพนักงานอยู่ (${minutes} นาทียังไม่มีคนตอบ) บอทจะกลับมาตอบเมื่อครบ ${settings.handoffTimeoutMinutes} นาที`,
          },
        },
        now,
      );
      realerted.push(episode.id);
    }
    if (idleMs < timeoutMs) continue;
    const done = await db.transaction((tx) => endEpisode(tx, { episodeId: episode.id, endedBy: 'timeout', now }));
    if (done) ended.push(episode.id);
  }
  return { realerted, ended };
}
