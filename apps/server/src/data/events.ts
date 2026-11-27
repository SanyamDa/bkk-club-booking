import type { Db } from '../db/client.js';
import { events } from '../db/schema.js';
import { newId } from '../lib/util.js';
import type { EventType } from './event-types.js';

export type EventInput = {
  clubId: string;
  type: EventType;
  occurredAt: Date;
  actorType: 'guest' | 'bot' | 'staff' | 'platform' | 'system';
  actorId?: string;
  channel?: string;
  dataOrigin: 'first_party' | 'line_chat' | 'line_profile' | 'instagram' | 'pos';
  source?: string;
  guestId?: string;
  conversationId?: string;
  bookingId?: string;
  tableId?: string;
  zoneId?: string;
  nightDate?: string;
  attemptId?: string;
  causeId?: string;
  lang?: string;
  props?: Record<string, string | number | boolean | null>;
  raw?: unknown;
  isTest: boolean;
  dedupeKey?: string;
};

/**
 * Record one event inside the caller's transaction (spec §14.2).
 * W0 stub: one insert, a repeated (club_id, dedupe_key) is skipped.
 * B1 adds versions, props validation, privacy classes and the dead letter; `strict` is unused until then.
 */
export async function emit(tx: Db, e: EventInput, _opts?: { strict?: boolean }): Promise<void> {
  await tx
    .insert(events)
    .values({
      id: newId(),
      occurredAt: e.occurredAt,
      recordedAt: new Date(),
      clubId: e.clubId,
      type: e.type,
      v: 1,
      actorType: e.actorType,
      actorId: e.actorId ?? null,
      channel: e.channel ?? null,
      dataOrigin: e.dataOrigin,
      source: e.source ?? null,
      guestId: e.guestId ?? null,
      conversationId: e.conversationId ?? null,
      bookingId: e.bookingId ?? null,
      tableId: e.tableId ?? null,
      zoneId: e.zoneId ?? null,
      nightDate: e.nightDate ?? null,
      attemptId: e.attemptId ?? null,
      causeId: e.causeId ?? null,
      lang: e.lang ?? null,
      props: e.props ?? {},
      raw: e.raw ?? null,
      isTest: e.isTest,
      dedupeKey: e.dedupeKey ?? null,
    })
    .onConflictDoNothing({ target: [events.clubId, events.dedupeKey] });
}
