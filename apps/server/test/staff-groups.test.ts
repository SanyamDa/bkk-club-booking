import type { webhook } from '@line/bot-sdk';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { handleEvent } from '../src/bot/flow.js';
import { issueStaffLinkCode } from '../src/bot/staff-link.js';
import type { Db } from '../src/db/client.js';
import { auditLog, clubs, staffGroups, type Club } from '../src/db/schema.js';
import type { LineGateway } from '../src/line/gateway.js';
import { raiseAlert } from '../src/platform/alerts.js';
import { purposeOfAlertKind, staffGroupFor } from '../src/platform/staff-groups.js';
import { FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let clubB: Club;
let app: ReturnType<typeof createApp>;
let pushes: { to: string; text: string }[];
let gw: LineGateway;
let seq = 0;

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
  await db.update(clubs).set({ staffGroupId: 'Cmain' }).where(eq(clubs.id, clubA.id));
  await db.update(clubs).set({ staffGroupId: 'CmainB' }).where(eq(clubs.id, clubB.id));
  clubA = (await db.query.clubs.findFirst({ where: eq(clubs.id, clubA.id) }))!;
  clubB = (await db.query.clubs.findFirst({ where: eq(clubs.id, clubB.id) }))!;
  app = createApp(testConfig(), db, { bot: { now: () => FRIDAY_AFTERNOON, log: () => {} } });
  pushes = [];
  gw = app.ctx.gateways.dev;
  vi.spyOn(gw, 'push').mockImplementation(async (to: string, msgs: { type: string; text?: string }[]) => {
    for (const m of msgs) pushes.push({ to, text: m.text ?? '' });
  });
  vi.spyOn(gw, 'reply').mockImplementation(async () => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

function groupText(groupId: string, text: string): webhook.Event {
  seq += 1;
  return {
    type: 'message',
    mode: 'active',
    timestamp: FRIDAY_AFTERNOON.getTime(),
    webhookEventId: `sg-ev-${seq}`,
    deliveryContext: { isRedelivery: false },
    source: { type: 'group', groupId, userId: 'Usomeone' },
    replyToken: `sg-rt-${seq}`,
    message: { id: `sg-m-${seq}`, type: 'text', text, quoteToken: 'q' },
  } as unknown as webhook.Event;
}

async function typeInGroup(club: Club, groupId: string, text: string) {
  const fresh = (await db.query.clubs.findFirst({ where: eq(clubs.id, club.id) }))!;
  await handleEvent(app.ctx.deps, fresh, gw, groupText(groupId, text));
}

/** Links `groupId` for `purpose` through the dashboard route and `link <code>` in the group. */
async function linkFor(club: Club, purpose: string, groupId: string) {
  const cookie = await staffCookie(app, club, 'manager');
  const res = await app.app.request(staffUrl(club.slug, '/staff-link-code'), {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ purpose }),
  });
  expect(res.status).toBe(200);
  const { code } = (await res.json()) as { code: string };
  await typeInGroup(club, groupId, `link ${code}`);
}

const urgent = (club: Club, kind: string, en: string) =>
  raiseAlert(db, { clubId: club.id, level: 'urgent', kind, text: { en, th: en } }, FRIDAY_AFTERNOON);

const sentTo = (text: string) => pushes.filter((p) => p.text.includes(text)).map((p) => p.to);

describe('staff groups per purpose (spec §6.1, §9)', () => {
  it('maps alert kinds to purposes', () => {
    expect(purposeOfAlertKind('payment_review')).toBe('payments');
    expect(purposeOfAlertKind('payment_unmatched')).toBe('payments');
    expect(purposeOfAlertKind('guest_wants_human')).toBe('handoff');
    expect(purposeOfAlertKind('complaint')).toBe('handoff');
    expect(purposeOfAlertKind('no_arrival')).toBe('bookings');
    expect(purposeOfAlertKind('no_show_released')).toBe('bookings');
    expect(purposeOfAlertKind('booking_confirmed')).toBe('bookings');
    expect(purposeOfAlertKind('line_disconnected')).toBeUndefined();
  });

  it('each purpose routes to its group', async () => {
    await linkFor(clubA, 'bookings', 'Cbookings');
    await linkFor(clubA, 'payments', 'Cpayments');
    await linkFor(clubA, 'handoff', 'Chandoff');
    const rows = await db.select().from(staffGroups).where(eq(staffGroups.clubId, clubA.id));
    expect(Object.fromEntries(rows.map((r) => [r.purpose, r.lineGroupId]))).toEqual({ bookings: 'Cbookings', payments: 'Cpayments', handoff: 'Chandoff' });
    // The main group stays linked.
    expect((await db.query.clubs.findFirst({ where: eq(clubs.id, clubA.id) }))!.staffGroupId).toBe('Cmain');

    await urgent(clubA, 'payment_review', 'slip-probe');
    await urgent(clubA, 'guest_wants_human', 'human-probe');
    await urgent(clubA, 'no_arrival', 'release-probe');
    await urgent(clubA, 'line_disconnected', 'ops-probe');
    expect(sentTo('slip-probe')).toEqual(['Cpayments']);
    expect(sentTo('human-probe')).toEqual(['Chandoff']);
    expect(sentTo('release-probe')).toEqual(['Cbookings']);
    expect(sentTo('ops-probe')).toEqual(['Cmain']);

    // outbox.toStaff with an explicit purpose (e.g. the pre-order bar note).
    await app.ctx.deps.outbox.toStaff(gw, clubA, [{ type: 'text', text: 'preorder-probe' }], undefined, { purpose: 'bookings' });
    await app.ctx.deps.outbox.toStaff(gw, clubA, [{ type: 'text', text: 'plain-probe' }]);
    expect(sentTo('preorder-probe')).toEqual(['Cbookings']);
    expect(sentTo('plain-probe')).toEqual(['Cmain']);

    const audit = await db.select().from(auditLog).where(and(eq(auditLog.clubId, clubA.id), eq(auditLog.action, 'staff_group.linked')));
    expect(audit.map((a) => (a.data as { purpose?: string }).purpose).sort()).toEqual(['bookings', 'handoff', 'payments']);
  });

  it('falls back to the main group when a purpose has no group', async () => {
    await linkFor(clubA, 'payments', 'Cpayments');
    await urgent(clubA, 'guest_wants_human', 'human-probe');
    expect(sentTo('human-probe')).toEqual(['Cmain']);
    expect(await staffGroupFor(db, clubA, 'bookings')).toBe('Cmain');
    expect(await staffGroupFor(db, clubA, 'payments')).toBe('Cpayments');

    // Unlinking a purpose sends its messages to the main group again.
    const cookie = await staffCookie(app, clubA, 'manager');
    const del = await app.app.request(staffUrl(clubA.slug, '/staff-groups/payments'), { method: 'DELETE', headers: { cookie } });
    expect(del.status).toBe(200);
    await urgent(clubA, 'payment_review', 'slip-probe');
    expect(sentTo('slip-probe')).toEqual(['Cmain']);
    const again = await app.app.request(staffUrl(clubA.slug, '/staff-groups/payments'), { method: 'DELETE', headers: { cookie } });
    expect(again.status).toBe(404);

    // No main group and no purpose group: nothing is sent.
    await db.update(clubs).set({ staffGroupId: null }).where(eq(clubs.id, clubA.id));
    pushes = [];
    await urgent(clubA, 'payment_review', 'none-probe');
    expect(pushes).toEqual([]);
  });

  it('a purpose code does not touch the main group and replacing a purpose group tells the old one', async () => {
    await linkFor(clubA, 'handoff', 'Chandoff1');
    await linkFor(clubA, 'handoff', 'Chandoff2');
    const club = (await db.query.clubs.findFirst({ where: eq(clubs.id, clubA.id) }))!;
    expect(club.staffGroupId).toBe('Cmain');
    expect(club.pendingStaffGroupId).toBeNull();
    expect(club.staffLinkCodePurpose).toBeNull();
    expect(await staffGroupFor(db, clubA, 'handoff')).toBe('Chandoff2');
    expect(pushes.some((p) => p.to === 'Chandoff1' && p.text.includes('another LINE group'))).toBe(true);
    const replaced = await db.select().from(auditLog).where(and(eq(auditLog.clubId, clubA.id), eq(auditLog.action, 'staff_group.replaced')));
    expect(replaced).toHaveLength(1);
    expect(replaced[0]!.data).toEqual({ purpose: 'handoff', from: 'Chandoff1', to: 'Chandoff2' });
  });

  it('a code without a purpose still links the main group (B5)', async () => {
    await db.update(clubs).set({ staffGroupId: null }).where(eq(clubs.id, clubA.id));
    const { code } = await issueStaffLinkCode(db, clubA.id, 'user-1', FRIDAY_AFTERNOON);
    await typeInGroup(clubA, 'Cfirst', `link ${code}`);
    expect((await db.query.clubs.findFirst({ where: eq(clubs.id, clubA.id) }))!.staffGroupId).toBe('Cfirst');
    expect(await db.select().from(staffGroups).where(eq(staffGroups.clubId, clubA.id))).toEqual([]);
  });

  it('cross-club isolation: one club never routes to another club\'s purpose group', async () => {
    await linkFor(clubB, 'payments', 'CpaymentsB');
    await urgent(clubA, 'payment_review', 'a-slip');
    await urgent(clubB, 'payment_review', 'b-slip');
    expect(sentTo('a-slip')).toEqual(['Cmain']);
    expect(sentTo('b-slip')).toEqual(['CpaymentsB']);

    // Club A's manager cannot unlink or see club B's groups.
    const cookie = await staffCookie(app, clubA, 'manager');
    expect((await app.app.request(staffUrl(clubA.slug, '/staff-groups/payments'), { method: 'DELETE', headers: { cookie } })).status).toBe(404);
    expect([403, 404]).toContain((await app.app.request(staffUrl(clubB.slug, '/staff-groups/payments'), { method: 'DELETE', headers: { cookie } })).status);
    expect(await staffGroupFor(db, clubB, 'payments')).toBe('CpaymentsB');
    const settingsA = (await (await app.app.request(staffUrl(clubA.slug, '/settings'), { headers: { cookie } })).json()) as { staffGroups: unknown[] };
    expect(settingsA.staffGroups).toEqual([]);

    // A code issued at club B, typed in a group talking to club A's bot, links nothing at A.
    const { code } = await issueStaffLinkCode(db, clubB.id, 'user-1', FRIDAY_AFTERNOON, 'handoff');
    await typeInGroup(clubA, 'Csneaky', `link ${code}`);
    expect(await db.select().from(staffGroups).where(eq(staffGroups.clubId, clubA.id))).toEqual([]);
  });

  it('issue route takes a purpose, refuses an unknown one, and settings lists linked purposes', async () => {
    const cookie = await staffCookie(app, clubA, 'manager');
    const issue = (body: unknown) =>
      app.app.request(staffUrl(clubA.slug, '/staff-link-code'), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await issue({ purpose: 'door' })).status).toBe(400);
    expect((await issue({ purpose: 'payments' })).status).toBe(200);
    expect((await db.query.clubs.findFirst({ where: eq(clubs.id, clubA.id) }))!.staffLinkCodePurpose).toBe('payments');
    // A later code with no purpose replaces it and links the main group.
    expect((await issue({})).status).toBe(200);
    expect((await db.query.clubs.findFirst({ where: eq(clubs.id, clubA.id) }))!.staffLinkCodePurpose).toBeNull();

    await linkFor(clubA, 'payments', 'Cpayments');
    const settings = (await (await app.app.request(staffUrl(clubA.slug, '/settings'), { headers: { cookie } })).json()) as {
      staffGroups: { purpose: string; linkedAt: string }[];
    };
    expect(settings.staffGroups).toEqual([{ purpose: 'payments', linkedAt: FRIDAY_AFTERNOON.toISOString() }]);
    expect(JSON.stringify(settings)).not.toContain('Cpayments');

    const host = await staffCookie(app, clubA, 'host');
    expect((await app.app.request(staffUrl(clubA.slug, '/staff-groups/payments'), { method: 'DELETE', headers: { cookie: host } })).status).toBe(403);
  });
});
