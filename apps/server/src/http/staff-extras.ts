import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  createMenuItem,
  getPreorder,
  listMenu,
  MAX_LINES,
  MAX_QTY,
  PreorderError,
  preordersForNight,
  setPreorder,
  updateMenuItem,
} from '../bookings/preorders.js';
import { getWaitlistEntry, leaveWaitlist, listWaitlist } from '../bookings/waitlist.js';
import type { MenuItem } from '../db/schema.js';
import { currentNightDate } from '../lib/time.js';
import { auditClubChange } from '../platform/club-settings.js';
import { requireClubRole, type AuthEnv } from './auth.js';
import type { AppContext } from './context.js';
import { actorOf } from './staff-settings.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const satang = z.number().int().min(0).max(100_000_000);
const itemBody = z.object({
  name: z.string().trim().min(1).max(80),
  nameTh: z.string().trim().min(1).max(80),
  priceSatang: satang,
  active: z.boolean().optional(),
  sort: z.number().int().min(0).max(10_000).optional(),
});
const itemPatch = itemBody.partial();
const preorderBody = z.object({
  items: z.array(z.object({ menuItemId: z.string().min(1), qty: z.number().int().min(1).max(MAX_QTY) })).max(MAX_LINES),
});

const STATUS: Record<PreorderError['code'], 400 | 404 | 409> = { not_found: 404, invalid_state: 409, bad_item: 400, too_many: 400 };

function fail(c: Context<AuthEnv>, err: unknown) {
  if (err instanceof PreorderError) return c.json({ error: err.code }, STATUS[err.code]);
  throw err;
}

const itemOut = (i: MenuItem) => ({ id: i.id, name: i.name, nameTh: i.nameTh, priceSatang: i.priceSatang, active: i.active, sort: i.sort });

/**
 * B22 staff view: the bottle menu (owner, manager), the night's pre-orders and waitlist, and a
 * booking's pre-order (owner, manager, host). Mounted inside `staffRoutes`; every lookup is
 * scoped by the caller's club, so another club's id is 404.
 */
export function staffExtrasRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  const managers = requireClubRole(app, 'owner', 'manager');
  const desk = requireClubRole(app, 'owner', 'manager', 'host');
  const nightOf = (c: Context<AuthEnv>) => {
    const q = c.req.query('date');
    return q ?? currentNightDate(app.deps.now(), c.var.club.settings.nightEndHour);
  };

  r.get('/clubs/:slug/menu', desk, async (c) => c.json({ items: (await listMenu(db, c.var.club.id)).map(itemOut) }));

  r.post('/clubs/:slug/menu', managers, async (c) => {
    const body = itemBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const now = app.deps.now();
    const item = await createMenuItem(db, c.var.club.id, body.data, now);
    await auditClubChange(db, c.var.club, actorOf(c), { action: 'menu.item_created', entity: 'menu_items', entityId: item.id, after: itemOut(item) }, now);
    return c.json({ item: itemOut(item) });
  });

  r.patch('/clubs/:slug/menu/:itemId', managers, async (c) => {
    const club = c.var.club;
    const before = (await listMenu(db, club.id)).find((i) => i.id === c.req.param('itemId'));
    if (!before) return c.json({ error: 'not_found' }, 404);
    const body = itemPatch.safeParse(await c.req.json().catch(() => null));
    // An empty patch (or one with only unknown keys, which zod strips) changes nothing: refuse it.
    if (!body.success || !Object.values(body.data).some((v) => v !== undefined)) return c.json({ error: 'bad_request' }, 400);
    const item = (await updateMenuItem(db, club.id, before.id, body.data))!;
    await auditClubChange(db, club, actorOf(c), { action: 'menu.item_changed', entity: 'menu_items', entityId: item.id, before: itemOut(before), after: itemOut(item) }, app.deps.now());
    return c.json({ item: itemOut(item) });
  });

  r.get('/clubs/:slug/preorders', desk, async (c) => {
    const date = nightOf(c);
    if (!DATE.test(date)) return c.json({ error: 'bad_request' }, 400);
    return c.json({ date, preorders: await preordersForNight(db, c.var.club, date) });
  });

  r.get('/clubs/:slug/bookings/:id/preorder', desk, async (c) => {
    try {
      return c.json({ preorder: await getPreorder(db, c.var.club.id, c.req.param('id')) });
    } catch (err) {
      return fail(c, err);
    }
  });

  r.put('/clubs/:slug/bookings/:id/preorder', desk, async (c) => {
    const club = c.var.club;
    try {
      // The booking is checked before the body, so another club's id is 404 whatever the body.
      await getPreorder(db, club.id, c.req.param('id'));
    } catch (err) {
      return fail(c, err);
    }
    const body = preorderBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    try {
      return c.json({ preorder: await setPreorder(db, club, c.req.param('id'), body.data.items, actorOf(c), app.deps.now()) });
    } catch (err) {
      return fail(c, err);
    }
  });

  r.get('/clubs/:slug/waitlist', desk, async (c) => {
    const date = nightOf(c);
    if (!DATE.test(date)) return c.json({ error: 'bad_request' }, 400);
    const rows = await listWaitlist(db, c.var.club, date);
    return c.json({
      date,
      entries: rows.map(({ entry, guestName, isTest }) => ({
        id: entry.id,
        guestName,
        paxRange: entry.paxRange,
        status: entry.status,
        joinedAt: entry.createdAt,
        offeredAt: entry.offeredAt,
        offerExpiresAt: entry.offerExpiresAt,
        bookingId: entry.bookingId,
        isTest,
      })),
    });
  });

  r.delete('/clubs/:slug/waitlist/:entryId', desk, async (c) => {
    const club = c.var.club;
    const entry = await getWaitlistEntry(db, club.id, c.req.param('entryId'));
    if (!entry) return c.json({ error: 'not_found' }, 404);
    const now = app.deps.now();
    const done = await leaveWaitlist(db, club.id, entry.id, actorOf(c), now);
    if (done) await auditClubChange(db, club, actorOf(c), { action: 'waitlist.entry_removed', entity: 'waitlist_entries', entityId: entry.id, before: { status: entry.status } }, now);
    return c.json({ ok: true, status: done?.status ?? entry.status });
  });

  return r;
}
