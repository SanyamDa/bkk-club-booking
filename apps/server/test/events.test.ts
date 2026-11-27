import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emit, type EventInput } from '../src/data/events.js';
import { EVENT_DECLARATIONS, EVENT_TYPES, paxRangeCode } from '../src/data/event-types.js';
import type { Db } from '../src/db/client.js';
import { events, eventsDeadLetter, type Club } from '../src/db/schema.js';
import { renderEventsDoc } from '../src/scripts/events-doc.js';
import { FRIDAY_AFTERNOON, setupDb } from './helpers.js';

/** Every event name in the spec §14.2 "What is recorded" table, copied verbatim. */
const SPEC_14_2_EVENTS = [
  // Contact
  'guest.first_seen', 'guest.followed', 'guest.unfollowed', 'guest.refollowed', 'notice.shown', 'notice.accepted', 'marketing.opted_out',
  // Messages
  'message.received', 'message.sent', 'intent.detected', 'intent.unknown', 'bot.fallback_menu', 'bot.error',
  // Demand
  'booking.started', 'night.selected', 'night.rejected', 'pax.selected', 'availability.searched', 'night.sold_out_shown', 'waitlist.joined',
  // Booking
  'table.held', 'table.hold_lost_race', 'hold.expired', 'booking.abandoned', 'form.opened', 'form.validation_failed', 'form.identity_rejected',
  'form.submit_rejected', 'details.submitted', 'rules.accepted', 'deposit.qr_sent', 'slip.received', 'slip.auto_verified', 'slip.review',
  'deposit.verified', 'deposit.rejected', 'booking.confirmed', 'booking.manual_created', 'booking.cancelled', 'running_late', 'reminder.sent',
  // The night
  'booking.checked_in', 'booking.no_show', 'table.released', 'door.count', 'crowd.rated', 'night.sold_out', 'booking.completed',
  'pos.bill_opened', 'pos.bill_updated', 'pos.bill_closed', 'pos.bill_matched',
  // Handoff and brain
  'handoff.requested', 'handoff.resolved', 'handoff.timed_out', 'host.replied', 'ai.answered', 'ai.call', 'faq.missed',
  'brain.note_drafted', 'brain.note_approved', 'brain.note_rejected',
  // Staff and platform
  'staff.login', 'staff.booking_viewed', 'staff.slip_viewed', 'support.session_started', 'support.session_ended', 'club.created',
  'club.settings_changed', 'club.price_changed', 'club.event_night_created', 'line.setup_run', 'line.webhook.rejected',
];

/** Types the plan adds beyond the spec table (B2, B4, B10b, A8). */
const PLAN_EXTRA_EVENTS = [
  'booking.status_changed', 'link.opened', 'guest.removal_requested', 'guest.removed',
  'staff.invited', 'staff.invite_accepted', 'staff.role_changed', 'staff.disabled',
];

const eventsDocPath = fileURLToPath(new URL('../../../docs/EVENTS.md', import.meta.url));

let db: Db;
let club: Club;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, club, close } = await setupDb());
});
afterEach(async () => close());

const base = (over: Partial<EventInput> = {}): EventInput => ({
  clubId: club.id,
  type: 'availability.searched',
  occurredAt: FRIDAY_AFTERNOON,
  actorType: 'guest',
  dataOrigin: 'first_party',
  isTest: true,
  props: { night_date: '2026-11-27', pax_range: 'p5_8', result_count: 0 },
  ...over,
});

const clubEvents = () => db.select().from(events).where(eq(events.clubId, club.id));

describe('event log core (B1)', () => {
  it('same dedupe_key inserts one row', async () => {
    const e = base({ dedupeKey: 'search:1' });
    await db.transaction(async (tx) => {
      await emit(tx as unknown as Db, e);
      await emit(tx as unknown as Db, e);
    });
    await emit(db, e);
    expect(await clubEvents()).toHaveLength(1);
  });

  it('free text in props is rejected', async () => {
    await expect(emit(db, base({ type: 'staff.login', props: { note: 'hello world' } }))).rejects.toThrow(/props/);
    // A declared key with a free-text value fails too.
    await expect(emit(db, base({ props: { night_date: 'next friday please' } }))).rejects.toThrow(/props\.night_date/);
    expect(await clubEvents()).toHaveLength(0);
    expect(await db.select().from(eventsDeadLetter)).toHaveLength(0);
  });

  it('rejected event goes to dead letter in production mode', async () => {
    await db.transaction(async (tx) => {
      await emit(tx as unknown as Db, base({ type: 'staff.login', props: { note: 'hello world' } }), { strict: false });
      await emit(tx as unknown as Db, base({ dedupeKey: 'ok:1' }), { strict: false });
    });
    const dead = await db.select().from(eventsDeadLetter);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.error).toMatch(/note/);
    expect(dead[0]!.payload).toMatchObject({ clubId: club.id, type: 'staff.login', props: { note: 'hello world' } });
    // The valid event in the same transaction still commits.
    const rows = await clubEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('availability.searched');
  });

  it('seq increases monotonically', async () => {
    for (let i = 0; i < 5; i++) await emit(db, base({ dedupeKey: `s:${i}` }));
    const rows = (await clubEvents()).sort((a, b) => a.seq - b.seq);
    expect(new Set(rows.map((r) => r.seq)).size).toBe(5);
    // Insertion order is seq order.
    expect(rows.map((r) => r.dedupeKey)).toEqual(['s:0', 's:1', 's:2', 's:3', 's:4']);
  });

  it('every §14.2 name is declared', () => {
    const declared = new Set<string>(EVENT_TYPES);
    for (const name of [...SPEC_14_2_EVENTS, ...PLAN_EXTRA_EVENTS]) expect(declared, name).toContain(name);
    for (const [name, d] of Object.entries(EVENT_DECLARATIONS)) {
      expect(d.v, name).toBeGreaterThanOrEqual(1);
      for (const cls of Object.values(d.props)) expect(['none', 'pseudonymous', 'personal']).toContain(cls);
    }
  });

  it('generated doc is current', () => {
    expect(readFileSync(eventsDocPath, 'utf8')).toBe(renderEventsDoc());
  });

  it('row carries the declared version and the event fields', async () => {
    await emit(db, base({ type: 'booking.status_changed', bookingId: 'b1', props: { from: 'held', to: 'cancelled', reason_code: 'guest_cancelled' } }));
    const [row] = await clubEvents();
    expect(row).toMatchObject({ type: 'booking.status_changed', v: EVENT_DECLARATIONS['booking.status_changed'].v, bookingId: 'b1', isTest: true, dataOrigin: 'first_party' });
  });

  it('pax range is coded for props', () => {
    expect(paxRangeCode('2-4')).toBe('p2_4');
    expect(paxRangeCode('5-8')).toBe('p5_8');
    expect(paxRangeCode('9-12')).toBe('p9_12');
    expect(paxRangeCode('13+')).toBe('p13_plus');
  });
});
