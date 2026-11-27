import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { auditLog, calendarDays, clubProfile, clubs, events, messages, nights, opsEvents, priceRules, tables, users, zones, type Club } from '../src/db/schema.js';
import { newId } from '../src/lib/util.js';
import { base32Decode, base32Encode, totp } from '../src/platform/totp.js';
import { FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { adminCookie, loginAs, makeUser, staffUrl, testConfig, type TestUser } from './helpers/track-a.js';

const TOTP_SECRET = base32Encode(Buffer.from('abcdefghij0123456789'));

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let clubB: Club;
let app: ReturnType<typeof createApp>;
let now: Date;
let manager: TestUser;
let cookie: string;

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
  now = FRIDAY_AFTERNOON;
  app = createApp(testConfig(), db, { bot: { now: () => now, log: () => {} } });
  manager = await makeUser(db, { email: 'manager-a@test.local', clubId: clubA.id, role: 'manager' });
  cookie = await loginAs(app, manager);
});
afterEach(async () => {
  await close();
});

function send(method: string, path: string, body?: unknown, c = cookie) {
  const headers: Record<string, string> = { cookie: c };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const staff = (method: string, path: string, body?: unknown, c = cookie) => send(method, staffUrl(clubA.slug, path), body, c);

const eventsOf = (type: string) => db.select().from(events).where(and(eq(events.clubId, clubA.id), eq(events.type, type)));
const auditOf = (action: string) => db.select().from(auditLog).where(and(eq(auditLog.clubId, clubA.id), eq(auditLog.action, action)));
const loadClub = async () => (await db.query.clubs.findFirst({ where: eq(clubs.id, clubA.id) }))!;

/** Gives the manager a TOTP secret and logs in again (login then asks for the code). */
async function managerWithTotp() {
  await db.update(users).set({ totpSecret: TOTP_SECRET }).where(eq(users.id, manager.id));
  manager = { ...manager, totpSecret: TOTP_SECRET };
  cookie = await loginAs(app, manager);
}
const code = () => totp(base32Decode(TOTP_SECRET), now);

/** The rule of `rules` that covers `date` (valid_to inclusive). */
const ruleOn = (rules: (typeof priceRules.$inferSelect)[], date: string) =>
  rules.find((r) => (!r.validFrom || r.validFrom <= date) && (!r.validTo || r.validTo >= date));

describe('settings (plan A9)', () => {
  it('a settings change emits club.settings_changed', async () => {
    const res = await staff('PATCH', '/settings', { holdMinutes: 15, rules: { en: ['No shorts'], th: ['ห้ามกางเกงขาสั้น'] } });
    expect(res.status).toBe(200);
    const club = await loadClub();
    expect(club.settings.holdMinutes).toBe(15);
    expect(club.settings.rules.en).toEqual(['No shorts']);
    expect(club.settings.rulesVersion).toBe('2026-11-27');
    const [ev] = await eventsOf('club.settings_changed');
    expect(ev).toMatchObject({ actorType: 'staff', actorId: manager.id, dataOrigin: 'first_party' });
    expect(ev!.props).toMatchObject({ fields: 'hold:rules' });
    expect(await auditOf('club.settings_changed')).toHaveLength(1);
  });

  it('the full booking-rules form (every field the web page sends) emits club.settings_changed', async () => {
    // pages/staff/Settings.tsx RulesEditor sends all of these together.
    const res = await staff('PATCH', '/settings', {
      openWeekdays: [3, 4, 5, 6],
      holdMinutes: 15,
      arrivalBy: '23:00',
      bookingWindowDays: 21,
      handoffTimeoutMinutes: 20,
      rules: { en: ['No shorts'], th: ['ห้ามกางเกงขาสั้น'] },
    });
    expect(res.status).toBe(200);
    const [ev] = await eventsOf('club.settings_changed');
    expect(ev!.props).toMatchObject({ fields: 'days:window:hold:arrival:handoff:rules' });
    // Every key the route accepts, at once, still fits the props pattern.
    const all = await staff('PATCH', '/settings', {
      openWeekdays: [3, 4],
      bookingWindowDays: 30,
      holdMinutes: 10,
      arrivalBy: '23:30',
      handoffTimeoutMinutes: 30,
      accentColor: '#112233',
      rules: { en: ['No shorts'], th: ['ห้ามกางเกงขาสั้น'] },
      address: '1 Sukhumvit',
      drinksMenuUrl: 'https://example.com/menu',
    });
    expect(all.status).toBe(200);
    expect(await eventsOf('club.settings_changed')).toHaveLength(2);
  });

  it('a host cannot change settings', async () => {
    const host = await loginAs(app, await makeUser(db, { email: 'host-a@test.local', clubId: clubA.id, role: 'host' }));
    expect((await staff('PATCH', '/settings', { holdMinutes: 15 }, host)).status).toBe(403);
    expect((await loadClub()).settings.holdMinutes).toBe(clubA.settings.holdMinutes);
  });

  it('manager adds a zone and a table, and edits the table', async () => {
    const z = await staff('POST', '/zones', { name: 'Balcony', nameTh: 'ระเบียง', minSpendSatang: 500_000, depositSatang: 100_000 });
    expect(z.status).toBe(201);
    const { id: zoneId } = (await z.json()) as { id: string };
    const t = await staff('POST', '/tables', { code: 'Z9', zoneId, minPax: 2, maxPax: 6 });
    expect(t.status).toBe(201);
    const { id: tableId } = (await t.json()) as { id: string };
    const [row] = await db.select().from(tables).where(eq(tables.id, tableId));
    expect(row).toMatchObject({ clubId: clubA.id, zoneId, code: 'Z9', validFrom: '2026-11-27', active: true });
    expect((await staff('PATCH', `/tables/${tableId}`, { maxPax: 8, active: false })).status).toBe(200);
    const [after] = await db.select().from(tables).where(eq(tables.id, tableId));
    expect(after).toMatchObject({ maxPax: 8, active: false });
    const list = (await (await staff('GET', '/tables')).json()) as { zones: { id: string }[]; tables: { id: string }[] };
    expect(list.zones.map((x) => x.id)).toContain(zoneId);
    expect(list.tables.map((x) => x.id)).toContain(tableId);
  });

  it("a table cannot be put in another club's zone", async () => {
    const res = await staff('POST', '/tables', { code: 'X1', zoneId: 'zone_b_vip', minPax: 2, maxPax: 4 });
    expect(res.status).toBe(404);
    expect(await db.select().from(tables).where(eq(tables.code, 'X1'))).toHaveLength(0);
  });

  it("price change keeps past nights' prices", async () => {
    const [zone] = await db.select().from(zones).where(eq(zones.clubId, clubA.id)).limit(1);
    const first = await staff('PUT', '/prices', { scope: 'zone', scopeId: zone!.id, minSpendSatang: 1_000_000, depositSatang: 300_000 });
    expect(first.status).toBe(200);
    // Next day (Saturday 09:00 Bangkok): a new price for the same zone.
    now = new Date('2026-11-28T02:00:00Z');
    cookie = await loginAs(app, manager);
    expect((await staff('PUT', '/prices', { scope: 'zone', scopeId: zone!.id, minSpendSatang: 1_500_000, depositSatang: 400_000 })).status).toBe(200);
    const rules = await db.select().from(priceRules).where(and(eq(priceRules.clubId, clubA.id), eq(priceRules.scopeId, zone!.id)));
    expect(rules).toHaveLength(2);
    expect(ruleOn(rules, '2026-11-27')).toMatchObject({ minSpendSatang: 1_000_000, depositSatang: 300_000, validFrom: '2026-11-27', validTo: '2026-11-27' });
    expect(ruleOn(rules, '2026-11-28')).toMatchObject({ minSpendSatang: 1_500_000, depositSatang: 400_000, validFrom: '2026-11-28', validTo: null });
    const changed = await eventsOf('club.price_changed');
    expect(changed).toHaveLength(2);
    expect(changed[0]).toMatchObject({ zoneId: zone!.id, actorType: 'staff' });
  });

  it("a second price change on the same day replaces today's rule", async () => {
    const [zone] = await db.select().from(zones).where(eq(zones.clubId, clubA.id)).limit(1);
    await staff('PUT', '/prices', { scope: 'zone', scopeId: zone!.id, minSpendSatang: 1_000_000, depositSatang: 300_000 });
    await staff('PUT', '/prices', { scope: 'zone', scopeId: zone!.id, minSpendSatang: 1_200_000, depositSatang: 300_000 });
    const rules = await db.select().from(priceRules).where(eq(priceRules.scopeId, zone!.id));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ minSpendSatang: 1_200_000, validFrom: '2026-11-27', validTo: null });
  });

  it('PromptPay change needs TOTP and notifies owner', async () => {
    await managerWithTotp();
    const refused = await staff('PUT', '/promptpay', { promptpayId: '0812345678' });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: 'totp_required' });
    expect((await staff('PUT', '/promptpay', { promptpayId: '0812345678', totp: '000000' })).status).toBe(401);
    expect((await loadClub()).promptpayId).toBe(clubA.promptpayId);

    const ok = await staff('PUT', '/promptpay', { promptpayId: '0812345678', promptpayName: 'Club A Co', totp: code() });
    expect(ok.status).toBe(200);
    expect(await loadClub()).toMatchObject({ promptpayId: '0812345678', promptpayName: 'Club A Co' });
    const notices = await db.select().from(messages).where(and(eq(messages.clubId, clubA.id), eq(messages.target, 'staff')));
    expect(notices.map((m) => (m.payload as { text: string }).text).join('\n')).toContain('PromptPay ID changed');
    const [audit] = await auditOf('club.promptpay_changed');
    // Plan A5/A9: the owner notice is the staff-group message plus the before/after audit row.
    expect(audit).toMatchObject({ actorType: 'staff', actorId: manager.id, before: { promptpayId: clubA.promptpayId }, after: { promptpayId: '0812345678' } });
    const [ev] = await eventsOf('club.settings_changed');
    expect(ev!.props).toMatchObject({ fields: 'promptpay' });
  });

  it('a manager with no second factor is refused without counting failures', async () => {
    for (let i = 0; i < 6; i++) {
      const res = await staff('PUT', '/promptpay', { promptpayId: '0812345678', totp: '123456' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'second_factor_not_enrolled' });
    }
    expect((await staff('PUT', '/greeting', { greeting: { en: 'Hi', th: 'สวัสดี' }, totp: '123456' })).status).toBe(403);
    const [u] = await db.select().from(users).where(eq(users.id, manager.id));
    expect(u).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    expect((await loadClub()).promptpayId).toBe(clubA.promptpayId);
    // The session still works.
    expect((await staff('GET', '/settings')).status).toBe(200);
    expect(await (await staff('GET', '/settings')).json()).toMatchObject({ secondFactorEnrolled: false });
  });

  it('greeting change needs TOTP and notifies the staff group', async () => {
    await managerWithTotp();
    expect((await staff('PUT', '/greeting', { greeting: { en: 'Hi', th: 'สวัสดี' } })).status).toBe(401);
    const ok = await staff('PUT', '/greeting', { greeting: { en: 'Hi', th: 'สวัสดี' }, totp: code() });
    expect(ok.status).toBe(200);
    expect((await loadClub()).settings.greeting).toEqual({ en: 'Hi', th: 'สวัสดี' });
    expect(await auditOf('club.greeting_changed')).toHaveLength(1);
  });

  it('creating an event night writes the nights row and emits club.event_night_created', async () => {
    const res = await staff('PUT', '/nights', {
      date: '2026-12-05',
      eventName: 'Techno Saturday',
      eventType: 'guest_dj',
      lineup: ['DJ One', 'DJ Two'],
      eventPrice: { minSpendSatang: 2_500_000, depositSatang: 1_000_000 },
    });
    expect(res.status).toBe(200);
    const [night] = await db.select().from(nights).where(and(eq(nights.clubId, clubA.id), eq(nights.date, '2026-12-05')));
    expect(night).toMatchObject({ status: 'open', eventName: 'Techno Saturday', eventType: 'guest_dj', lineup: ['DJ One', 'DJ Two'], editedBy: manager.id });
    const [ev] = await eventsOf('club.event_night_created');
    expect(ev).toMatchObject({ nightDate: '2026-12-05', actorType: 'staff', actorId: manager.id });
    const [rule] = await db.select().from(priceRules).where(eq(priceRules.nightId, night!.id));
    expect(rule).toMatchObject({ scope: 'club', minSpendSatang: 2_500_000, depositSatang: 1_000_000 });
    // Editing the same night does not create it again.
    expect((await staff('PUT', '/nights', { date: '2026-12-05', eventName: 'Techno Saturday II' })).status).toBe(200);
    expect(await eventsOf('club.event_night_created')).toHaveLength(1);
    const [edited] = await db.select().from(nights).where(eq(nights.id, night!.id));
    expect(edited!.eventName).toBe('Techno Saturday II');
  });

  it('closing a date writes closed_reason', async () => {
    expect((await staff('PUT', '/nights', { date: '2026-12-04', status: 'closed' })).status).toBe(400);
    const res = await staff('PUT', '/nights', { date: '2026-12-04', status: 'closed', closedReason: 'private_event' });
    expect(res.status).toBe(200);
    const [night] = await db.select().from(nights).where(and(eq(nights.clubId, clubA.id), eq(nights.date, '2026-12-04')));
    expect(night).toMatchObject({ status: 'closed', closedReason: 'private_event', editedBy: manager.id });
    const list = (await (await staff('GET', '/nights?from=2026-12-01&days=7')).json()) as { nights: { date: string; status: string }[] };
    expect(list.nights).toContainEqual(expect.objectContaining({ date: '2026-12-04', status: 'closed' }));
  });

  it('a founder edits the event calendar from the console', async () => {
    const admin = await adminCookie(app);
    const res = await send('PUT', `/api/admin/clubs/${clubA.slug}/nights`, { date: '2026-12-12', eventName: 'NYE warm-up', eventType: 'party' }, admin);
    expect(res.status).toBe(200);
    const [night] = await db.select().from(nights).where(and(eq(nights.clubId, clubA.id), eq(nights.date, '2026-12-12')));
    expect(night!.editedBy).toBeTruthy();
    const [ev] = await eventsOf('club.event_night_created');
    expect(ev).toMatchObject({ actorType: 'platform', nightDate: '2026-12-12' });
    const list = (await (await send('GET', `/api/admin/clubs/${clubA.slug}/nights?from=2026-12-10&days=5`, undefined, admin)).json()) as { nights: { date: string }[] };
    expect(list.nights.map((n) => n.date)).toContain('2026-12-12');
    expect((await send('PUT', `/api/admin/clubs/nope/nights`, { date: '2026-12-12', status: 'open' }, admin)).status).toBe(404);
  });

  it('an election day entered from the console appears in calendar_days', async () => {
    const admin = await adminCookie(app);
    const body = { date: '2027-03-29', kind: 'election', name: 'General election' };
    const res = await send('POST', '/api/admin/calendar-days', body, admin);
    expect(res.status).toBe(200);
    expect((await send('POST', '/api/admin/calendar-days', body, admin)).status).toBe(200);
    const rows = await db.select().from(calendarDays).where(eq(calendarDays.date, '2027-03-29'));
    expect(rows).toEqual([expect.objectContaining({ kind: 'election', name: 'General election' })]);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'platform.calendar_day_set'));
    expect(audit).toMatchObject({ clubId: null, actorType: 'platform', entity: 'calendar_days' });
    expect((await send('POST', '/api/admin/calendar-days', { ...body, kind: 'public_holiday' }, admin)).status).toBe(400);
    expect((await send('POST', '/api/admin/calendar-days', { ...body, date: '2027-02-30' }, admin)).status).toBe(400);
    expect((await send('POST', '/api/admin/calendar-days', body, cookie)).status).toBe(403);
  });

  it('profile edit is saved and audited', async () => {
    const res = await staff('PUT', '/profile', { capacityStanding: 400, genres: ['techno', 'house'], usualPeakHour: 1 });
    expect(res.status).toBe(200);
    const profile = await db.query.clubProfile.findFirst({ where: eq(clubProfile.clubId, clubA.id) });
    expect(profile).toMatchObject({ capacityStanding: 400, genres: ['techno', 'house'], usualPeakHour: 1 });
    const [audit] = await auditOf('club.profile_changed');
    expect(audit).toMatchObject({ actorType: 'staff', actorId: manager.id, entity: 'club_profile' });
    expect((await staff('PUT', '/profile', { usualPeakHour: 30 })).status).toBe(400);
  });

  it('quota warning shows at 80% used', async () => {
    const setup = (used: number, at: Date) =>
      db.insert(opsEvents).values({ id: newId(), clubId: clubA.id, kind: 'line_setup', detail: { report: { ok: true, steps: [] }, quota: { used, limit: 1000 } }, at });
    expect(await (await staff('GET', '/quota')).json()).toMatchObject({ quota: null });
    await setup(790, new Date('2026-11-27T01:00:00Z'));
    expect(await (await staff('GET', '/quota')).json()).toMatchObject({ quota: { used: 790, limit: 1000, warn: false } });
    await setup(800, new Date('2026-11-27T02:00:00Z'));
    expect(await (await staff('GET', '/quota')).json()).toMatchObject({ quota: { used: 800, limit: 1000, pct: 80, warn: true } });
  });

  it("another club's zone or table id answers 404", async () => {
    expect((await staff('PATCH', '/zones/zone_b_vip', { name: 'Hijack' })).status).toBe(404);
    expect((await staff('PATCH', '/tables/table_b_V1', { maxPax: 99 })).status).toBe(404);
    const [b] = await db.select().from(tables).where(eq(tables.id, 'table_b_V1'));
    expect(b!.maxPax).toBe(12);
    void clubB;
  });
});
