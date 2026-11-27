import type { webhook } from '@line/bot-sdk';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { holdTable } from '../src/bookings/service.js';
import { handleEvent } from '../src/bot/flow.js';
import { DETAILS_LINK_MAX_MS } from '../src/bot/links.js';
import { hashStaffLinkCode, issueStaffLinkCode } from '../src/bot/staff-link.js';
import { linkLiffSub } from '../src/data/identity.js';
import type { Db } from '../src/db/client.js';
import { auditLog, clubs, identityMap, type Booking, type Club } from '../src/db/schema.js';
import { DevLineGateway } from '../src/line/gateway.js';
import type { CredentialStore, LoginChannel } from '../src/line/credentials.js';
import { CLUB_B_ID, FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupTwoClubs } from './helpers.js';
import { staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

const config = testConfig({ PUBLIC_URL: 'https://club.test', DEV_SIMULATOR: true });
const OWN_LOGIN: LoginChannel = { channelId: '2000000001', channelSecret: 'own-login-secret', liffId: '2000000001-Own', shared: false };
const SHARED_LOGIN: LoginChannel = { channelId: '2009999999', channelSecret: 'shared-login-secret', liffId: '2009999999-Shared', shared: true };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

/** A credential store that answers `login()` per club id and has no messaging secrets. */
function fakeStore(logins: Record<string, LoginChannel | null>): CredentialStore {
  return {
    channelSecret: async () => null,
    line: async () => null,
    login: async (club) => logins[club.id] ?? null,
  };
}

async function setup(logins: Record<string, LoginChannel | null> = {}, tokens: Record<string, string> = {}) {
  const h = await setupTwoClubs();
  cleanups.push(h.close);
  const clock = { now: FRIDAY_AFTERNOON };
  const verify = vi.fn(async (token: string) => (tokens[token] ? { sub: tokens[token]! } : null));
  const app = createApp(config, h.db, { bot: { now: () => clock.now, log: () => {} }, credentials: fakeStore(logins), verifyIdToken: verify });
  return { ...h, app, clock, verify, db: h.db as Db };
}
type S = Awaited<ReturnType<typeof setup>>;

async function heldBooking(s: S, club: Club, lineUserId: string) {
  const guest = await makeGuest(s.db, { clubId: club.id, lineUserId });
  const tableId = club.id === s.clubA.id ? 'table_demo_B4' : 'table_b_S1';
  const pax = club.id === s.clubA.id ? 6 : 2;
  const booking = await holdTable(s.db, club, { guestId: guest.id, tableId, nightDate: FRIDAY, pax }, s.clock.now);
  const url = new URL(s.app.ctx.deps.links.details(club, booking, s.clock.now));
  return { guest, booking, ref: url.searchParams.get('ref')!, t: url.searchParams.get('t')!, url };
}

const read = (s: S, b: { ref: string; t: string }, idToken?: string) =>
  s.app.app.request(`/api/liff/booking?ref=${encodeURIComponent(b.ref)}&t=${encodeURIComponent(b.t)}`, {
    headers: idToken ? { 'X-Line-Id-Token': idToken } : {},
  });
const submit = (s: S, b: { ref: string; t: string }, idToken?: string, pax = 6) =>
  s.app.app.request('/api/liff/booking/details', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: b.ref, t: b.t, name: 'Ari', phone: '0812345678', nationality: 'Thai', pax, acceptRules: true, viaChat: true, idToken }),
  });
const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error;

describe('guest details link (B5)', () => {
  it('details read needs an ID token', async () => {
    const s = await setup({ club_demo: OWN_LOGIN }, { 'good-token': 'Uowner', 'other-token': 'Usomeoneelse' });
    const b = await heldBooking(s, s.clubA, 'Uowner');
    const none = await read(s, b);
    expect(none.status).toBe(401);
    expect(await errorOf(none)).toBe('login_required');
    const other = await read(s, b, 'other-token');
    expect(other.status).toBe(403);
    expect(await errorOf(other)).toBe('wrong_user');
    expect((await read(s, b, 'good-token')).status).toBe(200);
    expect(s.verify).toHaveBeenCalledWith('good-token', OWN_LOGIN.channelId);
    // The same check guards submit.
    expect((await submit(s, b)).status).toBe(401);
    expect((await submit(s, b, 'other-token')).status).toBe(403);
    expect((await submit(s, b, 'good-token')).status).toBe(200);
  });

  it('SIM- guest reads without a token', async () => {
    const s = await setup();
    const b = await heldBooking(s, s.clubA, 'SIM-guest1');
    expect((await read(s, b)).status).toBe(200);
    expect(s.verify).not.toHaveBeenCalled();
  });

  it('club lookup returns only name, accentColor and liffId', async () => {
    const s = await setup();
    await s.db.update(clubs).set({ liffId: '2000000001-Own' }).where(eq(clubs.id, s.clubA.id));
    const res = await s.app.app.request(`/api/liff/club?club=${s.clubA.slug}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['accentColor', 'liffId', 'name']);
    expect(body).toEqual({ name: s.clubA.name, accentColor: s.clubA.settings.accentColor, liffId: '2000000001-Own' });
    expect((await s.app.app.request('/api/liff/club?club=no-such-club')).status).toBe(404);
    expect((await s.app.app.request('/api/liff/club')).status).toBe(404);
  });

  it('expired link is refused', async () => {
    const s = await setup();
    const b = await heldBooking(s, s.clubA, 'SIM-guest2');
    expect((await read(s, b)).status).toBe(200);
    // The link dies with the hold (10 minutes in the fixture club).
    s.clock.now = new Date(b.booking.holdExpiresAt!.getTime() + 1_000);
    const late = await read(s, b);
    expect(late.status).toBe(410);
    expect(await errorOf(late)).toBe('link_expired');
    expect((await submit(s, b)).status).toBe(410);
    // The expiry is signed: a later expiry with the old signature is not accepted.
    const [, sig] = b.t.split('.');
    const forged = `${Math.ceil((s.clock.now.getTime() + 3_600_000) / 1000).toString(36)}.${sig}`;
    expect((await read(s, { ref: b.ref, t: forged })).status).toBe(404);
    // Never more than 24 hours, even for a longer hold.
    const long = { refCode: b.booking.refCode, holdExpiresAt: new Date(FRIDAY_AFTERNOON.getTime() + 3 * DETAILS_LINK_MAX_MS) } as Pick<Booking, 'refCode' | 'holdExpiresAt'>;
    const t = s.app.ctx.deps.links.detailsToken(long, FRIDAY_AFTERNOON);
    expect(parseInt(t.split('.')[0]!, 36) * 1000).toBe(FRIDAY_AFTERNOON.getTime() + DETAILS_LINK_MAX_MS);
  });

  it('token check runs for clubB with a store-supplied shared channel and no env var', async () => {
    const s = await setup({ [CLUB_B_ID]: SHARED_LOGIN }, { 'tok-b': 'Uprovider-b' });
    expect(s.clubB.lineLoginChannelIdEnv).toBeNull();
    const b = await heldBooking(s, s.clubB, 'Uclubb-webhook-id');
    expect((await read(s, b)).status).toBe(401);
    expect((await read(s, b, 'tok-b')).status).toBe(200);
    expect(s.verify).toHaveBeenCalledWith('tok-b', SHARED_LOGIN.channelId);
    expect((await submit(s, b, 'tok-b', 2)).status).toBe(200);
  });

  it('first use stores the sub pair, and a second token with a different sub returns 403 wrong_user', async () => {
    const s = await setup({ [CLUB_B_ID]: SHARED_LOGIN }, { 'tok-1': 'Psub-1', 'tok-2': 'Psub-2' });
    const b = await heldBooking(s, s.clubB, 'Uclubb-guest');
    expect((await read(s, b, 'tok-1')).status).toBe(200);
    const rows = await s.db.select().from(identityMap).where(eq(identityMap.guestId, b.guest.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clubId: s.clubB.id, platformLineSub: 'Psub-1' });
    const second = await read(s, b, 'tok-2');
    expect(second.status).toBe(403);
    expect(await errorOf(second)).toBe('wrong_user');
    expect((await read(s, b, 'tok-1')).status).toBe(200);
    expect(await s.db.select().from(identityMap)).toHaveLength(1);

    // linkLiffSub directly: the same sub at another club reuses the person id.
    const otherGuest = await makeGuest(s.db, { clubId: s.clubA.id });
    expect(await linkLiffSub(s.db, { clubId: s.clubA.id, guestId: otherGuest.id, sub: 'Psub-1' }, s.clock.now)).toBe('linked');
    expect(await linkLiffSub(s.db, { clubId: s.clubA.id, guestId: otherGuest.id, sub: 'Psub-1' }, s.clock.now)).toBe('match');
    expect(await linkLiffSub(s.db, { clubId: s.clubA.id, guestId: otherGuest.id, sub: 'Psub-9' }, s.clock.now)).toBe('mismatch');
    const both = await s.db.select().from(identityMap).where(eq(identityMap.platformLineSub, 'Psub-1'));
    expect(new Set(both.map((r) => r.personId)).size).toBe(1);
  });

  it('club with its own login channel keeps the direct sub check', async () => {
    const s = await setup({ [CLUB_B_ID]: OWN_LOGIN }, { 'own-good': 'Uclubb-own', 'own-other': 'Unot-them' });
    const b = await heldBooking(s, s.clubB, 'Uclubb-own');
    expect((await read(s, b, 'own-other')).status).toBe(403);
    expect((await read(s, b, 'own-good')).status).toBe(200);
    expect(await s.db.select().from(identityMap)).toHaveLength(0);
  });

  it('real guest at a club with no login channel is refused, never skipped', async () => {
    const s = await setup({}, { 'any-token': 'Ureal' });
    const b = await heldBooking(s, s.clubB, 'Ureal');
    const res = await read(s, b, 'any-token');
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toBe('login_not_configured');
    expect((await submit(s, b, 'any-token', 2)).status).toBe(503);
    expect(s.verify).not.toHaveBeenCalled();
  });
});

// ---------- Staff link code ----------

let eventSeq = 0;
function groupText(groupId: string, text: string): webhook.Event {
  eventSeq += 1;
  return {
    type: 'message',
    mode: 'active',
    timestamp: FRIDAY_AFTERNOON.getTime(),
    webhookEventId: `ev-${eventSeq}`,
    deliveryContext: { isRedelivery: false },
    source: { type: 'group', groupId, userId: 'Usomeone' },
    replyToken: `rt-${eventSeq}`,
    message: { id: `m-${eventSeq}`, type: 'text', text, quoteToken: 'q' },
  } as unknown as webhook.Event;
}

async function typeInGroup(s: S, gw: DevLineGateway, groupId: string, text: string) {
  const club = (await s.db.query.clubs.findFirst({ where: eq(clubs.id, s.clubA.id) }))!;
  await handleEvent(s.app.ctx.deps, club, gw, groupText(groupId, text));
  return (await s.db.query.clubs.findFirst({ where: eq(clubs.id, s.clubA.id) }))!;
}

describe('staff link code (B5)', () => {
  it('link code works once', async () => {
    const s = await setup();
    const gw = new DevLineGateway();
    const { code, expiresAt } = await issueStaffLinkCode(s.db, s.clubA.id, 'user-1', s.clock.now);
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(expiresAt.getTime()).toBe(s.clock.now.getTime() + 10 * 60_000);
    const stored = (await s.db.query.clubs.findFirst({ where: eq(clubs.id, s.clubA.id) }))!;
    expect(stored.staffLinkCodeHash).toBe(hashStaffLinkCode(code));
    expect(stored.staffLinkCodeHash).not.toContain(code);
    expect(stored.staffLinkCode).toBeNull();

    const linked = await typeInGroup(s, gw, 'Cgroup1', `link ${code.toLowerCase()}`);
    expect(linked.staffGroupId).toBe('Cgroup1');
    expect(linked.staffLinkCodeHash).toBeNull();
    // Used once: the same code in another group does nothing.
    const again = await typeInGroup(s, gw, 'Cgroup2', `link ${code}`);
    expect(again.staffGroupId).toBe('Cgroup1');
    expect(again.pendingStaffGroupId).toBeNull();
  });

  it('link code expires after 10 minutes', async () => {
    const s = await setup();
    const gw = new DevLineGateway();
    const { code } = await issueStaffLinkCode(s.db, s.clubA.id, 'user-1', s.clock.now);
    s.clock.now = new Date(s.clock.now.getTime() + 10 * 60_000 + 1_000);
    const club = await typeInGroup(s, gw, 'Cgroup1', `link ${code}`);
    expect(club.staffGroupId).toBeNull();
  });

  it('a first code typed in a new group leaves the old group linked', async () => {
    const s = await setup();
    const gw = new DevLineGateway();
    const reply = vi.spyOn(gw, 'reply');
    await s.db.update(clubs).set({ staffGroupId: 'Cold' }).where(eq(clubs.id, s.clubA.id));
    const { code } = await issueStaffLinkCode(s.db, s.clubA.id, 'user-1', s.clock.now);
    const club = await typeInGroup(s, gw, 'Cnew', `link ${code}`);
    expect(club.staffGroupId).toBe('Cold');
    expect(club.pendingStaffGroupId).toBe('Cnew');
    expect(club.staffLinkCodeHash).toBeNull();
    expect(JSON.stringify(reply.mock.calls)).toContain('Issue link code');
  });

  it('replacing a linked group needs a second dashboard-issued code and notifies the old group', async () => {
    const s = await setup();
    const gw = new DevLineGateway();
    const push = vi.spyOn(gw, 'push');
    await s.db.update(clubs).set({ staffGroupId: 'Cold' }).where(eq(clubs.id, s.clubA.id));
    const cookie = await staffCookie(s.app, s.clubA, 'manager');
    const issue = async () => {
      const res = await s.app.app.request(staffUrl(s.clubA.slug, '/staff-link-code'), { method: 'POST', headers: { cookie } });
      expect(res.status).toBe(200);
      return ((await res.json()) as { code: string }).code;
    };
    const first = await issue();
    expect((await typeInGroup(s, gw, 'Cnew', `link ${first}`)).pendingStaffGroupId).toBe('Cnew');
    const second = await issue();
    const club = await typeInGroup(s, gw, 'Cnew', `link ${second}`);
    expect(club.staffGroupId).toBe('Cnew');
    expect(club.pendingStaffGroupId).toBeNull();
    expect((push.mock.calls as unknown as [string][]).some(([to]) => to === 'Cold')).toBe(true);
    const audit = await s.db.select().from(auditLog).where(and(eq(auditLog.clubId, s.clubA.id), eq(auditLog.action, 'staff_group.replaced')));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).toEqual({ from: 'Cold', to: 'Cnew' });
  });

  it('settings response has no link code', async () => {
    const s = await setup();
    await issueStaffLinkCode(s.db, s.clubA.id, 'user-1', s.clock.now);
    const cookie = await staffCookie(s.app, s.clubA, 'manager');
    const res = await s.app.app.request(staffUrl(s.clubA.slug, '/settings'), { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('staffLinkCode');
    expect(JSON.stringify(body)).not.toMatch(/staffLinkCode/);
    expect(body).toHaveProperty('staffGroupLinked', false);
  });

  it('issue route needs owner or manager, returns the code once, and is audited', async () => {
    const s = await setup();
    const url = staffUrl(s.clubA.slug, '/staff-link-code');
    for (const role of ['host', 'door'] as const) {
      const cookie = await staffCookie(s.app, s.clubA, role);
      expect((await s.app.app.request(url, { method: 'POST', headers: { cookie } })).status).toBe(403);
    }
    for (const role of ['owner', 'manager'] as const) {
      const cookie = await staffCookie(s.app, s.clubA, role);
      const res = await s.app.app.request(url, { method: 'POST', headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { code: string; expiresAt: string };
      expect(body.code).toMatch(/^[A-Z2-9]{8}$/);
      expect(body.expiresAt).toBe(new Date(s.clock.now.getTime() + 10 * 60_000).toISOString());
      const club = (await s.db.query.clubs.findFirst({ where: eq(clubs.id, s.clubA.id) }))!;
      expect(club.staffLinkCodeHash).toBe(hashStaffLinkCode(body.code));
      const settings = await s.app.app.request(staffUrl(s.clubA.slug, '/settings'), { headers: { cookie } });
      expect(await settings.text()).not.toContain(body.code);
      const audit = await s.db.select().from(auditLog).where(and(eq(auditLog.clubId, s.clubA.id), eq(auditLog.action, 'staff_link_code.issued')));
      expect(audit.length).toBeGreaterThan(0);
      expect(JSON.stringify(audit)).not.toContain(body.code);
      expect(audit.at(-1)).toMatchObject({ actorType: 'staff', entity: 'club', entityId: s.clubA.id });
    }
    // Another club's slug is refused for this club's manager.
    const cookie = await staffCookie(s.app, s.clubA, 'manager');
    expect([403, 404]).toContain((await s.app.app.request(staffUrl(s.clubB.slug, '/staff-link-code'), { method: 'POST', headers: { cookie } })).status);
  });
});
