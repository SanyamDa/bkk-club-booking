import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { holdTable } from '../src/bookings/service.js';
import { emit, type EventInput } from '../src/data/events.js';
import { hashPhone, linkLiffSub, linkPhone, normalizePhone, personIdOf, phoneHashKey } from '../src/data/identity.js';
import { removeGuest } from '../src/data/removal.js';
import type { Db } from '../src/db/client.js';
import { events, guests, identityMap, type Club } from '../src/db/schema.js';
import { FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupTwoClubs } from './helpers.js';
import { testConfig } from './helpers/track-a.js';

const config = testConfig({ PUBLIC_URL: 'https://club.test', DEV_SIMULATOR: true });
const key = phoneHashKey(config.CREDENTIALS_KEY);
const now = FRIDAY_AFTERNOON;
const later = new Date(now.getTime() + 60_000);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function setup() {
  const h = await setupTwoClubs();
  cleanups.push(h.close);
  return { ...h, db: h.db as Db };
}
type S = Awaited<ReturnType<typeof setup>>;

function guestEvent(club: Club, guestId: string, dataOrigin: EventInput['dataOrigin'] = 'first_party'): EventInput {
  return { clubId: club.id, type: 'guest.first_seen', occurredAt: now, actorType: 'guest', actorId: guestId, channel: dataOrigin === 'instagram' ? 'instagram' : 'line', dataOrigin, guestId, isTest: false };
}
const eventsOf = (s: S, guestId: string) => s.db.select().from(events).where(eq(events.guestId, guestId));

describe('cross-club identity map (B20)', () => {
  it('same LINE person at two clubs gets one person_id', async () => {
    const s = await setup();
    const a = await makeGuest(s.db, { clubId: s.clubA.id });
    const b = await makeGuest(s.db, { clubId: s.clubB.id });
    expect(await linkLiffSub(s.db, { clubId: s.clubA.id, guestId: a.id, sub: 'Pperson-1' }, now)).toBe('linked');
    expect(await linkLiffSub(s.db, { clubId: s.clubB.id, guestId: b.id, sub: 'Pperson-1' }, later)).toBe('linked');
    const pa = await personIdOf(s.db, s.clubA.id, a.id);
    expect(pa).toBeTruthy();
    expect(await personIdOf(s.db, s.clubB.id, b.id)).toBe(pa);
    const c = await makeGuest(s.db, { clubId: s.clubB.id });
    await linkLiffSub(s.db, { clubId: s.clubB.id, guestId: c.id, sub: 'Pperson-2' }, later);
    expect(await personIdOf(s.db, s.clubB.id, c.id)).not.toBe(pa);
  });

  it('the same phone hash at two clubs links to one person_id', async () => {
    const s = await setup();
    const a = await makeGuest(s.db, { clubId: s.clubA.id });
    const b = await makeGuest(s.db, { clubId: s.clubB.id });
    const first = await linkPhone(s.db, { clubId: s.clubA.id, guestId: a.id, phone: '081-234-5678' }, key, now);
    const second = await linkPhone(s.db, { clubId: s.clubB.id, guestId: b.id, phone: '+66 81 234 5678' }, key, later);
    expect(first?.personId).toBeTruthy();
    expect(second?.personId).toBe(first!.personId);
    const rows = await s.db.select().from(identityMap);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.phoneHash))).toEqual(new Set([hashPhone(key, '0812345678')]));
    // A different number is a different person; a number that does not normalise links nothing.
    const c = await makeGuest(s.db, { clubId: s.clubB.id });
    expect((await linkPhone(s.db, { clubId: s.clubB.id, guestId: c.id, phone: '0899999999' }, key, later))?.personId).not.toBe(first!.personId);
    const d = await makeGuest(s.db, { clubId: s.clubB.id });
    expect(await linkPhone(s.db, { clubId: s.clubB.id, guestId: d.id, phone: '123' }, key, later)).toBeNull();
    expect(await personIdOf(s.db, s.clubB.id, d.id)).toBeNull();
  });

  it('phone numbers are normalised before hashing and the raw number is never stored', async () => {
    expect(normalizePhone('081-234-5678')).toBe('+66812345678');
    expect(normalizePhone('(081) 234 5678')).toBe('+66812345678');
    expect(normalizePhone('66812345678')).toBe('+66812345678');
    expect(normalizePhone('+66 81 234 5678')).toBe('+66812345678');
    expect(normalizePhone('+66 081 234 5678')).toBe('+66812345678');
    expect(normalizePhone('0066812345678')).toBe('+66812345678');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('12')).toBeNull();
    // The Thai local rule is 9 or 10 digits after the 0; 8 after the 0 is not read as Thai.
    expect(normalizePhone('021234567')).not.toBe('+6621234567');
    expect(normalizePhone('0212345678')).toBe('+66212345678');
    expect(hashPhone(key, '081-234-5678')).toBe(hashPhone(key, '+66812345678'));
    // Keyed: another key gives another hash.
    expect(hashPhone(phoneHashKey(Buffer.alloc(32, 0xab)), '0812345678')).not.toBe(hashPhone(key, '0812345678'));

    const s = await setup();
    const a = await makeGuest(s.db, { clubId: s.clubA.id });
    await linkPhone(s.db, { clubId: s.clubA.id, guestId: a.id, phone: '0812345678' }, key, now);
    const dump = JSON.stringify(await s.db.select().from(identityMap));
    expect(dump).not.toContain('812345678');
  });

  it('a phone link and a sub link of two persons merge into the earlier person, events included', async () => {
    const s = await setup();
    // Club A: the guest is known by LINE sub first (person P1).
    const a = await makeGuest(s.db, { clubId: s.clubA.id });
    await linkLiffSub(s.db, { clubId: s.clubA.id, guestId: a.id, sub: 'Pmerge' }, now);
    const p1 = (await personIdOf(s.db, s.clubA.id, a.id))!;
    await emit(s.db, guestEvent(s.clubA, a.id));
    // Club B: the same human is first known by phone (person P2), and club A's guest gives that phone too.
    const b = await makeGuest(s.db, { clubId: s.clubB.id });
    const p2 = (await linkPhone(s.db, { clubId: s.clubB.id, guestId: b.id, phone: '0811111111' }, key, later))!.personId;
    expect(p2).not.toBe(p1);
    await emit(s.db, guestEvent(s.clubB, b.id));
    expect((await eventsOf(s, b.id))[0]!.personId).toBe(p2);

    const merged = await linkPhone(s.db, { clubId: s.clubA.id, guestId: a.id, phone: '081 111 1111' }, key, later);
    expect(merged?.personId).toBe(p1);
    expect(await personIdOf(s.db, s.clubB.id, b.id)).toBe(p1);
    expect((await eventsOf(s, b.id)).every((e) => e.personId === p1)).toBe(true);
    expect((await eventsOf(s, a.id)).every((e) => e.personId === p1)).toBe(true);

    // The sub side merges too: a phone-only row whose sub is filled joins the sub's person.
    const c = await makeGuest(s.db, { clubId: s.clubB.id });
    const p3 = (await linkPhone(s.db, { clubId: s.clubB.id, guestId: c.id, phone: '0822222222' }, key, later))!.personId;
    expect(p3).not.toBe(p1);
    expect(await linkLiffSub(s.db, { clubId: s.clubB.id, guestId: c.id, sub: 'Pmerge' }, later)).toBe('linked');
    expect(await personIdOf(s.db, s.clubB.id, c.id)).toBe(p1);
    expect(new Set((await s.db.select().from(identityMap)).map((r) => r.personId))).toEqual(new Set([p1]));
  });

  it('events of a linked guest carry person_id, past and future; Instagram events never do', async () => {
    const s = await setup();
    const a = await makeGuest(s.db, { clubId: s.clubA.id });
    await emit(s.db, guestEvent(s.clubA, a.id));
    await emit(s.db, { ...guestEvent(s.clubA, a.id, 'instagram'), type: 'message.received' });
    expect((await eventsOf(s, a.id)).every((e) => e.personId === null)).toBe(true);

    const { personId } = (await linkPhone(s.db, { clubId: s.clubA.id, guestId: a.id, phone: '0833333333' }, key, now))!;
    await emit(s.db, { ...guestEvent(s.clubA, a.id), type: 'message.received' });
    await emit(s.db, { ...guestEvent(s.clubA, a.id, 'instagram'), type: 'message.sent' });
    const rows = await eventsOf(s, a.id);
    expect(rows).toHaveLength(4);
    for (const e of rows) expect(e.personId).toBe(e.dataOrigin === 'instagram' ? null : personId);
    // An event with no guest has no person.
    await emit(s.db, { clubId: s.clubA.id, type: 'guest.first_seen', occurredAt: now, actorType: 'system', dataOrigin: 'first_party', isTest: false, dedupeKey: 'no-guest' });
    const [noGuest] = await s.db.select().from(events).where(eq(events.dedupeKey, 'no-guest'));
    expect(noGuest!.personId).toBeNull();
  });

  it('submitting the booking form stores the phone link; a test guest is not linked', async () => {
    const s = await setup();
    const { app, ctx } = createApp(config, s.db, { bot: { now: () => now, log: () => {} } });
    async function submitAs(club: Club, tableId: string, pax: number, isTest: boolean) {
      const guest = await makeGuest(s.db, { clubId: club.id, lineUserId: `SIM-b20-${club.id}-${isTest}` });
      if (isTest) await s.db.update(guests).set({ isTest: true }).where(eq(guests.id, guest.id));
      const booking = await holdTable(s.db, club, { guestId: guest.id, tableId, nightDate: FRIDAY, pax }, now);
      const url = new URL(ctx.deps.links.details(club, booking, now));
      const res = await app.request('/api/liff/booking/details', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: url.searchParams.get('ref'), t: url.searchParams.get('t'), name: 'Ari', phone: '081 234 5678', nationality: 'Thai', pax, acceptRules: true, viaChat: true }),
      });
      expect(res.status).toBe(200);
      return guest;
    }
    const a = await submitAs(s.clubA, 'table_demo_B4', 6, false);
    const b = await submitAs(s.clubB, 'table_b_S1', 2, false);
    const pa = await personIdOf(s.db, s.clubA.id, a.id);
    expect(pa).toBeTruthy();
    expect(await personIdOf(s.db, s.clubB.id, b.id)).toBe(pa);
    const [row] = await s.db.select().from(identityMap).where(eq(identityMap.guestId, a.id));
    expect(row!.phoneHash).toBe(hashPhone(key, '0812345678'));
    // The details.submitted event already carries the person (backfilled at link time).
    expect((await eventsOf(s, a.id)).filter((e) => e.type === 'details.submitted').every((e) => e.personId === pa)).toBe(true);

    const testGuest = await submitAs(s.clubA, 'table_demo_B2', 6, true);
    expect(await personIdOf(s.db, s.clubA.id, testGuest.id)).toBeNull();
  });

  it('removal (B10b) deletes the links and leaves the other club\'s link', async () => {
    const s = await setup();
    const a = await makeGuest(s.db, { clubId: s.clubA.id });
    const b = await makeGuest(s.db, { clubId: s.clubB.id });
    await linkLiffSub(s.db, { clubId: s.clubA.id, guestId: a.id, sub: 'Premove' }, now);
    await linkPhone(s.db, { clubId: s.clubA.id, guestId: a.id, phone: '0844444444' }, key, now);
    const { personId } = (await linkPhone(s.db, { clubId: s.clubB.id, guestId: b.id, phone: '0844444444' }, key, later))!;
    await emit(s.db, guestEvent(s.clubA, a.id));
    const [before] = await eventsOf(s, a.id);
    expect(before!.personId).toBe(personId);

    await removeGuest(s.db, s.clubA.id, a.id, later);
    expect(await s.db.select().from(identityMap).where(eq(identityMap.guestId, a.id))).toHaveLength(0);
    const [after] = await s.db.select().from(events).where(eq(events.id, before!.id));
    expect(after!.personId).toBeNull();
    expect(await personIdOf(s.db, s.clubB.id, b.id)).toBe(personId);
  });
});
