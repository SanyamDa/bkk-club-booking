import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import {
  approveDeposit,
  BookingError,
  cancelBooking,
  createManualBooking,
  getBookingView,
  getDepositForClub,
  holdTable,
  listTableOptions,
  markArrived,
  recordSlip,
  requestDeposit,
  submitDetails,
  type Actor,
} from '../src/bookings/service.js';
import { getConversationForClub } from '../src/chat/conversations.js';
import { emit, type EventInput } from '../src/data/events.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { auditLog, bookings, clubs, conversations, deposits, events, messages, type Club } from '../src/db/schema.js';
import { newId } from '../src/lib/util.js';
import { envCredentialStore, type ClubLineCredentials, type CredentialStore } from '../src/line/credentials.js';
import { GatewayRegistry } from '../src/line/gateway.js';
import { FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupTwoClubs } from './helpers.js';
import { testConfig } from './helpers/track-a.js';

// ---- schema and migration ----

const drizzleDir = fileURLToPath(new URL('../drizzle/', import.meta.url));

const V2_TABLES = [
  // platform.ts
  'users', 'club_memberships', 'sessions', 'support_grants', 'club_profile', 'club_credentials',
  'channels', 'invites', 'platform_flags',
  // data.ts
  'raw_webhooks', 'events', 'events_dead_letter', 'ops_events', 'occupancy_snapshots', 'door_counts',
  'crowd_ratings', 'calendar_days', 'identity_map', 'booking_status_history', 'notices',
  'handoff_episodes', 'removal_requests',
  // brain.ts
  'brain_notes', 'brain_note_versions', 'brain_snapshots',
  // core.ts (new base-spec tables)
  'pos_bills', 'price_rules', 'nights',
];

const CORE_TABLES = [
  'clubs', 'zones', 'tables', 'nights', 'price_rules', 'guests', 'bookings', 'deposits',
  'conversations', 'messages', 'pos_bills', 'audit_log',
];

/** table -> columns that must exist after 0002_v2. */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  clubs: [
    'status', 'bot_paused', 'bot_paused_at', 'created_by', 'staff_link_code',
    'staff_link_code_hash', 'staff_link_code_expires_at', 'pending_staff_group_id',
  ],
  tables: ['floor_x', 'floor_y', 'shape', 'valid_from', 'valid_to'],
  price_rules: ['valid_from', 'valid_to', 'scope', 'scope_id', 'weekday', 'night_id', 'priority'],
  nights: ['date', 'status', 'closed_reason', 'event_type', 'event_name', 'lineup', 'notes', 'edited_by'],
  deposits: ['club_id', 'slip_trans_ref', 'slip_amount_satang', 'slip_receiver', 'slip_time'],
  bookings: [
    'reminder_sent_at', 'occasion', 'arrived_at', 'arrived_pax', 'cancelled_at', 'cancel_reason_code',
    'no_show_at', 'released_at', 'running_late_minutes', 'attempt_id', 'is_test',
  ],
  guests: ['birth_date', 'channel_id', 'external_user_id', 'is_test'],
  conversations: ['external_ref'],
  messages: [
    'external_id', 'processed_at', 'author_type', 'author_id', 'channel_id', 'occurred_at',
    'sent_via', 'delivery_status', 'error',
  ],
  audit_log: [
    'actor', 'data', 'actor_type', 'actor_id', 'session_id', 'support_grant_id', 'reason', 'ip',
    'before', 'after',
  ],
  users: ['failed_login_count', 'locked_until'],
  pos_bills: ['club_id', 'booking_id', 'table_code', 'covers', 'provider_bill_id', 'total_satang'],
  events: ['seq', 'id', 'club_id', 'type', 'dedupe_key', 'props', 'raw', 'is_test', 'data_origin'],
  invites: ['id', 'club_id', 'email', 'role', 'token_hash', 'expires_at', 'accepted_at', 'created_by'],
  platform_flags: ['key', 'value', 'updated_by', 'updated_at'],
  channels: ['id', 'club_id', 'kind', 'external_id', 'status', 'connected_at'],
};

let handle: DbHandle | undefined;
let raw: PGlite | undefined;

async function rows<T>(h: DbHandle, q: string): Promise<T[]> {
  const res = (await h.db.execute(q as never)) as unknown as { rows: T[] };
  return res.rows;
}

async function runMigrationFile(client: PGlite, name: string): Promise<void> {
  const sqlText = readFileSync(`${drizzleDir}${name}`, 'utf8');
  for (const stmt of sqlText.split('--> statement-breakpoint')) {
    if (stmt.trim()) await client.exec(stmt);
  }
}

describe('W0 schema contracts', () => {
  afterEach(async () => {
    await handle?.close();
    await raw?.close();
    handle = undefined;
    raw = undefined;
  });

  it('migrations create every v2 table', async () => {
    handle = await openDb({ dataDir: 'memory' });
    const tableRows = await rows<{ table_name: string }>(
      handle,
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = new Set(tableRows.map((r) => r.table_name));
    for (const t of V2_TABLES) expect(names, `table ${t}`).toContain(t);

    const colRows = await rows<{ table_name: string; column_name: string }>(
      handle,
      `select table_name, column_name from information_schema.columns where table_schema = 'public'`,
    );
    const cols = new Set(colRows.map((r) => `${r.table_name}.${r.column_name}`));
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      for (const c of columns) expect(cols, `${table}.${c}`).toContain(`${table}.${c}`);
    }

    const nullable = await rows<{ table_name: string; column_name: string; is_nullable: string }>(
      handle,
      `select table_name, column_name, is_nullable from information_schema.columns
       where table_schema = 'public' and (table_name, column_name) in
       (('clubs','staff_link_code'),('audit_log','club_id'),('deposits','club_id'),('pos_bills','booking_id'),('messages','channel_id'))`,
    );
    const isNull = Object.fromEntries(nullable.map((r) => [`${r.table_name}.${r.column_name}`, r.is_nullable]));
    expect(isNull['clubs.staff_link_code']).toBe('YES');
    expect(isNull['audit_log.club_id']).toBe('YES');
    expect(isNull['deposits.club_id']).toBe('NO');
    expect(isNull['pos_bills.booking_id']).toBe('YES');
    expect(isNull['messages.channel_id']).toBe('YES');

    const idx = await rows<{ indexname: string; indexdef: string }>(
      handle,
      `select indexname, indexdef from pg_indexes where schemaname = 'public'`,
    );
    const defs = idx.map((i) => i.indexdef);
    expect(defs.some((d) => /UNIQUE INDEX .* ON public\.events .*\(club_id, dedupe_key\)/.test(d))).toBe(true);
    expect(defs.some((d) => /UNIQUE INDEX .* ON public\.deposits .*\(club_id, slip_trans_ref\)/.test(d))).toBe(true);
    expect(defs.some((d) => /UNIQUE INDEX .* ON public\.messages .*\(club_id, external_id\)/.test(d))).toBe(true);
    expect(defs.some((d) => /UNIQUE INDEX .* ON public\.nights .*\(club_id, date\)/.test(d))).toBe(true);
  });

  it('every core table except clubs has a club_id column', async () => {
    handle = await openDb({ dataDir: 'memory' });
    const colRows = await rows<{ table_name: string }>(
      handle,
      `select table_name from information_schema.columns where table_schema = 'public' and column_name = 'club_id'`,
    );
    const withClub = new Set(colRows.map((r) => r.table_name));
    for (const t of CORE_TABLES.filter((t) => t !== 'clubs')) expect(withClub, t).toContain(t);
  });

  it('migration marks club_demo as demo and gives every existing club a line row in channels', async () => {
    raw = new PGlite();
    await runMigrationFile(raw, '0000_init.sql');
    await runMigrationFile(raw, '0001_live_line.sql');
    const settings = JSON.stringify({ refPrefix: 'VL' });
    await raw.exec(`
      insert into clubs (id, slug, name, settings, staff_link_code) values
        ('club_demo', 'demo', 'Demo', '${settings}', 'ABC123'),
        ('club_other', 'other', 'Other', '${settings}', 'DEF456');
      insert into zones (id, club_id, name, name_th, min_spend_satang, deposit_satang)
        values ('z1', 'club_other', 'Z', 'Z', 100, 50);
      insert into tables (id, club_id, zone_id, code, min_pax, max_pax) values ('t1', 'club_other', 'z1', 'T1', 1, 4);
      insert into guests (id, club_id, line_user_id) values ('g1', 'club_other', 'U1');
      insert into bookings (id, club_id, ref_code, guest_id, table_id, night_date, pax, status, source, min_spend_satang, deposit_satang)
        values ('b1', 'club_other', 'R1', 'g1', 't1', '2026-11-27', 2, 'confirmed', 'line', 100, 50);
      insert into deposits (id, booking_id, amount_satang, method, status) values ('d1', 'b1', 50, 'cash', 'verified');
      insert into messages (id, club_id, guest_id, direction, kind, payload, created_at)
        values ('m1', 'club_other', 'g1', 'in', 'text', '{}', '2026-11-01T10:00:00Z');
    `);
    await runMigrationFile(raw, '0002_v2.sql');

    const st = await raw.query<{ id: string; status: string }>(`select id, status from clubs order by id`);
    expect(st.rows).toEqual([
      { id: 'club_demo', status: 'demo' },
      { id: 'club_other', status: 'onboarding' },
    ]);
    const ch = await raw.query<{ club_id: string; kind: string }>(`select club_id, kind from channels order by club_id`);
    expect(ch.rows).toEqual([
      { club_id: 'club_demo', kind: 'line' },
      { club_id: 'club_other', kind: 'line' },
    ]);
    const dep = await raw.query<{ club_id: string }>(`select club_id from deposits where id = 'd1'`);
    expect(dep.rows[0]!.club_id).toBe('club_other');
    const msg = await raw.query<{ same: boolean }>(`select processed_at = created_at as same from messages where id = 'm1'`);
    expect(msg.rows[0]!.same).toBe(true);

    // A club inserted with no status gets onboarding.
    handle = await openDb({ dataDir: 'memory' });
    await handle.db.insert(clubs).values({
      id: 'club_new',
      slug: 'new',
      name: 'New',
      settings: {} as never,
    });
    const club = await handle.db.query.clubs.findFirst({ where: eq(clubs.id, 'club_new') });
    expect(club!.status).toBe('onboarding');
    expect(club!.staffLinkCode).toBeNull();
    expect(club!.botPaused).toBe(false);
    expect(club!.botPausedAt).toBeNull();
  });
});

// ---- booking service, notifier, scoped lookups ----

let ctx: Awaited<ReturnType<typeof setupTwoClubs>>;

const STAFF: Actor = { type: 'staff' };

/** A confirmed booking on the club's first table, made the way staff enter one by hand. */
async function bookIn(club: Club) {
  const [option] = await listTableOptions(ctx.db, club.id);
  return createManualBooking(
    ctx.db,
    club,
    { tableId: option!.table.id, nightDate: FRIDAY, pax: option!.table.minPax, name: 'Ari', depositPaid: false },
    STAFF,
    FRIDAY_AFTERNOON,
  );
}

describe('W0 booking contracts', () => {
  beforeEach(async () => {
    ctx = await setupTwoClubs();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('approveDeposit with a staff Actor writes actor_type and actor_id to audit_log', async () => {
    const { db, clubA } = ctx;
    const now = FRIDAY_AFTERNOON;
    const g = await makeGuest(db, { clubId: clubA.id });
    const b = await holdTable(db, clubA, { guestId: g.id, tableId: 'table_demo_B2', nightDate: FRIDAY, pax: 6 }, now);
    await submitDetails(db, clubA, b.id, { name: 'Ari', phone: '0812345678', nationality: 'Thai', pax: 6 }, now);
    await requestDeposit(db, clubA, b.id, now);
    await recordSlip(db, clubA, b.id, 'uploads/x.jpg', now);

    await approveDeposit(db, clubA.id, b.id, { type: 'staff', id: 'user_1', sessionId: 'sess_1' }, now);

    const row = await db.query.auditLog.findFirst({
      where: and(eq(auditLog.entityId, b.id), eq(auditLog.action, 'status:confirmed')),
    });
    expect(row).toMatchObject({ actorType: 'staff', actorId: 'user_1', sessionId: 'sess_1', actor: 'staff', clubId: clubA.id });
    const deposit = await db.query.deposits.findFirst({ where: eq(deposits.bookingId, b.id) });
    expect(deposit?.clubId).toBe(clubA.id);
  });

  it('cancelBooking takes a Reason and stores reason.text in status_reason', async () => {
    const b = await bookIn(ctx.clubA);
    const cancelled = await cancelBooking(
      ctx.db,
      ctx.clubA.id,
      b.id,
      STAFF,
      { code: 'club_cancelled', text: 'Closed for a private event' },
      FRIDAY_AFTERNOON,
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.statusReason).toBe('Closed for a private event');
  });

  it('markArrived refuses a booking of another club', async () => {
    const b = await bookIn(ctx.clubB);
    const err = await markArrived(ctx.db, ctx.clubA.id, b.id, STAFF, FRIDAY_AFTERNOON).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BookingError);
    expect((err as BookingError).code).toBe('not_found');
    const after = await ctx.db.query.bookings.findFirst({ where: eq(bookings.id, b.id) });
    expect(after?.status).toBe('confirmed');
  });

  it('getBookingView scoped by club', async () => {
    const b = await bookIn(ctx.clubB);
    expect(await getBookingView(ctx.db, { clubId: ctx.clubA.id, id: b.id })).toBeUndefined();
    expect(await getBookingView(ctx.db, { clubId: ctx.clubA.id, refCode: b.refCode })).toBeUndefined();
    expect((await getBookingView(ctx.db, { clubId: ctx.clubB.id, id: b.id }))?.booking.id).toBe(b.id);
  });

  it("getConversationForClub and getDepositForClub return undefined for another club's id", async () => {
    const { db, clubA, clubB } = ctx;
    const b = await bookIn(clubB);
    const [deposit] = await db
      .insert(deposits)
      .values({ id: newId(), clubId: clubB.id, bookingId: b.id, amountSatang: 100_00, method: 'manual', status: 'pending' })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ id: newId(), clubId: clubB.id, guestId: b.guestId, mode: 'bot', state: {} })
      .returning();

    expect(await getDepositForClub(db, clubA.id, deposit!.id)).toBeUndefined();
    expect(await getConversationForClub(db, clubA.id, conv!.id)).toBeUndefined();
    expect((await getDepositForClub(db, clubB.id, deposit!.id))?.id).toBe(deposit!.id);
    expect((await getConversationForClub(db, clubB.id, conv!.id))?.id).toBe(conv!.id);
  });

  it("notifier does not send for another club's booking", async () => {
    const { db, clubA, clubB } = ctx;
    const app = createApp(testConfig(), db, { bot: { now: () => FRIDAY_AFTERNOON, log: () => {} } });
    const g = await makeGuest(db, { clubId: clubA.id });
    const b = await holdTable(db, clubA, { guestId: g.id, tableId: 'table_demo_T1', nightDate: FRIDAY, pax: 2 }, FRIDAY_AFTERNOON);
    const outbound = async () =>
      (await db.select().from(messages).where(and(eq(messages.direction, 'out'), eq(messages.guestId, g.id)))).length;

    await app.ctx.notifier.confirmed(clubB.id, b.id);
    await app.ctx.notifier.hostReply(clubB.id, g.id, 'hello', STAFF);
    expect(await outbound()).toBe(0);

    // Control: the right club does send, so the zero above means "refused", not "broken".
    await app.ctx.notifier.confirmed(clubA.id, b.id);
    expect(await outbound()).toBeGreaterThan(0);
  });
});

// ---- credentials and gateway registry ----

const credClub = (over: Partial<Club> = {}): Club =>
  ({
    id: 'club_x',
    slug: 'x',
    lineChannelSecretEnv: 'X_SECRET',
    lineAccessTokenEnv: 'X_TOKEN',
    lineLoginChannelIdEnv: 'X_LOGIN_ID',
    lineLoginChannelSecretEnv: 'X_LOGIN_SECRET',
    liffId: 'liff-x',
    ...over,
  }) as Club;

function fakeStore(tokens: string[]): CredentialStore {
  let i = 0;
  return {
    channelSecret: async () => 's',
    line: async (): Promise<ClubLineCredentials> => ({ channelSecret: 's', accessToken: tokens[Math.min(i++, tokens.length - 1)]! }),
    login: async () => null,
  };
}

describe('credentials contracts', () => {
  it('registry rebuilds the gateway when the token changes', async () => {
    const reg = new GatewayRegistry(fakeStore(['t1', 't1', 't2']));
    const a = await reg.forClub(credClub());
    const b = await reg.forClub(credClub());
    const c = await reg.forClub(credClub());
    expect(a.live).toBe(true);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it('registry uses the dev gateway for simulator guests and clubs without credentials', async () => {
    const reg = new GatewayRegistry(fakeStore(['t1']));
    expect(await reg.forClub(credClub(), 'SIM-abc')).toBe(reg.dev);
    const none = new GatewayRegistry(envCredentialStore({}));
    expect(await none.forClub(credClub())).toBe(none.dev);
  });

  it('webhook with a secret but no access token skips the events and never replies via the dev gateway', async () => {
    const { db, close } = await setupTwoClubs();
    try {
      const store: CredentialStore = { channelSecret: async () => 's', line: async () => null, login: async () => null };
      const logs: string[] = [];
      const app = createApp(testConfig(), db, { credentials: store, bot: { log: (m) => logs.push(m) } });
      const reply = vi.spyOn(app.ctx.gateways.dev, 'reply');
      const push = vi.spyOn(app.ctx.gateways.dev, 'push');
      const body = JSON.stringify({
        destination: 'x',
        events: [{
          type: 'message', mode: 'active', timestamp: Date.now(), webhookEventId: 'e1', replyToken: 'r1',
          deliveryContext: { isRedelivery: false }, source: { type: 'user', userId: 'Ureal9' },
          message: { type: 'text', id: 'm1', quoteToken: 'q', text: 'hi' },
        }],
      });
      const sig = createHmac('sha256', 's').update(body).digest('base64');
      const res = await app.app.request('/line/webhook/demo', { method: 'POST', headers: { 'x-line-signature': sig }, body });
      expect(res.status).toBe(200);
      await app.settle();
      expect(reply).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      expect(await db.select().from(messages)).toHaveLength(0);
      expect(logs.some((m) => m.includes('access token missing'))).toBe(true);
    } finally {
      await close();
    }
  });

  it("env credential store reads the club's env names", async () => {
    const store = envCredentialStore({ X_SECRET: 's', X_TOKEN: 'tok' });
    expect(await store.line(credClub())).toEqual({ channelSecret: 's', accessToken: 'tok' });
    expect(await envCredentialStore({}).line(credClub())).toBeNull();
  });

  it('env credential store channelSecret() needs only the secret env', async () => {
    const store = envCredentialStore({ X_SECRET: 's' });
    expect(await store.channelSecret(credClub())).toBe('s');
    expect(await store.line(credClub())).toBeNull();
    expect(await envCredentialStore({}).channelSecret(credClub())).toBeNull();
  });

  it("env credential store login() reads the club's login env names", async () => {
    const store = envCredentialStore({ X_LOGIN_ID: 'id', X_LOGIN_SECRET: 'sec' });
    expect(await store.login(credClub())).toEqual({ channelId: 'id', channelSecret: 'sec', liffId: 'liff-x', shared: false });
    expect(await envCredentialStore({ X_LOGIN_ID: 'id' }).login(credClub())).toBeNull();
    expect(await envCredentialStore({}).login(credClub({ liffId: null }))).toBeNull();
  });
});

// ---- events ----

describe('emit (W0 stub)', () => {
  beforeEach(async () => {
    ctx = await setupTwoClubs();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('emit stub writes one events row and ignores a repeated dedupe_key', async () => {
    const e: EventInput = {
      clubId: ctx.clubA.id,
      type: 'staff.login',
      occurredAt: FRIDAY_AFTERNOON,
      actorType: 'staff',
      actorId: 'user_1',
      dataOrigin: 'first_party',
      isTest: true,
      dedupeKey: 'staff.login:session_1',
    };
    await ctx.db.transaction(async (tx) => {
      await emit(tx as never, e);
    });
    await emit(ctx.db, e);

    const rows = await ctx.db.select().from(events).where(eq(events.clubId, ctx.clubA.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('staff.login');
    expect(rows[0]!.dedupeKey).toBe('staff.login:session_1');
  });
});
