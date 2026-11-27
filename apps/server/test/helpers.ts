import { eq } from 'drizzle-orm';
import { openDb } from '../src/db/client.js';
import { clubs, guests } from '../src/db/schema.js';
import { DEMO_CLUB_ID, seedDemoClub } from '../src/db/seed.js';
import { newId } from '../src/lib/util.js';

/** A fresh in-memory database with the demo club. */
export async function setupDb() {
  const handle = await openDb({ dataDir: 'memory' });
  await seedDemoClub(handle.db, {});
  const club = (await handle.db.query.clubs.findFirst({ where: eq(clubs.id, DEMO_CLUB_ID) }))!;
  return { ...handle, club };
}

export async function makeGuest(db: Awaited<ReturnType<typeof setupDb>>['db'], lineUserId = `U${newId()}`) {
  const [g] = await db
    .insert(guests)
    .values({ id: newId(), clubId: DEMO_CLUB_ID, lineUserId, displayName: 'Test Guest' })
    .returning();
  return g!;
}

/** A Friday 15:00 Bangkok (08:00 UTC) — the demo club is open Wed–Sat. */
export const FRIDAY_AFTERNOON = new Date('2026-11-27T08:00:00Z');
export const FRIDAY = '2026-11-27';
