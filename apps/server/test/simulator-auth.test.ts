import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { events, guests, messages, type Club } from '../src/db/schema.js';
import { SIM_USER_PREFIX } from '../src/line/gateway.js';
import { FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { adminCookie, staffCookie, testConfig } from './helpers/track-a.js';

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let clubB: Club;

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
});
afterEach(async () => {
  await close();
});

function makeApp(devSimulator: boolean) {
  return createApp(testConfig({ DEV_SIMULATOR: devSimulator }), db, { bot: { now: () => FRIDAY_AFTERNOON, log: () => {} } });
}

function post(app: ReturnType<typeof makeApp>, path: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return app.app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

function get(app: ReturnType<typeof makeApp>, path: string, cookie?: string) {
  return app.app.request(path, cookie ? { headers: { cookie } } : {});
}

describe('simulator behind admin login (B8)', () => {
  it('simulator routes need platform-admin login', async () => {
    const app = makeApp(true);
    const staff = await staffCookie(app, clubA, 'owner');
    const admin = await adminCookie(app);
    const event = { userId: 'auth1', type: 'text', text: 'hello' };
    for (const base of ['/api/admin/sim', '/api/dev']) {
      expect((await post(app, `${base}/${clubA.slug}/event`, event)).status, `${base} event, no login`).toBe(401);
      expect((await get(app, `${base}/${clubA.slug}/transcript?userId=auth1`)).status, `${base} transcript, no login`).toBe(401);
      expect((await post(app, `${base}/${clubA.slug}/event`, event, staff)).status, `${base} event, club owner`).toBe(403);
      expect((await get(app, `${base}/${clubA.slug}/transcript?userId=auth1`, staff)).status, `${base} transcript, club owner`).toBe(403);
    }
    // Nothing ran for the refused calls.
    expect(await db.select().from(guests).where(eq(guests.lineUserId, `${SIM_USER_PREFIX}auth1`))).toEqual([]);
    expect((await post(app, `/api/admin/sim/${clubA.slug}/event`, event, admin)).status).toBe(200);
    expect((await get(app, `/api/admin/sim/${clubA.slug}/transcript?userId=auth1`, admin)).status).toBe(200);
  });

  it('simulator runs against any club and marks rows test', async () => {
    const app = makeApp(true);
    const admin = await adminCookie(app);
    // clubB is a `live` club: its guests are real unless they came from the simulator.
    const res = await post(app, `/api/admin/sim/${clubB.slug}/event`, { userId: 'live1', displayName: 'Sim', type: 'text', text: 'hi' }, admin);
    expect(res.status).toBe(200);
    const [guest] = await db
      .select()
      .from(guests)
      .where(and(eq(guests.clubId, clubB.id), eq(guests.lineUserId, `${SIM_USER_PREFIX}live1`)));
    expect(guest).toBeDefined();
    expect(guest!.isTest).toBe(true);
    expect(guest!.displayName).toBe('Sim');
    // The bot created the guest, so the simulator guest gets its first-seen event, as a test row.
    const seen = await db.select().from(events).where(and(eq(events.guestId, guest!.id), eq(events.type, 'guest.first_seen')));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.isTest).toBe(true);
    const rows = await db.select().from(messages).where(eq(messages.guestId, guest!.id));
    expect(rows.some((m) => m.direction === 'in')).toBe(true);
    expect(rows.some((m) => m.direction === 'out')).toBe(true);

    const t = await get(app, `/api/admin/sim/${clubB.slug}/transcript?userId=live1`, admin);
    expect(t.status).toBe(200);
    const body = (await t.json()) as { messages: { direction: string }[] };
    expect(body.messages.length).toBe(rows.length);

    // An unknown slug is a 404, not a fallback to another club.
    expect((await post(app, '/api/admin/sim/no-such-club/event', { userId: 'x', type: 'text', text: 'hi' }, admin)).status).toBe(404);
  });

  it('/api/dev is not mounted when config.DEV_SIMULATOR is off', async () => {
    const app = makeApp(false);
    const admin = await adminCookie(app);
    const event = { userId: 'off1', type: 'text', text: 'hello' };
    expect((await post(app, `/api/dev/${clubA.slug}/event`, event, admin)).status).toBe(404);
    expect((await get(app, `/api/dev/${clubA.slug}/transcript?userId=off1`, admin)).status).toBe(404);
    expect(app.app.routes.some((r) => r.path.startsWith('/api/dev'))).toBe(false);
    // The admin simulator is mounted in every environment.
    expect((await post(app, `/api/admin/sim/${clubA.slug}/event`, event, admin)).status).toBe(200);
  });
});
