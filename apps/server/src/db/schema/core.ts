import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  real,
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

export type ClubStatus = 'onboarding' | 'live' | 'paused' | 'demo';
export type ActorType = 'guest' | 'bot' | 'staff' | 'platform' | 'system';
export type BookingSource =
  | 'line'
  | 'instagram'
  | 'manual'
  | 'manual_phone'
  | 'manual_walkin'
  | 'promoter'
  | 'web';

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
  /** Legacy plain-text link code. Nullable since v2 and never set by new code (see staffLinkCodeHash). */
  staffLinkCode: text('staff_link_code'),
  staffLinkCodeHash: text('staff_link_code_hash'),
  staffLinkCodeExpiresAt: timestamp('staff_link_code_expires_at', { withTimezone: true }),
  /** A new staff group waiting for its replacement to be confirmed. */
  pendingStaffGroupId: text('pending_staff_group_id'),
  status: text('status').$type<ClubStatus>().notNull().default('onboarding'),
  botPaused: boolean('bot_paused').notNull().default(false),
  /** Set together with botPaused; identifies one pause. Null on resume. */
  botPausedAt: timestamp('bot_paused_at', { withTimezone: true }),
  createdBy: text('created_by'),
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
    floorX: real('floor_x'),
    floorY: real('floor_y'),
    shape: text('shape'),
    /** YYYY-MM-DD; past nights keep their real inventory. */
    validFrom: date('valid_from'),
    validTo: date('valid_to'),
  },
  (t) => [uniqueIndex('tables_club_code').on(t.clubId, t.code)],
);

export const nights = pgTable(
  'nights',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    /** YYYY-MM-DD of the night (Bangkok). */
    date: text('date').notNull(),
    status: text('status').$type<'open' | 'closed' | 'sold_out'>().notNull(),
    closedReason: text('closed_reason'),
    eventType: text('event_type'),
    eventName: text('event_name'),
    lineup: jsonb('lineup'),
    notes: text('notes'),
    /** Set when a person changed the row; the nights job never overwrites it. */
    editedBy: text('edited_by'),
  },
  (t) => [uniqueIndex('nights_club_date').on(t.clubId, t.date)],
);

export const priceRules = pgTable(
  'price_rules',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    scope: text('scope').$type<'club' | 'zone' | 'table'>().notNull(),
    scopeId: text('scope_id'),
    /** 0 = Sunday … 6 = Saturday. */
    weekday: integer('weekday'),
    nightId: text('night_id').references(() => nights.id),
    minSpendSatang: integer('min_spend_satang').notNull(),
    depositSatang: integer('deposit_satang').notNull(),
    priority: integer('priority').notNull().default(0),
    validFrom: date('valid_from'),
    validTo: date('valid_to'),
  },
  (t) => [index('price_rules_club').on(t.clubId)],
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
    birthDate: date('birth_date'),
    /** The guest's channel and their id on it; lineUserId stays for LINE. */
    channelId: text('channel_id'),
    externalUserId: text('external_user_id'),
    isTest: boolean('is_test').notNull().default(false),
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
    source: text('source').$type<BookingSource>().notNull(),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    minSpendSatang: integer('min_spend_satang').notNull(),
    depositSatang: integer('deposit_satang').notNull(),
    rulesVersion: text('rules_version'),
    rulesAcceptedAt: timestamp('rules_accepted_at', { withTimezone: true }),
    specialRequest: text('special_request'),
    notes: text('notes'),
    statusReason: text('status_reason'),
    occasion: text('occasion'),
    arrivedAt: timestamp('arrived_at', { withTimezone: true }),
    arrivedPax: integer('arrived_pax'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReasonCode: text('cancel_reason_code'),
    noShowAt: timestamp('no_show_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    runningLateMinutes: integer('running_late_minutes'),
    attemptId: text('attempt_id'),
    reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
    isTest: boolean('is_test').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The rule that makes double bookings impossible: one active booking per table per night.
    // Real and test rows (B6, spec §9) each have their own index, so a test booking never blocks
    // a real guest, and two test bookings still cannot share a table.
    uniqueIndex('bookings_one_active_per_table_night')
      .on(t.tableId, t.nightDate)
      .where(
        sql`${t.status} in ('held','awaiting_payment','payment_review','confirmed','arrived') and ${t.isTest} = false`,
      ),
    uniqueIndex('bookings_one_active_test_per_table_night')
      .on(t.tableId, t.nightDate)
      .where(
        sql`${t.status} in ('held','awaiting_payment','payment_review','confirmed','arrived') and ${t.isTest} = true`,
      ),
    index('bookings_club_night').on(t.clubId, t.nightDate),
    index('bookings_guest').on(t.guestId),
  ],
);

export const deposits = pgTable(
  'deposits',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    bookingId: text('booking_id').notNull().references(() => bookings.id),
    amountSatang: integer('amount_satang').notNull(),
    method: text('method').$type<'promptpay_slip' | 'cash' | 'waived' | 'manual'>().notNull(),
    status: text('status').$type<'pending' | 'review' | 'verified' | 'rejected'>().notNull(),
    slipPath: text('slip_path'),
    slipReceivedAt: timestamp('slip_received_at', { withTimezone: true }),
    slipTransRef: text('slip_trans_ref'),
    slipAmountSatang: integer('slip_amount_satang'),
    slipReceiver: text('slip_receiver'),
    slipTime: timestamp('slip_time', { withTimezone: true }),
    verifiedBy: text('verified_by'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // A slip's transaction reference is used once per club (stops reused slips).
  (t) => [uniqueIndex('deposits_club_slip_trans_ref').on(t.clubId, t.slipTransRef)],
);

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
    externalRef: text('external_ref'),
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
    authorType: text('author_type').$type<'guest' | 'bot' | 'staff' | 'system'>(),
    authorId: text('author_id'),
    channelId: text('channel_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    sentVia: text('sent_via').$type<'reply' | 'push' | 'none'>(),
    deliveryStatus: text('delivery_status').$type<'sent' | 'failed' | 'skipped'>(),
    error: text('error'),
    externalId: text('external_id'),
    /** Set as the last step of a completed bot turn. */
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_guest_time').on(t.guestId, t.createdAt),
    // LINE can redeliver webhooks; the same inbound message must only be processed once.
    uniqueIndex('messages_line_message_id').on(t.clubId, t.lineMessageId),
    uniqueIndex('messages_club_external_id').on(t.clubId, t.externalId),
  ],
);

export const posBills = pgTable(
  'pos_bills',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    /** Null for walk-in bills. */
    bookingId: text('booking_id').references(() => bookings.id),
    providerBillId: text('provider_bill_id'),
    tableCode: text('table_code'),
    covers: integer('covers'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    totalSatang: integer('total_satang'),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
  },
  (t) => [index('pos_bills_club').on(t.clubId)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    /** Null only for platform events. */
    clubId: text('club_id'),
    actor: text('actor').notNull(),
    actorType: text('actor_type').$type<ActorType>(),
    actorId: text('actor_id'),
    sessionId: text('session_id'),
    supportGrantId: text('support_grant_id'),
    reason: text('reason'),
    ip: text('ip'),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    data: jsonb('data'),
    before: jsonb('before'),
    after: jsonb('after'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_entity').on(t.entity, t.entityId)],
);

export type Club = typeof clubs.$inferSelect;
export type Zone = typeof zones.$inferSelect;
export type Table = typeof tables.$inferSelect;
export type Night = typeof nights.$inferSelect;
export type PriceRule = typeof priceRules.$inferSelect;
export type Guest = typeof guests.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type Deposit = typeof deposits.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type PosBill = typeof posBills.$inferSelect;
