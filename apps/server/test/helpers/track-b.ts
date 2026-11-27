import type { Db } from '../../src/db/client.js';
import { guests, menuItems, waitlistEntries, type Club } from '../../src/db/schema.js';
import { newId } from '../../src/lib/util.js';

/**
 * Per-club rows Track B adds for isolation tests. None so far: B5's
 * `POST /api/staff/clubs/:slug/staff-link-code` has no route param beyond `:slug`, and
 * `GET /api/liff/club` is not under /api/staff or /api/admin. B12's
 * `POST /api/staff/clubs/:slug/door/crowd-rating` has no param beyond `:slug` either.
 */
export async function isolationFixtures(db: Db, club: Club): Promise<Record<string, string>> {
  // B22: a bottle-menu item and a waitlist entry of `club`.
  const itemId = newId();
  await db.insert(menuItems).values({ id: itemId, clubId: club.id, name: 'Fixture bottle', nameTh: 'ขวดทดสอบ', priceSatang: 100_000 });
  const guestId = newId();
  await db.insert(guests).values({ id: guestId, clubId: club.id, lineUserId: `U${guestId}`, displayName: 'Fixture guest' });
  const entryId = newId();
  await db.insert(waitlistEntries).values({ id: entryId, clubId: club.id, guestId, nightDate: '2026-11-28', paxRange: '2-4' });
  return { 'menu/:itemId': itemId, 'waitlist/:entryId': entryId };
}
