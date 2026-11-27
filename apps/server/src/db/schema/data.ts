import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { bookings, clubs, conversations, guests, messages } from './core.js';
import type { ActorType } from './core.js';

/** Every webhook delivery, stored before we answer 200. club_id is null for an unknown club. */
export const rawWebhooks = pgTable(
  'raw_webhooks',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').references(() => clubs.id),
    channel: text('channel').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    body: jsonb('body').notNull(),
    signatureOk: boolean('signature_ok').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [index('raw_webhooks_club_received').on(t.clubId, t.receivedAt)],
);

export const events = pgTable(
  'events',
  {
    seq: bigserial('seq', { mode: 'number' }).notNull().unique(),
    id: text('id').primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    clubId: text('club_id').notNull(),
    type: text('type').notNull(),
    v: integer('v').notNull().default(1),
    actorType: text('actor_type').$type<ActorType>().notNull(),
    actorId: text('actor_id'),
    channel: text('channel'),
    dataOrigin: text('data_origin')
      .$type<'first_party' | 'line_chat' | 'line_profile' | 'instagram' | 'pos'>()
      .notNull(),
    source: text('source'),
    guestId: text('guest_id'),
    personId: text('person_id'),
    conversationId: text('conversation_id'),
    bookingId: text('booking_id'),
    tableId: text('table_id'),
    zoneId: text('zone_id'),
    nightDate: text('night_date'),
    attemptId: text('attempt_id'),
    causeId: text('cause_id'),
    lang: text('lang'),
    /** Coded values only (enums, ids, counts). Free text goes in raw. */
    props: jsonb('props').$type<Record<string, string | number | boolean | null>>().notNull().default({}),
    raw: jsonb('raw'),
    isTest: boolean('is_test').notNull().default(false),
    dedupeKey: text('dedupe_key'),
  },
  (t) => [
    uniqueIndex('events_club_dedupe').on(t.clubId, t.dedupeKey),
    index('events_club_occurred').on(t.clubId, t.occurredAt),
    index('events_booking').on(t.bookingId),
  ],
);

export const eventsDeadLetter = pgTable('events_dead_letter', {
  id: text('id').primaryKey(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb('payload').notNull(),
  error: text('error').notNull(),
});

export const opsEvents = pgTable(
  'ops_events',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id'),
    kind: text('kind')
      .$type<
        | 'webhook_bad_signature'
        | 'webhook_unknown_club'
        | 'bot_error'
        | 'send_failed'
        | 'line_setup'
        | 'login_failed'
      >()
      .notNull(),
    detail: jsonb('detail'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ops_events_club_at').on(t.clubId, t.at)],
);

export const occupancySnapshots = pgTable(
  'occupancy_snapshots',
  {
    clubId: text('club_id').notNull().references(() => clubs.id),
    nightDate: text('night_date').notNull(),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull(),
    leadBucket: text('lead_bucket').notNull(),
    tablesActive: integer('tables_active').notNull(),
    tablesHeld: integer('tables_held').notNull(),
    tablesConfirmed: integer('tables_confirmed').notNull(),
    tablesArrived: integer('tables_arrived').notNull(),
    paxBooked: integer('pax_booked').notNull(),
    minSpendBookedSatang: integer('min_spend_booked_satang').notNull(),
    depositsVerifiedSatang: integer('deposits_verified_satang').notNull(),
  },
  (t) => [primaryKey({ columns: [t.clubId, t.nightDate, t.takenAt] })],
);

export const doorCounts = pgTable(
  'door_counts',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    nightDate: text('night_date').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    delta: integer('delta').notNull(),
    kind: text('kind').$type<'table_guest' | 'guestlist' | 'walk_in' | 'ticket'>().notNull(),
    userId: text('user_id'),
  },
  (t) => [index('door_counts_club_night').on(t.clubId, t.nightDate)],
);

/** Staff "how full now?" rating, 1–5. */
export const crowdRatings = pgTable(
  'crowd_ratings',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    nightDate: text('night_date').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    level: integer('level').notNull(),
    userId: text('user_id'),
  },
  (t) => [index('crowd_ratings_club_night').on(t.clubId, t.nightDate)],
);

/** City calendar. Platform-level: no club_id. */
export const calendarDays = pgTable(
  'calendar_days',
  {
    date: date('date').notNull(),
    kind: text('kind')
      .$type<'public_holiday' | 'holy_day' | 'alcohol_ban' | 'election' | 'city_event'>()
      .notNull(),
    name: text('name').notNull(),
    notes: text('notes'),
  },
  (t) => [primaryKey({ columns: [t.date, t.kind, t.name] })],
);

export const identityMap = pgTable(
  'identity_map',
  {
    personId: text('person_id').notNull(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    guestId: text('guest_id').notNull().references(() => guests.id),
    platformLineSub: text('platform_line_sub'),
    phoneHash: text('phone_hash'),
    firstLinkedAt: timestamp('first_linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('identity_map_club_guest').on(t.clubId, t.guestId),
    index('identity_map_person').on(t.personId),
    index('identity_map_sub').on(t.platformLineSub),
  ],
);

export const bookingStatusHistory = pgTable(
  'booking_status_history',
  {
    id: text('id').primaryKey(),
    bookingId: text('booking_id').notNull().references(() => bookings.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorType: text('actor_type').$type<ActorType>().notNull(),
    actorId: text('actor_id'),
    reasonCode: text('reason_code'),
  },
  (t) => [index('booking_status_history_booking').on(t.bookingId, t.at)],
);

export const notices = pgTable(
  'notices',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    guestId: text('guest_id').notNull().references(() => guests.id),
    purpose: text('purpose').notNull(),
    textVersion: text('text_version').notNull(),
    channel: text('channel').notNull(),
    shownAt: timestamp('shown_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  },
  (t) => [index('notices_club_guest').on(t.clubId, t.guestId)],
);

export const handoffEpisodes = pgTable(
  'handoff_episodes',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    conversationId: text('conversation_id').notNull().references(() => conversations.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    trigger: text('trigger').notNull(),
    reason: text('reason'),
    resolverUserId: text('resolver_user_id'),
    firstMessageId: text('first_message_id').references(() => messages.id),
    lastMessageId: text('last_message_id').references(() => messages.id),
    endedBy: text('ended_by').$type<'staff' | 'timeout'>(),
    topic: text('topic'),
    matchedNoteId: text('matched_note_id'),
  },
  (t) => [index('handoff_episodes_club_conv').on(t.clubId, t.conversationId)],
);

export const removalRequests = pgTable(
  'removal_requests',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    guestId: text('guest_id').notNull().references(() => guests.id),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    channel: text('channel').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: text('completed_by'),
  },
  (t) => [index('removal_requests_club').on(t.clubId)],
);

export type Event = typeof events.$inferSelect;
export type HandoffEpisode = typeof handoffEpisodes.$inferSelect;
