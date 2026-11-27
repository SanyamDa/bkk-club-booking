import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { clubs, events, eventsDeadLetter, guests, notices, removalRequests } from '../../db/schema.js';
import { addDays, bangkokParts, toDateString } from '../../lib/time.js';
import { requirePlatformAdmin, type AuthEnv } from '../auth.js';
import type { AppContext } from '../context.js';

/** Days of per-day event counts the health table shows, today included. */
export const HEALTH_DAYS = 7;

const streamQuery = z.object({
  club: z.string().trim().min(1).optional(),
  conversation: z.string().trim().min(1).optional(),
  booking: z.string().trim().min(1).optional(),
  guest: z.string().trim().min(1).optional(),
  /** `seq` of the oldest event already shown; the next page is older. */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Bangkok calendar day of a timestamp column, as YYYY-MM-DD (Thailand is UTC+7 all year). */
const bkkDay = (col: unknown) => sql<string>`to_char((${col} at time zone 'UTC') + interval '7 hours', 'YYYY-MM-DD')`;

/**
 * Data health and the event stream (spec §14.6, plan A5). Mounted under /api/admin:
 * `GET /data/health`, `GET /events?club&conversation&booking&guest&before&limit` (newest first).
 */
export function dataRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  r.use('/data/*', requirePlatformAdmin(app));
  r.use('/events', requirePlatformAdmin(app));

  r.get('/data/health', async (c) => {
    const now = app.deps.now();
    const p = bangkokParts(now);
    const today = toDateString(p.year, p.month, p.day);
    const firstDay = addDays(today, -(HEALTH_DAYS - 1));
    const days = Array.from({ length: HEALTH_DAYS }, (_, i) => addDays(firstDay, i));
    // Bangkok midnight of the first day, as an instant.
    const since = new Date(`${firstDay}T00:00:00+07:00`);

    const allClubs = await db.select({ id: clubs.id, slug: clubs.slug, name: clubs.name, status: clubs.status }).from(clubs).orderBy(asc(clubs.name));
    const perDay = await db
      .select({ clubId: events.clubId, day: bkkDay(events.occurredAt), n: sql<number>`count(*)::int` })
      .from(events)
      .where(sql`${events.occurredAt} >= ${since}`)
      .groupBy(events.clubId, bkkDay(events.occurredAt));
    const last = await db
      .select({ clubId: events.clubId, at: sql<string | null>`max(${events.occurredAt})` })
      .from(events)
      .groupBy(events.clubId);
    const rejected = await db
      .select({ clubId: sql<string | null>`${eventsDeadLetter.payload}->>'clubId'`, n: sql<number>`count(*)::int` })
      .from(eventsDeadLetter)
      .groupBy(sql`${eventsDeadLetter.payload}->>'clubId'`);
    const guestCounts = await db
      .select({ clubId: guests.clubId, n: sql<number>`count(*)::int` })
      .from(guests)
      .groupBy(guests.clubId);
    const noticed = await db
      .select({ clubId: notices.clubId, n: sql<number>`count(distinct ${notices.guestId})::int` })
      .from(notices)
      .groupBy(notices.clubId);
    const removals = await db
      .select({ clubId: removalRequests.clubId, n: sql<number>`count(*)::int` })
      .from(removalRequests)
      .where(isNull(removalRequests.completedAt))
      .groupBy(removalRequests.clubId);

    const byClub = <T extends { clubId: string | null }>(rows: T[]) => new Map(rows.map((x) => [x.clubId, x]));
    const lastBy = byClub(last);
    const rejectedBy = byClub(rejected);
    const guestsBy = byClub(guestCounts);
    const noticedBy = byClub(noticed);
    const removalsBy = byClub(removals);

    return c.json({
      today,
      days,
      clubs: allClubs.map((club) => {
        const counts = new Map(perDay.filter((x) => x.clubId === club.id).map((x) => [x.day, Number(x.n)]));
        const lastAt = lastBy.get(club.id)?.at;
        const guestN = Number(guestsBy.get(club.id)?.n ?? 0);
        const noticedN = Number(noticedBy.get(club.id)?.n ?? 0);
        return {
          slug: club.slug,
          name: club.name,
          status: club.status,
          eventsPerDay: days.map((day) => ({ day, count: counts.get(day) ?? 0 })),
          eventsToday: counts.get(today) ?? 0,
          lastEventAt: lastAt ? new Date(lastAt).toISOString() : null,
          rejectedEvents: Number(rejectedBy.get(club.id)?.n ?? 0),
          noticeShare: guestN === 0 ? null : noticedN / guestN,
          pendingRemovals: Number(removalsBy.get(club.id)?.n ?? 0),
        };
      }),
    });
  });

  r.get('/events', async (c) => {
    const q = streamQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: 'invalid_request' }, 400);
    const { club, conversation, booking, guest, before, limit } = q.data;
    let clubId: string | undefined;
    if (club) {
      const row = await db.query.clubs.findFirst({ where: or(eq(clubs.slug, club), eq(clubs.id, club)), columns: { id: true } });
      if (!row) return c.json({ error: 'not_found' }, 404);
      clubId = row.id;
    }
    const rows = await db
      .select({
        seq: events.seq,
        id: events.id,
        occurredAt: events.occurredAt,
        clubId: events.clubId,
        type: events.type,
        actorType: events.actorType,
        actorId: events.actorId,
        channel: events.channel,
        dataOrigin: events.dataOrigin,
        guestId: events.guestId,
        conversationId: events.conversationId,
        bookingId: events.bookingId,
        nightDate: events.nightDate,
        props: events.props,
        isTest: events.isTest,
      })
      .from(events)
      .where(
        and(
          clubId ? eq(events.clubId, clubId) : undefined,
          conversation ? eq(events.conversationId, conversation) : undefined,
          booking ? eq(events.bookingId, booking) : undefined,
          guest ? eq(events.guestId, guest) : undefined,
          before ? lt(events.seq, before) : undefined,
        ),
      )
      .orderBy(desc(events.seq))
      .limit(limit);
    return c.json({
      events: rows.map((e) => ({ ...e, occurredAt: e.occurredAt.toISOString() })),
      nextBefore: rows.length === limit ? rows[rows.length - 1]!.seq : null,
    });
  });

  return r;
}
