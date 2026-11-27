import { and, desc, eq, isNull } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { alerts, auditLog, clubs, opsEvents } from '../src/db/schema.js';
import { QUOTA_EXHAUSTED, runAlertChecks } from '../src/platform/alert-checks.js';
import { fakeLineState, fakeSetupClients, rollbackRichMenu, runLineSetup, type FakeLineState } from '../src/line/setup.js';
import { totp } from '../src/platform/totp.js';
import { setupTwoClubs } from './helpers.js';
import { adminCookie, testConfig } from './helpers/track-a.js';

const T0 = new Date('2026-11-27T08:00:00Z');
/** The TOTP secret `adminCookie` gives every admin it creates (test/helpers/track-a.ts). */
const ADMIN_TOTP_KEY = Buffer.from('12345678901234567890');
const LINE_SECRET = 'messaging-channel-secret-a10a';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function setup(opts: { quota?: { used: number; limit: number } } = {}) {
  const h = await setupTwoClubs();
  cleanups.push(h.close);
  const line: FakeLineState = fakeLineState();
  const config = testConfig({ LINE_FAKE: true, PUBLIC_URL: 'https://club.test' });
  const created = createApp(config, h.db, {
    bot: { now: () => T0, log: () => {} },
    lineSetupClients: (token, login) => {
      const clients = fakeSetupClients(token, login, line);
      const q = opts.quota;
      if (q) {
        clients.api.getMessageQuota = async () => ({ type: 'limited', value: q.limit }) as never;
        clients.api.getMessageQuotaConsumption = async () => ({ totalUsage: q.used }) as never;
      }
      return clients;
    },
  });
  const cookie = await adminCookie(created);
  const req = (method: string, path: string, body?: unknown) =>
    created.app.request(path, {
      method,
      headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const code = () => totp(ADMIN_TOTP_KEY, T0);
  const slug = h.clubA.slug;
  const connect = () => req('POST', `/api/admin/clubs/${slug}/line`, { channelId: '1650000000', channelSecret: LINE_SECRET, totp: code() });
  const migrate = (body: Record<string, unknown> = {}) => req('POST', `/api/admin/clubs/${slug}/line/migrate`, { totp: code(), ...body });
  const rollback = () => req('POST', `/api/admin/clubs/${slug}/line/rich-menu/rollback`, {});
  const reload = async () => (await h.db.query.clubs.findFirst({ where: eq(clubs.id, h.clubA.id) }))!;
  return { ...h, app: created, db: h.db as Db, line, req, code, slug, connect, migrate, rollback, reload };
}

describe('greeting and rich menu migration (A10)', () => {
  it('migration records the quota reading, so an open quota_exhausted alert stays open', async () => {
    const s = await setup({ quota: { used: 500, limit: 500 } });
    expect((await s.connect()).status).toBe(200);
    await runAlertChecks(s.app.ctx, T0);
    const open = () => s.db.select().from(alerts).where(and(eq(alerts.clubId, s.clubA.id), eq(alerts.kind, QUOTA_EXHAUSTED), isNull(alerts.resolvedAt)));
    expect(await open()).toHaveLength(1);
    expect((await s.migrate()).status).toBe(200);
    const [latest] = await s.db
      .select()
      .from(opsEvents)
      .where(and(eq(opsEvents.clubId, s.clubA.id), eq(opsEvents.kind, 'line_setup')))
      .orderBy(desc(opsEvents.at), desc(opsEvents.id));
    expect((latest!.detail as { quota: unknown }).quota).toEqual({ used: 500, limit: 500 });
    await runAlertChecks(s.app.ctx, new Date(T0.getTime() + 60_000));
    expect(await open()).toHaveLength(1);
  });

  it('imports the greeting text from the setup clients into settings', async () => {
    const s = await setup();
    s.line.greeting = { en: 'Welcome to the club! RSVP recommended.', th: 'ยินดีต้อนรับ' };
    expect((await s.connect()).status).toBe(200);
    const res = await s.migrate();
    expect(res.status).toBe(200);
    const club = await s.reload();
    expect(club.settings.greeting).toEqual({ en: 'Welcome to the club! RSVP recommended.', th: 'ยินดีต้อนรับ' });
    const audit = await s.db.query.auditLog.findFirst({ where: and(eq(auditLog.clubId, s.clubA.id), eq(auditLog.action, 'club.greeting_imported')) });
    expect(audit?.before).toEqual({ greeting: s.clubA.settings.greeting });
    expect(audit?.after).toEqual({ greeting: club.settings.greeting });
  });

  it('pasted greeting text wins over the setup clients and keeps the other language', async () => {
    const s = await setup();
    s.line.greeting = { en: 'From LINE', th: 'จาก LINE' };
    await s.connect();
    const res = await s.migrate({ greeting: { en: 'Pasted by the founder' } });
    expect(res.status).toBe(200);
    expect((await s.reload()).settings.greeting).toEqual({ en: 'Pasted by the founder', th: s.clubA.settings.greeting.th });
  });

  it('answers 422 greeting_unreadable when LINE cannot give the greeting and none is pasted', async () => {
    const s = await setup();
    s.line.greeting = null;
    await s.connect();
    const res = await s.migrate();
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'greeting_unreadable' });
    expect((await s.reload()).settings.greeting).toEqual(s.clubA.settings.greeting);
  });

  it('greeting import needs fresh totp', async () => {
    const s = await setup();
    await s.connect();
    const res = await s.req('POST', `/api/admin/clubs/${s.slug}/line/migrate`, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'totp_required' });
  });

  it('replaces the rich menu with refreshRichMenu and keeps the old one for rollback', async () => {
    const s = await setup();
    await s.connect();
    const oldId = s.line.defaultRichMenuId;
    expect(oldId).toBeTruthy();
    const body = (await (await s.migrate()).json()) as { richMenu: { richMenuId: string; previousRichMenuId: string | null } };
    expect(body.richMenu.previousRichMenuId).toBe(oldId);
    expect(body.richMenu.richMenuId).not.toBe(oldId);
    expect(s.line.defaultRichMenuId).toBe(body.richMenu.richMenuId);
    expect(s.line.menus.map((m) => m.richMenuId)).toEqual(expect.arrayContaining([oldId, body.richMenu.richMenuId]));
    const audit = await s.db.query.auditLog.findFirst({ where: and(eq(auditLog.clubId, s.clubA.id), eq(auditLog.action, 'line.rich_menu_replaced')) });
    expect(audit?.after).toEqual(body.richMenu);
  });

  it('rollback restores the old rich menu as default and deletes the new one', async () => {
    const s = await setup();
    await s.connect();
    const oldId = s.line.defaultRichMenuId;
    const { richMenu } = (await (await s.migrate()).json()) as { richMenu: { richMenuId: string } };
    const res = await s.rollback();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, richMenuId: oldId });
    expect(s.line.defaultRichMenuId).toBe(oldId);
    expect(s.line.menus.map((m) => m.richMenuId)).not.toContain(richMenu.richMenuId);
    // A second rollback has nothing left to undo.
    const again = await s.rollback();
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'nothing_to_roll_back' });
  });

  it('rollback with no migration answers 409', async () => {
    const s = await setup();
    await s.connect();
    const res = await s.rollback();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'nothing_to_roll_back' });
  });

  it('runLineSetup with keepOldRichMenu does not delete the installed menu', async () => {
    const s = await setup();
    const line = fakeLineState();
    const clients = fakeSetupClients('fake-token', null, line);
    const base = { club: s.clubA, clients, publicUrl: 'https://club.test', sampleMessages: [], webhookRetries: 1, retryDelayMs: 0 };
    const first = await runLineSetup({ ...base, refreshRichMenu: true });
    expect(first.richMenu?.previousRichMenuId).toBeNull();
    const second = await runLineSetup({ ...base, refreshRichMenu: true, keepOldRichMenu: true });
    expect(second.richMenu?.previousRichMenuId).toBe(first.richMenu?.richMenuId);
    expect(line.menus).toHaveLength(2);
    await rollbackRichMenu(clients, second.richMenu!);
    expect(line.defaultRichMenuId).toBe(first.richMenu?.richMenuId);
    expect(line.menus).toHaveLength(1);
  });

  // B4 adds &s=rm_book, &s=rm_my and &s=rm_host to menuCells; the migrated menu carries them once B4 merges.
  it.todo('the replaced rich menu carries B4 s=rm_* tags');
});
