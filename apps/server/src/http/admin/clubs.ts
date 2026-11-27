import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { channels, clubProfile, clubs, type ClubStatus } from '../../db/schema.js';
import { emit } from '../../data/events.js';
import { chatwootFlagKey, tryProvisionClubInbox } from '../../integrations/chatwoot/provision.js';
import { newId } from '../../lib/util.js';
import { newClubSettings, uniqueRefPrefix } from '../../platform/club-templates.js';
import { credentialSummary } from '../../platform/credentials.js';
import { clubHealth } from '../../platform/health.js';
import { platformLoginSummary } from '../../platform/login-channel.js';
import type { AuthEnv } from '../auth.js';
import type { AppContext } from '../context.js';
import { adminAudit, clubBySlug, jsonBody } from './controls.js';

const STATUSES = ['onboarding', 'live', 'paused', 'demo'] as const satisfies readonly ClubStatus[];

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/),
  template: z.enum(['blank', 'velora-like']),
});

const statusBody = z.object({ status: z.enum(STATUSES) });

/** `club_profile` columns (§9) the console writes; A9's staff profile route reuses it. */
export const profileBody = z
  .object({
    capacityStanding: z.number().int().min(0).nullable(),
    capacitySeated: z.number().int().min(0).nullable(),
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
    district: z.string().max(200).nullable(),
    venueType: z.string().max(100).nullable(),
    genres: z.array(z.string().max(60)).max(30).nullable(),
    priceBand: z.string().max(40).nullable(),
    openingHours: z.record(z.string(), z.unknown()).nullable(),
    usualPeakHour: z.number().int().min(0).max(23).nullable(),
    licenceType: z.string().max(100).nullable(),
    posVendor: z.string().max(100).nullable(),
  })
  .partial();

async function takenPrefixes(db: Db): Promise<string[]> {
  const rows = await db.select({ settings: clubs.settings }).from(clubs);
  return rows.map((r) => r.settings.refPrefix);
}

/**
 * Clubs (plan A5, spec §12.3): list with health tiles, create from a template, status changes
 * and the club profile. Mounted under /api/admin.
 */
export function clubsRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;

  r.get('/clubs', async (c) => {
    const now = app.deps.now();
    const all = await db.select().from(clubs).orderBy(asc(clubs.name));
    return c.json({ clubs: await Promise.all(all.map((club) => clubHealth(db, club, now))) });
  });

  r.post('/clubs', async (c) => {
    const parsed = createBody.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues.map((i) => i.path.join('.')) }, 400);
    const { name, slug, template } = parsed.data;
    // B0's applyClubContent is not merged yet: the velora-like template waits for it.
    if (template === 'velora-like') return c.json({ error: 'not_ready', message: 'The velora-like template needs Track B task B0.' }, 501);
    if (await clubBySlug(db, slug)) return c.json({ error: 'slug_taken' }, 409);
    const now = app.deps.now();
    const id = `club_${newId()}`;
    const platform = await platformLoginSummary(db);
    const settings = { ...newClubSettings(slug, now), refPrefix: uniqueRefPrefix(slug, await takenPrefixes(db)) };
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.insert(clubs).values({
        id,
        slug,
        name,
        settings,
        status: 'onboarding',
        liffId: platform?.liffId ?? null,
        createdBy: c.var.user.id,
        createdAt: now,
      });
      await tx.insert(channels).values({ id: `chan_line_${id}`, clubId: id, kind: 'line' });
      await emit(tx, {
        clubId: id,
        type: 'club.created',
        occurredAt: now,
        actorType: 'platform',
        actorId: c.var.user.id,
        dataOrigin: 'first_party',
        props: { template },
        isTest: false,
      });
      await adminAudit(tx, c, { clubId: id, action: 'club.created', entity: 'clubs', entityId: id, after: { slug, name, template, refPrefix: settings.refPrefix } }, now);
    });
    // A13: one Chatwoot account + API inbox + agent bot per club. Skipped when Chatwoot is not
    // configured; a failure leaves the club created and is retried with POST .../inbox/provision.
    const inbox = await tryProvisionClubInbox(db, app.chatwoot, app.config.CREDENTIALS_KEY, { id, name, slug }, { publicUrl: app.config.PUBLIC_URL, by: c.var.user.id, now, log: app.deps.log });
    return c.json({ id, slug, name, status: 'onboarding', refPrefix: settings.refPrefix, inbox }, 201);
  });

  /** A13: (re)runs Chatwoot provisioning for a club; idempotent, completed steps are skipped. */
  r.post('/clubs/:slug/inbox/provision', async (c) => {
    if (!app.chatwoot) return c.json({ error: 'inbox_not_configured' }, 503);
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const now = app.deps.now();
    const inbox = await tryProvisionClubInbox(db, app.chatwoot, app.config.CREDENTIALS_KEY, club, { publicUrl: app.config.PUBLIC_URL, by: c.var.user.id, now, log: app.deps.log });
    await adminAudit(db, c, { clubId: club.id, action: 'club.inbox_provisioned', entity: 'platform_flags', entityId: chatwootFlagKey(club.id), after: inbox }, now);
    return c.json({ inbox }, inbox.status === 'ready' ? 200 : 502);
  });

  r.get('/clubs/:slug', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const profile = await db.query.clubProfile.findFirst({ where: eq(clubProfile.clubId, club.id) });
    return c.json({
      id: club.id,
      slug: club.slug,
      name: club.name,
      status: club.status,
      settings: club.settings,
      liffId: club.liffId,
      promptpayConfigured: Boolean(club.promptpayId),
      health: await clubHealth(db, club, app.deps.now()),
      credentials: await credentialSummary(db, club.id),
      profile: profile ?? null,
    });
  });

  r.patch('/clubs/:slug', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const parsed = statusBody.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const { status } = parsed.data;
    const now = app.deps.now();
    if (status === 'live') {
      const profile = await db.query.clubProfile.findFirst({ where: eq(clubProfile.clubId, club.id) });
      if (!profile) return c.json({ error: 'profile_missing' }, 409);
      // B5 refuses every guest of a club whose links have no LIFF id or login channel.
      if (!club.liffId || !(await app.credentials.login(club))) return c.json({ error: 'login_not_configured' }, 409);
      if (!profile.goLiveAt) await db.update(clubProfile).set({ goLiveAt: now }).where(eq(clubProfile.clubId, club.id));
    }
    await db.update(clubs).set({ status }).where(eq(clubs.id, club.id));
    await adminAudit(db, c, { clubId: club.id, action: 'club.status_changed', entity: 'clubs', entityId: club.id, before: { status: club.status }, after: { status } }, now);
    return c.json({ slug: club.slug, status });
  });

  r.put('/clubs/:slug/profile', async (c) => {
    const club = await clubBySlug(db, c.req.param('slug'));
    if (!club) return c.json({ error: 'not_found' }, 404);
    const parsed = profileBody.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues.map((i) => i.path.join('.')) }, 400);
    const now = app.deps.now();
    const before = await db.query.clubProfile.findFirst({ where: eq(clubProfile.clubId, club.id) });
    const values = parsed.data as Partial<typeof clubProfile.$inferInsert>;
    await db
      .insert(clubProfile)
      .values({ ...values, clubId: club.id })
      .onConflictDoUpdate({ target: clubProfile.clubId, set: Object.keys(values).length > 0 ? values : { clubId: club.id } });
    const after = await db.query.clubProfile.findFirst({ where: eq(clubProfile.clubId, club.id) });
    await adminAudit(db, c, { clubId: club.id, action: 'club.profile_changed', entity: 'club_profile', entityId: club.id, before: before ?? null, after }, now);
    return c.json({ profile: after });
  });

  return r;
}
