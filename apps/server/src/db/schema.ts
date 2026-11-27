import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** Statuses during which a booking occupies its table for the night. */
export const ACTIVE_BOOKING_STATUSES = [
  'held',
  'awaiting_payment',
  'payment_review',
  'confirmed',
  'arrived',
] as const;

export type BookingStatus =
  | (typeof ACTIVE_BOOKING_STATUSES)[number]
  | 'completed'
  | 'cancelled'
  | 'no_show'
  | 'expired'
  | 'abandoned'
  | 'rejected';

export interface ClubSettings {
  /** 0 = Sunday … 6 = Saturday (Bangkok time). */
  openWeekdays: number[];
  closedDates: string[];
  bookingWindowDays: number;
  holdMinutes: number;
  /** A night starts at this local hour and belongs to that calendar date. */
  nightStartHour: number;
  nightEndHour: number;
  arrivalBy: string;
  handoffTimeoutMinutes: number;
  refPrefix: string;
  accentColor: string;
  rulesVersion: string;
  rules: { en: string[]; th: string[] };
  greeting: { en: string; th: string };
  address: string;
  mapUrl: string;
  drinksMenuUrl?: string;
}

export const clubs = pgTable('clubs', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  settings: jsonb('settings').$type<ClubSettings>().notNull(),
  /** Names of environment variables holding the LINE secrets (secrets never live in the DB). */
  lineChannelSecretEnv: text('line_channel_secret_env'),
  lineAccessTokenEnv: text('line_access_token_env'),
  /** LINE Login channel (owns the LIFF app). Used to verify guests' ID tokens and update the LIFF endpoint. */
  lineLoginChannelIdEnv: text('line_login_channel_id_env'),
  lineLoginChannelSecretEnv: text('line_login_channel_secret_env'),
  liffId: text('liff_id'),
  promptpayId: text('promptpay_id'),
  promptpayName: text('promptpay_name'),
  staffGroupId: text('staff_group_id'),
  staffLinkCode: text('staff_link_code').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const zones = pgTable('zones', {
  id: text('id').primaryKey(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  name: text('name').notNull(),
  nameTh: text('name_th').notNull(),
  sort: integer('sort').notNull().default(0),
  minSpendSatang: integer('min_spend_satang').notNull(),
  depositSatang: integer('deposit_satang').notNull(),
});

export const tables = pgTable(
  'tables',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    zoneId: text('zone_id').notNull().references(() => zones.id),
    code: text('code').notNull(),
    minPax: integer('min_pax').notNull(),
    maxPax: integer('max_pax').notNull(),
    sort: integer('sort').notNull().default(0),
    /** Overrides the zone price when set. */
    minSpendSatang: integer('min_spend_satang'),
    depositSatang: integer('deposit_satang'),
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('tables_club_code').on(t.clubId, t.code)],
);

export const guests = pgTable(
  'guests',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    /** LINE user ids are unique per LINE provider, so the same person differs between clubs. */
    lineUserId: text('line_user_id'),
    displayName: text('display_name'),
    name: text('name'),
    phone: text('phone'),
    nationality: text('nationality'),
    lang: text('lang').notNull().default('en'),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    /** Set when the guest blocks the club's LINE account; pushes are skipped while set. */
    unfollowedAt: timestamp('unfollowed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('guests_club_line_user').on(t.clubId, t.lineUserId)],
);

export const bookings = pgTable(
  'bookings',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    refCode: text('ref_code').notNull().unique(),
    guestId: text('guest_id').notNull().references(() => guests.id),
    tableId: text('table_id').notNull().references(() => tables.id),
    /** YYYY-MM-DD of the night (Bangkok), see ClubSettings.nightStartHour. */
    nightDate: text('night_date').notNull(),
    pax: integer('pax').notNull(),
    status: text('status').$type<BookingStatus>().notNull(),
    source: text('source').$type<'line' | 'manual'>().notNull(),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    minSpendSatang: integer('min_spend_satang').notNull(),
    depositSatang: integer('deposit_satang').notNull(),
    rulesVersion: text('rules_version'),
    rulesAcceptedAt: timestamp('rules_accepted_at', { withTimezone: true }),
    specialRequest: text('special_request'),
    notes: text('notes'),
    statusReason: text('status_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The rule that makes double bookings impossible: one active booking per table per night.
    uniqueIndex('bookings_one_active_per_table_night')
      .on(t.tableId, t.nightDate)
      .where(
        sql`${t.status} in ('held','awaiting_payment','payment_review','confirmed','arrived')`,
      ),
    index('bookings_club_night').on(t.clubId, t.nightDate),
    index('bookings_guest').on(t.guestId),
  ],
);

export const deposits = pgTable('deposits', {
  id: text('id').primaryKey(),
  bookingId: text('booking_id').notNull().references(() => bookings.id),
  amountSatang: integer('amount_satang').notNull(),
  method: text('method').$type<'promptpay_slip' | 'cash' | 'waived' | 'manual'>().notNull(),
  status: text('status').$type<'pending' | 'review' | 'verified' | 'rejected'>().notNull(),
  slipPath: text('slip_path'),
  slipReceivedAt: timestamp('slip_received_at', { withTimezone: true }),
  verifiedBy: text('verified_by'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export interface ConversationState {
  nightDate?: string;
  paxRange?: string;
}

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    guestId: text('guest_id').notNull().references(() => guests.id),
    mode: text('mode').$type<'bot' | 'human'>().notNull().default('bot'),
    state: jsonb('state').$type<ConversationState>().notNull().default({}),
    handoffRequestedAt: timestamp('handoff_requested_at', { withTimezone: true }),
    handoffReason: text('handoff_reason'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('conversations_guest').on(t.guestId)],
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    guestId: text('guest_id').references(() => guests.id),
    /** For outbound messages to a staff group rather than a guest. */
    target: text('target'),
    direction: text('direction').$type<'in' | 'out'>().notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    lineMessageId: text('line_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_guest_time').on(t.guestId, t.createdAt),
    // LINE can redeliver webhooks; the same inbound message must only be processed once.
    uniqueIndex('messages_line_message_id').on(t.clubId, t.lineMessageId),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    data: jsonb('data'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_entity').on(t.entity, t.entityId)],
);

export type Club = typeof clubs.$inferSelect;
export type Zone = typeof zones.$inferSelect;
export type Table = typeof tables.$inferSelect;
export type Guest = typeof guests.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type Deposit = typeof deposits.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
