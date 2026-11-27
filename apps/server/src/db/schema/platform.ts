import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { bookings, clubs, guests } from './core.js';

export type MembershipRole = 'owner' | 'manager' | 'host' | 'door' | 'promoter';

/** Per-person accounts (replaces v1's shared staff password). Platform-level: no club_id. */
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  passwordHash: text('password_hash'),
  platformRole: text('platform_role').$type<'admin'>(),
  totpSecret: text('totp_secret'),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const clubMemberships = pgTable(
  'club_memberships',
  {
    userId: text('user_id').notNull().references(() => users.id),
    clubId: text('club_id').notNull().references(() => clubs.id),
    role: text('role').$type<MembershipRole>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.clubId] })],
);

/** Server-side, revocable sessions. The cookie holds the token; only its hash is stored. */
export const sessions = pgTable(
  'sessions',
  {
    idHash: text('id_hash').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user').on(t.userId)],
);

/** A founder's time-limited access to one club. */
export const supportGrants = pgTable(
  'support_grants',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    clubId: text('club_id').notNull().references(() => clubs.id),
    reason: text('reason').notNull(),
    ticketRef: text('ticket_ref'),
    mode: text('mode').$type<'read' | 'write'>().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    ip: text('ip'),
  },
  (t) => [index('support_grants_user_club').on(t.userId, t.clubId)],
);

export const clubProfile = pgTable('club_profile', {
  clubId: text('club_id').primaryKey().references(() => clubs.id),
  capacityStanding: integer('capacity_standing'),
  capacitySeated: integer('capacity_seated'),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  district: text('district'),
  venueType: text('venue_type'),
  genres: text('genres').array(),
  priceBand: text('price_band'),
  openingHours: jsonb('opening_hours'),
  /** Local hour 0–23. */
  usualPeakHour: integer('usual_peak_hour'),
  licenceType: text('licence_type'),
  crowdMix: text('crowd_mix'),
  guestlistOffered: boolean('guestlist_offered'),
  posVendor: text('pos_vendor'),
  goLiveAt: timestamp('go_live_at', { withTimezone: true }),
});

/** Encrypted club secrets; never returned by any API. */
export const clubCredentials = pgTable(
  'club_credentials',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    kind: text('kind').$type<'line_messaging' | 'line_login' | 'instagram' | 'pos'>().notNull(),
    ciphertext: text('ciphertext').notNull(),
    keyRef: text('key_ref').notNull(),
    last4: text('last4'),
    setBy: text('set_by'),
    setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('club_credentials_club_kind').on(t.clubId, t.kind)],
);

/** One row per connected channel of any kind; every club has one kind = 'line' row. */
export const channels = pgTable(
  'channels',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    kind: text('kind').$type<'line' | 'instagram' | 'whatsapp' | 'web'>().notNull(),
    externalId: text('external_id'),
    status: text('status').notNull().default('pending'),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('channels_club_kind').on(t.clubId, t.kind)],
);

export const invites = pgTable('invites', {
  id: text('id').primaryKey(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  email: text('email').notNull(),
  role: text('role').$type<MembershipRole>().notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdBy: text('created_by'),
});

export const platformFlags = pgTable('platform_flags', {
  key: text('key').primaryKey(),
  value: jsonb('value'),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AlertLevel = 'urgent' | 'needs_input' | 'info';

/**
 * Manager alerts (spec §6.4, plan A15). Urgent ones also go to the staff LINE group; info ones
 * only when the club switches it on (`club_alert_settings.info_to_line`). `sent_line_at` is set
 * when the staff-group send was made.
 */
export const alerts = pgTable(
  'alerts',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    level: text('level').$type<AlertLevel>().notNull(),
    kind: text('kind').notNull(),
    conversationId: text('conversation_id'),
    bookingId: text('booking_id'),
    textEn: text('text_en').notNull(),
    textTh: text('text_th').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    sentLineAt: timestamp('sent_line_at', { withTimezone: true }),
  },
  (t) => [index('alerts_club_created').on(t.clubId, t.createdAt), index('alerts_club_kind_open').on(t.clubId, t.kind, t.resolvedAt)],
);

/** Per-club alert switches (spec §6.4: "LINE alert only if the club switches it on"). No row = defaults. */
export const clubAlertSettings = pgTable('club_alert_settings', {
  clubId: text('club_id').primaryKey().references(() => clubs.id),
  infoToLine: boolean('info_to_line').notNull().default(false),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Promoters of one club (spec §4, plan A20a). `code` is the club-unique, lowercase code in the promoter's link. */
export const promoters = pgTable(
  'promoters',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** The promoter's own login (a `promoter` membership of the club), for their limited dashboard. */
    userId: text('user_id').references(() => users.id),
    /** Commission in basis points of the booking's spend (1000 = 10%). */
    commissionBps: integer('commission_bps').notNull().default(0),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('promoters_club_code').on(t.clubId, t.code)],
);

/**
 * Which promoter brought a booking (plan A20a). Kept here, keyed by booking id, because
 * `bookings` is Track B's table. `via` is 'link' (the promoter's link) or 'manual' (set by staff).
 */
export const promoterAttributions = pgTable(
  'promoter_attributions',
  {
    bookingId: text('booking_id').primaryKey().references(() => bookings.id),
    clubId: text('club_id').notNull().references(() => clubs.id),
    promoterId: text('promoter_id').notNull().references(() => promoters.id),
    via: text('via').$type<'link' | 'manual'>().notNull(),
    attributedBy: text('attributed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('promoter_attributions_club_promoter').on(t.clubId, t.promoterId)],
);

/** Guest tags (spec §6.2 "VIP tags", plan A20c). Normalised lowercase; `vip` marks a VIP. */
export const guestTags = pgTable(
  'guest_tags',
  {
    guestId: text('guest_id').notNull().references(() => guests.id),
    clubId: text('club_id').notNull().references(() => clubs.id),
    tag: text('tag').notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.guestId, t.tag] }), index('guest_tags_club_tag').on(t.clubId, t.tag)],
);

/** Staff notes on a guest (plan A20c). Append-only. */
export const guestNotes = pgTable(
  'guest_notes',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    guestId: text('guest_id').notNull().references(() => guests.id),
    text: text('text').notNull(),
    authorId: text('author_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('guest_notes_guest').on(t.guestId)],
);

export type Promoter = typeof promoters.$inferSelect;
export type PromoterAttribution = typeof promoterAttributions.$inferSelect;
export type GuestNote = typeof guestNotes.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type User = typeof users.$inferSelect;
export type ClubMembership = typeof clubMemberships.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type SupportGrant = typeof supportGrants.$inferSelect;
export type Channel = typeof channels.$inferSelect;
