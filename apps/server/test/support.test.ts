import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { holdTable, recordSlip, requestDeposit, submitDetails } from '../src/bookings/service.js';
import type { Db } from '../src/db/client.js';
import { auditLog, bookings, clubs, conversations, messages, platformFlags, type Club } from '../src/db/schema.js';
import { newId } from '../src/lib/util.js';
import { dataRoutes } from '../src/http/admin/data.js';
import { debugRoutes } from '../src/http/admin/debug.js';
import { supportRoutes } from '../src/http/admin/support.js';
import { isGloballyStopped } from '../src/platform/support.js';
import { FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupTwoClubs } from './helpers.js';
import { adminCookie, staffUrl, testConfig } from './helpers/track-a.js';

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let clock: Date;

/** The app with the A5 support/debug/data routers in front, independent of `http/admin/index.ts`. */
function supportApp() {
  const created = createApp(testConfig(), db, { bot: { now: () => clock, log: () => {} } });
  const h = new Hono();
  h.route('/api/admin', supportRoutes(created.ctx));
  h.route('/api/admin', debugRoutes(created.ctx));
  h.route('/api/admin', dataRoutes(created.ctx));
  h.all('*', (c) => created.app.fetch(c.req.raw));
  return { app: h, ctx: created.ctx, settle: created.settle };
}
let app: ReturnType<typeof supportApp>;

beforeEach(async () => {
  ({ db, close, clubA } = await setupTwoClubs());
  clock = FRIDAY_AFTERNOON;
  app = supportApp();
});
afterEach(async () => {
  await app.settle();
  await close();
});

const json = (cookie: string, body: unknown) => ({
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const minutes = (n: number) => new Date(FRIDAY_AFTERNOON.getTime() + n * 60_000);

async function startSession(cookie: string, club: Club, reason = 'Club asked why a booking is stuck') {
  const res = await app.app.request('/api/admin/support', json(cookie, { clubSlug: club.slug, reason, ticketRef: 'T-1' }));
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; mode: string; expiresAt: string };
}

describe('support sessions', () => {
  it('grant expires after 60 minutes', async () => {
    const cookie = await adminCookie(app);
    const grant = await startSession(cookie, clubA);
    expect(grant.mode).toBe('read');
    expect(grant.expiresAt).toBe(minutes(60).toISOString());

    // No grant, no access: a platform admin is not a club member.
    const other = await app.app.request(staffUrl('test-b', '/night'), { headers: { cookie } });
    expect(other.status).toBe(403);

    clock = minutes(59);
    const ok = await app.app.request(staffUrl(clubA.slug, '/night'), { headers: { cookie } });
    expect(ok.status).toBe(200);
    // 08:00Z + 60 min = 16:00 Bangkok.
    expect(decodeURIComponent(ok.headers.get('X-Support-Session')!)).toBe(`${clubA.name}, ends 16:00`);

    clock = minutes(61);
    const late = await app.app.request(staffUrl(clubA.slug, '/night'), { headers: { cookie } });
    expect(late.status).toBe(403);
  });

  it('read-only grant cannot write', async () => {
    const guest = await makeGuest(db);
    const b = await holdTable(db, clubA, { guestId: guest.id, tableId: 'table_demo_B2', nightDate: FRIDAY, pax: 6 }, clock);
    await submitDetails(db, clubA, b.id, { name: 'Ari', phone: '0812345678', nationality: 'Thai', pax: 6 }, clock);
    await requestDeposit(db, clubA, b.id, clock);
    await recordSlip(db, clubA, b.id, 'uploads/x.jpg', clock);

    const cookie = await adminCookie(app);
    const grant = await startSession(cookie, clubA);
    const approve = () => app.app.request(staffUrl(clubA.slug, `/bookings/${b.id}/approve`), json(cookie, {}));

    const refused = await approve();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'support_read_only' });
    const [still] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(still!.status).toBe('payment_review');

    const elevated = await app.app.request(`/api/admin/support/${grant.id}/elevate`, json(cookie, { reason: 'Approve the slip the club sent us' }));
    expect(elevated.status).toBe(200);
    expect(((await elevated.json()) as { mode: string }).mode).toBe('write');

    const ok = await approve();
    expect(ok.status).toBe(200);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe('confirmed');
  });

  it('a write-mode grant cannot reply to a guest', async () => {
    const guest = await makeGuest(db, { clubId: clubA.id });
    const [conv] = await db.insert(conversations).values({ id: newId(), clubId: clubA.id, guestId: guest.id, mode: 'human' }).returning();
    const cookie = await adminCookie(app);
    const grant = await startSession(cookie, clubA);
    const elevated = await app.app.request(`/api/admin/support/${grant.id}/elevate`, json(cookie, { reason: 'Fix the settings the club asked about' }));
    expect(elevated.status).toBe(200);
    const res = await app.app.request(staffUrl(clubA.slug, `/conversations/${conv!.id}/reply`), json(cookie, { text: 'Hello from the platform' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'support_no_guest_messages' });
    const out = await db.select().from(messages).where(and(eq(messages.clubId, clubA.id), eq(messages.direction, 'out')));
    expect(out).toHaveLength(0);
  });

  it('a club with a Thai name still gets the banner header', async () => {
    await db.update(clubs).set({ name: 'คลับทดสอบ 🎶' }).where(eq(clubs.id, clubA.id));
    const cookie = await adminCookie(app);
    await startSession(cookie, clubA);
    const res = await app.app.request(staffUrl(clubA.slug, '/night'), { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(decodeURIComponent(res.headers.get('X-Support-Session')!)).toBe('คลับทดสอบ 🎶, ends 16:00');
  });

  it('every request under a grant is audited', async () => {
    const cookie = await adminCookie(app);
    const grant = await startSession(cookie, clubA, 'Checking tonight for the manager');
    const res = await app.app.request(staffUrl(clubA.slug, '/night'), { headers: { cookie } });
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.supportGrantId, grant.id), eq(auditLog.action, 'support.request')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clubId: clubA.id,
      actorType: 'platform',
      supportGrantId: grant.id,
      reason: 'Checking tonight for the manager',
    });
    expect(rows[0]!.data).toMatchObject({ method: 'GET', path: `/api/staff/clubs/${clubA.slug}/night` });
  });

  it('an ended session opens nothing', async () => {
    const cookie = await adminCookie(app);
    const grant = await startSession(cookie, clubA);
    const end = await app.app.request(`/api/admin/support/${grant.id}/end`, json(cookie, {}));
    expect(end.status).toBe(200);
    const res = await app.app.request(staffUrl(clubA.slug, '/night'), { headers: { cookie } });
    expect(res.status).toBe(403);
  });

  it('isGloballyStopped reads platform_flags global_stop', async () => {
    expect(await isGloballyStopped(db)).toBe(false);
    await db.insert(platformFlags).values({ key: 'global_stop', value: { stopped: true } });
    expect(await isGloballyStopped(db)).toBe(true);
    await db.update(platformFlags).set({ value: false }).where(eq(platformFlags.key, 'global_stop'));
    expect(await isGloballyStopped(db)).toBe(false);
  });
});
