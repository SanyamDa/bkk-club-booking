import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { auditLog } from '../src/db/schema.js';
import { FEATURE_DEFAULTS, isFeatureOn } from '../src/platform/features.js';
import { setupTwoClubs } from './helpers.js';
import { adminCookie, routeTable, staffCookie, testConfig } from './helpers/track-a.js';

const T0 = new Date('2026-11-27T08:00:00Z');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function setup() {
  const h = await setupTwoClubs();
  cleanups.push(h.close);
  const created = createApp(testConfig(), h.db, { bot: { now: () => T0, log: () => {} } });
  const cookie = await adminCookie(created);
  const req = (method: string, path: string, body?: unknown, cookieOverride?: string) =>
    created.app.request(path, {
      method,
      headers: { cookie: cookieOverride ?? cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  return { ...h, db: h.db as Db, created, cookie, req };
}

describe('A17b per-club feature switches', () => {
  it('a switch takes effect on the next request without restart', async () => {
    const s = await setup();
    expect(await isFeatureOn(s.db, s.clubA.id, 'ai_answers')).toBe(FEATURE_DEFAULTS.ai_answers);
    const res = await s.req('PATCH', `/api/admin/clubs/${s.clubA.slug}/features`, { ai_answers: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { features: Record<string, boolean> }).features.ai_answers).toBe(true);
    // Same app instance, same db: no restart, and the next read sees it.
    expect(await isFeatureOn(s.db, s.clubA.id, 'ai_answers')).toBe(true);
    // The other club is untouched.
    expect(await isFeatureOn(s.db, s.clubB.id, 'ai_answers')).toBe(FEATURE_DEFAULTS.ai_answers);
    const get = await s.req('GET', `/api/admin/clubs/${s.clubA.slug}/features`);
    expect(get.status).toBe(200);
    expect(((await get.json()) as { features: Record<string, boolean> }).features).toEqual({ ...FEATURE_DEFAULTS, ai_answers: true });

    await s.req('PATCH', `/api/admin/clubs/${s.clubA.slug}/features`, { ai_answers: false });
    expect(await isFeatureOn(s.db, s.clubA.id, 'ai_answers')).toBe(false);
  });

  it('an unknown key is 400', async () => {
    const s = await setup();
    const res = await s.req('PATCH', `/api/admin/clubs/${s.clubA.slug}/features`, { teleport: true });
    expect(res.status).toBe(400);
    expect((await s.req('PATCH', `/api/admin/clubs/${s.clubA.slug}/features`, { ai_answers: 'yes' })).status).toBe(400);
    expect((await s.req('PATCH', `/api/admin/clubs/${s.clubA.slug}/features`, {})).status).toBe(400);
    expect((await s.req('PATCH', `/api/admin/clubs/nope/features`, { ai_answers: true })).status).toBe(404);
  });

  it('the change is in audit_log', async () => {
    const s = await setup();
    await s.req('PATCH', `/api/admin/clubs/${s.clubA.slug}/features`, { pos_sync: true });
    const rows = await s.db.select().from(auditLog).where(and(eq(auditLog.clubId, s.clubA.id), eq(auditLog.action, 'club.features_changed')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorType).toBe('platform');
    expect(rows[0]!.before).toMatchObject({ pos_sync: FEATURE_DEFAULTS.pos_sync });
    expect(rows[0]!.after).toMatchObject({ pos_sync: true });
  });

  it('the route is in ADMIN_ROUTES and refuses staff', async () => {
    const s = await setup();
    const routes = routeTable(s.created.app, '/api/admin');
    expect(routes).toContainEqual(expect.objectContaining({ method: 'PATCH', path: '/api/admin/clubs/:slug/features' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/api/admin/clubs/:slug/features' }));
    const staff = await staffCookie(s.created, s.clubA);
    expect((await s.req('PATCH', `/api/admin/clubs/${s.clubA.slug}/features`, { ai_answers: true }, staff)).status).toBe(403);
  });
});
