import { and, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { holdTable } from '../src/bookings/service.js';
import { openDb, type Db } from '../src/db/client.js';
import { auditLog, bookings, channels, clubs, guestNotes, guests, platformFlags, tables, zones, type Club } from '../src/db/schema.js';
import { DEMO_CLUB_ID, seedDemoClub } from '../src/db/seed.js';
import { ClubDeleteError, clearClubWebhook, deleteClub, PARKED_WEBHOOK_PATH } from '../src/demo/delete-club.js';
import { resetDemoClub } from '../src/demo/reset.js';
import type { CredentialStore } from '../src/line/credentials.js';
import { fakeSetupClients, type SetupClients } from '../src/line/setup.js';
import { featuresFlagKey } from '../src/platform/features.js';
import { newId } from '../src/lib/util.js';
import { adminCookie, testConfig } from './helpers/track-a.js';

/** Friday 27 Nov 2026, 20:00 Bangkok. */
const FRI = new Date('2026-11-27T13:00:00Z');
const B_ID = 'club_delete_test_b';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** Every table with a club_id column except audit_log, with the rows that club has in it. */
async function clubRowCounts(db: Db, clubId: string): Promise<Record<string, number>> {
  const res = await db.execute(sql`
    select c.table_name as t from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = current_schema() and t.table_type = 'BASE TABLE' and c.column_name = 'club_id' and c.table_name <> 'audit_log'`);
  const out: Record<string, number> = {};
  for (const { t } of (res as unknown as { rows: { t: string }[] }).rows) {
    const n = (await db.execute(sql`select count(*)::int as n from ${sql.raw(`"${t}"`)} where club_id = ${clubId}`)) as unknown as { rows: { n: number }[] };
    if (n.rows[0]!.n) out[t] = n.rows[0]!.n;
  }
  return out;
}

/** Velora, a live club B, and an app whose LINE client is a fake that records webhook changes. */
async function setup() {
  const handle = await openDb({ dataDir: 'memory' });
  closers.push(handle.close);
  const db = handle.db;
  await seedDemoClub(db, {}, FRI);
  const velora = (await db.query.clubs.findFirst({ where: eq(clubs.id, DEMO_CLUB_ID) }))!;
  await db.insert(clubs).values({ id: B_ID, slug: 'delete-test-b', name: 'Club B', settings: { ...velora.settings, refPrefix: 'DB' }, status: 'live' });
  await db.insert(channels).values({ id: `chan_line_${B_ID}`, clubId: B_ID, kind: 'line' });
  await db.insert(zones).values({ id: 'zone_db', clubId: B_ID, name: 'Main', nameTh: 'หลัก', minSpendSatang: 500_000, depositSatang: 100_000 });
  await db.insert(tables).values({ id: 'table_db_1', clubId: B_ID, zoneId: 'zone_db', code: 'M1', minPax: 2, maxPax: 6 });

  const webhookCalls: { token: string; endpoint: string }[] = [];
  const lineSetupClients = (accessToken: string): SetupClients => {
    const clients = fakeSetupClients(accessToken, null);
    const set = clients.api.setWebhookEndpoint.bind(clients.api);
    clients.api.setWebhookEndpoint = (async (req: { endpoint: string }) => {
      webhookCalls.push({ token: accessToken, endpoint: req.endpoint });
      return set(req);
    }) as SetupClients['api']['setWebhookEndpoint'];
    return clients;
  };
  // The spare LINE account's credentials: every club but Velora gets a token named after it.
  const credentials: CredentialStore = {
    channelSecret: async (club) => (club.id === DEMO_CLUB_ID ? null : `secret-${club.slug}`),
    line: async (club) => (club.id === DEMO_CLUB_ID ? null : { channelSecret: `secret-${club.slug}`, accessToken: `token-${club.slug}` }),
    login: async () => null,
  };
  const app = createApp(testConfig({ PUBLIC_URL: 'https://demo.example.test' }), db, { bot: { now: () => FRI, log: () => {} }, credentials, lineSetupClients });
  const admin = await adminCookie(app);
  const post = (path: string, body?: unknown) =>
    app.app.request(path, { method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { db, app, velora, post, webhookCalls };
}

/** Demo step 7: the founder creates a second club in the wizard, marked as made by the Velora demo. */
async function createSpare(post: (path: string, body?: unknown) => Promise<Response> | Response, slug = 'demo-spare'): Promise<string> {
  const res = await post('/api/admin/clubs', { name: 'Spare club', slug, template: 'velora-like', demoOf: 'demo' });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; status: string };
  expect(body.status).toBe('demo');
  return body.id;
}

/** Activity in a club: a guest with a note, a held booking (with status history and events) and a feature flag. */
async function activity(db: Db, club: Club) {
  const [g] = await db.insert(guests).values({ id: newId(), clubId: club.id, lineUserId: `U-${newId()}`, displayName: 'G' }).returning();
  await db.insert(guestNotes).values({ id: newId(), clubId: club.id, guestId: g!.id, text: 'likes the riser' });
  const [table] = await db.select().from(tables).where(eq(tables.clubId, club.id)).limit(1);
  const booking = await holdTable(db, club, { guestId: g!.id, tableId: table!.id, nightDate: '2026-11-27', pax: 2 }, FRI);
  await db.insert(platformFlags).values({ key: featuresFlagKey(club.id), value: {} });
  return booking;
}

const clubOf = async (db: Db, id: string) => (await db.query.clubs.findFirst({ where: eq(clubs.id, id) }))!;

describe('demo step-7 club deletion (spec §12.4)', () => {
  it('reset deletes the step-7 club and all its rows', async () => {
    const { db, post } = await setup();
    const spareId = await createSpare(post);
    const spare = await clubOf(db, spareId);
    expect(spare.settings.demoOf).toBe(DEMO_CLUB_ID);
    const booking = await activity(db, spare);
    const before = await clubRowCounts(db, spareId);
    expect(before.bookings).toBe(1);
    expect(before.tables).toBeGreaterThan(0);
    expect(before.events).toBeGreaterThan(0);

    const res = await post('/api/admin/demo/demo/reset');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ nightDate: '2026-11-27', deletedClubs: [{ slug: 'demo-spare', webhook: 'cleared' }] });

    expect(await db.query.clubs.findFirst({ where: eq(clubs.id, spareId) })).toBeUndefined();
    expect(await clubRowCounts(db, spareId)).toEqual({});
    const history = (await db.execute(sql`select count(*)::int as n from booking_status_history where booking_id = ${booking.id}`)) as unknown as { rows: { n: number }[] };
    expect(history.rows[0]!.n).toBe(0);
    expect(await db.query.platformFlags.findFirst({ where: eq(platformFlags.key, featuresFlagKey(spareId)) })).toBeUndefined();
    // The audit trail keeps the club's history and records the deletion.
    const [deleted] = await db.select().from(auditLog).where(and(eq(auditLog.clubId, spareId), eq(auditLog.action, 'club.deleted')));
    expect(deleted).toMatchObject({ actorType: 'platform', entityId: spareId });
    expect((deleted!.after as { rows: Record<string, number> }).rows.bookings).toBe(1);
    // A second reset has nothing more to delete.
    expect(await (await post('/api/admin/demo/demo/reset')).json()).toMatchObject({ deletedClubs: [] });
  });

  it('reset leaves other clubs untouched', async () => {
    const { db, post } = await setup();
    await createSpare(post);
    // Club B is live; a club created normally in the console is onboarding and unmarked.
    const normal = await post('/api/admin/clubs', { name: 'Real new club', slug: 'real-new', template: 'velora-like' });
    expect(normal.status).toBe(201);
    const normalId = ((await normal.json()) as { id: string; status: string }).id;
    const realNew = await clubOf(db, normalId);
    expect(realNew.status).toBe('onboarding');
    expect(realNew.settings.demoOf).toBeUndefined();
    await activity(db, realNew);
    await activity(db, await clubOf(db, B_ID));
    const beforeB = await clubRowCounts(db, B_ID);
    const beforeNew = await clubRowCounts(db, normalId);
    const veloraTables = (await clubRowCounts(db, DEMO_CLUB_ID)).tables;

    expect((await post('/api/admin/demo/demo/reset')).status).toBe(200);
    expect(await clubRowCounts(db, B_ID)).toEqual(beforeB);
    expect(await clubRowCounts(db, normalId)).toEqual(beforeNew);
    expect((await clubRowCounts(db, DEMO_CLUB_ID)).tables).toBe(veloraTables);
    expect(await db.query.clubs.findFirst({ where: eq(clubs.id, B_ID) })).toBeDefined();
    expect(await db.query.platformFlags.findFirst({ where: eq(platformFlags.key, featuresFlagKey(normalId)) })).toBeDefined();
    expect((await db.select().from(bookings).where(eq(bookings.clubId, normalId))).map((b) => b.status)).toEqual(['held']);
  });

  it('deleteClub refuses a real club with 409', async () => {
    const { db, post } = await setup();
    // Not marked: club B (live), Velora itself (demo but not made by a demo), a normal new club.
    for (const id of [B_ID, DEMO_CLUB_ID]) {
      await expect(deleteClub(db, id, { type: 'platform', id: 'u1' }, FRI)).rejects.toMatchObject({ code: 'not_demo_spare' });
    }
    await expect(deleteClub(db, 'club_missing', { type: 'system' }, FRI)).rejects.toBeInstanceOf(ClubDeleteError);
    expect((await post('/api/admin/demo/delete-test-b/delete')).status).toBe(409);
    expect(await (await post('/api/admin/demo/demo/delete')).json()).toEqual({ error: 'not_demo_spare' });
    // A step-7 club turned into a real one (status live) is refused too.
    const spareId = await createSpare(post);
    await db.update(clubs).set({ status: 'live' }).where(eq(clubs.id, spareId));
    expect((await post('/api/admin/demo/demo-spare/delete')).status).toBe(409);
    expect(await db.query.clubs.findFirst({ where: eq(clubs.id, spareId) })).toBeDefined();
    expect(await db.query.clubs.findFirst({ where: eq(clubs.id, B_ID) })).toBeDefined();
    // Marking is only at creation, from a demo club.
    expect((await post('/api/admin/clubs', { name: 'X', slug: 'x-club', template: 'blank', demoOf: 'delete-test-b' })).status).toBe(400);
    // A spare is deleted directly through the route.
    await db.update(clubs).set({ status: 'demo' }).where(eq(clubs.id, spareId));
    const del = await post('/api/admin/demo/demo-spare/delete');
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ slug: 'demo-spare', webhook: 'cleared' });
    expect(await db.query.clubs.findFirst({ where: eq(clubs.id, spareId) })).toBeUndefined();
  });

  it('reset clears the spare webhook through the fake LINE client', async () => {
    const { db, app, post, webhookCalls } = await setup();
    await createSpare(post);
    expect((await post('/api/admin/demo/demo/reset')).status).toBe(200);
    expect(webhookCalls).toEqual([{ token: 'token-demo-spare', endpoint: `https://demo.example.test${PARKED_WEBHOOK_PATH}` }]);
    // The parked path belongs to no club: LINE deliveries there get 404.
    expect((await app.app.request(PARKED_WEBHOOK_PATH, { method: 'POST', body: '{}' })).status).toBe(404);
    // No credentials: nothing to clear, and a LINE failure is reported, never thrown.
    const club = await clubOf(db, DEMO_CLUB_ID);
    expect(await clearClubWebhook(app.ctx, club)).toBe('no_credentials');
    const failing = { ...app.ctx, lineSetupClients: () => ({ api: { setWebhookEndpoint: async () => { throw new Error('LINE down'); } } }) as unknown as SetupClients };
    expect(await clearClubWebhook(failing, await clubOf(db, B_ID))).toBe('failed');
    // resetDemoClub without a clearer still deletes the club and reports the webhook as skipped.
    const spare2 = await createSpare(post, 'demo-spare-2');
    const res = await resetDemoClub(db, DEMO_CLUB_ID, FRI);
    expect(res.deletedClubs).toEqual([{ id: spare2, slug: 'demo-spare-2', webhook: 'skipped' }]);
  });
});
