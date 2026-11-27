import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { alerts, bookings, clubs, deposits, messages, opsEvents, tables, zones, type Club } from '../src/db/schema.js';
import { newId } from '../src/lib/util.js';
import { DAILY_SUMMARY, LINE_DISCONNECTED, LINE_PROBE_EVERY_MS, QUOTA_EXHAUSTED, runAlertChecks } from '../src/platform/alert-checks.js';
import { raiseAlert } from '../src/platform/alerts.js';
import { makeGuest, setupTwoClubs } from './helpers.js';
import { staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

/** Friday 27 Nov 2026, 15:00 Bangkok: before the 17:00 daily summary. */
const T0 = new Date('2026-11-27T08:00:00Z');
/** Friday 27 Nov 2026, 17:00 Bangkok: the daily summary time (spec §6.1). */
const T17 = new Date('2026-11-27T10:00:00Z');

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let clubB: Club;
let app: ReturnType<typeof createApp>;
let pushes: { to: string; text: string }[];

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
  await db.update(clubs).set({ staffGroupId: 'Cstaffgroup' }).where(eq(clubs.id, clubA.id));
  clubA = (await db.query.clubs.findFirst({ where: eq(clubs.id, clubA.id) }))!;
  app = createApp(testConfig(), db, { bot: { now: () => T0, log: () => {} } });
  pushes = [];
  const dev = app.ctx.gateways.dev as unknown as { push: (to: string, msgs: { type: string; text?: string }[]) => Promise<void> };
  vi.spyOn(dev, 'push').mockImplementation(async (to, msgs) => {
    for (const m of msgs) pushes.push({ to, text: m.text ?? '' });
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

const json = (cookie: string, method = 'GET', body?: unknown): RequestInit => ({
  method,
  headers: { cookie, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function feed(cookie: string, club = clubA) {
  const res = await app.app.request(staffUrl(club.slug, '/feed'), json(cookie));
  expect(res.status).toBe(200);
  return (await res.json()) as {
    alerts: { id: string; level: string; kind: string; text: { en: string; th: string }; resolvedAt: string | null; sentLine: boolean }[];
    counts: { urgent: number; needs_input: number; info: number };
  };
}

function lineSetupRow(club: Club, ok: boolean, quota: { used: number; limit: number } | null, at = T0) {
  const report = { ok, steps: [{ name: 'LINE credentials', ok, detail: '' }, { name: 'Webhook', ok, detail: '' }] };
  return db.insert(opsEvents).values({ id: newId(), clubId: club.id, kind: 'line_setup', detail: { report, quota }, at });
}

describe('A15 alerts', () => {
  it('urgent alert reaches the inbox feed and the staff group within 5 s', async () => {
    const cookie = await staffCookie(app, clubA);
    const started = Date.now();
    await raiseAlert(db, { clubId: clubA.id, level: 'urgent', kind: 'guest_wants_human', text: { en: 'Guest asks for a person', th: 'ลูกค้าขอคุยกับพนักงาน' } }, T0);
    const f = await feed(cookie);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(f.alerts).toHaveLength(1);
    expect(f.alerts[0]).toMatchObject({ level: 'urgent', kind: 'guest_wants_human', sentLine: true, resolvedAt: null });
    expect(f.counts.urgent).toBe(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.to).toBe('Cstaffgroup');
    expect(pushes[0]!.text).toContain('Guest asks for a person');
    expect(pushes[0]!.text).toContain('ลูกค้าขอคุยกับพนักงาน');
    const staffMsgs = await db.select().from(messages).where(and(eq(messages.clubId, clubA.id), eq(messages.target, 'staff')));
    expect(staffMsgs).toHaveLength(1);
  });

  it('needs-input counter increments and clears on resolve', async () => {
    const cookie = await staffCookie(app, clubA, 'host');
    const raise = () => raiseAlert(db, { clubId: clubA.id, level: 'needs_input', kind: 'brain_draft_waiting', text: { en: 'Draft waiting', th: 'มีร่างรออนุมัติ' } }, T0);
    await raise();
    await raise();
    let counts = (await (await app.app.request(staffUrl(clubA.slug, '/feed/counts'), json(cookie))).json()) as { needs_input: number };
    expect(counts.needs_input).toBe(2);
    expect(pushes).toHaveLength(0);
    const f = await feed(cookie);
    for (const a of f.alerts) {
      const res = await app.app.request(staffUrl(clubA.slug, `/feed/${a.id}/resolve`), json(cookie, 'POST', {}));
      expect(res.status).toBe(200);
    }
    counts = (await (await app.app.request(staffUrl(clubA.slug, '/feed/counts'), json(cookie))).json()) as { needs_input: number };
    expect(counts.needs_input).toBe(0);
  });

  it("resolving another club's alert answers 404 and leaves it open", async () => {
    const cookie = await staffCookie(app, clubA);
    await raiseAlert(db, { clubId: clubB.id, level: 'needs_input', kind: 'gap_waiting', text: { en: 'Gap', th: 'คำถาม' } }, T0);
    const [b] = await db.select().from(alerts).where(eq(alerts.clubId, clubB.id));
    const res = await app.app.request(staffUrl(clubA.slug, `/feed/${b!.id}/resolve`), json(cookie, 'POST', {}));
    expect(res.status).toBe(404);
    const [after] = await db.select().from(alerts).where(eq(alerts.id, b!.id));
    expect(after!.resolvedAt).toBeNull();
    expect((await feed(cookie)).alerts).toHaveLength(0);
  });

  it('LINE disconnected raises one urgent alert, not repeated while it lasts', async () => {
    await lineSetupRow(clubA, false, null);
    for (let i = 0; i < 3; i++) await runAlertChecks(app.ctx, new Date(T0.getTime() + i * 60_000));
    const rows = await db.select().from(alerts).where(and(eq(alerts.clubId, clubA.id), eq(alerts.kind, LINE_DISCONNECTED)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.level).toBe('urgent');
    expect(rows[0]!.sentLineAt).not.toBeNull();
    expect(pushes.filter((p) => p.text.includes('LINE is disconnected'))).toHaveLength(1);
    // Reconnected: the alert resolves; a later disconnect alerts again.
    await lineSetupRow(clubA, true, null, new Date(T0.getTime() + 5 * 60_000));
    await runAlertChecks(app.ctx, new Date(T0.getTime() + 6 * 60_000));
    await lineSetupRow(clubA, false, null, new Date(T0.getTime() + 7 * 60_000));
    await runAlertChecks(app.ctx, new Date(T0.getTime() + 8 * 60_000));
    const again = await db.select().from(alerts).where(and(eq(alerts.clubId, clubA.id), eq(alerts.kind, LINE_DISCONNECTED)));
    expect(again).toHaveLength(2);
    expect(again.filter((a) => a.resolvedAt === null)).toHaveLength(1);
  });

  it('quota exhausted raises urgent', async () => {
    await lineSetupRow(clubA, true, { used: 500, limit: 500 });
    await runAlertChecks(app.ctx, T0);
    await runAlertChecks(app.ctx, new Date(T0.getTime() + 60_000));
    const rows = await db.select().from(alerts).where(and(eq(alerts.clubId, clubA.id), eq(alerts.kind, QUOTA_EXHAUSTED)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.level).toBe('urgent');
    expect(pushes.filter((p) => p.text.includes('quota'))).toHaveLength(1);
    expect(await db.select().from(alerts).where(eq(alerts.kind, LINE_DISCONNECTED))).toHaveLength(0);
  });

  it('the daily summary appears in the feed and sends no LINE push by default', async () => {
    const cookie = await staffCookie(app, clubA);
    await runAlertChecks(app.ctx, T0); // 15:00: too early
    expect((await feed(cookie)).alerts.filter((a) => a.kind === DAILY_SUMMARY)).toHaveLength(0);
    await runAlertChecks(app.ctx, T17);
    await runAlertChecks(app.ctx, new Date(T17.getTime() + 60_000));
    const f = await feed(cookie);
    const summaries = f.alerts.filter((a) => a.kind === DAILY_SUMMARY);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ level: 'info', sentLine: false });
    expect(summaries[0]!.text.en).toContain('Tonight 2026-11-27');
    expect(pushes).toHaveLength(0);
  });

  it("the daily summary gives tonight's bookings by zone, deposits collected and expected minimum spend", async () => {
    const zs = await db.select().from(zones).where(eq(zones.clubId, clubA.id)).orderBy(asc(zones.sort));
    const ts = await db.select().from(tables).where(eq(tables.clubId, clubA.id));
    const [z1, z2] = zs as [typeof zs[number], typeof zs[number]];
    const t1 = ts.filter((t) => t.zoneId === z1.id);
    const t2 = ts.find((t) => t.zoneId === z2.id)!;
    const guest = await makeGuest(db, { clubId: clubA.id });
    const book = async (tableId: string, night: string, status: 'confirmed' | 'cancelled', minSpend: number, deposit?: number) => {
      const id = newId();
      await db.insert(bookings).values({
        id,
        clubId: clubA.id,
        guestId: guest.id,
        tableId,
        nightDate: night,
        pax: 4,
        status,
        source: 'line',
        refCode: `T${id.slice(0, 6)}`,
        minSpendSatang: minSpend,
        depositSatang: deposit ?? 0,
      } as typeof bookings.$inferInsert);
      if (deposit) await db.insert(deposits).values({ id: newId(), clubId: clubA.id, bookingId: id, amountSatang: deposit, method: 'promptpay_slip', status: 'verified' });
    };
    await book(t1[0]!.id, '2026-11-27', 'confirmed', 1_000_000, 300_000);
    await book(t1[1]!.id, '2026-11-27', 'confirmed', 1_000_000);
    await book(t2.id, '2026-11-27', 'confirmed', 2_000_000, 500_000);
    await book(t2.id, '2026-11-27', 'cancelled', 2_000_000, 500_000); // not counted
    await book(t2.id, '2026-11-28', 'confirmed', 9_000_000, 900_000); // another night
    await runAlertChecks(app.ctx, T17);
    const [row] = await db.select().from(alerts).where(and(eq(alerts.clubId, clubA.id), eq(alerts.kind, DAILY_SUMMARY)));
    expect(row!.textEn).toBe(`Tonight 2026-11-27: 3 bookings (${z1.name} 2, ${z2.name} 1). Deposits collected ฿8,000. Expected minimum spend ฿40,000.`);
    expect(row!.textTh).toContain(`${z1.nameTh} 2`);
  });

  it('a LINE disconnect is found by the timed probe, with no setup row written by hand', async () => {
    const line = { ok: true, quota: { used: 10, limit: 500 } };
    const probed = createApp(testConfig({ PUBLIC_URL: 'https://club.test' }), db, {
      bot: { now: () => T0, log: () => {} },
      credentials: {
        channelSecret: async () => 'secret',
        line: async (club) => (club.id === clubA.id ? { channelSecret: 'secret', accessToken: 'token' } : null),
        login: async () => null,
      },
      lineSetupClients: () => {
        const fail = async () => {
          throw new Error('401 Unauthorized: invalid token');
        };
        return {
          api: {
            getBotInfo: line.ok ? async () => ({ userId: 'U1', basicId: '@club', displayName: 'Club', chatMode: 'bot', markAsReadMode: 'auto' }) : fail,
            getWebhookEndpoint: line.ok ? async () => ({ endpoint: `https://club.test/line/webhook/${clubA.slug}`, active: true }) : fail,
            getMessageQuota: async () => ({ type: 'limited', value: line.quota.limit }),
            getMessageQuotaConsumption: async () => ({ totalUsage: line.quota.used }),
          },
        } as never;
      },
    });
    vi.spyOn(probed.ctx.gateways, 'forClub').mockResolvedValue(probed.ctx.gateways.dev);
    const dev = probed.ctx.gateways.dev as unknown as { push: (to: string, msgs: { type: string; text?: string }[]) => Promise<void> };
    vi.spyOn(dev, 'push').mockImplementation(async (to, msgs) => {
      for (const m of msgs) pushes.push({ to, text: m.text ?? '' });
    });
    const kindOf = (kind: string) => db.select().from(alerts).where(and(eq(alerts.clubId, clubA.id), eq(alerts.kind, kind)));

    await runAlertChecks(probed.ctx, T0);
    expect(await kindOf(LINE_DISCONNECTED)).toHaveLength(0);
    const setups = await db.select().from(opsEvents).where(and(eq(opsEvents.clubId, clubA.id), eq(opsEvents.kind, 'line_setup')));
    expect(setups).toHaveLength(1);

    // The token is revoked. Within the probe interval nothing is re-read; after it, the probe sees it.
    line.ok = false;
    await runAlertChecks(probed.ctx, new Date(T0.getTime() + 60_000));
    expect(await kindOf(LINE_DISCONNECTED)).toHaveLength(0);
    await runAlertChecks(probed.ctx, new Date(T0.getTime() + LINE_PROBE_EVERY_MS));
    const raised = await kindOf(LINE_DISCONNECTED);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.level).toBe('urgent');
    expect(pushes.filter((p) => p.text.includes('LINE is disconnected'))).toHaveLength(1);

    // The quota runs out while the token works again: the probe raises quota_exhausted and resolves the disconnect.
    line.ok = true;
    line.quota = { used: 500, limit: 500 };
    await runAlertChecks(probed.ctx, new Date(T0.getTime() + 2 * LINE_PROBE_EVERY_MS));
    expect((await kindOf(QUOTA_EXHAUSTED)).filter((a) => !a.resolvedAt)).toHaveLength(1);
    expect((await kindOf(LINE_DISCONNECTED)).filter((a) => !a.resolvedAt)).toHaveLength(0);
  });

  it('a check with no quota reading keeps an open quota_exhausted alert open', async () => {
    await lineSetupRow(clubA, true, { used: 500, limit: 500 });
    await runAlertChecks(app.ctx, T0);
    await lineSetupRow(clubA, true, null, new Date(T0.getTime() + 60_000));
    await runAlertChecks(app.ctx, new Date(T0.getTime() + 2 * 60_000));
    const rows = await db.select().from(alerts).where(and(eq(alerts.clubId, clubA.id), eq(alerts.kind, QUOTA_EXHAUSTED)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolvedAt).toBeNull();
  });

  it('raiseAlert does not throw when the club LINE channel is unavailable, and records no LINE send', async () => {
    vi.spyOn(app.ctx.gateways, 'forClub').mockRejectedValue(new Error('token issue failed'));
    await expect(
      raiseAlert(db, { clubId: clubA.id, level: 'urgent', kind: 'bot_error', text: { en: 'Bot error', th: 'บอทขัดข้อง' } }, T0),
    ).resolves.toBeUndefined();
    const [row] = await db.select().from(alerts).where(and(eq(alerts.clubId, clubA.id), eq(alerts.kind, 'bot_error')));
    expect(row!.sentLineAt).toBeNull();
    const staffMsgs = await db.select().from(messages).where(and(eq(messages.clubId, clubA.id), eq(messages.target, 'staff')));
    expect(staffMsgs).toHaveLength(1);
    expect(pushes).toHaveLength(0);
  });

  it('the per-club "also send to LINE" switch sends info alerts to the staff group', async () => {
    const manager = await staffCookie(app, clubA, 'manager');
    const host = await staffCookie(app, clubA, 'host');
    expect((await app.app.request(staffUrl(clubA.slug, '/alert-settings'), json(host, 'PUT', { infoToLine: true }))).status).toBe(403);
    const res = await app.app.request(staffUrl(clubA.slug, '/alert-settings'), json(manager, 'PUT', { infoToLine: true }));
    expect(res.status).toBe(200);
    expect(await (await app.app.request(staffUrl(clubA.slug, '/alert-settings'), json(manager))).json()).toEqual({ infoToLine: true });
    await raiseAlert(db, { clubId: clubA.id, level: 'info', kind: 'booking_confirmed', text: { en: 'New booking', th: 'การจองใหม่' } }, T0);
    expect(pushes).toHaveLength(1);
    // clubB keeps the default.
    await raiseAlert(db, { clubId: clubB.id, level: 'info', kind: 'booking_confirmed', text: { en: 'New booking', th: 'การจองใหม่' } }, T0);
    expect(pushes).toHaveLength(1);
  });
});
