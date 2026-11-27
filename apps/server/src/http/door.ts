import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { BookingError, markArrived } from '../bookings/service.js';
import type { Db } from '../db/client.js';
import { bookings, doorCounts as doorCountsTable, guests, tables, zones, type Club } from '../db/schema.js';
import { emit } from '../data/events.js';
import { isTestContext } from '../data/test-flag.js';
import { openPosBillAtCheckIn } from '../integrations/pos/live.js';
import { currentNightDate } from '../lib/time.js';
import { newId } from '../lib/util.js';
import { requireClubRole, type AuthEnv } from './auth.js';
import type { AppContext } from './context.js';
import { actorOf } from './staff-settings.js';

/** Guest types the door clicker tags (spec §14.3, `door_counts.kind`). */
export const DOOR_KINDS = ['table_guest', 'guestlist', 'walk_in', 'ticket'] as const;
export type DoorKind = (typeof DOOR_KINDS)[number];

/** Bookings the door screen lists: still expected, already in, or marked no-show. */
const DOOR_STATUSES = ['confirmed', 'arrived', 'no_show'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Net door count for one club-night, per kind and in total (sum of `door_counts.delta`). */
export async function doorCounts(db: Db, clubId: string, nightDate: string): Promise<{ byKind: Record<DoorKind, number>; total: number }> {
  const rows = await db
    .select({ kind: doorCountsTable.kind, net: sql<number>`coalesce(sum(${doorCountsTable.delta}), 0)::int` })
    .from(doorCountsTable)
    .where(and(eq(doorCountsTable.clubId, clubId), eq(doorCountsTable.nightDate, nightDate)))
    .groupBy(doorCountsTable.kind);
  const byKind = Object.fromEntries(DOOR_KINDS.map((k) => [k, 0])) as Record<DoorKind, number>;
  for (const r of rows) if (r.kind in byKind) byKind[r.kind] = Number(r.net);
  return { byKind, total: DOOR_KINDS.reduce((s, k) => s + byKind[k], 0) };
}

/** The club-night's bookings the door sees, with guest, table and zone. */
async function nightArrivals(db: Db, clubId: string, nightDate: string) {
  const rows = await db
    .select({ booking: bookings, guest: guests, table: tables, zone: zones })
    .from(bookings)
    .innerJoin(guests, eq(guests.id, bookings.guestId))
    .innerJoin(tables, eq(tables.id, bookings.tableId))
    .innerJoin(zones, eq(zones.id, tables.zoneId))
    .where(and(eq(bookings.clubId, clubId), eq(bookings.nightDate, nightDate), inArray(bookings.status, [...DOOR_STATUSES])))
    .orderBy(asc(tables.sort), asc(bookings.createdAt));
  return rows.map(({ booking: b, guest: g, table: t, zone: z }) => ({
    id: b.id,
    ref: b.refCode,
    status: b.status,
    guestName: g.name ?? g.displayName ?? 'Guest',
    /** Search-only fields: never sent to the door screen (`publicArrival`). */
    displayName: g.displayName,
    phone: g.phone,
    table: t.code,
    zone: z.name,
    pax: b.pax,
    arrivedPax: b.arrivedPax,
    arrivedAt: b.arrivedAt?.toISOString() ?? null,
    notes: b.notes,
  }));
}

/** A door-screen row without the search-only fields (phone stays hidden from the door role). */
function publicArrival({ phone: _phone, displayName: _displayName, ...rest }: Awaited<ReturnType<typeof nightArrivals>>[number]) {
  return rest;
}

const checkInBody = z.object({ arrivedPax: z.number().int().min(0).max(200).optional() });
const countBody = z.object({
  kind: z.enum(DOOR_KINDS),
  delta: z.union([z.literal(1), z.literal(-1)]),
  /** Client id of one tap; a retry with the same id writes nothing more. */
  clickId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
});

/**
 * Door screen (plan B11, spec §6.2 Door, §14.3), mounted at `/api/staff`: tonight's arrivals,
 * QR / name lookup, one-tap check-in with the actual party size, and the door clicker by guest type.
 * A door-role account is enough; a promoter is refused.
 */
export function doorRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  const door = requireClubRole(app, 'owner', 'manager', 'host', 'door');
  const base = '/clubs/:slug/door';
  const tonight = (club: Club) => currentNightDate(app.deps.now(), club.settings.nightEndHour);

  r.get(base, door, async (c) => {
    const club = c.var.club;
    const q = c.req.query('date');
    const nightDate = q && DATE.test(q) ? q : tonight(club);
    const [arrivals, counts] = await Promise.all([nightArrivals(db, club.id, nightDate), doorCounts(db, club.id, nightDate)]);
    return c.json({ nightDate, arrivals: arrivals.map(publicArrival), counts });
  });

  // The pass QR (`/media/pass`) encodes the booking ref; the name / phone search is the fallback.
  r.get(`${base}/find`, door, async (c) => {
    const club = c.var.club;
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    if (!q) return c.json({ results: [] });
    const all = await nightArrivals(db, club.id, tonight(club));
    const byRef = all.filter((b) => b.ref.toLowerCase() === q);
    const results = byRef.length
      ? byRef
      : all.filter((b) => [b.guestName, b.displayName ?? '', b.phone ?? ''].some((s) => s.toLowerCase().includes(q))).slice(0, 20);
    return c.json({ results: results.map(publicArrival) });
  });

  r.post(`${base}/bookings/:id/check-in`, door, async (c) => {
    const club = c.var.club;
    const id = c.req.param('id');
    const booking = await db.query.bookings.findFirst({ where: and(eq(bookings.id, id), eq(bookings.clubId, club.id)) });
    if (!booking) return c.json({ error: 'not_found' }, 404);
    const parsed = checkInBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
    if (booking.nightDate !== tonight(club)) {
      return c.json({ error: 'wrong_night', message: `This booking is for ${booking.nightDate}`, nightDate: booking.nightDate }, 409);
    }
    const now = app.deps.now();
    try {
      await markArrived(db, club.id, id, actorOf(c), now, parsed.data.arrivedPax ?? booking.pax);
    } catch (err) {
      if (err instanceof BookingError) return c.json({ error: err.code, message: err.message }, err.code === 'not_found' ? 404 : 409);
      throw err;
    }
    // A19 L2: open the POS bill with the deposit as a prepayment (no-op without a live POS).
    app.track(openPosBillAtCheckIn(db, app.config.CREDENTIALS_KEY, club, id, { now, fetch: app.posFetch }));
    return c.json({ ok: true });
  });

  r.post(`${base}/count`, door, async (c) => {
    const club = c.var.club;
    const parsed = countBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
    const { kind, delta, clickId } = parsed.data;
    const nightDate = tonight(club);
    const now = app.deps.now();
    const actor = actorOf(c);
    const userId = c.var.user.id;
    const outcome = await db.transaction(async (tx) => {
      // Serialize taps per club-night so two concurrent -1s cannot both pass the below-zero check.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`door:${club.id}:${nightDate}`}))`);
      const before = await doorCounts(tx, club.id, nightDate);
      if (delta < 0 && before.byKind[kind] + delta < 0) return 'below_zero' as const;
      const [row] = await tx
        .insert(doorCountsTable)
        .values({ id: clickId ? `dc_${club.id}_${clickId}` : newId(), clubId: club.id, nightDate, at: now, delta, kind, userId })
        .onConflictDoNothing()
        .returning();
      if (!row) return 'repeat' as const;
      await emit(tx, {
        clubId: club.id,
        type: 'door.count',
        occurredAt: now,
        actorType: actor.type,
        actorId: actor.id,
        channel: 'door',
        dataOrigin: 'first_party',
        nightDate,
        props: { kind, count_in: delta > 0 ? delta : 0, count_out: delta < 0 ? -delta : 0, total: before.total + delta },
        isTest: isTestContext({ club }),
        dedupeKey: clickId ? `door:${clickId}` : undefined,
      });
      return 'ok' as const;
    });
    if (outcome === 'below_zero') return c.json({ error: 'below_zero', message: 'The count for this guest type is already 0' }, 409);
    return c.json({ ok: true, counts: await doorCounts(db, club.id, nightDate) });
  });

  return r;
}
