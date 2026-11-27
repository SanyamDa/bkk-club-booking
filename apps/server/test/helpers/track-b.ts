import type { Db } from '../../src/db/client.js';
import type { Club } from '../../src/db/schema.js';

/**
 * Per-club rows Track B adds for isolation tests. None so far: B5's
 * `POST /api/staff/clubs/:slug/staff-link-code` has no route param beyond `:slug`, and
 * `GET /api/liff/club` is not under /api/staff or /api/admin.
 */
export async function isolationFixtures(_db: Db, _club: Club): Promise<Record<string, string>> {
  return {};
}
