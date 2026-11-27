import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { addNote, addTag, CrmError, guestProfile, removeTag, searchGuests } from '../platform/crm.js';
import { auditClubChange } from '../platform/club-settings.js';
import { requireClubRole, type AuthEnv } from './auth.js';
import { actorOf } from './staff-settings.js';
import type { AppContext } from './context.js';

const tagBody = z.object({ tag: z.string().max(64) });
const noteBody = z.object({ text: z.string().max(4000) });

function fail(c: Context<AuthEnv>, err: unknown) {
  if (err instanceof CrmError) return c.json({ error: err.code }, err.code === 'not_found' ? 404 : 400);
  throw err;
}

/**
 * Guest CRM and VIP tags (plan A20c, spec §6.2), mounted inside `staffRoutes`. Owner, manager and
 * host. Every lookup is club-scoped (`platform/crm.ts`), so another club's guest id is 404, and the
 * guest is checked before the body is read.
 */
export function staffCrmRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  const desk = requireClubRole(app, 'owner', 'manager', 'host');

  r.get('/clubs/:slug/guests', desk, async (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    try {
      const list = await searchGuests(db, c.var.club, { q: c.req.query('q') || undefined, tag: c.req.query('tag') || undefined, limit: Number.isFinite(limit) ? Math.trunc(limit) : 50 });
      return c.json({ guests: list });
    } catch (err) {
      return fail(c, err);
    }
  });

  r.get('/clubs/:slug/guests/:guestId', desk, async (c) => {
    const profile = await guestProfile(db, c.var.club, c.req.param('guestId'));
    if (!profile) return c.json({ error: 'not_found' }, 404);
    return c.json({ profile });
  });

  r.post('/clubs/:slug/guests/:guestId/tags', desk, async (c) => {
    const club = c.var.club;
    const guestId = c.req.param('guestId');
    if (!(await guestProfile(db, club, guestId))) return c.json({ error: 'not_found' }, 404);
    const body = tagBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_tag' }, 400);
    try {
      const now = app.deps.now();
      const tags = await addTag(db, club.id, guestId, body.data.tag, c.var.user.id, now);
      await auditClubChange(db, club, actorOf(c), { action: 'guest.tag_added', entity: 'guests', entityId: guestId, after: { tags } }, now);
      return c.json({ tags });
    } catch (err) {
      return fail(c, err);
    }
  });

  r.delete('/clubs/:slug/guests/:guestId/tags/:tag', desk, async (c) => {
    try {
      const tags = await removeTag(db, c.var.club.id, c.req.param('guestId'), c.req.param('tag'));
      await auditClubChange(db, c.var.club, actorOf(c), { action: 'guest.tag_removed', entity: 'guests', entityId: c.req.param('guestId'), after: { tags } }, app.deps.now());
      return c.json({ tags });
    } catch (err) {
      return fail(c, err);
    }
  });

  r.post('/clubs/:slug/guests/:guestId/notes', desk, async (c) => {
    const club = c.var.club;
    const guestId = c.req.param('guestId');
    if (!(await guestProfile(db, club, guestId))) return c.json({ error: 'not_found' }, 404);
    const body = noteBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    try {
      const now = app.deps.now();
      const note = await addNote(db, club.id, guestId, body.data.text, c.var.user.id, now);
      // The note text stays out of the audit row: it is guest data, kept only in guest_notes.
      await auditClubChange(db, club, actorOf(c), { action: 'guest.note_added', entity: 'guest_notes', entityId: note.id }, now);
      return c.json({ note: { id: note.id, text: note.text, createdAt: note.createdAt.toISOString() } });
    } catch (err) {
      return fail(c, err);
    }
  });

  return r;
}
