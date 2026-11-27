import type { Db } from '../../src/db/client.js';
import type { Club } from '../../src/db/schema.js';

/** Per-club rows Track B adds for isolation tests. W0: none. */
export async function isolationFixtures(_db: Db, _club: Club): Promise<Record<string, string>> {
  return {};
}
