import { and, asc, desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Actor } from '../bookings/service.js';
import { regenerateLayoutNote } from '../brain/layout.js';
import type { Db } from '../db/client.js';
import { clubProfile, clubs, GUEST_FIELDS, opsEvents, RICH_MENU_CELLS, tables, zones, type ClubSettings } from '../db/schema.js';
import { describeLineError, refreshRichMenuOnly, RICH_MENU_CELL_LABELS, richMenuCellsOf, type SetupReport } from '../line/setup.js';
import { newId } from '../lib/util.js';
import {
  auditClubChange,
  clubChangeEvent,
  clubToday,
  currentPriceRules,
  listNights,
  nightBody,
  nightsRange,
  priceBody,
  setPriceRule,
  SettingsError,
  upsertNight,
  type SettingsActor,
} from '../platform/club-settings.js';
import { quotaView, type LineSetupDetail } from '../platform/health.js';
import { clientIp, requireClubRole, type AuthEnv, type Role } from './auth.js';
import { profileBody } from './admin/clubs.js';
import { freshTotpRefusal, jsonBody, notifyOwners } from './admin/controls.js';
import type { AppContext } from './context.js';

const MANAGER_ROLES: Role[] = ['owner', 'manager'];

type C = Context<AuthEnv>;

/** The signed-in person, or a founder under a support grant (as in http/staff.ts). */
export function actorOf(c: C): SettingsActor {
  const grant = c.var.supportGrant;
  const base: Actor = grant
    ? { type: 'platform', id: c.var.user.id, sessionId: c.var.session.idHash, supportGrantId: grant.id }
    : { type: 'staff', id: c.var.user.id, sessionId: c.var.session.idHash };
  return { ...base, ip: clientIp(c) };
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/**
 * `club.settings_changed` props.fields code per settings key. All the keys the settings route
 * accepts, joined with ':', stay within the 64-character props limit.
 */
export const SETTINGS_FIELD_CODES: Record<string, string> = {
  openWeekdays: 'days',
  bookingWindowDays: 'window',
  holdMinutes: 'hold',
  arrivalBy: 'arrival',
  handoffTimeoutMinutes: 'handoff',
  accentColor: 'accent',
  rules: 'rules',
  address: 'address',
  drinksMenuUrl: 'menu',
  urgentWords: 'words',
  sameNightCutoffHour: 'cutoff',
  maxBookingsPerGuestPerNight: 'per_night',
  greeting: 'greeting',
  mapUrl: 'map',
  // PATCH /policy (its own route, so neither form's codes pass the 64-character limit).
  arrivalGraceMinutes: 'grace',
  reminderTime: 'remind',
  cancellationPolicy: 'cancel',
  requiredFields: 'fields',
  tone: 'tone',
  hostHours: 'hosts',
  afterVisitMessage: 'after',
  // PUT /rich-menu (A10b).
  richMenuCells: 'rich_menu',
};

/** A10b: 2 to 6 allowed cells, no repeats, Book a table and Privacy always there (§5.1, §5.5). */
const richMenuBody = z
  .object({
    cells: z
      .array(z.enum(RICH_MENU_CELLS))
      .min(2)
      .max(6)
      .refine((c) => new Set(c).size === c.length, { message: 'a cell appears twice' })
      .refine((c) => c.includes('book'), { message: 'book is required' })
      .refine((c) => c.includes('privacy'), { message: 'privacy is required (spec §5.5)' }),
  })
  .strict();

const settingsBody = z
  .object({
    openWeekdays: z.array(z.number().int().min(0).max(6)).max(7),
    bookingWindowDays: z.number().int().min(1).max(365),
    holdMinutes: z.number().int().min(5).max(30), // §7.2: 5–30
    arrivalBy: hhmm,
    handoffTimeoutMinutes: z.number().int().min(5).max(240),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    rules: z.object({ en: z.array(z.string().trim().min(1).max(300)).max(30), th: z.array(z.string().trim().min(1).max(300)).max(30) }),
    address: z.string().trim().max(300),
    drinksMenuUrl: z.string().url().max(2000),
    // B19b: complaint and safety words (§6.4); an empty list falls back to the platform list.
    urgentWords: z.array(z.string().trim().min(2).max(60)).max(200),
    // Spec §7.2: the same-night cut-off hour (after midnight, before the night ends) and the per-night limit.
    sameNightCutoffHour: z.number().int().min(0).max(12),
    maxBookingsPerGuestPerNight: z.number().int().min(1).max(10),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to change' });

/** §6.2 Settings, Rules and Bot content keys beyond the booking rules (PATCH /clubs/:slug/policy). */
const policyBody = z
  .object({
    arrivalGraceMinutes: z.number().int().min(0).max(180),
    reminderTime: hhmm,
    cancellationPolicy: z.object({ en: z.string().trim().max(500), th: z.string().trim().max(500) }),
    requiredFields: z.array(z.enum(GUEST_FIELDS)).max(GUEST_FIELDS.length),
    tone: z.enum(['formal', 'casual']),
    hostHours: z.object({ from: hhmm, to: hhmm }).nullable(),
    afterVisitMessage: z.boolean(),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to change' });

const promptpayBody = z.object({ promptpayId: z.string().trim().min(1).max(40), promptpayName: z.string().trim().max(200).optional(), totp: z.string() }).strict();
const greetingBody = z
  .object({
    greeting: z.object({ en: z.string().max(2000), th: z.string().max(2000) }).optional(),
    mapUrl: z.string().url().max(2000).optional(),
    totp: z.string(),
  })
  .strict()
  .refine((b) => b.greeting !== undefined || b.mapUrl !== undefined, { message: 'nothing to change' });

const satang = z.number().int().min(0).max(1_000_000_000);
const zoneCreate = z.object({ name: z.string().trim().min(1).max(60), nameTh: z.string().trim().min(1).max(60), sort: z.number().int().min(0).max(999).optional(), minSpendSatang: satang, depositSatang: satang }).strict();
/** Zone prices change through PUT /prices (price_rules), never the columns, so past nights keep theirs. */
const zonePatch = z.object({ name: z.string().trim().min(1).max(60), nameTh: z.string().trim().min(1).max(60), sort: z.number().int().min(0).max(999) }).partial().strict();
const tableFields = {
  code: z.string().trim().min(1).max(20),
  zoneId: z.string().min(1),
  minPax: z.number().int().min(1).max(100),
  maxPax: z.number().int().min(1).max(100),
  sort: z.number().int().min(0).max(999),
  floorX: z.number().min(0).max(1).nullable(),
  floorY: z.number().min(0).max(1).nullable(),
  shape: z.string().max(20).nullable(),
  active: z.boolean(),
};
const tableCreate = z
  .object(tableFields)
  .partial({ sort: true, floorX: true, floorY: true, shape: true, active: true })
  .strict()
  .refine((b) => b.minPax <= b.maxPax, { message: 'minPax must not exceed maxPax' });
const tablePatch = z.object(tableFields).partial().strict();

const issues = (e: z.ZodError) => e.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));

/**
 * Club settings for managers (plan A9, spec §6.2 Settings, §11.1.4, §14.3), mounted from
 * http/staff.ts under /api/staff. Every route is `/clubs/:slug/...` behind `requireClubRole`
 * (owner or manager), and every id is checked against the club in the URL.
 */
export function staffSettingsRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  const managers = requireClubRole(app, ...MANAGER_ROLES);

  const refuse = (c: C, err: unknown) => {
    if (err instanceof SettingsError) return c.json({ error: err.code }, err.status);
    throw err;
  };

  /**
   * Writes new `settings`, audits and emits `club.settings_changed` with the changed fields as
   * short codes (SETTINGS_FIELD_CODES), in one transaction. Codes, not key names, because every
   * key the settings form sends, joined, is longer than the 64-character props limit.
   */
  async function saveSettings(c: C, db: Db, patch: Partial<ClubSettings>, action: string) {
    const club = c.var.club;
    const now = app.deps.now();
    const settings = { ...club.settings, ...patch };
    const fields = Object.keys(patch)
      .filter((k) => k !== 'rulesVersion')
      .map((k) => SETTINGS_FIELD_CODES[k] ?? k);
    const pickOf = (s: ClubSettings) => Object.fromEntries(Object.keys(patch).map((k) => [k, s[k as keyof ClubSettings] ?? null]));
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.update(clubs).set({ settings }).where(eq(clubs.id, club.id));
      await auditClubChange(tx, club, actorOf(c), { action, entity: 'clubs', entityId: club.id, before: pickOf(club.settings), after: pickOf(settings) }, now);
      await clubChangeEvent(tx, club, actorOf(c), now, { type: 'club.settings_changed', props: { fields: fields.join(':') } }); // ':' because ',' fails the B1 props pattern
    });
    return settings;
  }

  // ----- Booking rules and opening days -----
  r.patch('/clubs/:slug/settings', managers, async (c) => {
    const parsed = settingsBody.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'invalid', issues: issues(parsed.error) }, 400);
    const patch: Partial<ClubSettings> = { ...parsed.data };
    if (patch.rules) patch.rulesVersion = clubToday(c.var.club, app.deps.now());
    const settings = await saveSettings(c, db, patch, 'club.settings_changed');
    return c.json({ settings });
  });

  // Grace period, reminder time, cancellation policy, required guest fields, tone, host hours and the
  // after-visit message (spec §6.2 Settings: Rules and Bot content).
  r.patch('/clubs/:slug/policy', managers, async (c) => {
    const parsed = policyBody.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'invalid', issues: issues(parsed.error) }, 400);
    const { hostHours, requiredFields, ...rest } = parsed.data;
    const patch: Partial<ClubSettings> = { ...rest };
    if (requiredFields) patch.requiredFields = [...new Set(requiredFields)];
    // null clears host hours (hosts always available).
    if (hostHours !== undefined) patch.hostHours = hostHours ?? undefined;
    const settings = await saveSettings(c, db, patch, 'club.settings_changed');
    return c.json({ settings });
  });

  // ----- Rich menu cells (A10b, spec §6.2 Bot content, §11.1.1) -----
  r.get('/clubs/:slug/rich-menu', managers, async (c) => {
    const club = c.var.club;
    return c.json({
      cells: richMenuCellsOf(club),
      allowed: RICH_MENU_CELLS.map((id) => ({ id, ...RICH_MENU_CELL_LABELS[id], available: id !== 'drinks' || Boolean(club.settings.drinksMenuUrl) })),
    });
  });

  /**
   * Saves the club's rich menu cells, then rebuilds the menu on LINE with `refreshRichMenuOnly`
   * (with the counted links, so every cell keeps its `s=rm_*` tag). Without a
   * LINE connection the cells are saved and the next setup run installs them.
   */
  r.put('/clubs/:slug/rich-menu', managers, async (c) => {
    const club = c.var.club;
    const parsed = richMenuBody.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'invalid', issues: issues(parsed.error) }, 400);
    const { cells } = parsed.data;
    if (cells.includes('drinks') && !club.settings.drinksMenuUrl) {
      return c.json({ error: 'invalid', issues: [{ field: 'cells', message: 'set the drinks menu link before adding the Drinks menu cell' }] }, 400);
    }
    const settings = await saveSettings(c, db, { richMenuCells: cells }, 'club.rich_menu_changed');
    const fresh = { ...club, settings };
    const creds = await app.credentials.line(fresh);
    if (!creds) return c.json({ cells, refreshed: false, report: null });
    let report: SetupReport;
    try {
      // Only the rich menu step: the webhook, LIFF, sample messages and PUBLIC_URL are left alone.
      const clients = app.lineSetupClients(creds.accessToken, await app.credentials.login(fresh));
      const menu = await refreshRichMenuOnly({ club: fresh, clients, links: app.deps.links, refresh: true });
      report = { ok: menu.step.ok, steps: [menu.step], ...(menu.richMenu ? { richMenu: menu.richMenu } : {}) };
    } catch (err) {
      report = { ok: false, steps: [{ name: 'Rich menu', ok: false, detail: describeLineError(err) }] };
    }
    // `refreshed` is true only when LINE took the new menu; the report says why otherwise.
    return c.json({ cells, refreshed: Boolean(report.richMenu), report });
  });

  // ----- Sensitive changes: fresh TOTP, audit, staff-group notice (spec §12.3) -----
  r.put('/clubs/:slug/promptpay', managers, async (c) => {
    const club = c.var.club;
    const body = await jsonBody(c);
    const refused = await freshTotpRefusal(app, c, body);
    if (refused) return refused;
    const parsed = promptpayBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid', issues: issues(parsed.error) }, 400);
    const now = app.deps.now();
    const after = { promptpayId: parsed.data.promptpayId, promptpayName: parsed.data.promptpayName ?? club.promptpayName };
    await db.update(clubs).set(after).where(eq(clubs.id, club.id));
    await auditClubChange(db, club, actorOf(c), { action: 'club.promptpay_changed', entity: 'clubs', entityId: club.id, before: { promptpayId: club.promptpayId, promptpayName: club.promptpayName }, after }, now);
    await clubChangeEvent(db, club, actorOf(c), now, { type: 'club.settings_changed', props: { fields: 'promptpay' } });
    await notifyOwners(app, club, `PromptPay ID changed by ${c.var.user.name ?? 'a manager'} to the account ending ${after.promptpayId.slice(-4)}. Deposits now go to this account. If the owner did not expect this, change it back in Settings now.`);
    return c.json({ ok: true, promptpayEnding: after.promptpayId.slice(-4) });
  });

  r.put('/clubs/:slug/greeting', managers, async (c) => {
    const club = c.var.club;
    const body = await jsonBody(c);
    const refused = await freshTotpRefusal(app, c, body);
    if (refused) return refused;
    const parsed = greetingBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid', issues: issues(parsed.error) }, 400);
    const patch: Partial<ClubSettings> = {};
    if (parsed.data.greeting) patch.greeting = parsed.data.greeting;
    if (parsed.data.mapUrl) patch.mapUrl = parsed.data.mapUrl;
    await saveSettings(c, db, patch, 'club.greeting_changed');
    await notifyOwners(app, club, `The greeting message or map link was changed by ${c.var.user.name ?? 'a manager'}.`);
    return c.json({ ok: true });
  });

  // ----- Zones and tables -----
  r.get('/clubs/:slug/tables', managers, async (c) => {
    const club = c.var.club;
    const [zs, ts, rules] = await Promise.all([
      db.select().from(zones).where(eq(zones.clubId, club.id)).orderBy(asc(zones.sort)),
      db.select().from(tables).where(eq(tables.clubId, club.id)).orderBy(asc(tables.sort)),
      currentPriceRules(db, club, app.deps.now()),
    ]);
    return c.json({ zones: zs, tables: ts, priceRules: rules, today: clubToday(club, app.deps.now()) });
  });

  r.post('/clubs/:slug/zones', managers, async (c) => {
    const club = c.var.club;
    const parsed = zoneCreate.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'invalid', issues: issues(parsed.error) }, 400);
    const now = app.deps.now();
    const [zone] = await db.insert(zones).values({ id: `zone_${newId()}`, clubId: club.id, ...parsed.data }).returning();
    await auditClubChange(db, club, actorOf(c), { action: 'club.zone_created', entity: 'zones', entityId: zone!.id, after: zone }, now);
    await clubChangeEvent(db, club, actorOf(c), now, { type: 'club.settings_changed', zoneId: zone!.id, props: { fields: 'zones' } });
    await refreshLayout(club.id, now);
    return c.json(zone, 201);
  });

  r.patch('/clubs/:slug/zones/:id', managers, async (c) => {
    const club = c.var.club;
    const before = await db.query.zones.findFirst({ where: and(eq(zones.id, c.req.param('id')), eq(zones.clubId, club.id)) });
    if (!before) return c.json({ error: 'not_found' }, 404);
    const parsed = zonePatch.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'invalid', issues: issues(parsed.error) }, 400);
    const now = app.deps.now();
    const [zone] = Object.keys(parsed.data).length ? await db.update(zones).set(parsed.data).where(eq(zones.id, before.id)).returning() : [before];
    await auditClubChange(db, club, actorOf(c), { action: 'club.zone_changed', entity: 'zones', entityId: before.id, before, after: zone }, now);
    await clubChangeEvent(db, club, actorOf(c), now, { type: 'club.settings_changed', zoneId: before.id, props: { fields: 'zones' } });
    await refreshLayout(club.id, now);
    return c.json(zone);
  });

  // The brain's layout note follows the tables (spec §8.2, B15). A failure is logged; the table change stands.
  async function refreshLayout(clubId: string, now: Date) {
    try {
      await regenerateLayoutNote(db, clubId, now);
    } catch (err) {
      app.deps.log('Layout note regenerate failed', err);
    }
  }
  const ownZone = (clubId: string, id: string) => db.query.zones.findFirst({ where: and(eq(zones.id, id), eq(zones.clubId, clubId)) });
  const codeTaken = async (clubId: string, code: string, exceptId?: string) => {
    const t = await db.query.tables.findFirst({ where: and(eq(tables.clubId, clubId), eq(tables.code, code)) });
    return Boolean(t && t.id !== exceptId);
  };

  r.post('/clubs/:slug/tables', managers, async (c) => {
    const club = c.var.club;
    const parsed = tableCreate.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'invalid', issues: issues(parsed.error) }, 400);
    if (!(await ownZone(club.id, parsed.data.zoneId))) return c.json({ error: 'not_found' }, 404);
    if (await codeTaken(club.id, parsed.data.code)) return c.json({ error: 'code_taken' }, 409);
    const now = app.deps.now();
    // New inventory counts from tonight on (spec §14.3).
    const [table] = await db.insert(tables).values({ id: `table_${newId()}`, clubId: club.id, ...parsed.data, validFrom: clubToday(club, now) }).returning();
    await auditClubChange(db, club, actorOf(c), { action: 'club.table_created', entity: 'tables', entityId: table!.id, after: table }, now);
    await clubChangeEvent(db, club, actorOf(c), now, { type: 'club.settings_changed', tableId: table!.id, zoneId: table!.zoneId, props: { fields: 'tables' } });
    await refreshLayout(club.id, now);
    return c.json(table, 201);
  });

  r.patch('/clubs/:slug/tables/:id', managers, async (c) => {
    const club = c.var.club;
    const before = await db.query.tables.findFirst({ where: and(eq(tables.id, c.req.param('id')), eq(tables.clubId, club.id)) });
    if (!before) return c.json({ error: 'not_found' }, 404);
    const parsed = tablePatch.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'invalid', issues: issues(parsed.error) }, 400);
    const p = parsed.data;
    if (p.zoneId && !(await ownZone(club.id, p.zoneId))) return c.json({ error: 'not_found' }, 404);
    if (p.code && (await codeTaken(club.id, p.code, before.id))) return c.json({ error: 'code_taken' }, 409);
    if ((p.minPax ?? before.minPax) > (p.maxPax ?? before.maxPax)) return c.json({ error: 'invalid', issues: [{ field: 'minPax', message: 'minPax must not exceed maxPax' }] }, 400);
    const now = app.deps.now();
    // A table taken out stays in the inventory of the nights it was in, up to tonight.
    const validity = p.active === false && before.active ? { validTo: clubToday(club, now) } : p.active === true && !before.active ? { validTo: null } : {};
    const [table] = await db.update(tables).set({ ...p, ...validity }).where(eq(tables.id, before.id)).returning();
    await auditClubChange(db, club, actorOf(c), { action: 'club.table_changed', entity: 'tables', entityId: before.id, before, after: table }, now);
    await clubChangeEvent(db, club, actorOf(c), now, { type: 'club.settings_changed', tableId: before.id, zoneId: table!.zoneId, props: { fields: 'tables' } });
    await refreshLayout(club.id, now);
    return c.json(table);
  });

  // ----- Prices (price_rules; the booking flow reads them through bookings/pricing.ts) -----
  r.get('/clubs/:slug/prices', managers, async (c) => c.json({ priceRules: await currentPriceRules(db, c.var.club, app.deps.now()) }));

  r.put('/clubs/:slug/prices', managers, async (c) => {
    const parsed = priceBody.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'invalid', issues: issues(parsed.error) }, 400);
    try {
      return c.json({ rule: await setPriceRule(db, c.var.club, parsed.data, actorOf(c), app.deps.now()) });
    } catch (err) {
      return refuse(c, err);
    }
  });

  // ----- Nights calendar -----
  r.get('/clubs/:slug/nights', managers, async (c) => {
    const club = c.var.club;
    const { from, days } = nightsRange(club, app.deps.now(), { from: c.req.query('from'), days: c.req.query('days') });
    return c.json({ from, days, nights: await listNights(db, club, from, days) });
  });

  r.put('/clubs/:slug/nights', managers, async (c) => {
    const parsed = nightBody.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'invalid', issues: issues(parsed.error) }, 400);
    try {
      return c.json(await upsertNight(db, c.var.club, parsed.data, actorOf(c), app.deps.now()));
    } catch (err) {
      return refuse(c, err);
    }
  });

  // ----- Club profile (same fields as the console's PUT /api/admin/clubs/:slug/profile) -----
  r.get('/clubs/:slug/profile', managers, async (c) => {
    const profile = await db.query.clubProfile.findFirst({ where: eq(clubProfile.clubId, c.var.club.id) });
    return c.json({ profile: profile ?? null });
  });

  r.put('/clubs/:slug/profile', managers, async (c) => {
    const club = c.var.club;
    const parsed = profileBody.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'invalid', issues: issues(parsed.error) }, 400);
    const now = app.deps.now();
    const before = await db.query.clubProfile.findFirst({ where: eq(clubProfile.clubId, club.id) });
    const values = parsed.data as Partial<typeof clubProfile.$inferInsert>;
    await db
      .insert(clubProfile)
      .values({ ...values, clubId: club.id })
      .onConflictDoUpdate({ target: clubProfile.clubId, set: Object.keys(values).length > 0 ? values : { clubId: club.id } });
    const after = await db.query.clubProfile.findFirst({ where: eq(clubProfile.clubId, club.id) });
    await auditClubChange(db, club, actorOf(c), { action: 'club.profile_changed', entity: 'club_profile', entityId: club.id, before: before ?? null, after }, now);
    await clubChangeEvent(db, club, actorOf(c), now, { type: 'club.settings_changed', props: { fields: 'profile' } });
    return c.json({ profile: after });
  });

  // ----- Push quota (spec §11.1.4: warn at 80%) -----
  r.get('/clubs/:slug/quota', managers, async (c) => {
    const [setup] = await db
      .select()
      .from(opsEvents)
      .where(and(eq(opsEvents.clubId, c.var.club.id), eq(opsEvents.kind, 'line_setup')))
      .orderBy(desc(opsEvents.at))
      .limit(1);
    const detail = setup?.detail as LineSetupDetail | undefined;
    return c.json({ quota: quotaView(detail?.quota), checkedAt: setup?.at.toISOString() ?? null });
  });

  return r;
}
