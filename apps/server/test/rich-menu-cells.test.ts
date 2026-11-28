import { and, eq } from 'drizzle-orm';
import type { messagingApi } from '@line/bot-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { auditLog, clubs, events, type Club } from '../src/db/schema.js';
import { fakeLineState, fakeSetupClients, richMenuRequest, type FakeLineState } from '../src/line/setup.js';
import { totp } from '../src/platform/totp.js';
import { setupTwoClubs } from './helpers.js';
import { adminCookie, staffCookie, staffUrl, testConfig } from './helpers/track-a.js';

const T0 = new Date('2026-11-27T08:00:00Z');
/** The TOTP secret `adminCookie` gives every admin it creates (test/helpers/track-a.ts). */
const ADMIN_TOTP_KEY = Buffer.from('12345678901234567890');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

/** Postback data, or the uri, of each area left to right. */
const areaTargets = (req: messagingApi.RichMenuRequest) =>
  (req.areas ?? []).map((a) => (a.action?.type === 'postback' ? (a.action as { data: string }).data : (a.action as { uri: string }).uri));

async function setup(opts: { connect?: boolean; publicUrl?: string } = {}) {
  const h = await setupTwoClubs();
  cleanups.push(h.close);
  const line: FakeLineState = fakeLineState();
  const created: messagingApi.RichMenuRequest[] = [];
  /** Other LINE setup calls (webhook, sample checks, quota), counted to prove the menu editor leaves them alone. */
  const otherCalls: string[] = [];
  const app = createApp(testConfig({ LINE_FAKE: true, PUBLIC_URL: opts.publicUrl ?? 'https://club.test' }), h.db, {
    bot: { now: () => T0, log: () => {} },
    lineSetupClients: (token, login) => {
      const clients = fakeSetupClients(token, login, line);
      const create = clients.api.createRichMenu.bind(clients.api);
      clients.api.createRichMenu = async (req) => {
        created.push(req);
        return create(req);
      };
      for (const name of ['setWebhookEndpoint', 'testWebhookEndpoint', 'validateReply', 'getMessageQuota'] as const) {
        const real = (clients.api as any)[name].bind(clients.api);
        (clients.api as any)[name] = async (...args: unknown[]) => {
          otherCalls.push(name);
          return real(...args);
        };
      }
      return clients;
    },
  });
  if (opts.connect !== false) {
    const admin = await adminCookie(app);
    const res = await app.app.request(`/api/admin/clubs/${h.clubA.slug}/line`, {
      method: 'POST',
      headers: { cookie: admin, 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: '1650000000', channelSecret: 'messaging-secret-a10b', totp: totp(ADMIN_TOTP_KEY, T0) }),
    });
    expect(res.status).toBe(200);
  }
  const manager = await staffCookie(app, h.clubA, 'manager');
  const req = (method: string, path: string, body?: unknown, cookie = manager) =>
    app.app.request(staffUrl(h.clubA.slug, path), {
      method,
      headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const reload = async () => (await h.db.query.clubs.findFirst({ where: eq(clubs.id, h.clubA.id) }))!;
  return { ...h, db: h.db as Db, app, line, created, otherCalls, req, reload };
}

const withSettings = (club: Club, patch: Partial<Club['settings']>): Club => ({ ...club, settings: { ...club.settings, ...patch } });

describe('rich menu cells per club (A10b)', () => {
  it('chosen cells appear in the rich menu request in order with tags', async () => {
    const s = await setup({ connect: false });
    const club = withSettings(s.clubA, { drinksMenuUrl: 'https://club.test/drinks', richMenuCells: ['host', 'book', 'drinks', 'privacy'] });
    const links = s.app.ctx.deps.links;
    const req = richMenuRequest(club, { tracked: links.tracked.bind(links), privacy: () => 'https://club.test/privacy' });
    const targets = areaTargets(req);
    expect(targets).toHaveLength(4);
    expect(targets[0]).toBe('a=host&s=rm_host');
    expect(targets[1]).toBe('a=book&s=rm_book');
    // The drinks link goes through the counted redirect with its own tag.
    expect(targets[2]).toBe(s.app.ctx.deps.links.tracked(club, 'drinks', 'rm_drinks'));
    expect(targets[3]).toBe('https://club.test/privacy');
    // Book a table is the wide cell; the areas cover the full width without gaps.
    const bounds = (req.areas ?? []).map((a) => a.bounds!);
    expect(bounds.map((b) => b.width)).toEqual([500, 1000, 500, 500]);
    expect(bounds.map((b) => b.x)).toEqual([0, 500, 1500, 2000]);
    expect(req.chatBarText!.length).toBeLessThanOrEqual(14);
  });

  it('unset cells keep the default menu', async () => {
    const s = await setup({ connect: false });
    expect(areaTargets(richMenuRequest(s.clubA)).filter((t) => t.startsWith('a='))).toEqual(['a=book&s=rm_book', 'a=my&s=rm_my', 'a=host&s=rm_host', 'a=privacy']);
    expect((richMenuRequest(s.clubA).areas ?? []).map((a) => a.bounds!.width)).toEqual([1000, 375, 375, 375, 375]);
    const res = await s.req('GET', '/rich-menu');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cells: string[]; allowed: { id: string }[] };
    expect(body.cells).toEqual(['book', 'my', 'location', 'host', 'privacy']);
    expect(body.allowed.map((a) => a.id)).toEqual(['book', 'my', 'location', 'drinks', 'host', 'privacy']);
  });

  it('invalid cell answers 400', async () => {
    const s = await setup({ connect: false });
    for (const cells of [['book', 'floor', 'privacy'], ['book', 'book', 'privacy'], ['book', 'my'], ['book'], ['book', 'my', 'location', 'drinks', 'host', 'privacy', 'my']]) {
      const res = await s.req('PUT', '/rich-menu', { cells });
      expect(res.status, JSON.stringify(cells)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid');
    }
    expect((await s.reload()).settings.richMenuCells).toBeUndefined();
  });

  it('drinks without a drinks URL answers 400', async () => {
    const s = await setup({ connect: false });
    const { drinksMenuUrl: _drop, ...rest } = s.clubA.settings;
    await s.db.update(clubs).set({ settings: rest }).where(eq(clubs.id, s.clubA.id));
    const res = await s.req('PUT', '/rich-menu', { cells: ['book', 'drinks', 'privacy'] });
    expect(res.status).toBe(400);
    expect((await s.reload()).settings.richMenuCells).toBeUndefined();
  });

  it('a change refreshes the rich menu on LINE', async () => {
    const s = await setup();
    const before = s.line.defaultRichMenuId;
    const n = s.created.length;
    const res = await s.req('PUT', '/rich-menu', { cells: ['book', 'location', 'privacy'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cells: string[]; refreshed: boolean; report: { richMenu?: { richMenuId: string } } };
    expect(body.cells).toEqual(['book', 'location', 'privacy']);
    expect(body.refreshed).toBe(true);
    expect(s.created).toHaveLength(n + 1);
    const req = s.created.at(-1)!;
    const targets = areaTargets(req);
    expect(targets).toHaveLength(3);
    expect(targets[0]).toBe('a=book&s=rm_book');
    expect(targets[1]).toBe(s.app.ctx.deps.links.tracked(s.clubA, 'map', 'rm_location'));
    expect(s.line.defaultRichMenuId).toBe(body.report.richMenu!.richMenuId);
    expect(s.line.defaultRichMenuId).not.toBe(before);
    expect((await s.reload()).settings.richMenuCells).toEqual(['book', 'location', 'privacy']);
  });

  it('the menu editor rebuilds only the rich menu: no webhook change, and it works without an https PUBLIC_URL', async () => {
    const s = await setup({ publicUrl: 'http://localhost:5173' });
    s.otherCalls.length = 0;
    const n = s.created.length;
    const res = await s.req('PUT', '/rich-menu', { cells: ['book', 'host', 'privacy'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refreshed: boolean; report: { ok: boolean; steps: { name: string; ok: boolean }[] } };
    expect(body.refreshed).toBe(true);
    expect(body.report.steps).toEqual([expect.objectContaining({ name: 'Rich menu', ok: true })]);
    expect(s.created).toHaveLength(n + 1);
    expect(s.otherCalls).toEqual([]);
  });

  it('without LINE the cells are saved and nothing is refreshed', async () => {
    const s = await setup({ connect: false });
    const res = await s.req('PUT', '/rich-menu', { cells: ['book', 'host', 'privacy'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cells: ['book', 'host', 'privacy'], refreshed: false, report: null });
    expect(s.created).toHaveLength(0);
  });

  it('a change writes an audit row and emits club.settings_changed', async () => {
    const s = await setup({ connect: false });
    expect((await s.req('PUT', '/rich-menu', { cells: ['book', 'my', 'privacy'] })).status).toBe(200);
    const [audit] = await s.db.select().from(auditLog).where(and(eq(auditLog.clubId, s.clubA.id), eq(auditLog.action, 'club.rich_menu_changed')));
    expect(audit?.before).toEqual({ richMenuCells: null });
    expect(audit?.after).toEqual({ richMenuCells: ['book', 'my', 'privacy'] });
    expect(audit?.actorType).toBe('staff');
    const evs = await s.db.select().from(events).where(and(eq(events.clubId, s.clubA.id), eq(events.type, 'club.settings_changed')));
    expect(evs.map((e) => (e.props as { fields: string }).fields)).toContain('rich_menu');
  });

  it('host gets 403', async () => {
    const s = await setup({ connect: false });
    const host = await staffCookie(s.app, s.clubA, 'host');
    expect((await s.req('PUT', '/rich-menu', { cells: ['book', 'privacy'] }, host)).status).toBe(403);
    expect((await s.req('GET', '/rich-menu', undefined, host)).status).toBe(403);
  });
});
