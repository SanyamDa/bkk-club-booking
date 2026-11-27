import { brainNotes } from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';
import type { Club } from '../../src/db/schema.js';
import { newId } from '../../src/lib/util.js';

/**
 * Per-club rows Track B adds for isolation tests, keyed like Track A's (segment before the param
 * plus the param). B5's `POST /api/staff/clubs/:slug/staff-link-code` has no route param beyond
 * `:slug`. B19: one draft brain note (`/brain/notes/:noteId/...`). B11's door check-in
 * (`/door/bookings/:id/check-in`) reuses Track A's `bookings/:id` fixture, so it adds no row here.
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
  return { 'notes/:noteId': noteId };
}
