import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, inArray, like, lte, sql } from 'drizzle-orm';
import { nightStatus } from '../bookings/service.js';
import type { Db } from '../db/client.js';
import {
  auditLog,
  clubProfile,
  clubs,
  crowdRatings,
  doorCounts,
  events,
  occupancySnapshots,
  platformFlags,
  type Club,
} from '../db/schema.js';
import { addDays, bangkokParts, currentNightDate, weekdayOf } from '../lib/time.js';
import { newId } from '../lib/util.js';

/**
 * The busyness feed v1 for the separate consumer app (spec §14.7, plan B21). Reads only the
 * aggregate area: occupancy snapshots, door counts, crowd ratings, and first-party / POS events
 * (§14.8). It never reads bookings or guests, and returns levels, never counts.
 */

export const BUSYNESS_RATE_LIMIT_PER_MINUTE = 60;
/** A forecast resting on fewer booked guests than this is "no data" (§14.7 starting value). */
export const MIN_BOOKED_GUESTS = 10;
/** Earlier same-weekday nights needed before the weekday baseline × pace method is used. */
export const BASELINE_MIN_NIGHTS = 4;
/** How many earlier same-weekday nights the baseline looks at (8 weeks). */
const BASELINE_WEEKS = 8;
/** A crowd rating sets the level of the buckets in the hour after it. */
const RATING_FRESH_MS = 60 * 60_000;
const BUCKET_MS = 30 * 60_000;
const BKK_OFFSET_MS = 7 * 60 * 60_000;
/** The only origins the feed may read (§14.8). */
const FEED_ORIGINS = ['first_party', 'pos'] as const;

export type BusynessLevel = 1 | 2 | 3 | 4 | 5;
export type BusynessInput = 'bookings' | 'baseline' | 'door_count' | 'crowd_rating' | 'searches';

export interface BusynessBucket {
  start: string;
  label: string;
  level: BusynessLevel | null;
  noData: boolean;
  confidence: 'low' | 'medium' | 'high' | null;
  inputs: BusynessInput[];
}

export interface BusynessClub {
  slug: string;
  name: string;
  nightDate: string;
  night: 'open' | 'closed' | 'sold_out';
  method: 'booking_heat' | 'baseline_pace' | null;
  test: boolean;
  buckets: BusynessBucket[];
}

export interface BusynessFeed {
  version: 'v1';
  generatedAt: string;
  sandbox: boolean;
  clubs: BusynessClub[];
}

/** A fraction of capacity (0–1) on the 5-step scale. */
export function levelOf(fraction: number): BusynessLevel {
  if (fraction < 0.2) return 1;
  if (fraction < 0.4) return 2;
  if (fraction < 0.6) return 3;
  if (fraction < 0.8) return 4;
  return 5;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** The instant of `hour:00` Bangkok time on `date`. */
function bangkokAt(date: string, hour: number): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, hour) - BKK_OFFSET_MS);
}

/** 30-minute buckets from doors to close (exclusive). */
function nightBuckets(club: Club, nightDate: string): Date[] {
  const { nightStartHour, nightEndHour } = club.settings;
  const doors = bangkokAt(nightDate, nightStartHour).getTime();
  const close = bangkokAt(nightEndHour <= nightStartHour ? addDays(nightDate, 1) : nightDate, nightEndHour).getTime();
  const out: Date[] = [];
  for (let t = doors; t < close; t += BUCKET_MS) out.push(new Date(t));
  return out;
}

const label = (at: Date) => {
  const p = bangkokParts(at);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

type Snapshot = typeof occupancySnapshots.$inferSelect;

const heatOf = (s: Snapshot) => (s.tablesActive > 0 ? (s.tablesHeld + s.tablesConfirmed + s.tablesArrived) / s.tablesActive : 0);

/** The latest snapshot taken at or before `at`. `list` is in time order. */
function snapshotAt(list: Snapshot[], at: Date): Snapshot | undefined {
  let found: Snapshot | undefined;
  for (const s of list) if (s.takenAt <= at) found = s;
  return found;
}

/**
 * Weekday baseline × pace (§14.7, weeks 4–8): null until BASELINE_MIN_NIGHTS earlier same-weekday
 * nights have snapshots. Otherwise a forecast for a snapshot of tonight: mean final heat of those
 * nights × pace, where pace compares the snapshot's heat with those nights' mean heat at the same
 * lead bucket (pace 1 when that mean is 0 or no earlier night has that bucket).
 */
async function baselineModel(db: Db, club: Club, nightDate: string): Promise<((snap: Snapshot) => number) | null> {
  const dates = Array.from({ length: BASELINE_WEEKS }, (_, i) => addDays(nightDate, -7 * (i + 1)));
  const rows = await db
    .select()
    .from(occupancySnapshots)
    .where(and(eq(occupancySnapshots.clubId, club.id), inArray(occupancySnapshots.nightDate, dates)))
    .orderBy(asc(occupancySnapshots.takenAt));
  const byNight = new Map<string, Snapshot[]>();
  for (const r of rows) {
    if (weekdayOf(r.nightDate) !== weekdayOf(nightDate)) continue;
    byNight.set(r.nightDate, [...(byNight.get(r.nightDate) ?? []), r]);
  }
  if (byNight.size < BASELINE_MIN_NIGHTS) return null;
  const nightsList = [...byNight.values()];
  const finalMean = nightsList.reduce((s, l) => s + heatOf(l.at(-1)!), 0) / nightsList.length;
  const meanAt = new Map<string, number>();
  return (snap) => {
    let sameMean = meanAt.get(snap.leadBucket);
    if (sameMean === undefined) {
      const same = nightsList.map((l) => l.find((s) => s.leadBucket === snap.leadBucket)).filter((s): s is Snapshot => !!s);
      sameMean = same.length ? same.reduce((s, x) => s + heatOf(x), 0) / same.length : 0;
      meanAt.set(snap.leadBucket, sameMean);
    }
    const pace = sameMean > 0 ? heatOf(snap) / sameMean : 1;
    return clamp01(finalMean * pace);
  };
}

async function clubNight(db: Db, club: Club, nightDate: string, now: Date, sandbox: boolean): Promise<BusynessClub> {
  const night = await nightStatus(db, club.id, nightDate);
  const base: BusynessClub = { slug: club.slug, name: club.name, nightDate, night, method: null, test: club.status === 'demo', buckets: [] };
  if (night === 'closed') return base;

  const buckets = nightBuckets(club, nightDate);
  const snaps = await db
    .select()
    .from(occupancySnapshots)
    .where(and(eq(occupancySnapshots.clubId, club.id), eq(occupancySnapshots.nightDate, nightDate), lte(occupancySnapshots.takenAt, now)))
    .orderBy(asc(occupancySnapshots.takenAt));
  const ratings = await db
    .select({ at: crowdRatings.at, level: crowdRatings.level })
    .from(crowdRatings)
    .where(and(eq(crowdRatings.clubId, club.id), eq(crowdRatings.nightDate, nightDate), lte(crowdRatings.at, now)))
    .orderBy(asc(crowdRatings.at));
  const doors = await db
    .select({ at: doorCounts.at, delta: doorCounts.delta })
    .from(doorCounts)
    .where(and(eq(doorCounts.clubId, club.id), eq(doorCounts.nightDate, nightDate), lte(doorCounts.at, now)))
    .orderBy(asc(doorCounts.at));
  const profile = await db.query.clubProfile.findFirst({ where: eq(clubProfile.clubId, club.id) });
  const capacity = profile?.capacityStanding && profile.capacityStanding > 0 ? profile.capacityStanding : null;
  // Search demand: first-party and POS events only (§14.8); the production feed leaves test rows out.
  const [searched] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(events)
    .where(
      and(
        eq(events.clubId, club.id),
        eq(events.type, 'availability.searched'),
        eq(events.nightDate, nightDate),
        inArray(events.dataOrigin, [...FEED_ORIGINS]),
        sandbox ? undefined : eq(events.isTest, false),
        lte(events.occurredAt, now),
      ),
    );
  const hasSearches = (searched?.n ?? 0) > 0;

  const latest = snaps.at(-1);
  const baseline = latest ? await baselineModel(db, club, nightDate) : null;
  const method = baseline === null ? 'booking_heat' : 'baseline_pace';
  const observedNight = ratings.length > 0 || doors.length > 0;

  base.method = method;
  base.buckets = buckets.map((start): BusynessBucket => {
    const end = new Date(start.getTime() + BUCKET_MS);
    const started = start <= now;
    const at = started ? (end < now ? end : now) : now;
    const inputs = new Set<BusynessInput>();
    if (hasSearches) inputs.add('searches');
    const snap = snapshotAt(snaps, at);
    if (snap) inputs.add('bookings');

    if (started) {
      const rating = [...ratings].reverse().find((r) => r.at <= at && at.getTime() - r.at.getTime() <= RATING_FRESH_MS);
      if (rating) {
        inputs.add('crowd_rating');
        return { start: start.toISOString(), label: label(start), level: rating.level as BusynessLevel, noData: false, confidence: 'high', inputs: [...inputs] };
      }
      const inside = doors.filter((d) => d.at <= at).reduce((s, d) => s + d.delta, 0);
      if (capacity && doors.some((d) => d.at <= at)) {
        inputs.add('door_count');
        return { start: start.toISOString(), label: label(start), level: levelOf(clamp01(inside / capacity)), noData: false, confidence: 'medium', inputs: [...inputs] };
      }
    }
    const thin = !snap || snap.paxBooked < MIN_BOOKED_GUESTS || (started && !observedNight);
    if (thin) return { start: start.toISOString(), label: label(start), level: null, noData: true, confidence: null, inputs: [...inputs] };
    // Under baseline_pace every forecast bucket uses baseline × pace from its own snapshot.
    if (baseline) inputs.add('baseline');
    const fraction = baseline ? baseline(snap) : heatOf(snap);
    return {
      start: start.toISOString(),
      label: label(start),
      level: levelOf(fraction),
      noData: false,
      confidence: method === 'baseline_pace' ? 'medium' : 'low',
      inputs: [...inputs],
    };
  });
  return base;
}

/**
 * The feed (§14.7). A production key sees every live club; a sandbox key sees only demo clubs
 * (Velora), marked test. `date` defaults to each club's current night.
 */
export async function busynessFeed(db: Db, opts: { kind: 'production' | 'sandbox'; date?: string; now: Date }): Promise<BusynessFeed> {
  const sandbox = opts.kind === 'sandbox';
  const list = await db
    .select()
    .from(clubs)
    .where(eq(clubs.status, sandbox ? 'demo' : 'live'))
    .orderBy(asc(clubs.slug));
  const out: BusynessClub[] = [];
  for (const club of list) {
    const nightDate = opts.date ?? currentNightDate(opts.now, club.settings.nightEndHour);
    out.push(await clubNight(db, club, nightDate, opts.now, sandbox));
  }
  return { version: 'v1', generatedAt: opts.now.toISOString(), sandbox, clubs: out };
}

// ---------- API keys for the separate app ----------

export type BusynessKeyKind = 'production' | 'sandbox';

interface StoredKey {
  kind: BusynessKeyKind;
  label: string;
  hash: string;
  createdAt: string;
  createdBy: string;
  rotatedAt: string | null;
  revokedAt: string | null;
}

export interface BusynessKeyInfo {
  id: string;
  kind: BusynessKeyKind;
  label: string;
  createdAt: string;
  createdBy: string;
  rotatedAt: string | null;
  revokedAt: string | null;
}

const KEY_PREFIX = 'busyness_key:';
const flagKey = (id: string) => `${KEY_PREFIX}${id}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newToken = (id: string) => `bk_${id}_${randomBytes(32).toString('base64url')}`;
const info = (id: string, k: StoredKey): BusynessKeyInfo => ({
  id,
  kind: k.kind,
  label: k.label,
  createdAt: k.createdAt,
  createdBy: k.createdBy,
  rotatedAt: k.rotatedAt,
  revokedAt: k.revokedAt,
});

async function loadKey(db: Db, id: string): Promise<StoredKey | null> {
  const row = await db.query.platformFlags.findFirst({ where: eq(platformFlags.key, flagKey(id)) });
  return (row?.value as StoredKey | null | undefined) ?? null;
}

async function saveKey(db: Db, id: string, k: StoredKey, by: string, now: Date) {
  await db
    .insert(platformFlags)
    .values({ key: flagKey(id), value: k, updatedBy: by, updatedAt: now })
    .onConflictDoUpdate({ target: platformFlags.key, set: { value: k, updatedBy: by, updatedAt: now } });
}

async function keyAudit(db: Db, action: string, id: string, by: string, now: Date, after: unknown, ip?: string | null) {
  await db.insert(auditLog).values({
    id: newId(),
    clubId: null,
    actor: 'platform',
    actorType: 'platform',
    actorId: by,
    ip: ip ?? null,
    action,
    entity: 'busyness_key',
    entityId: id,
    after: after ?? null,
    at: now,
  });
}

/** Issues a key; the token is returned once and only its hash is stored. */
export async function issueBusynessKey(
  db: Db,
  input: { label: string; kind: BusynessKeyKind },
  by: string,
  now: Date,
  ip?: string | null,
): Promise<{ key: BusynessKeyInfo; token: string }> {
  const id = newId();
  const token = newToken(id);
  const stored: StoredKey = { kind: input.kind, label: input.label, hash: sha256(token), createdAt: now.toISOString(), createdBy: by, rotatedAt: null, revokedAt: null };
  await saveKey(db, id, stored, by, now);
  await keyAudit(db, 'busyness_key_issued', id, by, now, { kind: input.kind, label: input.label }, ip);
  return { key: info(id, stored), token };
}

/**
 * A new secret on the same id; the old token stops at once. Null when unknown or revoked. The write
 * is a compare-and-set on the hash read and on `revokedAt` still null, so a rotate that overlaps a
 * revoke (or another rotate) cannot undo it: the losing call changes nothing and returns null.
 */
export async function rotateBusynessKey(db: Db, id: string, by: string, now: Date, ip?: string | null): Promise<{ key: BusynessKeyInfo; token: string } | null> {
  const k = await loadKey(db, id);
  if (!k || k.revokedAt) return null;
  const token = newToken(id);
  const patch = { hash: sha256(token), rotatedAt: now.toISOString() };
  const [row] = await db
    .update(platformFlags)
    .set({ value: sql`${platformFlags.value} || ${JSON.stringify(patch)}::jsonb`, updatedBy: by, updatedAt: now })
    .where(
      and(
        eq(platformFlags.key, flagKey(id)),
        sql`${platformFlags.value}->>'hash' = ${k.hash}`,
        sql`${platformFlags.value}->>'revokedAt' is null`,
      ),
    )
    .returning({ value: platformFlags.value });
  if (!row) return null;
  await keyAudit(db, 'busyness_key_rotated', id, by, now, { kind: k.kind }, ip);
  return { key: info(id, row.value as StoredKey), token };
}

/**
 * Revokes a key. Sets only `revokedAt` (never rewrites the hash from a stale read), and only when it
 * is still null; revoking an already revoked key changes nothing and writes no audit row.
 */
export async function revokeBusynessKey(db: Db, id: string, by: string, now: Date, ip?: string | null): Promise<BusynessKeyInfo | null> {
  const [row] = await db
    .update(platformFlags)
    .set({ value: sql`jsonb_set(${platformFlags.value}, '{revokedAt}', to_jsonb(${now.toISOString()}::text))`, updatedBy: by, updatedAt: now })
    .where(and(eq(platformFlags.key, flagKey(id)), sql`${platformFlags.value}->>'revokedAt' is null`))
    .returning({ value: platformFlags.value });
  if (!row) {
    const k = await loadKey(db, id);
    return k ? info(id, k) : null;
  }
  const k = row.value as StoredKey;
  await keyAudit(db, 'busyness_key_revoked', id, by, now, { kind: k.kind }, ip);
  return info(id, k);
}

export async function listBusynessKeys(db: Db): Promise<BusynessKeyInfo[]> {
  const rows = await db.select().from(platformFlags).where(like(platformFlags.key, `${KEY_PREFIX}%`));
  return rows
    .map((r) => info(r.key.slice(KEY_PREFIX.length), r.value as StoredKey))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The key a token belongs to, or null (unknown, wrong secret or revoked). */
export async function verifyBusynessKey(db: Db, token: string): Promise<BusynessKeyInfo | null> {
  const m = /^bk_([A-Za-z0-9_-]+?)_([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const id = m[1]!;
  const k = await loadKey(db, id);
  if (!k || k.revokedAt) return null;
  const a = Buffer.from(sha256(token), 'hex');
  const b = Buffer.from(k.hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return info(id, k);
}

/** Access log (§14.7): one `audit_log` row per accepted read. */
export async function logBusynessRead(db: Db, key: BusynessKeyInfo, now: Date, data: { clubs: number; date: string | null }, ip?: string | null) {
  await db.insert(auditLog).values({
    id: newId(),
    clubId: null,
    actor: `busyness_key:${key.id}`,
    actorType: 'system',
    actorId: key.id,
    ip: ip ?? null,
    action: 'busyness_read',
    entity: 'busyness_key',
    entityId: key.id,
    data: { kind: key.kind, ...data },
    at: now,
  });
}

/** Rolling one-minute request window per key, in memory (one per app instance). */
export function busynessRateLimiter(limit = BUSYNESS_RATE_LIMIT_PER_MINUTE) {
  const hits = new Map<string, number[]>();
  return (keyId: string, now: Date): { ok: true } | { ok: false; retryAfterSeconds: number } => {
    const t = now.getTime();
    const list = (hits.get(keyId) ?? []).filter((x) => t - x < 60_000);
    if (list.length >= limit) {
      hits.set(keyId, list);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((list[0]! + 60_000 - t) / 1000)) };
    }
    list.push(t);
    hits.set(keyId, list);
    return { ok: true };
  };
}
