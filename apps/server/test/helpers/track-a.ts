import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../src/config.js';
import type { Club } from '../../src/db/schema.js';

type Requester = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
/** Either the object `createApp` returns (with `.app`) or the Hono app itself. */
export type TestApp = Requester | { app: Requester };

function requester(app: TestApp): Requester {
  return 'app' in app ? app.app : app;
}

/** Config for tests. W0: today's literal; A3 changes it. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    API_PORT: 0,
    PUBLIC_URL: 'http://localhost:5173',
    DATABASE_URL: undefined,
    DATA_DIR: mkdtempSync(join(tmpdir(), 'club-test-')),
    APP_SECRET: 'test-secret-test-secret-test-secret',
    STAFF_PASSWORD: 'staffpass',
    DEV_SIMULATOR: true,
    NODE_ENV: 'test',
    ...overrides,
  };
}

/** Staff session cookie for a club. W0: shared-password login; A1 changes it. */
export async function staffCookie(app: TestApp, _club: Club): Promise<string> {
  const res = await requester(app).request('/api/staff/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'staffpass' }),
  });
  if (res.status !== 200) throw new Error(`staff login failed: ${res.status}`);
  return res.headers.get('set-cookie')!.split(';')[0]!;
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

/** Platform admin cookie. W0: no admin account exists yet, so it returns the staff cookie; A1 changes it. */
export async function adminCookie(app: TestApp): Promise<string> {
  return staffCookie(app, undefined as unknown as Club);
}
