import { createHmac } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { autoReleaseFromPrompt, latestKeep } from '../src/bookings/release-prompt.js';
import { createManualBooking } from '../src/bookings/service.js';
import type { Db } from '../src/db/client.js';
import { alerts, auditLog, bookings, clubs, events, staffGroups, type Club } from '../src/db/schema.js';
import { buildScheduler } from '../src/jobs/index.js';
import { releaseAt } from '../src/jobs/no-show.js';
import type { CredentialStore } from '../src/line/credentials.js';
import type { LineGateway, Message } from '../src/line/gateway.js';
import { newId } from '../src/lib/util.js';
import { FRIDAY, FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

/** Plan B10c (spec §5.2 step 9): the host prompt [Release] [Keep 30 min] for a guest not arrived. */
const SECRET = 'release-prompt-secret';
const GROUP_A = 'Cgroup_a';
const GROUP_B = 'Cgroup_b';
const STAFF = { type: 'staff' as const, id: 'user_staff' };
const MIN = 60_000;

type Sent = { via: 'reply' | 'push'; to: string; messages: Message[] };

function fakeGateway(): LineGateway & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    live: true,
    sent,
    reply: async (to, msgs) => void sent.push({ via: 'reply', to, messages: msgs }),
    push: async (to, msgs) => void sent.push({ via: 'push', to, messages: msgs }),
    getContent: async () => Buffer.alloc(0),
    getProfile: async () => ({ displayName: 'Guest', language: 'en' }),
    loading: async () => {},
  };
}

const credentials: CredentialStore = {
  channelSecret: async () => SECRET,
  line: async () => ({ channelSecret: SECRET, accessToken: 'fake-token' }),
  login: async () => null,
};

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let clubB: Club;
let clock: Date;
let created: ReturnType<typeof createApp>;
let gw: ReturnType<typeof fakeGateway>;

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
  await db.update(clubs).set({ staffGroupId: GROUP_A }).where(eq(clubs.id, clubA.id));
  await db.update(clubs).set({ staffGroupId: GROUP_B }).where(eq(clubs.id, clubB.id));
  clubA = (await db.query.clubs.findFirst({ where: eq(clubs.id, clubA.id) }))!;
  clock = FRIDAY_AFTERNOON;
  created = createApp(testConfig(), db, { bot: { now: () => clock, log: () => {} }, credentials });
  gw = fakeGateway();
  created.ctx.gateways.forClub = async () => gw;
});
afterEach(async () => {
  await created.settle();
  await close();
});

const run = async (at: Date) => {
  clock = at;
  await buildScheduler(created.ctx, () => at).runOnce('no-show', at);
  await created.settle();
};

async function confirmed(tableId = 'table_demo_B1') {
  return createManualBooking(db, clubA, { tableId, nightDate: FRIDAY, pax: 4, name: 'Ari', depositPaid: true }, STAFF, clock);
}

const bookingOf = async (id: string) => (await db.query.bookings.findFirst({ where: eq(bookings.id, id) }))!;
const prompts = (bookingId: string) =>
  db.select().from(alerts).where(and(eq(alerts.bookingId, bookingId), eq(alerts.kind, 'no_arrival'))).orderBy(asc(alerts.createdAt));
const groupPushes = (group = GROUP_A) => gw.sent.filter((s) => s.via === 'push' && s.to === group);
const replies = () => gw.sent.filter((s) => s.via === 'reply');

/** The postback `data` of the button labelled `label` on the newest prompt card in the group. */
function buttonData(label: string, group = GROUP_A): string {
  const card = groupPushes(group).at(-1)!.messages[0] as any;
  expect(card.type).toBe('flex');
  const btn = card.contents.footer.contents.find((c: any) => c.action.label.startsWith(label));
  return btn.action.data as string;
}

async function tap(slug: string, groupId: string, data: string) {
  const id = newId();
  const raw = JSON.stringify({
    destination: 'Ubot',
    events: [
      {
        type: 'postback',
        mode: 'active',
        timestamp: clock.getTime(),
        webhookEventId: id,
        deliveryContext: { isRedelivery: false },
        source: { type: 'group', groupId, userId: 'Ustaffer' },
        replyToken: `rt-${id}`,
        postback: { data },
      },
    ],
  });
  const res = await created.app.request(`/line/webhook/${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': createHmac('sha256', SECRET).update(raw).digest('base64') },
    body: raw,
  });
  await created.settle();
  expect(res.status).toBe(200);
}

describe('host release prompt (B10c)', () => {
  it('prompt sent once at the release time', async () => {
    const b = await confirmed();
    const release = releaseAt(clubA, b);
    await run(new Date(release.getTime() - MIN));
    expect(await prompts(b.id)).toHaveLength(0);

    await run(release);
    const [p] = await prompts(b.id);
    expect(p).toMatchObject({ level: 'urgent', bookingId: b.id, resolvedAt: null });
    expect(p!.textEn).toContain('Not arrived at release time: release table?');
    expect(p!.textEn).toContain('B1'); // bookingText adds the table line
    expect(p!.sentLineAt).not.toBeNull();
    // The staff group gets one card with the two buttons.
    expect(groupPushes()).toHaveLength(1);
    expect(buttonData('Release')).toBe(`a=ns_release&b=${b.id}`);
    expect(buttonData('Keep 30 min')).toBe(`a=ns_keep&b=${b.id}&al=${p!.id}`);
    // The table is not released by the prompt itself.
    expect((await bookingOf(b.id)).status).toBe('confirmed');

    await run(new Date(release.getTime() + MIN));
    await run(new Date(release.getTime() + 5 * MIN));
    expect(await prompts(b.id)).toHaveLength(1);
    expect(groupPushes()).toHaveLength(1);
  });

  it('Release releases the table', async () => {
    const b = await confirmed();
    const release = releaseAt(clubA, b);
    await run(release);
    clock = new Date(release.getTime() + 2 * MIN);
    await tap(clubA.slug, GROUP_A, buttonData('Release'));

    const after = await bookingOf(b.id);
    expect(after.status).toBe('no_show');
    expect(after.releasedAt?.toISOString()).toBe(clock.toISOString());
    expect(await db.select().from(events).where(and(eq(events.bookingId, b.id), eq(events.type, 'table.released')))).toHaveLength(1);
    const [p] = await prompts(b.id);
    expect(p!.resolvedAt).not.toBeNull();
    expect(JSON.stringify(replies().at(-1)!.messages)).toContain('Released B1');
    // The table can be sold again for the night.
    const again = await createManualBooking(db, clubA, { tableId: 'table_demo_B1', nightDate: FRIDAY, pax: 4, name: 'Bo', depositPaid: false }, STAFF, clock);
    expect(again.status).toBe('confirmed');

    // The dashboard has the same answer, club-scoped.
    const other = await confirmed('table_demo_B2');
    await run(new Date(clock.getTime() + MIN));
    const cookie = await staffCookie(created, clubA, 'host');
    const detail = await created.app.request(staffUrl(clubA.slug, `/bookings/${other.id}`), { headers: { cookie } });
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { releasePrompt: { alertId: string } | null }).releasePrompt?.alertId).toBe((await prompts(other.id))[0]!.id);
    const res = await created.app.request(staffUrl(clubA.slug, `/bookings/${other.id}/release`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect((await bookingOf(other.id)).status).toBe('no_show');
  });

  it('Keep extends 30 min and re-prompts', async () => {
    const b = await confirmed();
    const release = releaseAt(clubA, b);
    await run(release);
    clock = new Date(release.getTime() + 3 * MIN);
    const keepData = buttonData('Keep 30 min');
    await tap(clubA.slug, GROUP_A, keepData);
    const until = new Date(release.getTime() + 30 * MIN);
    expect(JSON.stringify(replies().at(-1)!.messages)).toContain('Keeping B1 until');
    const kept = await db.select().from(auditLog).where(and(eq(auditLog.entityId, b.id), eq(auditLog.action, 'release_kept')));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ actorType: 'staff', actorId: `line_group:${GROUP_A}` });
    expect((kept[0]!.data as { until: string }).until).toBe(until.toISOString());
    expect((await prompts(b.id))[0]!.resolvedAt).not.toBeNull();

    // A second tap on the same prompt extends nothing.
    await tap(clubA.slug, GROUP_A, keepData);
    expect(JSON.stringify(replies().at(-1)!.messages)).toContain('already answered');
    expect(await db.select().from(auditLog).where(and(eq(auditLog.entityId, b.id), eq(auditLog.action, 'release_kept')))).toHaveLength(1);

    // Past the old window the table is still kept, and nothing is asked again before `until`.
    await run(new Date(release.getTime() + 20 * MIN));
    await run(new Date(until.getTime() - MIN));
    expect((await bookingOf(b.id)).status).toBe('confirmed');
    expect(await prompts(b.id)).toHaveLength(1);

    // At `until` the host is asked again, once.
    await run(until);
    await run(new Date(until.getTime() + MIN));
    const all = await prompts(b.id);
    expect(all).toHaveLength(2);
    expect(all[1]!.resolvedAt).toBeNull();
    expect(groupPushes()).toHaveLength(2);
    expect(buttonData('Keep 30 min')).toBe(`a=ns_keep&b=${b.id}&al=${all[1]!.id}`);
  });

  it('no answer auto-releases', async () => {
    const b = await confirmed();
    const release = releaseAt(clubA, b);
    await run(release);
    await run(new Date(release.getTime() + 14 * MIN));
    expect((await bookingOf(b.id)).status).toBe('confirmed');

    const timeout = new Date(release.getTime() + 15 * MIN);
    await run(timeout);
    const after = await bookingOf(b.id);
    expect(after.status).toBe('no_show');
    expect(after.releasedAt?.toISOString()).toBe(timeout.toISOString());
    expect((await prompts(b.id))[0]!.resolvedAt).not.toBeNull();
    const released = await db.select().from(alerts).where(and(eq(alerts.bookingId, b.id), eq(alerts.kind, 'no_show_released')));
    expect(released).toHaveLength(1);
    expect(released[0]!.textEn).toContain('Not arrived, table released');

    // A late tap changes nothing more.
    await tap(clubA.slug, GROUP_A, `a=ns_keep&b=${b.id}`);
    expect(JSON.stringify(replies().at(-1)!.messages)).toContain('no longer waiting');
    expect((await bookingOf(b.id)).status).toBe('no_show');

    // autoNoShow off: prompted, then the booking waits for the host.
    await db.update(clubs).set({ settings: { ...clubA.settings, autoNoShow: false } }).where(eq(clubs.id, clubA.id));
    const waits = await confirmed('table_demo_B2');
    await run(new Date(timeout.getTime() + MIN));
    await run(new Date(timeout.getTime() + 3 * 60 * MIN));
    expect((await bookingOf(waits.id)).status).toBe('confirmed');
    expect(await prompts(waits.id)).toHaveLength(1);
  });

  it('staff from another club cannot answer', async () => {
    const b = await confirmed();
    const release = releaseAt(clubA, b);
    await run(release);
    const releaseData = buttonData('Release');
    const keepData = buttonData('Keep 30 min');

    // Club B's staff group, through club B's webhook, naming club A's booking.
    await tap(clubB.slug, GROUP_B, releaseData);
    await tap(clubB.slug, GROUP_B, keepData);
    // A group not linked to club A, through club A's webhook.
    await tap(clubA.slug, 'Cstranger', releaseData);
    await tap(clubA.slug, 'Cstranger', keepData);
    expect(replies()).toHaveLength(0);
    expect((await bookingOf(b.id)).status).toBe('confirmed');
    expect((await prompts(b.id))[0]!.resolvedAt).toBeNull();
    expect(await db.select().from(auditLog).where(and(eq(auditLog.entityId, b.id), eq(auditLog.action, 'release_kept')))).toHaveLength(0);

    // Club B's dashboard staff cannot answer either.
    const cookie = await staffCookie(created, clubB, 'manager');
    for (const action of ['release', 'keep']) {
      const res = await created.app.request(staffUrl(clubA.slug, `/bookings/${b.id}/${action}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: '{}',
      });
      expect(res.status).toBe(403);
    }
    expect((await bookingOf(b.id)).status).toBe('confirmed');
  });

  it("a tap from the club's bookings group counts; another club's purpose group does not", async () => {
    await db.insert(staffGroups).values({ id: newId(), clubId: clubA.id, lineGroupId: 'Cbookings_a', purpose: 'bookings', linkedAt: clock });
    await db.insert(staffGroups).values({ id: newId(), clubId: clubB.id, lineGroupId: 'Cbookings_b', purpose: 'bookings', linkedAt: clock });
    const b = await confirmed();
    const other = await confirmed('table_demo_B2');
    const release = releaseAt(clubA, b);
    await run(release);
    // B5b routes `no_arrival` to the bookings group, not the main group.
    expect(groupPushes(GROUP_A)).toHaveLength(0);
    expect(groupPushes('Cbookings_a')).toHaveLength(2);
    const card = (bookingId: string) =>
      groupPushes('Cbookings_a').find((s) => JSON.stringify(s.messages).includes(`b=${bookingId}`))!.messages[0] as any;
    const data = (bookingId: string, label: string) =>
      card(bookingId).contents.footer.contents.find((c: any) => c.action.label.startsWith(label)).action.data as string;

    // Club B's bookings group, through club A's webhook, is ignored.
    await tap(clubA.slug, 'Cbookings_b', data(b.id, 'Release'));
    await tap(clubA.slug, 'Cbookings_b', data(other.id, 'Keep 30 min'));
    expect(replies()).toHaveLength(0);
    expect((await bookingOf(b.id)).status).toBe('confirmed');
    expect((await prompts(other.id))[0]!.resolvedAt).toBeNull();

    clock = new Date(release.getTime() + 2 * MIN);
    await tap(clubA.slug, 'Cbookings_a', data(b.id, 'Release'));
    expect((await bookingOf(b.id)).status).toBe('no_show');
    await tap(clubA.slug, 'Cbookings_a', data(other.id, 'Keep 30 min'));
    expect(JSON.stringify(replies().at(-1)!.messages)).toContain('Keeping B2 until');
    expect(await db.select().from(auditLog).where(and(eq(auditLog.entityId, other.id), eq(auditLog.action, 'release_kept')))).toHaveLength(1);
  });

  it('a Keep tapped while the job is about to auto-release wins', async () => {
    const b = await confirmed();
    const release = releaseAt(clubA, b);
    await run(release);
    const [p] = await prompts(b.id);
    // The job saw the unanswered prompt; then a host taps Keep before its release runs.
    clock = new Date(release.getTime() + 15 * MIN);
    await tap(clubA.slug, GROUP_A, buttonData('Keep 30 min'));
    expect(await autoReleaseFromPrompt(db, clubA.id, b.id, p!.id, { type: 'system' }, clock)).toBe('answered');
    expect((await bookingOf(b.id)).status).toBe('confirmed');
    expect(await db.select().from(events).where(and(eq(events.bookingId, b.id), eq(events.type, 'table.released')))).toHaveLength(0);
  });

  it('a Keep whose prompt was removed (demo reset reseeds the same id) no longer counts', async () => {
    const b = await confirmed();
    const release = releaseAt(clubA, b);
    await run(release);
    clock = new Date(release.getTime() + 3 * MIN);
    await tap(clubA.slug, GROUP_A, buttonData('Keep 30 min'));
    expect(await latestKeep(db, clubA.id, b.id)).toBeDefined();
    // resetDemoClub deletes the alerts of the bookings it reseeds; the audit log is kept.
    await db.delete(alerts).where(eq(alerts.bookingId, b.id));
    expect(await latestKeep(db, clubA.id, b.id)).toBeUndefined();
    await run(new Date(release.getTime() + 5 * MIN));
    const again = await prompts(b.id);
    expect(again).toHaveLength(1);
    expect(again[0]!.resolvedAt).toBeNull();
  });
});
