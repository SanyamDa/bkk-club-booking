import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResponseRecord } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { clubMemberships, users, type Club, type MembershipRole } from '../../src/db/schema.js';
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

/** Id-addressed staff routes, which W0 still serves outside `/clubs/:slug`. */
const UNSCOPED_STAFF_PATHS = /^\/(login|logout|me|bookings\/[^/]+|conversations\/|deposits\/)/;

/**
 * Staff API URL. Callers pass the route tail relative to the club (`/night`, `/handoffs`,
 * `/bookings/:id/approve`), never `/clubs/<slug>`. W0: club-scoped routes go to
 * `/api/staff/clubs/<slug><path>`, id routes to `/api/staff<path>`. A2 changes every path to
 * `/api/staff/clubs/<slug><path>`.
 */
export function staffUrl(slug: string, path: string): string {
  if (path.startsWith('/clubs/')) throw new Error(`staffUrl: pass the path without /clubs/<slug>: ${path}`);
  return UNSCOPED_STAFF_PATHS.test(path) ? `/api/staff${path}` : `/api/staff/clubs/${slug}${path}`;
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
