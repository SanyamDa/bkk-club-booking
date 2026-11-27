import type { PaxRangeKey } from '../bookings/service.js';
import type { BookingStatus } from '../db/schema.js';

/**
 * Privacy class of one event field (spec §14.2 "a privacy class per field").
 * - `none`: a code, count or flag that says nothing about a person.
 * - `pseudonymous`: an id that links to a guest, staff member or record.
 * - `personal`: identifies or describes a person (names, text, profile). Allowed only in `raw`.
 */
export type PrivacyClass = 'none' | 'pseudonymous' | 'personal';

export type EventArea =
  | 'Contact'
  | 'Messages'
  | 'Demand'
  | 'Booking'
  | 'The night'
  | 'Handoff and brain'
  | 'Staff and platform'
  | 'Internal';

export type EventDeclaration = {
  /** Version of the event's fields; bump when a prop changes meaning or is removed. */
  v: number;
  area: EventArea;
  description: string;
  /** The allowed `props` keys and the privacy class of each. Values are coded (see `data/events.ts`). */
  props: Record<string, PrivacyClass>;
  /** Privacy class of `raw` when the event carries it; absent means the event has no raw payload. */
  raw?: PrivacyClass;
};

const N = 'none' as const;
const P = 'pseudonymous' as const;

/**
 * Every event type, with its version, props and privacy classes (spec §14.2 table verbatim, plus the
 * internal types the plan adds). This declaration is the contract: `emit` validates against it,
 * `npm run events:doc -w @club/server` renders `docs/EVENTS.md` from it, and no event-name string
 * literal appears outside code that passes an `EventType`. The plan's B4b table lists which task emits each.
 */
export const EVENT_DECLARATIONS = {
  // Contact
  'guest.first_seen': { v: 1, area: 'Contact', description: 'First message or follow from a guest the club has not seen.', props: {}, raw: 'personal' },
  'guest.followed': { v: 1, area: 'Contact', description: 'Guest added the club OA.', props: {}, raw: 'personal' },
  'guest.unfollowed': { v: 1, area: 'Contact', description: 'Guest blocked or removed the club OA.', props: {} },
  'guest.refollowed': { v: 1, area: 'Contact', description: 'Guest who unfollowed added the OA again.', props: {}, raw: 'personal' },
  'notice.shown': { v: 1, area: 'Contact', description: 'Data notice shown to the guest (spec §5.5).', props: { notice_id: P, purpose: N, text_version: N } },
  'notice.accepted': { v: 1, area: 'Contact', description: 'Guest accepted the notice in the booking form.', props: { notice_id: P, purpose: N, text_version: N } },
  'marketing.opted_out': { v: 1, area: 'Contact', description: 'Guest asked for no marketing.', props: {}, raw: 'personal' },

  // Messages
  'message.received': { v: 1, area: 'Messages', description: 'Inbound guest message.', props: { kind: N, attachments: N, messageId: P }, raw: 'personal' },
  'message.sent': { v: 1, area: 'Messages', description: 'Bot or staff send: reply or push, delivered or failed, latency, template.', props: { kind: N, delivered: N, latency_ms: N, template: N, messageId: P }, raw: 'personal' },
  'intent.detected': { v: 1, area: 'Messages', description: 'Typed text matched an intent.', props: { intent: N }, raw: 'personal' },
  'intent.unknown': { v: 1, area: 'Messages', description: 'Typed text matched no intent.', props: {}, raw: 'personal' },
  'bot.fallback_menu': { v: 1, area: 'Messages', description: 'Bot answered with the fallback menu.', props: {} },
  'bot.error': { v: 1, area: 'Messages', description: 'Bot failed while handling an event.', props: { code: N, step: N }, raw: 'personal' },

  // Demand
  'booking.started': { v: 1, area: 'Demand', description: 'Booking attempt started; creates attempt_id.', props: {} },
  'night.selected': { v: 1, area: 'Demand', description: 'Guest picked a night (night_date column).', props: {} },
  'night.rejected': { v: 1, area: 'Demand', description: 'Guest picked a night that cannot be booked.', props: { reason: N } },
  'pax.selected': { v: 1, area: 'Demand', description: 'Guest picked a party size range (paxRangeCode).', props: { pax_range: N } },
  'availability.searched': { v: 1, area: 'Demand', description: 'Table search, including zero results.', props: { night_date: N, pax_range: N, result_count: N, tables_shown: N } },
  'night.sold_out_shown': { v: 1, area: 'Demand', description: 'Guest was shown a full night.', props: { pax_range: N } },
  'waitlist.joined': { v: 1, area: 'Demand', description: 'Guest joined the waitlist for a night.', props: { pax_range: N } },

  // Booking
  'table.held': { v: 1, area: 'Booking', description: 'Table held for the guest.', props: { hold_minutes: N } },
  'table.hold_lost_race': { v: 1, area: 'Booking', description: 'Another guest took the table first.', props: {} },
  'hold.expired': { v: 1, area: 'Booking', description: 'Hold ran out before payment.', props: { reason_code: N } },
  'booking.abandoned': { v: 1, area: 'Booking', description: 'Attempt ended without a booking, with the last step reached.', props: { last_step: N, reason_code: N } },
  'form.opened': { v: 1, area: 'Booking', description: 'Details form opened.', props: {} },
  'form.validation_failed': { v: 1, area: 'Booking', description: 'Details form failed validation.', props: { field: N, code: N } },
  'form.identity_rejected': { v: 1, area: 'Booking', description: 'Details form identity check failed.', props: { code: N } },
  'form.submit_rejected': { v: 1, area: 'Booking', description: 'Details form submit refused by the server.', props: { code: N } },
  'details.submitted': { v: 1, area: 'Booking', description: 'Guest submitted the details form.', props: { pax: N }, raw: 'personal' },
  'rules.accepted': { v: 1, area: 'Booking', description: 'Guest accepted the club rules.', props: { rules_version: N } },
  'deposit.qr_sent': { v: 1, area: 'Booking', description: 'Deposit QR sent.', props: { depositId: P, amount_satang: N } },
  'slip.received': { v: 1, area: 'Booking', description: 'Payment slip received.', props: { depositId: P } },
  'slip.auto_verified': { v: 1, area: 'Booking', description: 'Slip verified by the slip provider.', props: { depositId: P, provider: N, amount_satang: N } },
  'slip.review': { v: 1, area: 'Booking', description: 'Slip sent to staff review.', props: { depositId: P, code: N } },
  'deposit.verified': { v: 1, area: 'Booking', description: 'Deposit approved.', props: { depositId: P, amount_satang: N } },
  'deposit.rejected': { v: 1, area: 'Booking', description: 'Deposit rejected.', props: { depositId: P, reason_code: N } },
  'booking.confirmed': { v: 1, area: 'Booking', description: 'Booking confirmed.', props: {} },
  'booking.manual_created': { v: 1, area: 'Booking', description: 'Staff created a booking by hand.', props: { pax: N } },
  'booking.cancelled': { v: 1, area: 'Booking', description: 'Booking cancelled.', props: { reason_code: N } },
  running_late: { v: 1, area: 'Booking', description: 'Guest said they are running late.', props: { minutes: N } },
  'reminder.sent': { v: 1, area: 'Booking', description: 'Reminder sent to the guest.', props: { kind: N } },

  // The night
  'booking.checked_in': { v: 1, area: 'The night', description: 'Guest arrived, with actual party size.', props: { arrived_pax: N } },
  'booking.no_show': { v: 1, area: 'The night', description: 'Guest did not arrive.', props: {} },
  'table.released': { v: 1, area: 'The night', description: 'Table released for resale.', props: {} },
  'door.count': { v: 1, area: 'The night', description: 'Door count recorded.', props: { count_in: N, count_out: N, total: N } },
  'crowd.rated': { v: 1, area: 'The night', description: 'Staff crowd rating.', props: { rating: N } },
  'night.sold_out': { v: 1, area: 'The night', description: 'Last table of the night taken.', props: {} },
  'booking.completed': { v: 1, area: 'The night', description: 'Booking closed with its bill.', props: { billRef: P, totalSatang: N } },
  'pos.bill_opened': { v: 1, area: 'The night', description: 'POS bill opened for a booking.', props: { billRef: P, prepaidSatang: N } },
  'pos.bill_updated': { v: 1, area: 'The night', description: 'POS bill changed.', props: { billRef: P, totalSatang: N, tableCode: N, covers: N, eventId: P } },
  'pos.bill_closed': { v: 1, area: 'The night', description: 'POS bill closed.', props: { billRef: P, covers: N, totalSatang: N } },
  'pos.bill_matched': { v: 1, area: 'The night', description: 'POS bill matched to a booking.', props: { billRef: P, method: N } },

  // Handoff and brain
  'handoff.requested': { v: 1, area: 'Handoff and brain', description: 'Conversation handed to a person, with trigger.', props: { trigger: N } },
  'handoff.resolved': { v: 1, area: 'Handoff and brain', description: 'Takeover ended, with duration.', props: { durationSec: N } },
  'handoff.timed_out': { v: 1, area: 'Handoff and brain', description: 'Takeover timed out and went back to the bot.', props: { durationSec: N } },
  'host.replied': { v: 1, area: 'Handoff and brain', description: 'Staff replied to the guest.', props: { latency_ms: N }, raw: 'personal' },
  'ai.answered': { v: 1, area: 'Handoff and brain', description: 'AI answered: notes used, topic, language.', props: { notes_used: N, topic: N }, raw: 'personal' },
  'ai.call': { v: 1, area: 'Handoff and brain', description: 'One model call: model, tokens, latency, cost.', props: { model: N, input_tokens: N, output_tokens: N, latency_ms: N, cost_usd_micros: N } },
  'faq.missed': { v: 1, area: 'Handoff and brain', description: 'Guest asked something the brain could not answer.', props: { topic: N }, raw: 'personal' },
  'brain.note_drafted': { v: 1, area: 'Handoff and brain', description: 'Brain note drafted, with note type and source.', props: { noteId: P, noteType: N, source: N } },
  'brain.note_approved': { v: 1, area: 'Handoff and brain', description: 'Brain note approved, with note type and source.', props: { noteId: P, noteType: N, source: N } },
  'brain.note_rejected': { v: 1, area: 'Handoff and brain', description: 'Brain note rejected, with note type and source.', props: { noteId: P, noteType: N, source: N } },

  // Staff and platform
  'staff.login': { v: 1, area: 'Staff and platform', description: 'Staff signed in (one per club membership).', props: {} },
  'staff.booking_viewed': { v: 1, area: 'Staff and platform', description: 'Staff opened a booking.', props: {} },
  'staff.slip_viewed': { v: 1, area: 'Staff and platform', description: 'Staff opened a slip image.', props: { depositId: P } },
  'support.session_started': { v: 1, area: 'Staff and platform', description: 'Platform support session started.', props: { supportGrantId: P, mode: N } },
  'support.session_ended': { v: 1, area: 'Staff and platform', description: 'Platform support session ended.', props: { supportGrantId: P, mode: N } },
  'club.created': { v: 1, area: 'Staff and platform', description: 'Club created from the console.', props: { template: N } },
  'club.settings_changed': { v: 1, area: 'Staff and platform', description: 'Club settings changed; changed fields as short codes (days, window, hold, arrival, handoff, accent, rules, address, menu, greeting, map, promptpay, zones, tables, profile) joined with ":".', props: { fields: N } },
  'club.price_changed': {
    v: 1,
    area: 'Staff and platform',
    description: 'Price rule changed.',
    props: { scope: N, scopeId: P, weekday: N, nightId: P, minSpendSatang: N, depositSatang: N, previousMinSpendSatang: N, previousDepositSatang: N, validFrom: N },
  },
  'club.event_night_created': { v: 1, area: 'Staff and platform', description: 'Event night created; the event name is in raw.', props: { nightId: P, eventType: N }, raw: 'none' },
  'line.setup_run': { v: 1, area: 'Staff and platform', description: 'LINE setup, status or probe ran.', props: { ok: N, check: N } },
  'line.webhook.rejected': { v: 1, area: 'Staff and platform', description: 'LINE webhook delivery rejected.', props: { reason: N } },

  // Internal (beyond the §14.2 table)
  'booking.status_changed': { v: 1, area: 'Internal', description: 'Every booking status change (B2); the row the nightly check matches on.', props: { from: N, to: N, reason_code: N }, raw: 'personal' },
  'link.opened': { v: 1, area: 'Internal', description: 'Tagged redirect link tapped (B4).', props: { kind: N } },
  'guest.removal_requested': { v: 1, area: 'Internal', description: 'Guest asked for their data to be removed (B10b).', props: {} },
  'guest.removed': { v: 1, area: 'Internal', description: 'Guest data removal job finished (B10b).', props: {} },
  'guest.tester_registered': { v: 1, area: 'Internal', description: 'Guest typed the one-time tester code at an onboarding club; their rows are test data from now on (B6).', props: {} },
  'staff.invited': { v: 1, area: 'Internal', description: 'Manager invited a staff member (A8).', props: { inviteId: P, role: N, via: N } },
  'staff.invite_accepted': { v: 1, area: 'Internal', description: 'Invite accepted (A8).', props: { inviteId: P, role: N } },
  'staff.role_changed': { v: 1, area: 'Internal', description: 'Member role changed (A8).', props: { from: N, to: N } },
  'staff.disabled': { v: 1, area: 'Internal', description: 'Member disabled in this club (A8).', props: { role: N, sessionsRevoked: N, accountDisabled: N } },
} as const satisfies Record<string, EventDeclaration>;

export type EventType = keyof typeof EVENT_DECLARATIONS;

/** Every event type, in declaration order. */
export const EVENT_TYPES = Object.keys(EVENT_DECLARATIONS) as readonly EventType[];

export function eventDeclaration(type: string): EventDeclaration | undefined {
  return Object.hasOwn(EVENT_DECLARATIONS, type) ? (EVENT_DECLARATIONS as Record<string, EventDeclaration>)[type] : undefined;
}

/** Party size range as a props code: `13+` fails the props pattern, so events store these (B4, B4b). */
export type PaxRangeCode = 'p2_4' | 'p5_8' | 'p9_12' | 'p13_plus';
const PAX_RANGE_CODES: Record<PaxRangeKey, PaxRangeCode> = { '2-4': 'p2_4', '5-8': 'p5_8', '9-12': 'p9_12', '13+': 'p13_plus' };
export function paxRangeCode(key: PaxRangeKey): PaxRangeCode {
  return PAX_RANGE_CODES[key];
}

/**
 * The §14.2 events a booking status change writes, by the status it moves to (B2). `changeStatus` in
 * `bookings/service.ts` writes these next to the generic `booking.status_changed`, in the same
 * transaction. The `deposit.*` entries are written only when the change concerns a deposit (a
 * confirm with no deposit, or a manual booking without one, writes `booking.confirmed` alone).
 * `completed` has no entry: the POS bill close that completes a booking emits `booking.completed`.
 */
export const STATUS_EVENTS: Partial<Record<BookingStatus, readonly EventType[]>> = {
  held: ['table.held'],
  expired: ['hold.expired'],
  abandoned: ['booking.abandoned'],
  awaiting_payment: ['deposit.qr_sent'],
  payment_review: ['slip.received'],
  confirmed: ['deposit.verified', 'booking.confirmed'],
  rejected: ['deposit.rejected'],
  cancelled: ['booking.cancelled'],
  arrived: ['booking.checked_in'],
  no_show: ['booking.no_show'],
};
