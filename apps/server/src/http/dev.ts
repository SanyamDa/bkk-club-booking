import { randomUUID } from 'node:crypto';
import type { webhook } from '@line/bot-sdk';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { handleEvent } from '../bot/flow.js';
import { clubs, guests, messages } from '../db/schema.js';
import { SIM_USER_PREFIX } from '../line/gateway.js';
import type { AppContext } from './context.js';

const eventSchema = z.object({
  userId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  displayName: z.string().max(40).default('Simulator guest'),
  lang: z.enum(['en', 'th']).default('en'),
  type: z.enum(['follow', 'text', 'postback', 'image']),
  text: z.string().max(500).optional(),
  data: z.string().max(300).optional(),
  date: z.string().optional(),
  imageBase64: z.string().max(14_000_000).optional(),
});

/**
 * Local chat simulator (DEV_SIMULATOR=1 only). Builds the same webhook events LINE would send
 * and runs them through the real bot, using the dev gateway so nothing reaches LINE.
 */
export function devRoutes(app: AppContext) {
  const r = new Hono();
  const { db } = app.deps;

  r.post('/:slug/event', async (c) => {
    const club = await db.query.clubs.findFirst({ where: eq(clubs.slug, c.req.param('slug')) });
    if (!club) return c.json({ error: 'not_found' }, 404);
    const parsed = eventSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
    const input = parsed.data;
    const userId = `${SIM_USER_PREFIX}${input.userId}`;
    app.gateways.dev.setProfile(userId, { displayName: input.displayName, language: input.lang });

    const base = {
      timestamp: Date.now(),
      mode: 'active' as const,
      webhookEventId: randomUUID(),
      deliveryContext: { isRedelivery: false },
      source: { type: 'user' as const, userId },
      replyToken: randomUUID(),
    };
    let event: webhook.Event;
    if (input.type === 'follow') {
      event = { ...base, type: 'follow', follow: { isUnblocked: false } };
    } else if (input.type === 'text') {
      event = { ...base, type: 'message', message: { type: 'text', id: randomUUID(), text: input.text ?? '', quoteToken: 'sim' } };
    } else if (input.type === 'postback') {
      event = {
        ...base,
        type: 'postback',
        postback: { data: input.data ?? '', ...(input.date ? { params: { date: input.date } } : {}) },
      };
    } else {
      const id = randomUUID();
      app.gateways.dev.addImage(id, Buffer.from(input.imageBase64 ?? '', 'base64'));
      event = {
        ...base,
        type: 'message',
        message: { type: 'image', id, quoteToken: 'sim', contentProvider: { type: 'line' } },
      };
    }
    await handleEvent(app.deps, club, app.gateways.dev, event);
    return c.json({ ok: true });
  });

  r.get('/:slug/transcript', async (c) => {
    const club = await db.query.clubs.findFirst({ where: eq(clubs.slug, c.req.param('slug')) });
    if (!club) return c.json({ error: 'not_found' }, 404);
    const userId = `${SIM_USER_PREFIX}${c.req.query('userId') ?? ''}`;
    const guest = await db.query.guests.findFirst({ where: and(eq(guests.clubId, club.id), eq(guests.lineUserId, userId)) });
    const rows = guest
      ? await db.select().from(messages).where(eq(messages.guestId, guest.id)).orderBy(asc(messages.createdAt)).limit(300)
      : [];
    const staffRows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.clubId, club.id), isNull(messages.guestId)))
      .orderBy(desc(messages.createdAt))
      .limit(15);
    return c.json({
      messages: rows.map((m) => ({ id: m.id, direction: m.direction, kind: m.kind, payload: m.payload, at: m.createdAt.toISOString() })),
      staffAlerts: staffRows.map((m) => ({ id: m.id, payload: m.payload, at: m.createdAt.toISOString() })),
    });
  });

  return r;
}
