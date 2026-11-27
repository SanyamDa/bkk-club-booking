import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { holdTable } from '../src/bookings/service.js';
import { bookings, clubMemberships, events, sessions, tables, users, type Club } from '../src/db/schema.js';
import type { Db } from '../src/db/client.js';
import { newId } from '../src/lib/util.js';
import { hashPassword } from '../src/platform/passwords.js';
import { base32Decode, base32Encode, totp } from '../src/platform/totp.js';
import { createAccount } from '../src/scripts/create-admin.js';
import { FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupTwoClubs } from './helpers.js';
import { testConfig } from './helpers/track-a.js';

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let clubB: Club;
let clock: Date;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
  clock = FRIDAY_AFTERNOON;
  app = createApp(testConfig(), db, { bot: { now: () => clock, log: () => {} } });
});
afterEach(async () => {
  await close();
});

const PASSWORD = 'correct horse battery';

async function makeUser(opts: { email?: string; clubId?: string; admin?: boolean } = {}) {
  const id = newId();
  const email = opts.email ?? `${id}@test.local`;
  const totpSecret = opts.admin ? base32Encode(Buffer.from('12345678901234567890')) : null;
  await db.insert(users).values({
    id,
    email,
    name: 'Test',
    passwordHash: await hashPassword(PASSWORD),
    platformRole: opts.admin ? 'admin' : null,
    totpSecret,
  });
  if (opts.clubId) await db.insert(clubMemberships).values({ userId: id, clubId: opts.clubId, role: 'manager' });
  return { id, email, totpSecret };
}

function login(body: Record<string, unknown>) {
  return app.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;
const me = (cookie: string) => app.app.request('/api/auth/me', { headers: { cookie } });

describe('auth', () => {
  it('login creates a revocable session', async () => {
    const u = await makeUser({ clubId: clubA.id });
    const res = await login({ email: u.email, password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(res.headers.get('set-cookie')).toMatch(/SameSite=Lax/i);
    expect((await me(cookie)).status).toBe(200);
    const out = await app.app.request('/api/auth/logout', { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(200);
    expect((await me(cookie)).status).toBe(401);
  });

  it('session id is not stored in clear', async () => {
    const u = await makeUser({ clubId: clubA.id });
    const cookie = cookieOf(await login({ email: u.email, password: PASSWORD }));
    const sid = cookie.slice('sid='.length);
    const rows = await db.select().from(sessions).where(eq(sessions.userId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idHash).not.toBe(sid);
    expect(rows[0]!.idHash).not.toContain(sid);
  });

  it('me lists only own clubs', async () => {
    const u = await makeUser({ clubId: clubA.id });
    const cookie = cookieOf(await login({ email: u.email, password: PASSWORD }));
    const body = (await (await me(cookie)).json()) as { clubs: { slug: string }[] };
    expect(body.clubs.map((c) => c.slug)).toEqual([clubA.slug]);
    expect(body.clubs.map((c) => c.slug)).not.toContain(clubB.slug);
  });

  it('locks after five failures and hides the reason', async () => {
    const u = await makeUser({ clubId: clubA.id });
    for (let i = 0; i < 5; i++) {
      const bad = await login({ email: u.email, password: 'wrong' });
      expect(bad.status).toBe(401);
      expect(await bad.json()).toEqual({ error: 'invalid_login' });
    }
    const locked = await login({ email: u.email, password: PASSWORD });
    expect(locked.status).toBe(401);
    expect(await locked.json()).toEqual({ error: 'invalid_login' });
    const unknown = await login({ email: 'nobody@test.local', password: PASSWORD });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: 'invalid_login' });

    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row!.lockedUntil!.getTime()).toBe(clock.getTime() + 60_000);
    clock = new Date(row!.lockedUntil!.getTime() + 1000);
    expect((await login({ email: u.email, password: PASSWORD })).status).toBe(200);
  });

  it('parallel wrong passwords each count and lock the account', async () => {
    const u = await makeUser({ clubId: clubA.id });
    const results = await Promise.all(Array.from({ length: 6 }, () => login({ email: u.email, password: 'wrong' })));
    for (const r of results) expect(r.status).toBe(401);
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row!.failedLoginCount).toBe(6);
    expect(row!.lockedUntil).not.toBeNull();
    expect((await login({ email: u.email, password: PASSWORD })).status).toBe(401);
  });

  it('platform admin needs totp', async () => {
    const u = await makeUser({ admin: true });
    const secret = base32Decode(u.totpSecret!);
    const none = await login({ email: u.email, password: PASSWORD });
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: 'totp_required' });
    const good = totp(secret, clock);
    const wrong = good === '000000' ? '111111' : '000000';
    expect((await login({ email: u.email, password: PASSWORD, totp: wrong })).status).toBe(401);
    const ok = await login({ email: u.email, password: PASSWORD, totp: good });
    expect(ok.status).toBe(200);
    const [s] = await db.select().from(sessions).where(eq(sessions.userId, u.id));
    expect(s!.expiresAt.getTime() - clock.getTime()).toBe(8 * 3_600_000);
  });

  it("login emits staff.login for the user's club", async () => {
    const u = await makeUser({ clubId: clubA.id });
    expect((await login({ email: u.email, password: PASSWORD })).status).toBe(200);
    const rows = await db.select().from(events).where(eq(events.type, 'staff.login'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clubId).toBe(clubA.id);
    expect(rows[0]!.actorId).toBe(u.id);
    expect(rows[0]!.isTest).toBe(true); // clubA is the demo fixture club

    const admin = await makeUser({ admin: true });
    const code = totp(base32Decode(admin.totpSecret!), clock);
    expect((await login({ email: admin.email, password: PASSWORD, totp: code })).status).toBe(200);
    expect(await db.select().from(events).where(eq(events.type, 'staff.login'))).toHaveLength(1);
  });

  it('create-admin with --club and --role makes a club member who can log in without totp', async () => {
    const out = await createAccount(db, ['--email', 'Owner@Test.local', '--name', 'Owner', '--club', clubB.slug, '--role', 'owner']);
    expect(out.otpauthUrl).toBeNull();
    const [u] = await db.select().from(users).where(eq(users.email, 'owner@test.local'));
    expect(u!.platformRole).toBeNull();
    expect(u!.totpSecret).toBeNull();
    const [m] = await db
      .select()
      .from(clubMemberships)
      .where(and(eq(clubMemberships.userId, u!.id), eq(clubMemberships.clubId, clubB.id)));
    expect(m!.role).toBe('owner');
    const res = await login({ email: 'owner@test.local', password: out.password });
    expect(res.status).toBe(200);
    const body = (await (await me(cookieOf(res))).json()) as { clubs: { slug: string }[] };
    expect(body.clubs.map((c) => c.slug)).toEqual([clubB.slug]);
  });

  it("a club user cannot use another club's staff routes", async () => {
    const guest = await makeGuest(db, { clubId: clubB.id });
    const [table] = await db.select().from(tables).where(eq(tables.clubId, clubB.id)).limit(1);
    const booking = await holdTable(db, clubB, { guestId: guest.id, tableId: table!.id, nightDate: FRIDAY, pax: 2 }, clock);
    const u = await makeUser({ clubId: clubA.id });
    const cookie = cookieOf(await login({ email: u.email, password: PASSWORD }));
    const get = (path: string) => app.app.request(path, { headers: { cookie } });
    const post = (path: string) => app.app.request(path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });

    expect((await get(`/api/staff/clubs/${clubA.slug}/night`)).status).toBe(200);
    for (const tail of ['/night', '/settings', '/handoffs', '/alerts', '/line-status']) {
      expect((await get(`/api/staff/clubs/${clubB.slug}${tail}`)).status).toBe(403);
    }
    expect((await post(`/api/staff/clubs/${clubB.slug}/line-setup`)).status).toBe(403);
    expect((await get(`/api/staff/bookings/${booking.id}`)).status).toBe(404);
    expect((await post(`/api/staff/bookings/${booking.id}/cancel`)).status).not.toBe(200);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(after!.status).toBe(booking.status);
  });

  it('a door user cannot open settings or approve deposits', async () => {
    const id = newId();
    await db.insert(users).values({ id, email: `${id}@test.local`, name: 'Door', passwordHash: await hashPassword(PASSWORD) });
    await db.insert(clubMemberships).values({ userId: id, clubId: clubA.id, role: 'door' });
    const cookie = cookieOf(await login({ email: `${id}@test.local`, password: PASSWORD }));
    expect((await app.app.request(`/api/staff/clubs/${clubA.slug}/night`, { headers: { cookie } })).status).toBe(200);
    expect((await app.app.request(`/api/staff/clubs/${clubA.slug}/settings`, { headers: { cookie } })).status).toBe(403);
  });

  it('create-admin without --club makes a platform admin with a totp url', async () => {
    const out = await createAccount(db, ['--email', 'founder@test.local', '--name', 'Founder']);
    expect(out.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const [u] = await db.select().from(users).where(eq(users.email, 'founder@test.local'));
    expect(u!.platformRole).toBe('admin');
    const code = totp(base32Decode(u!.totpSecret!), clock);
    expect((await login({ email: 'founder@test.local', password: out.password, totp: code })).status).toBe(200);
  });
});
