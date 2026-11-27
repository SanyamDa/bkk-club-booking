import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { getBookingView } from '../../bookings/service.js';
import { getConversationForClub } from '../../chat/conversations.js';
import type { Db } from '../../db/client.js';
import {
  auditLog,
  bookingStatusHistory,
  bookings,
  clubs,
  events,
  guests,
  messages,
  rawWebhooks,
  type Club,
} from '../../db/schema.js';
import { newId } from '../../lib/util.js';
import { clientIp, requirePlatformAdmin, type AuthEnv } from '../auth.js';
import type { AppContext } from '../context.js';
import { processDelivery } from '../webhook.js';

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime({ offset: true }).optional(),
});

const testMessageBody = z.object({ to: z.enum(['self', 'staff_group']) });

type ClubEnv = AuthEnv & { Variables: { debugClub: Club } };

/**
 * One `audit_log` row when a founder opens a conversation, a booking, or a club's webhook or
 * message list (spec P2, §12.3: every founder access to a club's guest data is logged).
 */
async function auditView(db: Db, c: Context<ClubEnv>, entity: string, entityId: string) {
  await db.insert(auditLog).values({
    id: newId(),
    clubId: c.var.debugClub.id,
    actor: 'platform',
    actorType: 'platform',
    actorId: c.var.user.id,
    sessionId: c.var.session.idHash,
    ip: clientIp(c) ?? null,
    action: 'debug.view',
    entity,
    entityId,
    data: { method: c.req.method, path: c.req.path, query: c.req.query() },
  });
}

/**
 * Founder debug views (spec §12.3 Debug, plan A5). Read-only over Track B tables. Every path is
 * under `/api/admin/clubs/:slug`: `GET webhooks`, `GET messages`, `GET conversations/:id/timeline`,
 * `GET bookings/:id/timeline`, `POST webhooks/:id/replay` (B3 `processDelivery` dry run),
 * `POST test-message {to}`.
 */
export function debugRoutes(app: AppContext) {
  const r = new Hono<ClubEnv>();
  const { db } = app.deps;
  const admin = requirePlatformAdmin(app);

  const PATHS = ['webhooks', 'webhooks/:id/replay', 'messages', 'conversations/:id/timeline', 'bookings/:id/timeline', 'test-message'];
  for (const p of PATHS) {
    r.use(`/clubs/:slug/${p}`, admin as never, async (c, next) => {
      const club = await db.query.clubs.findFirst({ where: eq(clubs.slug, c.req.param('slug')) });
      if (!club) return c.json({ error: 'not_found' }, 404);
      c.set('debugClub', club);
      await next();
    });
  }

  r.get('/clubs/:slug/webhooks', async (c) => {
    const q = pageQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: 'invalid_request' }, 400);
    const club = c.var.debugClub;
    await auditView(db, c, 'raw_webhooks', club.id);
    const rows = await db
      .select()
      .from(rawWebhooks)
      .where(and(eq(rawWebhooks.clubId, club.id), q.data.before ? lt(rawWebhooks.receivedAt, new Date(q.data.before)) : undefined))
      .orderBy(desc(rawWebhooks.receivedAt))
      .limit(q.data.limit);
    return c.json({
      webhooks: rows.map((w) => ({
        id: w.id,
        channel: w.channel,
        receivedAt: w.receivedAt.toISOString(),
        signatureOk: w.signatureOk,
        processedAt: w.processedAt?.toISOString() ?? null,
        result: w.error ? 'error' : w.processedAt ? 'processed' : 'pending',
        error: w.error,
        body: w.body,
      })),
    });
  });

  r.get('/clubs/:slug/messages', async (c) => {
    const q = pageQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: 'invalid_request' }, 400);
    const club = c.var.debugClub;
    await auditView(db, c, 'messages', club.id);
    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.clubId, club.id), q.data.before ? lt(messages.createdAt, new Date(q.data.before)) : undefined))
      .orderBy(desc(messages.createdAt))
      .limit(q.data.limit);
    return c.json({ messages: rows.map(messageShape) });
  });

  r.get('/clubs/:slug/conversations/:id/timeline', async (c) => {
    const club = c.var.debugClub;
    const conv = await getConversationForClub(db, club.id, c.req.param('id'));
    if (!conv) return c.json({ error: 'not_found' }, 404);
    await auditView(db, c, 'conversation', conv.id);
    const guest = await db.query.guests.findFirst({ where: and(eq(guests.id, conv.guestId), eq(guests.clubId, club.id)) });
    const msgs = await db
      .select()
      .from(messages)
      .where(and(eq(messages.clubId, club.id), eq(messages.guestId, conv.guestId)));
    const evs = await db
      .select()
      .from(events)
      .where(and(eq(events.clubId, club.id), or(eq(events.conversationId, conv.id), eq(events.guestId, conv.guestId))));
    const guestBookings = await db
      .select({ id: bookings.id, refCode: bookings.refCode })
      .from(bookings)
      .where(and(eq(bookings.clubId, club.id), eq(bookings.guestId, conv.guestId)));
    const history = guestBookings.length
      ? await db.select().from(bookingStatusHistory).where(inArray(bookingStatusHistory.bookingId, guestBookings.map((b) => b.id)))
      : [];
    // Deliveries that carry this guest's LINE id (B3 may later link raw rows to messages directly).
    const raws = guest?.lineUserId
      ? await db
          .select()
          .from(rawWebhooks)
          .where(and(eq(rawWebhooks.clubId, club.id), sql`${rawWebhooks.body}::text like ${'%' + guest.lineUserId + '%'}`))
      : [];
    const items = [
      ...raws.map((w) => ({
        at: w.receivedAt,
        kind: 'raw_webhook' as const,
        id: w.id,
        signatureOk: w.signatureOk,
        result: w.error ? 'error' : w.processedAt ? 'processed' : 'pending',
        error: w.error,
      })),
      ...msgs.map((m) => {
        const { kind: messageKind, ...rest } = messageShape(m);
        return { ...rest, at: m.occurredAt ?? m.createdAt, kind: 'message' as const, messageKind };
      }),
      ...evs.map((e) => ({ at: e.occurredAt, kind: 'event' as const, id: e.id, type: e.type, actorType: e.actorType, bookingId: e.bookingId, props: e.props })),
      ...history.map((h) => ({
        at: h.at,
        kind: 'booking_change' as const,
        id: h.id,
        bookingId: h.bookingId,
        from: h.fromStatus,
        to: h.toStatus,
        actorType: h.actorType,
        actorId: h.actorId,
        reasonCode: h.reasonCode,
      })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
    return c.json({
      conversation: { id: conv.id, guestId: conv.guestId, mode: conv.mode },
      items: items.map((i) => ({ ...i, at: i.at.toISOString() })),
    });
  });

  r.get('/clubs/:slug/bookings/:id/timeline', async (c) => {
    const club = c.var.debugClub;
    const view = await getBookingView(db, { clubId: club.id, id: c.req.param('id') });
    if (!view) return c.json({ error: 'not_found' }, 404);
    await auditView(db, c, 'booking', view.booking.id);
    const history = await db
      .select()
      .from(bookingStatusHistory)
      .where(eq(bookingStatusHistory.bookingId, view.booking.id))
      .orderBy(asc(bookingStatusHistory.at));
    return c.json({
      booking: { id: view.booking.id, ref: view.booking.refCode, status: view.booking.status, nightDate: view.booking.nightDate },
      history: history.map((h) => ({
        at: h.at.toISOString(),
        from: h.fromStatus,
        to: h.toStatus,
        actorType: h.actorType,
        actorId: h.actorId,
        reasonCode: h.reasonCode,
      })),
    });
  });

  // B3: a dry run (one transaction, always rolled back, nothing sent); shows the replies even
  // when the delivery was already processed.
  r.post('/clubs/:slug/webhooks/:id/replay', async (c) => {
    const [raw] = await db
      .select({ id: rawWebhooks.id, signatureOk: rawWebhooks.signatureOk, channel: rawWebhooks.channel })
      .from(rawWebhooks)
      .where(and(eq(rawWebhooks.clubId, c.var.debugClub.id), eq(rawWebhooks.id, c.req.param('id'))))
      .limit(1);
    if (!raw) return c.json({ error: 'not_found' }, 404);
    if (!raw.signatureOk || raw.channel !== 'line') return c.json({ error: 'not_replayable' }, 409);
    await auditView(db, c, 'raw_webhooks', raw.id);
    try {
      const result = await processDelivery(app, raw.id, { dryRun: true });
      return c.json({ dryRun: true, ...result });
    } catch (err) {
      return c.json({ error: 'replay_failed', message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  r.post('/clubs/:slug/test-message', async (c) => {
    const parsed = testMessageBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const club = c.var.debugClub;
    // Deferred (sync/track-a.md, A5): no founder LINE user id is stored yet, so "our own LINE
    // account" cannot be addressed (spec §12.3). Storing it needs a users column (migration) and a
    // way to capture the id; until then `to: 'self'` answers 501 and an it.todo tracks it.
    if (parsed.data.to === 'self') return c.json({ error: 'not_ready' }, 501);
    if (!club.staffGroupId) return c.json({ error: 'no_staff_group' }, 409);
    const gateway = await app.gateways.forClub(club);
    await app.deps.outbox.toStaff(gateway, club, [{ type: 'text', text: 'Test message from the platform team. No action needed.' }]);
    return c.json({ ok: true });
  });

  return r;
}

function messageShape(m: typeof messages.$inferSelect) {
  return {
    id: m.id,
    direction: m.direction,
    kind: m.kind,
    target: m.target,
    guestId: m.guestId,
    authorType: m.authorType,
    sentVia: m.sentVia,
    deliveryStatus: m.deliveryStatus,
    error: m.error,
    payload: m.payload,
    createdAt: m.createdAt.toISOString(),
  };
}
