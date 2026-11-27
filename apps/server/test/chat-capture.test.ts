import { randomUUID } from 'node:crypto';
import type { webhook } from '@line/bot-sdk';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { processEvent } from '../src/bot/flow.js';
import { DATA_NOTICE_VERSION } from '../src/bot/i18n.js';
import { getBookingView, holdTable, requestDeposit, submitDetails } from '../src/bookings/service.js';
import * as M from '../src/bot/messages.js';
import { bookings, channels, clubs, conversations, events, guests, messages, notices, promoterAttributions, promoters } from '../src/db/schema.js';
import { SIM_USER_PREFIX } from '../src/line/gateway.js';
import { richMenuRequest } from '../src/line/setup.js';
import { createPromoter } from '../src/platform/promoters.js';
import { FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupDb } from './helpers.js';
import { testConfig } from './helpers/track-a.js';

const config = testConfig({ PUBLIC_URL: 'https://club.test' });

let ctx: Awaited<ReturnType<typeof setupDb>>;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  ctx = await setupDb();
  app = createApp(config, ctx.db, { bot: { now: () => FRIDAY_AFTERNOON, log: () => {} } });
});
afterEach(async () => {
  await ctx.close();
});

const userId = (u: string) => `${SIM_USER_PREFIX}${u}`;

function base(u: string) {
  return {
    timestamp: FRIDAY_AFTERNOON.getTime() - 1500,
    mode: 'active' as const,
    webhookEventId: randomUUID(),
    deliveryContext: { isRedelivery: false },
    source: { type: 'user' as const, userId: userId(u) },
    replyToken: randomUUID(),
  };
}
const textEvent = (u: string, text: string): webhook.Event => ({
  ...base(u),
  type: 'message',
  message: { type: 'text', id: randomUUID(), text, quoteToken: 'q' },
});
const postbackEvent = (u: string, data: string): webhook.Event => ({ ...base(u), type: 'postback', postback: { data } });

const run = (e: webhook.Event) => processEvent(app.ctx.deps, ctx.club, app.ctx.gateways.dev, e);
const guestOf = async (u: string) => (await ctx.db.query.guests.findFirst({ where: eq(guests.lineUserId, userId(u)) }))!;
const rowsOf = async (u: string) => {
  const g = await guestOf(u);
  return ctx.db.select().from(messages).where(eq(messages.guestId, g.id)).orderBy(asc(messages.createdAt));
};
const eventsOf = (type: string) => ctx.db.select().from(events).where(and(eq(events.clubId, ctx.club.id), eq(events.type, type)));

/** night → 5–8 guests → the table, after the tap that started the attempt. */
async function walkToHold(u: string, table = 'table_demo_B1') {
  await run(postbackEvent(u, `a=night&d=${FRIDAY}`));
  await run(postbackEvent(u, 'a=pax&r=5-8'));
  await run(postbackEvent(u, `a=table&t=${table}&d=${FRIDAY}`));
}

describe('full chat capture (B4)', () => {
  it('inbound payload is stored whole', async () => {
    const e = textEvent('cap1', 'hello there');
    await run(e);
    const [inbound] = (await rowsOf('cap1')).filter((m) => m.direction === 'in');
    expect(inbound!.payload).toEqual(e);
    expect(inbound!.authorType).toBe('guest');
    expect(inbound!.channelId).toBe(`chan_line_${ctx.club.id}`);
    expect(inbound!.occurredAt?.getTime()).toBe(FRIDAY_AFTERNOON.getTime() - 1500);
  });

  it('bot and guest messages have different authors', async () => {
    await run(textEvent('cap2', 'book a table'));
    const rows = await rowsOf('cap2');
    const g = await guestOf('cap2');
    expect(rows.filter((m) => m.direction === 'in').map((m) => [m.authorType, m.authorId])).toEqual([['guest', g.id]]);
    const out = rows.filter((m) => m.direction === 'out');
    expect(out.length).toBeGreaterThan(0);
    for (const m of out) {
      expect(m.authorType).toBe('bot');
      expect(m.authorId).toBeNull();
      expect(m.channelId).toBe(`chan_line_${ctx.club.id}`);
    }
  });

  it('staff reply is stored with author_type staff and the staff user id', async () => {
    await run(textEvent('cap3', 'hi'));
    const g = await guestOf('cap3');
    await app.ctx.notifier.hostReply(ctx.club.id, g.id, 'See you tonight!', { type: 'staff', id: 'user_host_1', sessionId: 's1' });
    const reply = (await rowsOf('cap3')).find((m) => (m.payload as { text?: string }).text === 'See you tonight!');
    expect(reply).toMatchObject({ direction: 'out', authorType: 'staff', authorId: 'user_host_1' });
  });
});

describe('entry tags and attempts (B4)', () => {
  it('search with no free table records result_count 0', async () => {
    // V1 and V2 are the only tables for 9–12; both are taken.
    for (const tableId of ['table_demo_V1', 'table_demo_V2']) {
      const other = await makeGuest(ctx.db);
      await holdTable(ctx.db, ctx.club, { guestId: other.id, tableId, nightDate: FRIDAY, pax: 10 }, FRIDAY_AFTERNOON);
    }
    await run(postbackEvent('zero', 'a=book&s=rm_book'));
    await run(postbackEvent('zero', `a=night&d=${FRIDAY}`));
    await run(postbackEvent('zero', 'a=pax&r=9-12'));
    const [searched] = await eventsOf('availability.searched');
    expect(searched!.props).toEqual({ night_date: FRIDAY, pax_range: 'p9_12', result_count: 0, tables_shown: 0 });
    expect(searched!.nightDate).toBe(FRIDAY);
  });

  it('entry tag flows from postback to booking events', async () => {
    await run(postbackEvent('tag1', 'a=book&s=rm_book'));
    await walkToHold('tag1');
    const conv = (await ctx.db.query.conversations.findFirst({ where: eq(conversations.guestId, (await guestOf('tag1')).id) }))!;
    expect(conv.state.entry).toBe('rm_book');
    const attemptId = conv.state.attemptId!;
    expect(attemptId).toBeTruthy();
    const [searched] = await eventsOf('availability.searched');
    const [held] = await eventsOf('table.held');
    expect(searched).toMatchObject({ source: 'rm_book', attemptId });
    expect(held).toMatchObject({ source: 'rm_book', attemptId });
    const [booking] = await ctx.db.select().from(bookings).where(eq(bookings.id, held!.bookingId!));
    expect(booking!.attemptId).toBe(attemptId);
    // Later events of the same attempt carry the entry tag too.
    await submitDetails(ctx.db, ctx.club, booking!.id, { name: 'Tag Guest', phone: '0812345678', nationality: 'TH', pax: 6 }, FRIDAY_AFTERNOON);
    await requestDeposit(ctx.db, ctx.club, booking!.id, FRIDAY_AFTERNOON);
    const [details] = await eventsOf('details.submitted');
    expect(details).toMatchObject({ source: 'rm_book', attemptId });
    const later = (await ctx.db.select().from(events).where(eq(events.bookingId, booking!.id))).filter((e) => e.type !== 'table.held');
    expect(later.length).toBeGreaterThan(1);
    for (const e of later) expect(e).toMatchObject({ source: 'rm_book', attemptId });
  });

  it('pax range is stored as a code', async () => {
    await run(postbackEvent('pax1', 'a=book&s=qr_book'));
    await run(postbackEvent('pax1', `a=night&d=${FRIDAY}`));
    await run(postbackEvent('pax1', 'a=pax&r=5-8'));
    const [searched] = await eventsOf('availability.searched');
    expect(searched!.props).toMatchObject({ pax_range: 'p5_8' });
    expect((searched!.props as { result_count: number }).result_count).toBeGreaterThan(0);
  });

  it('postback without s is tagged rm_unknown', async () => {
    await run(postbackEvent('old1', 'a=book'));
    await walkToHold('old1');
    const [searched] = await eventsOf('availability.searched');
    const [held] = await eventsOf('table.held');
    expect(searched!.source).toBe('rm_unknown');
    expect(held!.source).toBe('rm_unknown');
  });

  it('typed booking text is tagged text_intent, and "Another night" keeps the attempt', async () => {
    await run(textEvent('txt1', 'I want to book a table'));
    const g = await guestOf('txt1');
    const first = (await ctx.db.query.conversations.findFirst({ where: eq(conversations.guestId, g.id) }))!.state;
    expect(first.entry).toBe('text_intent');
    await run(postbackEvent('txt1', 'a=book&s=other_night'));
    const after = (await ctx.db.query.conversations.findFirst({ where: eq(conversations.guestId, g.id) }))!.state;
    expect(after).toMatchObject({ entry: 'text_intent', attemptId: first.attemptId });
    // A new tap from the menu is a new attempt.
    await run(postbackEvent('txt1', 'a=book&s=rm_book'));
    const fresh = (await ctx.db.query.conversations.findFirst({ where: eq(conversations.guestId, g.id) }))!.state;
    expect(fresh.entry).toBe('rm_book');
    expect(fresh.attemptId).not.toBe(first.attemptId);
  });

  it('rich menu postbacks carry rm_book, rm_my and rm_host', () => {
    const data = (richMenuRequest(ctx.club).areas ?? [])
      .map((a) => a.action)
      .filter((a) => a?.type === 'postback')
      .map((a) => (a as { data: string }).data);
    expect(data).toEqual(['a=book&s=rm_book', 'a=my&s=rm_my', 'a=host&s=rm_host']);
  });
});

describe('data notice (B4, spec §5.5)', () => {
  it('data notice shown once and recorded with its version', async () => {
    await run(textEvent('n1', 'hello'));
    const firstOut = (await rowsOf('n1')).filter((m) => m.direction === 'out');
    expect((firstOut[0]!.payload as { text: string }).text).toContain('Chats and bookings with Velora (Demo) are stored');
    expect((firstOut[0]!.payload as { text: string }).text).toContain('https://club.test/privacy');
    // The menu (with its quick replies) is still the last message of the reply.
    expect((firstOut.at(-1)!.payload as { quickReply?: unknown }).quickReply).toBeDefined();

    await run(textEvent('n1', 'hello again'));
    const allOut = (await rowsOf('n1')).filter((m) => m.direction === 'out');
    const noticeLines = allOut.filter((m) => String((m.payload as { text?: string }).text ?? '').includes('Chats and bookings with'));
    expect(noticeLines).toHaveLength(1);

    const g = await guestOf('n1');
    const rows = await ctx.db.select().from(notices).where(and(eq(notices.guestId, g.id), eq(notices.purpose, 'data')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clubId: ctx.club.id, textVersion: DATA_NOTICE_VERSION, channel: 'line', acceptedAt: null });
    expect(rows[0]!.shownAt?.getTime()).toBe(FRIDAY_AFTERNOON.getTime());
    const shown = await eventsOf('notice.shown');
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ guestId: g.id, props: { notice_id: rows[0]!.id, purpose: 'data', text_version: DATA_NOTICE_VERSION } });
  });

  it('two deliveries racing on first contact show the notice once', async () => {
    await Promise.all([run(textEvent('race1', 'hi')), run(textEvent('race1', 'hello'))]);
    const out = (await rowsOf('race1')).filter((m) => m.direction === 'out');
    const noticeLines = out.filter((m) => String((m.payload as { text?: string }).text ?? '').includes('Chats and bookings with'));
    expect(noticeLines).toHaveLength(1);
    const g = await guestOf('race1');
    expect(await ctx.db.select().from(notices).where(eq(notices.guestId, g.id))).toHaveLength(1);
  });

  it('privacy page serves the notice', async () => {
    const res = await app.app.request('/privacy');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data controller');
  });
});

describe('counted redirects (B4)', () => {
  it('redirect link tap is counted', async () => {
    const link = app.ctx.deps.links.tracked(ctx.club, 'map', 'text_location');
    const path = new URL(link).pathname;
    expect(path.startsWith('/r/')).toBe(true);
    const res = await app.app.request(path);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(ctx.club.settings.mapUrl);
    const opened = await eventsOf('link.opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ source: 'text_location', props: { kind: 'map' }, isTest: true });

    // A forged or altered code is not counted.
    const forged = await app.app.request(path.replace('text_location', 'rm_book'));
    expect(forged.status).toBe(404);
    expect(await eventsOf('link.opened')).toHaveLength(1);
  });

  it('the location reply sends the counted map link', async () => {
    await run(textEvent('loc1', 'where are you located?'));
    const out = (await rowsOf('loc1')).filter((m) => m.direction === 'out');
    expect((out.at(-1)!.payload as { text: string }).text).toContain('https://club.test/r/map.demo.text_location.');
  });

  it('menu, confirmation and rich-menu location links go through the counted redirect', async () => {
    await ctx.db
      .update(clubs)
      .set({ settings: { ...ctx.club.settings, drinksMenuUrl: 'https://club.test/drinks.pdf' } })
      .where(eq(clubs.id, ctx.club.id));
    ctx.club = (await ctx.db.query.clubs.findFirst({ where: eq(clubs.id, ctx.club.id) }))!;
    const links = app.ctx.deps.links;
    const uris = (items: { action: { type: string; uri?: string } }[]) => items.filter((i) => i.action.type === 'uri').map((i) => i.action.uri);
    expect(uris(M.menuQuickReplies(ctx.club, 'en', links) as never)).toEqual([
      links.tracked(ctx.club, 'drinks', 'qr_drinks'),
      links.tracked(ctx.club, 'map', 'qr_location'),
    ]);
    expect(uris(M.menuQuickReplies(ctx.club, 'en', links, 'greet') as never)).toEqual([
      links.tracked(ctx.club, 'drinks', 'greet_drinks'),
      links.tracked(ctx.club, 'map', 'greet_location'),
    ]);
    // The confirmation card's Location button.
    await run(postbackEvent('conf1', 'a=book&s=rm_book'));
    await walkToHold('conf1');
    const [held] = await eventsOf('table.held');
    const view = (await getBookingView(ctx.db, { clubId: ctx.club.id, id: held!.bookingId! }))!;
    const card = JSON.stringify(M.confirmation(ctx.club, 'en', view, links.pass(view.booking), links));
    expect(card).toContain(links.tracked(ctx.club, 'map', 'confirm_location'));
    expect(card).not.toContain(ctx.club.settings.mapUrl);
    // The rich menu's Location cell, as runLineSetup creates it.
    const cell = (richMenuRequest(ctx.club, links).areas ?? []).map((a) => a.action).find((a) => a?.type === 'uri') as { uri: string };
    expect(cell.uri).toBe(links.tracked(ctx.club, 'map', 'rm_location'));
    const res = await app.app.request(new URL(cell.uri).pathname);
    expect(res.status).toBe(302);
    expect((await eventsOf('link.opened')).map((e) => e.source)).toEqual(['rm_location']);
  });

  it('the details link tap is counted once, at the first booking read, with the entry tag', async () => {
    await run(postbackEvent('det1', 'a=book&s=rm_book'));
    await walkToHold('det1');
    const out = (await rowsOf('det1')).filter((m) => m.direction === 'out');
    const url = JSON.stringify(out.map((m) => m.payload)).match(/https:\/\/club\.test\/liff\/details\?[^"\\]+/)![0];
    const q = new URL(url).searchParams;
    const path = `/api/liff/booking?ref=${q.get('ref')}&t=${encodeURIComponent(q.get('t')!)}`;
    expect((await app.app.request(path)).status).toBe(200);
    expect((await app.app.request(path)).status).toBe(200);
    const opened = await eventsOf('link.opened');
    expect(opened).toHaveLength(1);
    const [held] = await eventsOf('table.held');
    expect(opened[0]).toMatchObject({ source: 'rm_book', props: { kind: 'details' }, bookingId: held!.bookingId, attemptId: held!.attemptId });
  });

  it('promoter link tap is counted and the hold is attributed to the promoter', async () => {
    const promoter = await createPromoter(ctx.db, ctx.club.id, { name: 'Ari', code: 'ari' }, FRIDAY_AFTERNOON);
    await ctx.db.update(channels).set({ externalId: '@velora' }).where(eq(channels.id, `chan_line_${ctx.club.id}`));
    const res = await app.app.request(`/r/p/${ctx.club.slug}/ARI`);
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location.startsWith('https://line.me/R/oaMessage/%40velora/?')).toBe(true);
    const text = decodeURIComponent(location.split('?')[1]!);
    expect(text).toBe('Book a table · promo ari');
    expect((await eventsOf('link.opened'))[0]).toMatchObject({ source: 'link_promoter', props: { kind: 'promoter' } });

    // The guest sends the pre-filled text, then books.
    await run(textEvent('promo1', text));
    await walkToHold('promo1');
    const [held] = await eventsOf('table.held');
    expect(held!.source).toBe('link_promoter');
    const [booking] = await ctx.db.select().from(bookings).where(eq(bookings.id, held!.bookingId!));
    expect(booking!.source).toBe('promoter');
    const [attr] = await ctx.db.select().from(promoterAttributions).where(eq(promoterAttributions.bookingId, booking!.id));
    expect(attr).toMatchObject({ promoterId: promoter.id, via: 'link' });

    // Unknown promoter: 404, nothing counted.
    expect((await app.app.request(`/r/p/${ctx.club.slug}/nobody`)).status).toBe(404);
    expect(await eventsOf('link.opened')).toHaveLength(1);
  });

  it('only the exact pre-filled text of an enabled promoter starts a promoter attempt', async () => {
    const promoter = await createPromoter(ctx.db, ctx.club.id, { name: 'Bo', code: 'tonight' }, FRIDAY_AFTERNOON);
    // Ordinary questions that mention a promo, and codes no enabled promoter holds, are not promoter links.
    for (const [u, text] of [
      ['q1', 'any promo tonight?'],
      ['q2', 'what promo codes do you have'],
      ['q3', 'Book a table · promo nobody'],
    ] as const) {
      await run(textEvent(u, text));
      const state = (await ctx.db.query.conversations.findFirst({ where: eq(conversations.guestId, (await guestOf(u)).id) }))?.state;
      expect(state?.entry).not.toBe('link_promoter');
      expect(state?.promoterCode).toBeUndefined();
    }
    // Disabled after the guest sent the text: the hold is not a promoter booking.
    await run(textEvent('q4', 'Book a table · promo tonight'));
    await ctx.db.update(promoters).set({ disabledAt: FRIDAY_AFTERNOON }).where(eq(promoters.id, promoter.id));
    await walkToHold('q4');
    const [held] = await eventsOf('table.held');
    const [booking] = await ctx.db.select().from(bookings).where(eq(bookings.id, held!.bookingId!));
    expect(booking!.source).not.toBe('promoter');
    expect(await ctx.db.select().from(promoterAttributions).where(eq(promoterAttributions.bookingId, booking!.id))).toHaveLength(0);
  });
});
