import { eq } from 'drizzle-orm';
import { openDb, type Db } from '../src/db/client.js';
import { channels, clubs, guests, tables, zones, type Club } from '../src/db/schema.js';
import { newId } from '../src/lib/util.js';
import { FIXTURE_CLUB_ID, fixtureSettings, seedFixtureClub } from './fixtures/club.js';

async function loadClub(db: Db, id: string): Promise<Club> {
  return (await db.query.clubs.findFirst({ where: eq(clubs.id, id) }))!;
}

/** A fresh in-memory database with the frozen fixture club (test/fixtures/club.ts). */
export async function setupDb() {
  const handle = await openDb({ dataDir: 'memory' });
  await seedFixtureClub(handle.db);
  const club = await loadClub(handle.db, FIXTURE_CLUB_ID);
  return { ...handle, club };
}

export const CLUB_B_ID = 'club_test_b';

/**
 * Two clubs in one database: clubA is the fixture club (status 'demo'), clubB is
 * club_test_b (slug test-b, status 'live') with two zones and four tables of its own.
 */
export async function setupTwoClubs(): Promise<{ db: Db; close: () => Promise<void>; clubA: Club; clubB: Club }> {
  const handle = await openDb({ dataDir: 'memory' });
  await seedFixtureClub(handle.db);
  await handle.db.insert(clubs).values({
    id: CLUB_B_ID,
    slug: 'test-b',
    name: 'Test Club B',
    settings: { ...fixtureSettings, refPrefix: 'TB' },
    lineChannelSecretEnv: 'TEST_B_LINE_CHANNEL_SECRET',
    lineAccessTokenEnv: 'TEST_B_LINE_ACCESS_TOKEN',
    status: 'live',
  });
  await handle.db.insert(channels).values({ id: `chan_line_${CLUB_B_ID}`, clubId: CLUB_B_ID, kind: 'line' });
  await handle.db.insert(zones).values([
    { id: 'zone_b_vip', clubId: CLUB_B_ID, name: 'VIP', nameTh: 'วีไอพี', sort: 1, minSpendSatang: 2_000_000, depositSatang: 800_000 },
    { id: 'zone_b_std', clubId: CLUB_B_ID, name: 'Standard', nameTh: 'มาตรฐาน', sort: 2, minSpendSatang: 600_000, depositSatang: 200_000 },
  ]);
  await handle.db.insert(tables).values([
    { id: 'table_b_V1', clubId: CLUB_B_ID, zoneId: 'zone_b_vip', code: 'V1', minPax: 6, maxPax: 12, sort: 1 },
    { id: 'table_b_V2', clubId: CLUB_B_ID, zoneId: 'zone_b_vip', code: 'V2', minPax: 6, maxPax: 12, sort: 2 },
    { id: 'table_b_S1', clubId: CLUB_B_ID, zoneId: 'zone_b_std', code: 'S1', minPax: 2, maxPax: 4, sort: 3 },
    { id: 'table_b_S2', clubId: CLUB_B_ID, zoneId: 'zone_b_std', code: 'S2', minPax: 2, maxPax: 4, sort: 4 },
  ]);
  return {
    db: handle.db,
    close: handle.close,
    clubA: await loadClub(handle.db, FIXTURE_CLUB_ID),
    clubB: await loadClub(handle.db, CLUB_B_ID),
  };
}

export async function makeGuest(db: Db, opts: { clubId?: string; lineUserId?: string } = {}) {
  const [g] = await db
    .insert(guests)
    .values({
      id: newId(),
      clubId: opts.clubId ?? FIXTURE_CLUB_ID,
      lineUserId: opts.lineUserId ?? `U${newId()}`,
      displayName: 'Test Guest',
    })
    .returning();
  return g!;
}

/** A Friday 15:00 Bangkok (08:00 UTC) — the demo club is open Wed–Sat. */
export const FRIDAY_AFTERNOON = new Date('2026-11-27T08:00:00Z');
export const FRIDAY = '2026-11-27';
