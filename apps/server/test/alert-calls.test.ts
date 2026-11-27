import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { alertBrainWaiting, alertNoArrival } from '../src/bot/alerts.js';
import { getBookingView, holdTable, requestDeposit, submitDetails } from '../src/bookings/service.js';
import type { Db } from '../src/db/client.js';
import { alerts, clubs, conversations, guests, messages, platformFlags, type Club } from '../src/db/schema.js';
import { featuresFlagKey } from '../src/platform/features.js';
import type { CredentialStore } from '../src/line/credentials.js';
import type { LineGateway, Message } from '../src/line/gateway.js';
import { newId } from '../src/lib/util.js';
import { resolveOpenAlerts } from '../src/platform/alerts.js';
import { FRIDAY, FRIDAY_AFTERNOON, setupDb } from './helpers.js';
import { staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

/** Plan B19b: Track B's staff alerts go through A15's raiseAlert at the §6.4 level. */
const SECRET = 'alert-calls-secret';
const GROUP = 'Calertgroup';
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);

type Sent = { via: 'reply' | 'push'; to: string; messages: Message[] };

function fakeGateway(over: Partial<LineGateway> = {}): LineGateway & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    live: true,
    sent,
    reply: async (to, msgs) => void sent.push({ via: 'reply', to, messages: msgs }),
    push: async (to, msgs) => void sent.push({ via: 'push', to, messages: msgs }),
    getContent: async () => FAKE_JPEG,
    getProfile: async () => ({ displayName: 'Alert guest', language: 'en' }),
    loading: async () => {},
    ...over,
  };
}

const credentials: CredentialStore = {
  channelSecret: async () => SECRET,
  line: async () => ({ channelSecret: SECRET, accessToken: 'fake-token' }),
  login: async () => null,
};

let db: Db;
let close: () => Promise<void>;
let club: Club;
let clock: Date;
let created: ReturnType<typeof createApp>;
let gw: ReturnType<typeof fakeGateway>;

function useGateway(g: ReturnType<typeof fakeGateway>) {
  gw = g;
  created.ctx.gateways.forClub = async () => gw;
}

beforeEach(async () => {
  ({ db, close, club } = await setupDb());
  await db.update(clubs).set({ staffGroupId: GROUP }).where(eq(clubs.id, club.id));
  club = (await db.query.clubs.findFirst({ where: eq(clubs.id, club.id) }))!;
  clock = FRIDAY_AFTERNOON;
  created = createApp(testConfig(), db, { bot: { now: () => clock, log: () => {} }, credentials });
  useGateway(fakeGateway());
});
afterEach(async () => {
  await created.settle();
  await close();
});

function event(userId: string, message: Record<string, unknown>) {
  const id = newId();
  return {
    destination: 'Ubot',
    events: [
      {
        type: 'message',
        mode: 'active',
        timestamp: clock.getTime(),
        webhookEventId: id,
        deliveryContext: { isRedelivery: false },
        source: { type: 'user', userId },
        replyToken: `rt-${id}`,
        message: { id: `m-${id}`, ...message },
      },
    ],
  };
}
const text = (userId: string, t: string) => event(userId, { type: 'text', text: t, quoteToken: 'q' });
const image = (userId: string) => event(userId, { type: 'image', contentProvider: { type: 'line' }, quoteToken: 'q' });

async function post(body: unknown) {
  const raw = JSON.stringify(body);
  const sig = createHmac('sha256', SECRET).update(raw).digest('base64');
  const res = await created.app.request(`/line/webhook/${club.slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sig },
    body: raw,
  });
  await created.settle();
  expect(res.status).toBe(200);
}

const clubAlerts = () => db.select().from(alerts).where(eq(alerts.clubId, club.id));
const groupPushes = () => gw.sent.filter((s) => s.to === GROUP);
const staffRows = () => db.select().from(messages).where(and(eq(messages.clubId, club.id), eq(messages.target, 'staff')));

async function guestOf(userId: string) {
  return (await db.query.guests.findFirst({ where: and(eq(guests.clubId, club.id), eq(guests.lineUserId, userId)) }))!;
}

/** A booking of `userId` waiting for its slip (held, details in, deposit requested). */
async function awaitingSlip(userId: string) {
  await post(text(userId, 'hello'));
  const guest = await guestOf(userId);
  const held = await holdTable(db, club, { guestId: guest.id, tableId: 'table_demo_B1', nightDate: FRIDAY, pax: 6 }, clock);
  await submitDetails(db, club, held.id, { name: 'Ari', phone: '0812345678', nationality: 'Thai', pax: 6 }, clock);
  await requestDeposit(db, club, held.id, clock);
  return held.id;
}

describe('B19b alert call sites', () => {
  it('urgent alert reaches inbox and staff group within 5 s', async () => {
    const started = Date.now();
    await post(text('Uhost1', 'can I talk to a staff member please'));
    expect(Date.now() - started).toBeLessThan(5_000);
    const [a] = await clubAlerts();
    expect(a).toMatchObject({ level: 'urgent', kind: 'guest_wants_human', resolvedAt: null });
    expect(a!.conversationId).not.toBeNull();
    expect(a!.sentLineAt).not.toBeNull();
    expect(a!.sentLineAt!.getTime() - a!.createdAt.getTime()).toBeLessThan(5_000);
    expect(groupPushes()).toHaveLength(1);
    const body = (groupPushes()[0]!.messages[0] as { text: string }).text;
    expect(body).toContain('[URGENT]');
    expect(body).toContain('ด่วน');
    // The inbox feed shows it.
    const cookie = await staffCookie(created, club);
    const feed = (await (await created.app.request(staffUrl(club.slug, '/feed'), { headers: { cookie } })).json()) as any;
    expect(feed.alerts.map((x: any) => x.kind)).toContain('guest_wants_human');
    expect(feed.counts.urgent).toBe(1);
  });

  it('a paused club raises one alert per conversation per pause through raiseAlert', async () => {
    await db.update(clubs).set({ botPaused: true, botPausedAt: clock }).where(eq(clubs.id, club.id));
    await post(text('Upause1', 'hello'));
    await post(text('Upause1', 'anyone?'));
    await post(text('Upause2', 'hello'));
    const rows = await clubAlerts();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.level === 'urgent' && r.kind === 'bot_paused')).toBe(true);
    expect(new Set(rows.map((r) => r.conversationId)).size).toBe(2);
    expect(groupPushes()).toHaveLength(2);
    expect(gw.sent.filter((s) => s.to !== GROUP)).toHaveLength(0); // nothing to the guests

    // A new pause alerts the same conversation once more.
    await db.update(clubs).set({ botPaused: true, botPausedAt: new Date(clock.getTime() + 3_600_000) }).where(eq(clubs.id, club.id));
    await post(text('Upause1', 'hello again'));
    await post(text('Upause1', 'hello?'));
    expect(await clubAlerts()).toHaveLength(3);
  });

  it('a complaint word raises urgent', async () => {
    await post(text('Ucomp1', 'my friend got hurt near the bar, please help'));
    const [a] = await clubAlerts();
    expect(a).toMatchObject({ level: 'urgent', kind: 'complaint' });
    expect(a!.sentLineAt).not.toBeNull();
    const guest = await guestOf('Ucomp1');
    const conv = (await db.query.conversations.findFirst({ where: eq(conversations.guestId, guest.id) }))!;
    expect(a!.conversationId).toBe(conv.id);
    expect(conv.mode).toBe('human'); // handed to a host
    // Thai works too, in another conversation.
    await post(text('Ucomp2', 'จะแจ้งตำรวจนะ'));
    expect((await clubAlerts()).filter((r) => r.kind === 'complaint')).toHaveLength(2);
  });

  it("a club's own word list replaces the default", async () => {
    const cookie = await staffCookie(created, club);
    const res = await created.app.request(staffUrl(club.slug, '/settings'), {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ urgentWords: ['ขี้เมา', 'rude bouncer'] }),
    });
    expect(res.status).toBe(200);
    await post(text('Uown1', 'I want a refund')); // a default word, not on this club's list
    expect(await clubAlerts()).toHaveLength(0);
    await post(text('Uown2', 'the RUDE BOUNCER pushed us'));
    expect((await clubAlerts()).map((r) => r.kind)).toEqual(['complaint']);
  });

  it('a slip waiting for review raises urgent payment_review', async () => {
    const bookingId = await awaitingSlip('Uslip1');
    await post(image('Uslip1'));
    const [a] = await clubAlerts();
    expect(a).toMatchObject({ level: 'urgent', kind: 'payment_review', bookingId });
    expect(a!.textEn).toContain('Slip to check');
    expect(a!.textEn).toContain('B1');
    expect(a!.textTh).toContain('ตรวจสลิป');
    expect(groupPushes()).toHaveLength(1);
  });

  it('a confirmed booking raises info and sends no LINE push by default', async () => {
    const bookingId = await awaitingSlip('Uconf1');
    await post(image('Uconf1'));
    const pushesBefore = groupPushes().length;
    const staffBefore = (await staffRows()).length;
    const cookie = await staffCookie(created, club);
    const approve = await created.app.request(staffUrl(club.slug, `/bookings/${bookingId}/approve`), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(approve.status).toBe(200);
    await created.settle();
    const info = (await clubAlerts()).filter((r) => r.kind === 'booking_confirmed');
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({ level: 'info', bookingId, sentLineAt: null });
    expect(info[0]!.textEn).toContain('Ari (Thai) · 0812345678');
    expect(groupPushes()).toHaveLength(pushesBefore);
    expect(await staffRows()).toHaveLength(staffBefore);
  });

  it('a bot error raises one urgent alert while it stays open', async () => {
    useGateway(fakeGateway({ getProfile: async () => { throw new Error('profile lookup exploded'); } }));
    await post(text('Uerr1', 'hello'));
    await post(text('Uerr2', 'hello'));
    let rows = (await clubAlerts()).filter((r) => r.kind === 'bot_error');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: 'urgent' });
    expect(groupPushes()).toHaveLength(1);
    // Once staff resolve it, the next error alerts again.
    await resolveOpenAlerts(db, club.id, 'bot_error', clock);
    await post(text('Uerr3', 'hello'));
    rows = (await clubAlerts()).filter((r) => r.kind === 'bot_error');
    expect(rows).toHaveLength(2);
  });

  it('a release time passed with no arrival raises urgent', async () => {
    const bookingId = await awaitingSlip('Unoshow1');
    const view = (await getBookingView(db, { clubId: club.id, id: bookingId }))!;
    await alertNoArrival(db, view, clock);
    const [a] = (await clubAlerts()).filter((r) => r.kind === 'no_arrival');
    expect(a).toMatchObject({ level: 'urgent', bookingId });
    expect(a!.sentLineAt).not.toBeNull();
    expect(groupPushes()).toHaveLength(1);
  });

  it('a waiting draft raises needs-input', async () => {
    await alertBrainWaiting(db, { clubId: club.id, kind: 'brain_draft_waiting', count: 2 }, clock);
    await alertBrainWaiting(db, { clubId: club.id, kind: 'brain_draft_waiting', count: 3 }, clock); // one open per kind
    const rows = await clubAlerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: 'needs_input', kind: 'brain_draft_waiting', sentLineAt: null });
    expect(groupPushes()).toHaveLength(0);
  });

  it('alerts_line switched off keeps the alert in the feed and sends nothing to the staff group', async () => {
    const value = { alerts_line: false };
    await db.insert(platformFlags).values({ key: featuresFlagKey(club.id), value }).onConflictDoUpdate({ target: platformFlags.key, set: { value } });
    await post(text('Uhost2', 'can I talk to a staff member please'));
    const [a] = await clubAlerts();
    expect(a).toMatchObject({ level: 'urgent', kind: 'guest_wants_human', sentLineAt: null });
    expect(groupPushes()).toHaveLength(0);
  });
});
