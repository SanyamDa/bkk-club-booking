import { createHash, randomBytes } from 'node:crypto';
import { and, eq, like, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { auditLog, clubProfile, clubs, platformFlags, priceRules, tables, zones, type Club } from '../../db/schema.js';
import { tryProvisionClubInbox } from '../../integrations/chatwoot/provision.js';
import { newId } from '../../lib/util.js';
import { clubToday, setPriceRule, type SettingsActor } from '../../platform/club-settings.js';
import { clubHealth } from '../../platform/health.js';
import { clientIp, type AuthEnv } from '../auth.js';
import type { AppContext } from '../context.js';
import { profileBody } from './clubs.js';
import { adminAudit, clubBySlug, jsonBody } from './controls.js';

/**
 * Onboarding wizard (plan A17, spec §12.2). The founder makes a pre-call form link; the club fills
 * the form at /onboard/<token> in its own time; the founder reads the answers and applies them
 * (tables, prices, rules, profile) before the call. The call's steps are timed.
 *
 * Storage, all in `platform_flags` (no migration):
 * - `onboarding_link:<clubId>`: `{ tokenHash, createdAt, expiresAt, createdBy }`. Only the SHA-256
 *   of the token is stored. A new link replaces (revokes) the old one.
 * - `onboarding_form:<clubId>`: `{ submittedAt, data }`, the latest submission.
 * - `onboarding:<clubId>`: `{ steps: { [step]: { startedAt, endedAt, durationMs } }, appliedAt? }`.
 *
 * Baseline FAQs are kept in the submission; writing them into the brain waits for B15
 * (`brain/notes.ts`), so the apply step reports `faqs: not_ready`.
 */

export const LINK_TTL_MS = 14 * 86_400_000;

/** The minute table of §12.2, in order. */
export const ONBOARDING_STEPS = [
  'login',
  'messaging_api',
  'credentials',
  'connect',
  'response_settings',
  'live_test',
  'staff_login',
  'plan_check',
  'go_live',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

const linkKey = (clubId: string) => `onboarding_link:${clubId}`;
const formKey = (clubId: string) => `onboarding_form:${clubId}`;
const timingKey = (clubId: string) => `onboarding:${clubId}`;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

type LinkValue = { tokenHash: string; createdAt: string; expiresAt: string; createdBy: string };
type StepTiming = { startedAt: string | null; endedAt: string | null; durationMs: number | null };
type TimingValue = { steps: Partial<Record<OnboardingStep, StepTiming>>; appliedAt?: string };

const satang = z.number().int().min(0).max(1_000_000_000);
const text = (max: number) => z.string().trim().min(1).max(max);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** What the club enters in the pre-call form (spec §12.2 "Before the call"). */
export const onboardingForm = z
  .object({
    zones: z
      .array(
        z
          .object({
            name: text(60),
            nameTh: text(60),
            minSpendSatang: satang,
            depositSatang: satang,
            weekdayPrices: z.array(z.object({ weekday: z.number().int().min(0).max(6), minSpendSatang: satang, depositSatang: satang }).strict()).max(7).optional(),
          })
          .strict(),
      )
      .max(30),
    tables: z
      .array(
        z
          .object({ code: text(20), zone: text(60), minPax: z.number().int().min(1).max(100), maxPax: z.number().int().min(1).max(100), minSpendSatang: satang.optional(), depositSatang: satang.optional() })
          .strict()
          .refine((t) => t.minPax <= t.maxPax, { message: 'minPax must not exceed maxPax' })
          .refine((t) => (t.minSpendSatang === undefined) === (t.depositSatang === undefined), { message: 'give both table prices or neither' }),
      )
      .max(300),
    policies: z
      .object({
        openWeekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
        arrivalBy: hhmm.optional(),
        rules: z.object({ en: z.array(text(300)).max(30), th: z.array(text(300)).max(30) }).strict().optional(),
        cancellationPolicy: z.string().trim().max(2000).optional(),
      })
      .strict()
      .default({}),
    profile: profileBody.default({}),
    faqs: z.array(z.object({ question: text(300), answerEn: z.string().trim().max(2000).optional(), answerTh: z.string().trim().max(2000).optional() }).strict()).max(100).default([]),
    /** Recorded only; the PromptPay ID is entered with a fresh second factor in Settings (§12.3). */
    promptpayNote: z.string().trim().max(100).optional(),
    contact: z.object({ name: z.string().trim().max(120).optional(), lineAdmin: z.boolean().optional(), desktop: z.boolean().optional(), noOtherBot: z.boolean().optional() }).strict().optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    const names = new Set(f.zones.map((z) => z.name));
    if (names.size !== f.zones.length) ctx.addIssue({ code: 'custom', path: ['zones'], message: 'zone names must be unique' });
    const codes = new Set<string>();
    f.tables.forEach((t, i) => {
      if (!names.has(t.zone)) ctx.addIssue({ code: 'custom', path: ['tables', i, 'zone'], message: 'unknown zone' });
      if (codes.has(t.code)) ctx.addIssue({ code: 'custom', path: ['tables', i, 'code'], message: 'duplicate table code' });
      codes.add(t.code);
    });
  });
export type OnboardingForm = z.infer<typeof onboardingForm>;

const timingBody = z.object({ step: z.enum(ONBOARDING_STEPS), event: z.enum(['start', 'end']) }).strict();

const issues = (e: z.ZodError) => e.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));

async function readFlag<T>(db: Db, key: string): Promise<T | null> {
  const row = await db.query.platformFlags.findFirst({ where: eq(platformFlags.key, key) });
  return (row?.value as T | undefined) ?? null;
}

async function writeFlag(db: Db, key: string, value: unknown, by: string | null, now: Date) {
  await db
    .insert(platformFlags)
    .values({ key, value, updatedBy: by, updatedAt: now })
    .onConflictDoUpdate({ target: platformFlags.key, set: { value, updatedBy: by, updatedAt: now } });
}

/** The club a live (not expired, not replaced) form token belongs to. */
async function clubForToken(db: Db, token: string, now: Date): Promise<Club | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const hash = hashToken(token);
  const [row] = await db
    .select()
    .from(platformFlags)
    .where(and(like(platformFlags.key, 'onboarding_link:%'), sql`${platformFlags.value}->>'tokenHash' = ${hash}`))
    .limit(1);
  if (!row) return null;
  const link = row.value as LinkValue;
  if (new Date(link.expiresAt) <= now) return null;
  const clubId = row.key.slice('onboarding_link:'.length);
  return (await db.query.clubs.findFirst({ where: eq(clubs.id, clubId) })) ?? null;
}

function totalMs(t: TimingValue | null): number | null {
  const steps = Object.values(t?.steps ?? {});
  const starts = steps.map((s) => s.startedAt).filter((x): x is string => Boolean(x)).map((x) => Date.parse(x));
  const ends = steps.map((s) => s.endedAt).filter((x): x is string => Boolean(x)).map((x) => Date.parse(x));
  if (starts.length === 0 || ends.length === 0) return null;
  return Math.max(...ends) - Math.min(...starts);
}

/** Go-live readiness, read fresh on every call (the wizard polls it). */
async function liveChecks(app: AppContext, club: Club) {
  const { db } = app.deps;
  const now = app.deps.now();
  const [tableCount] = await db.select({ n: sql<number>`count(*)::int` }).from(tables).where(and(eq(tables.clubId, club.id), eq(tables.active, true)));
  const [priceCount] = await db.select({ n: sql<number>`count(*)::int` }).from(priceRules).where(eq(priceRules.clubId, club.id));
  const profile = await db.query.clubProfile.findFirst({ where: eq(clubProfile.clubId, club.id) });
  const health = await clubHealth(db, club, now);
  return {
    formSubmitted: Boolean(await readFlag(db, formKey(club.id))),
    tables: (tableCount?.n ?? 0) > 0,
    prices: (priceCount?.n ?? 0) > 0,
    rules: club.settings.rules.en.length > 0 && club.settings.rules.th.length > 0,
    profile: Boolean(profile),
    lineConnected: health.lineConnected,
    webhookOk: health.webhookOk,
    loginConfigured: Boolean(club.liffId) && Boolean(await app.credentials.login(club).catch(() => null)),
    promptpay: Boolean(club.promptpayId),
    staffGroupLinked: health.staffGroupLinked,
    live: club.status === 'live',
  };
}

type ApplyStep = { name: string; status: 'done' | 'skipped' | 'not_ready' | 'manual' | 'failed'; count?: number; detail?: string };

/** Loads one submission into the club: zones, tables, prices (price_rules), rules, profile. Idempotent. */
async function applyForm(db: Db, club: Club, form: OnboardingForm, actor: SettingsActor, now: Date): Promise<ApplyStep[]> {
  const steps: ApplyStep[] = [];
  const zoneIds = new Map<string, string>();
  const existingZones = await db.select().from(zones).where(eq(zones.clubId, club.id));
  let sort = existingZones.length;
  for (const z of form.zones) {
    const found = existingZones.find((e) => e.name === z.name);
    if (found) {
      // Zone prices live in price_rules from here on; only the Thai name is refreshed.
      await db.update(zones).set({ nameTh: z.nameTh }).where(eq(zones.id, found.id));
      zoneIds.set(z.name, found.id);
    } else {
      const newIdValue = `zone_${newId()}`;
      await db.insert(zones).values({ id: newIdValue, clubId: club.id, name: z.name, nameTh: z.nameTh, sort: sort++, minSpendSatang: z.minSpendSatang, depositSatang: z.depositSatang });
      zoneIds.set(z.name, newIdValue);
    }
  }
  steps.push({ name: 'zones', status: 'done', count: form.zones.length });

  const tableIds = new Map<string, string>();
  const existingTables = await db.select().from(tables).where(eq(tables.clubId, club.id));
  for (const [i, t] of form.tables.entries()) {
    const zoneId = zoneIds.get(t.zone)!;
    const found = existingTables.find((e) => e.code === t.code);
    if (found) {
      await db.update(tables).set({ zoneId, minPax: t.minPax, maxPax: t.maxPax, active: true }).where(eq(tables.id, found.id));
      tableIds.set(t.code, found.id);
    } else {
      const id = `table_${newId()}`;
      await db.insert(tables).values({ id, clubId: club.id, zoneId, code: t.code, minPax: t.minPax, maxPax: t.maxPax, sort: existingTables.length + i, validFrom: clubToday(club, now) });
      tableIds.set(t.code, id);
    }
  }
  steps.push({ name: 'tables', status: 'done', count: form.tables.length });

  // Prices go through setPriceRule (valid_from today), which changes a same-day rule in place.
  let prices = 0;
  for (const z of form.zones) {
    const scopeId = zoneIds.get(z.name)!;
    await setPriceRule(db, club, { scope: 'zone', scopeId, minSpendSatang: z.minSpendSatang, depositSatang: z.depositSatang }, actor, now);
    prices++;
    for (const w of z.weekdayPrices ?? []) {
      await setPriceRule(db, club, { scope: 'zone', scopeId, weekday: w.weekday, minSpendSatang: w.minSpendSatang, depositSatang: w.depositSatang }, actor, now);
      prices++;
    }
  }
  for (const t of form.tables) {
    if (t.minSpendSatang === undefined || t.depositSatang === undefined) continue;
    await setPriceRule(db, club, { scope: 'table', scopeId: tableIds.get(t.code)!, minSpendSatang: t.minSpendSatang, depositSatang: t.depositSatang }, actor, now);
    prices++;
  }
  steps.push({ name: 'prices', status: 'done', count: prices });

  const p = form.policies;
  const fresh = (await db.query.clubs.findFirst({ where: eq(clubs.id, club.id) }))!;
  const settings = {
    ...fresh.settings,
    ...(p.openWeekdays ? { openWeekdays: [...p.openWeekdays].sort((a, b) => a - b) } : {}),
    ...(p.arrivalBy ? { arrivalBy: p.arrivalBy } : {}),
    ...(p.rules ? { rules: p.rules, rulesVersion: clubToday(club, now) } : {}),
  };
  await db.update(clubs).set({ settings }).where(eq(clubs.id, club.id));
  steps.push({ name: 'rules', status: p.rules || p.openWeekdays || p.arrivalBy ? 'done' : 'skipped' });

  const profile = form.profile as Partial<typeof clubProfile.$inferInsert>;
  if (Object.keys(profile).length > 0) {
    await db.insert(clubProfile).values({ ...profile, clubId: club.id }).onConflictDoUpdate({ target: clubProfile.clubId, set: profile });
    steps.push({ name: 'profile', status: 'done' });
  } else steps.push({ name: 'profile', status: 'skipped' });

  steps.push({ name: 'faqs', status: 'not_ready', count: form.faqs.length, detail: 'Baseline FAQs wait for the brain store (B15 brain/notes.ts); kept in the submission.' });
  steps.push({ name: 'promptpay', status: 'manual', detail: 'Enter the PromptPay ID in Settings with a fresh second factor.' });
  return steps;
}

/** Founder side, mounted under /api/admin (behind requirePlatformAdmin). */
export function onboardingAdminRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;

  const actorOf = (c: Context<AuthEnv>): SettingsActor => ({ type: 'platform', id: c.var.user.id, sessionId: c.var.session.idHash, ip: clientIp(c) });

  r.post('/clubs/:slug/onboarding/link', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    if (club.status !== 'onboarding') return c.json({ error: 'not_onboarding' }, 409);
    const now = app.deps.now();
    const token = randomBytes(24).toString('base64url');
    const value: LinkValue = { tokenHash: hashToken(token), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + LINK_TTL_MS).toISOString(), createdBy: c.var.user.id };
    await writeFlag(db, linkKey(club.id), value, c.var.user.id, now);
    await adminAudit(db, c, { clubId: club.id, action: 'onboarding.link_created', entity: 'platform_flags', entityId: linkKey(club.id), after: { expiresAt: value.expiresAt } }, now);
    const base = app.config.PUBLIC_URL.replace(/\/$/, '');
    return c.json({ url: `${base}/onboard/${token}`, expiresAt: value.expiresAt }, 201);
  });

  r.get('/clubs/:slug/onboarding', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const link = await readFlag<LinkValue>(db, linkKey(club.id));
    const timing = await readFlag<TimingValue>(db, timingKey(club.id));
    return c.json({
      link: link ? { createdAt: link.createdAt, expiresAt: link.expiresAt, expired: new Date(link.expiresAt) <= app.deps.now() } : null,
      submission: await readFlag(db, formKey(club.id)),
      timing: { steps: timing?.steps ?? {}, appliedAt: timing?.appliedAt ?? null, totalMs: totalMs(timing) },
      checks: await liveChecks(app, club),
    });
  });

  r.post('/clubs/:slug/onboarding/apply', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    if (club.status !== 'onboarding') return c.json({ error: 'not_onboarding' }, 409);
    const sub = await readFlag<{ data: unknown }>(db, formKey(club.id));
    if (!sub) return c.json({ error: 'no_submission' }, 409);
    const parsed = onboardingForm.safeParse(sub.data);
    if (!parsed.success) return c.json({ error: 'invalid_submission', issues: issues(parsed.error) }, 409);
    const now = app.deps.now();
    const steps = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const out = await applyForm(tx, club, parsed.data, actorOf(c), now);
      const timing = (await readFlag<TimingValue>(tx, timingKey(club.id))) ?? { steps: {} };
      await writeFlag(tx, timingKey(club.id), { ...timing, appliedAt: now.toISOString() }, c.var.user.id, now);
      await adminAudit(tx, c, { clubId: club.id, action: 'onboarding.applied', entity: 'clubs', entityId: club.id, after: { steps: out } }, now);
      return out;
    });
    // A13: the wizard also (re)runs the club's Chatwoot provisioning; idempotent, outside the
    // transaction because it calls Chatwoot. Skipped when Chatwoot is not configured.
    const inbox = await tryProvisionClubInbox(db, app.chatwoot, app.config.CREDENTIALS_KEY, club, { publicUrl: app.config.PUBLIC_URL, by: c.var.user.id, now, log: app.deps.log });
    steps.push({ name: 'inbox', status: inbox.status === 'ready' ? 'done' : inbox.status === 'not_configured' ? 'skipped' : 'failed', ...('error' in inbox && inbox.error ? { detail: String(inbox.error) } : {}) });
    return c.json({ steps });
  });

  r.post('/clubs/:slug/onboarding/timing', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const parsed = timingBody.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: issues(parsed.error) }, 400);
    const { step, event } = parsed.data;
    const now = app.deps.now();
    const timing = (await readFlag<TimingValue>(db, timingKey(club.id))) ?? { steps: {} };
    const cur: StepTiming = timing.steps[step] ?? { startedAt: null, endedAt: null, durationMs: null };
    const next: StepTiming =
      event === 'start'
        ? { startedAt: now.toISOString(), endedAt: null, durationMs: null }
        : { startedAt: cur.startedAt, endedAt: now.toISOString(), durationMs: cur.startedAt ? now.getTime() - Date.parse(cur.startedAt) : null };
    const value: TimingValue = { ...timing, steps: { ...timing.steps, [step]: next } };
    await writeFlag(db, timingKey(club.id), value, c.var.user.id, now);
    return c.json({ step, timing: next, totalMs: totalMs(value) });
  });

  return r;
}

/**
 * The club's side, mounted at /api/onboard (outside /api/staff and /api/admin): the token in the
 * path is the only credential. A wrong, replaced or expired token is 404; a club that is no longer
 * onboarding is 410. Submitting stores the answers only; nothing reaches club data until the
 * founder applies them.
 */
export function onboardPublicRoutes(app: AppContext) {
  const r = new Hono();
  const { db } = app.deps;

  r.get('/:token', async (c) => {
    const now = app.deps.now();
    const club = await clubForToken(db, c.req.param('token'), now);
    if (!club) return c.json({ error: 'invalid_link' }, 404);
    if (club.status !== 'onboarding') return c.json({ error: 'closed' }, 410);
    const sub = await readFlag<{ submittedAt: string; data: unknown }>(db, formKey(club.id));
    return c.json({ club: { name: club.name }, submission: sub ?? null });
  });

  r.put('/:token', async (c) => {
    const now = app.deps.now();
    const club = await clubForToken(db, c.req.param('token'), now);
    if (!club) return c.json({ error: 'invalid_link' }, 404);
    if (club.status !== 'onboarding') return c.json({ error: 'closed' }, 410);
    const parsed = onboardingForm.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', issues: issues(parsed.error) }, 400);
    const value = { submittedAt: now.toISOString(), data: parsed.data };
    await writeFlag(db, formKey(club.id), value, null, now);
    await db.insert(auditLog).values({
      id: newId(),
      clubId: club.id,
      actor: 'system',
      actorType: 'system',
      ip: clientIp(c) ?? null,
      action: 'onboarding.form_submitted',
      entity: 'platform_flags',
      entityId: formKey(club.id),
      after: { zones: parsed.data.zones.length, tables: parsed.data.tables.length, faqs: parsed.data.faqs.length },
      at: now,
    });
    return c.json({ ok: true, submittedAt: value.submittedAt });
  });

  return r;
}
