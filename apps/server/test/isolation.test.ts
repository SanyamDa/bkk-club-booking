import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { bookings, conversations, deposits, messages, type Club } from '../src/db/schema.js';
import { FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { adminCookie, isolationFixtures as trackAFixtures, loginAs, makeUser, routeTable, testConfig } from './helpers/track-a.js';
import { isolationFixtures as trackBFixtures } from './helpers/track-b.js';

/** `/api/staff` paths that legitimately carry no `:slug` (none since A2). */
const UNSCOPED_ALLOWLIST = new Set<string>();

/** Bytes only clubB's slip file holds; no response to a clubA user may contain them. */
const CLUB_B_SLIP = 'CLUB-B-SLIP-BYTES-0123456789';

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let clubB: Club;
let app: ReturnType<typeof createApp>;
let fixtures: Record<string, string>;

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
  app = createApp(testConfig(), db, { bot: { now: () => FRIDAY_AFTERNOON, log: () => {} } });
  fixtures = { ...(await trackAFixtures(db, clubB)), ...(await trackBFixtures(db, clubB)) };
  const [deposit] = await db.select().from(deposits).where(eq(deposits.id, fixtures['deposits/:id']!));
  const file = join(app.ctx.deps.uploadsDir, deposit!.slipPath!);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, CLUB_B_SLIP);
});
afterEach(async () => {
  await close();
});

const staffRoutes = () => routeTable(app.app, '/api/staff');
const adminRoutes = () => routeTable(app.app, '/api/admin');

/** Params of a Hono path (`:name` or `:name{regex}`), each with the segment before it. */
function paramsOf(path: string): { name: string; key: string }[] {
  const segs = path.split('/');
  const out: { name: string; key: string }[] = [];
  segs.forEach((seg, i) => {
    const m = /^:([A-Za-z0-9_]+)/.exec(seg);
    if (m) out.push({ name: m[1]!, key: `${segs[i - 1]}/:${m[1]}` });
  });
  return out;
}

/** Fills `:slug` with `slug` and every other param with clubB's fixture id; throws on a param with no fixture. */
function fill(path: string, slug: string): string {
  let url = path;
  for (const p of paramsOf(path)) {
    const pattern = new RegExp(`:${p.name}(\\{[^}]*\\})?`);
    if (p.name === 'slug') {
      url = url.replace(pattern, slug);
      continue;
    }
    const id = fixtures[p.key];
    if (!id) throw new Error(`no isolation fixture for ${p.key} (route ${path}); add it to isolationFixtures`);
    url = url.replace(pattern, encodeURIComponent(id));
  }
  return url;
}

const hasOtherParam = (path: string) => paramsOf(path).some((p) => p.name !== 'slug');
const hasSlug = (path: string) => paramsOf(path).some((p) => p.name === 'slug');

function call(method: string, url: string, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const init: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify({ text: 'isolation probe', reason: 'isolation probe' });
  return app.app.request(url, init);
}

async function clubBState() {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, fixtures['bookings/:id']!));
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, fixtures['conversations/:id']!));
  const [deposit] = await db.select().from(deposits).where(eq(deposits.id, fixtures['deposits/:id']!));
  const outbound = await db
    .select()
    .from(messages)
    .where(and(eq(messages.clubId, clubB.id), eq(messages.direction, 'out')));
  return { bookingStatus: booking!.status, conversationMode: conv!.mode, depositStatus: deposit!.status, outbound: outbound.length };
}

async function clubAManager() {
  return loginAs(app, await makeUser(db, { email: 'manager-a@test.local', clubId: clubA.id, role: 'manager' }));
}

describe('club isolation (plan A2)', () => {
  it('every /api/staff route has :slug (or is allowlisted)', () => {
    const routes = staffRoutes();
    expect(routes.length).toBeGreaterThan(0);
    const missing = routes.filter((r) => !hasSlug(r.path) && !UNSCOPED_ALLOWLIST.has(`${r.method} ${r.path}`));
    expect(missing).toEqual([]);
  });

  it("own slug with another club's id returns 404", async () => {
    const cookie = await clubAManager();
    const before = await clubBState();
    const routes = staffRoutes().filter((r) => hasOtherParam(r.path));
    expect(routes.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const r of routes) {
      if (!hasSlug(r.path) && !UNSCOPED_ALLOWLIST.has(`${r.method} ${r.path}`)) throw new Error(`no :slug in ${r.path}`);
      const res = await call(r.method, fill(r.path, clubA.slug), cookie);
      const body = await res.text();
      if (res.status !== 404) wrong.push(`${r.method} ${r.path} -> ${res.status}`);
      expect(body).not.toContain(CLUB_B_SLIP);
    }
    expect(wrong).toEqual([]);
    expect(await clubBState()).toEqual(before);
  });

  it("own slug with another club's id returns 404 on ADMIN_ROUTES (platform admin)", async () => {
    const cookie = await adminCookie(app);
    const before = await clubBState();
    const wrong: string[] = [];
    const routes = adminRoutes().filter((x) => hasSlug(x.path) && hasOtherParam(x.path));
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      const res = await call(r.method, fill(r.path, clubA.slug), cookie);
      const body = await res.text();
      if (res.status !== 404) wrong.push(`${r.method} ${r.path} -> ${res.status}`);
      expect(body).not.toContain(CLUB_B_SLIP);
    }
    expect(wrong).toEqual([]);
    expect(await clubBState()).toEqual(before);
  });

  it("another club's slug returns 403", async () => {
    const cookie = await clubAManager();
    const before = await clubBState();
    const wrong: string[] = [];
    for (const r of staffRoutes()) {
      if (!hasSlug(r.path) && !UNSCOPED_ALLOWLIST.has(`${r.method} ${r.path}`)) throw new Error(`no :slug in ${r.path}`);
      const res = await call(r.method, fill(r.path, clubB.slug), cookie);
      const body = await res.text();
      if (res.status !== 403) wrong.push(`${r.method} ${r.path} -> ${res.status}`);
      expect(body).not.toContain(CLUB_B_SLIP);
    }
    expect(wrong).toEqual([]);
    expect(await clubBState()).toEqual(before);
  });

  it('own club still works', async () => {
    const cookie = await clubAManager();
    const res = await app.app.request(`/api/staff/clubs/${clubA.slug}/night`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('no session → 401', async () => {
    const wrong: string[] = [];
    for (const r of staffRoutes()) {
      const res = await call(r.method, fill(r.path, clubA.slug));
      if (res.status !== 401) wrong.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });
});
