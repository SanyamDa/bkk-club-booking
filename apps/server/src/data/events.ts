import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events, eventsDeadLetter, identityMap } from '../db/schema.js';
import { newId } from '../lib/util.js';
import { eventDeclaration, type EventType } from './event-types.js';

/** A props string value: a code or id, never free text (spec §9). */
export const PROPS_VALUE_PATTERN = /^[A-Za-z0-9_:.\-]{1,64}$/;

const DATA_ORIGINS = new Set(['first_party', 'line_chat', 'line_profile', 'instagram', 'pos']);

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

export class EventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventValidationError';
  }
}

/** The reasons `e` does not match its declaration in `data/event-types.ts`; empty when it does. */
export function eventProblems(e: EventInput): string[] {
  const decl = eventDeclaration(e.type);
  if (!decl) return [`unknown event type ${JSON.stringify(e.type)}`];
  const problems: string[] = [];
  if (!DATA_ORIGINS.has(e.dataOrigin)) problems.push(`dataOrigin ${JSON.stringify(e.dataOrigin)} is not a known origin`);
  if (typeof e.isTest !== 'boolean') problems.push('isTest is required');
  for (const [key, value] of Object.entries(e.props ?? {})) {
    if (!Object.hasOwn(decl.props, key)) {
      problems.push(`props.${key} is not declared for ${e.type}`);
      continue;
    }
    const ok =
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && PROPS_VALUE_PATTERN.test(value));
    if (!ok) problems.push(`props.${key} must be a number, boolean, null or a code matching ${PROPS_VALUE_PATTERN}`);
  }
  return problems;
}

/** The event as JSON; a raw payload that cannot be serialised is replaced so the dead letter is never lost. */
function deadLetterPayload(e: EventInput): unknown {
  try {
    return JSON.parse(JSON.stringify(e));
  } catch {
    return JSON.parse(JSON.stringify({ ...e, raw: '[unserialisable]' }));
  }
}

/** Strict unless told otherwise: tests throw on a bad event, production dead-letters it. */
const defaultStrict = () => process.env.NODE_ENV === 'test';

/**
 * Record one event inside the caller's transaction (spec §14.2). Pass the transaction handle so the
 * event commits or rolls back with the change it records.
 * - A valid event is inserted with its declared version `v`; a repeated (club_id, dedupe_key) is skipped.
 * - An event that fails its declaration throws `EventValidationError` when `strict` (the default when
 *   NODE_ENV is test); otherwise it is written to `events_dead_letter` in the same transaction and the
 *   caller's change still commits.
 */
export async function emit(tx: Db, e: EventInput, opts?: { strict?: boolean }): Promise<void> {
  const problems = eventProblems(e);
  if (problems.length) {
    const error = `${e.type}: ${problems.join('; ')}`;
    if (opts?.strict ?? defaultStrict()) throw new EventValidationError(error);
    await tx.insert(eventsDeadLetter).values({ id: newId(), receivedAt: new Date(), payload: deadLetterPayload(e), error });
    return;
  }
  const decl = eventDeclaration(e.type)!;
  await tx
    .insert(events)
    .values({
      id: newId(),
      occurredAt: e.occurredAt,
      recordedAt: new Date(),
      clubId: e.clubId,
      type: e.type,
      v: decl.v,
      actorType: e.actorType,
      actorId: e.actorId ?? null,
      channel: e.channel ?? null,
      dataOrigin: e.dataOrigin,
      // B4: every event of a booking attempt carries the attempt's entry tag. A booking event with an
      // `attemptId` and no `source` takes it from the booking's tagged hold event (`events_booking` index).
      source:
        e.source ??
        (e.attemptId && e.bookingId
          ? sql`(select ${events.source} from ${events} where ${events.bookingId} = ${e.bookingId} and ${events.clubId} = ${e.clubId} and ${events.attemptId} = ${e.attemptId} and ${events.source} is not null order by ${events.occurredAt} limit 1)`
          : null),
      guestId: e.guestId ?? null,
      // The guest's platform person (B20, §14.4); Instagram data stays with its club (§14.8).
      personId:
        e.guestId && e.dataOrigin !== 'instagram'
          ? sql`(select ${identityMap.personId} from ${identityMap} where ${identityMap.clubId} = ${e.clubId} and ${identityMap.guestId} = ${e.guestId})`
          : null,
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
