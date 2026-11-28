import { brainNotes } from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';
import { guests, menuItems, staffGroups, waitlistEntries, type Club } from '../../src/db/schema.js';
import { newId } from '../../src/lib/util.js';

/**
 * Per-club rows Track B adds for isolation tests, keyed like Track A's (segment before the param
 * plus the param). B5's `POST /api/staff/clubs/:slug/staff-link-code` has no route param beyond
 * `:slug`, and `GET /api/liff/club` is not under /api/staff or /api/admin. B12's
 * `POST /api/staff/clubs/:slug/door/crowd-rating` has no param beyond `:slug` either. B19: one draft
 * brain note (`/brain/notes/:noteId/...`). B11's door check-in (`/door/bookings/:id/check-in`) reuses
 * Track A's `bookings/:id` fixture, so it adds no row here.
 */
export async function isolationFixtures(db: Db, club: Club): Promise<Record<string, string>> {
  const noteId = newId();
  await db.insert(brainNotes).values({
    id: noteId,
    clubId: club.id,
    slug: `isolation-${noteId.slice(0, 8)}`,
    title: 'Isolation note',
    type: 'faq',
    status: 'draft',
    bodyMd: 'Isolation probe note.',
    source: 'manual',
  });
  // B22: a bottle-menu item and a waitlist entry of `club`.
  const itemId = newId();
  await db.insert(menuItems).values({ id: itemId, clubId: club.id, name: 'Fixture bottle', nameTh: 'ขวดทดสอบ', priceSatang: 100_000 });
  const guestId = newId();
  await db.insert(guests).values({ id: guestId, clubId: club.id, lineUserId: `U${guestId}`, displayName: 'Fixture guest' });
  const entryId = newId();
  await db.insert(waitlistEntries).values({ id: entryId, clubId: club.id, guestId, nightDate: '2026-11-28', paxRange: '2-4' });
  // §9 staff_groups: `club` has a payments group, so `DELETE .../staff-groups/payments` at another club is 404.
  await db.insert(staffGroups).values({ id: newId(), clubId: club.id, lineGroupId: 'Cisolation-payments', purpose: 'payments' });
  return { 'notes/:noteId': noteId, 'menu/:itemId': itemId, 'waitlist/:entryId': entryId, 'staff-groups/:purpose': 'payments' };
}
