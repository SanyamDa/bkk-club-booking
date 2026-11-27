import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { ResponseRecord } from '../../src/app.js';
import { holdTable } from '../../src/bookings/service.js';
import type { Config } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { clubMemberships, conversations, deposits, guests, rawWebhooks, tables, users, type Club, type MembershipRole } from '../../src/db/schema.js';
import type { AppContext } from '../../src/http/context.js';
import { newId } from '../../src/lib/util.js';
import { hashPassword } from '../../src/platform/passwords.js';
import { base32Decode, base32Encode, totp } from '../../src/platform/totp.js';

type Requester = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
/** Either the object `createApp` returns (with `.app`) or the Hono app itself. */
export type TestApp = Requester | { app: Requester };

function requester(app: TestApp): Requester {
  return 'app' in app ? app.app : app;
}

/** Config for tests (A3: no STAFF_PASSWORD; a fixed 32-byte test CREDENTIALS_KEY). */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    API_PORT: 0,
    PUBLIC_URL: 'http://localhost:5173',
    DATABASE_URL: undefined,
    DATA_DIR: mkdtempSync(join(tmpdir(), 'club-test-')),
    APP_SECRET: 'test-secret-test-secret-test-secret',
    CREDENTIALS_KEY: Buffer.alloc(32, 7),
    ANTHROPIC_API_KEY: undefined,
    DEV_SIMULATOR: true,
    LINE_FAKE: false,
    NODE_ENV: 'test',
    ...overrides,
  };
}

const TEST_PASSWORD = 'test-password-123';
const TEST_TOTP_SECRET = base32Encode(Buffer.from('12345678901234567890'));

/** The app's database and clock; needs the object `createApp` returns, not the bare Hono app. */
function appContext(app: TestApp): AppContext {
  const ctx = (app as { ctx?: AppContext }).ctx;
  if (!ctx) throw new Error('staffCookie/adminCookie need the object createApp returns (with .ctx)');
  return ctx;
}

async function loginCookie(app: TestApp, body: Record<string, unknown>): Promise<string> {
  const res = await requester(app).request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

/** Staff session cookie: creates a manager of `club` and logs in through POST /api/auth/login. */
export async function staffCookie(app: TestApp, club: Club, role: MembershipRole = 'manager'): Promise<string> {
  const { db } = appContext(app).deps;
  const id = newId();
  const email = `${role}-${id}@test.local`;
  await db.insert(users).values({ id, email, name: `Test ${role}`, passwordHash: await hashPassword(TEST_PASSWORD) });
  await db.insert(clubMemberships).values({ userId: id, clubId: club.id, role });
  return loginCookie(app, { email, password: TEST_PASSWORD });
}

/**
 * Staff API URL. Callers pass the route tail relative to the club (`/night`, `/handoffs`,
 * `/bookings/:id/approve`), never `/clubs/<slug>`. A2: every staff route is club-scoped, so every
 * path goes to `/api/staff/clubs/<slug><path>`.
 */
export function staffUrl(slug: string, path: string): string {
  if (path.startsWith('/clubs/')) throw new Error(`staffUrl: pass the path without /clubs/<slug>: ${path}`);
  return `/api/staff/clubs/${slug}${path}`;
}

/** Platform admin cookie: creates a `platform_role = 'admin'` user and logs in with TOTP at the app's clock. */
export async function adminCookie(app: TestApp): Promise<string> {
  const ctx = appContext(app);
  const id = newId();
  const email = `admin-${id}@test.local`;
  await ctx.deps.db.insert(users).values({
    id,
    email,
    name: 'Test admin',
    passwordHash: await hashPassword(TEST_PASSWORD),
    platformRole: 'admin',
    totpSecret: TEST_TOTP_SECRET,
  });
  const code = totp(base32Decode(TEST_TOTP_SECRET), ctx.deps.now());
  return loginCookie(app, { email, password: TEST_PASSWORD, totp: code });
}

/**
 * Shared secret-leak check (plan A4 "no admin or staff response body contains a stored secret").
 * Pass `onResponse` to `createApp(..., { onResponse })` in every admin and staff suite, note each
 * secret the suite stores with `track`, and call `assertNoLeak()` at the end (e.g. in `afterEach`).
 */
export function secretLeakRecorder() {
  const records: ResponseRecord[] = [];
  const secrets = new Set<string>();
  return {
    records,
    onResponse: (r: ResponseRecord) => {
      records.push(r);
    },
    track: (...values: string[]) => {
      for (const v of values) if (v) secrets.add(v);
    },
    /** Throws naming the request when any recorded JSON body contains a tracked secret. */
    assertNoLeak: (extra: string[] = []) => {
      const all = [...secrets, ...extra.filter(Boolean)];
      for (const r of records) {
        const body = JSON.stringify(r.body);
        for (const s of all) {
          if (body.includes(s)) throw new Error(`secret ending ${s.slice(-4)} leaked in ${r.method} ${r.path} (${r.status})`);
        }
      }
    },
  };
}

/** A test account made by `makeUser`; pass it to `loginAs`. */
export interface TestUser {
  id: string;
  email: string;
  password: string;
  /** Base32 TOTP secret; set for platform admins only. */
  totpSecret: string | null;
}

/** A user row with a known password, optionally a member of `clubId` with `role` (default manager), optionally a platform admin. */
export async function makeUser(
  db: Db,
  opts: { email: string; clubId?: string; role?: MembershipRole; platformAdmin?: boolean },
): Promise<TestUser> {
  const id = newId();
  const totpSecret = opts.platformAdmin ? TEST_TOTP_SECRET : null;
  await db.insert(users).values({
    id,
    email: opts.email,
    name: `Test ${opts.email}`,
    passwordHash: await hashPassword(TEST_PASSWORD),
    platformRole: opts.platformAdmin ? 'admin' : null,
    totpSecret,
  });
  if (opts.clubId) await db.insert(clubMemberships).values({ userId: id, clubId: opts.clubId, role: opts.role ?? 'manager' });
  return { id, email: opts.email, password: TEST_PASSWORD, totpSecret };
}

/** Logs `user` in through POST /api/auth/login (with a TOTP code at the app's clock for an admin); returns the cookie. */
export async function loginAs(app: TestApp, user: TestUser): Promise<string> {
  const body: Record<string, unknown> = { email: user.email, password: user.password };
  if (user.totpSecret) body.totp = totp(base32Decode(user.totpSecret), appContext(app).deps.now());
  return loginCookie(app, body);
}

/**
 * Every route of the **root** Hono app (`createApp(...).app`) under `prefix` (plan A2 Interfaces): middleware `ALL` entries are
 * dropped and duplicates (a route with its own middleware is listed once per handler) removed.
 */
export function routeTable(app: { routes: readonly { method: string; path: string }[] }, prefix: string): { method: string; path: string }[] {
  const seen = new Set<string>();
  const out: { method: string; path: string }[] = [];
  for (const r of app.routes) {
    if (r.method === 'ALL') continue;
    if (r.path !== prefix && !r.path.startsWith(`${prefix}/`)) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, path: r.path });
  }
  return out;
}

/** Fixed clock for fixture rows (a Friday afternoon in Bangkok, the fixture clubs are open). */
const FIXTURE_NOW = new Date('2026-11-27T08:00:00Z');

/**
 * Track A rows owned by `club`, keyed by the route segment before the param plus the param
 * (plan A2 Interfaces): one held booking, one conversation in handoff (mode `human`) and one
 * deposit in review with a slip path. The slip file itself is not written: the test writes it
 * under the app's `uploadsDir` at the deposit's `slipPath` when it needs the bytes.
 */
export async function isolationFixtures(db: Db, club: Club): Promise<Record<string, string>> {
  const [guest] = await db
    .insert(guests)
    .values({ id: newId(), clubId: club.id, lineUserId: `U${newId()}`, displayName: 'Isolation Guest' })
    .returning();
  const [table] = await db.select().from(tables).where(eq(tables.clubId, club.id)).limit(1);
  if (!guest || !table) throw new Error(`isolationFixtures: club ${club.slug} has no tables`);
  const booking = await holdTable(db, club, { guestId: guest.id, tableId: table.id, nightDate: '2026-11-27', pax: table.minPax }, FIXTURE_NOW);
  const conversationId = newId();
  await db.insert(conversations).values({
    id: conversationId,
    clubId: club.id,
    guestId: guest.id,
    mode: 'human',
    handoffRequestedAt: FIXTURE_NOW,
    handoffReason: 'isolation fixture',
  });
  const depositId = newId();
  await db.insert(deposits).values({
    id: depositId,
    clubId: club.id,
    bookingId: booking.id,
    amountSatang: booking.depositSatang,
    method: 'promptpay_slip',
    status: 'review',
    slipPath: `isolation/${depositId}.jpg`,
    slipReceivedAt: FIXTURE_NOW,
  });
  // A5 debug routes (`/api/admin/clubs/:slug/webhooks/:id/replay`).
  const rawWebhookId = newId();
  await db.insert(rawWebhooks).values({ id: rawWebhookId, clubId: club.id, channel: 'line', body: { events: [] }, signatureOk: true });
  return { 'bookings/:id': booking.id, 'conversations/:id': conversationId, 'deposits/:id': depositId, 'webhooks/:id': rawWebhookId };
}
