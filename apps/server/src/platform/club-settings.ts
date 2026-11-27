import { and, asc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Actor } from '../bookings/service.js';
import type { Db } from '../db/client.js';
import { auditLog, nights, priceRules, tables, zones, type Club, type Night, type PriceRule } from '../db/schema.js';
import { emit, type EventInput } from '../data/events.js';
import { addDays, currentNightDate } from '../lib/time.js';
import { newId } from '../lib/util.js';

/**
 * Club data writes shared by the staff Settings and Calendar pages and the founder console
 * (plan A9, spec §6.2 Settings, §12.3 Club data, §14.3). Prices go to `price_rules` with
 * `valid_from` / `valid_to`, and nights to `nights` with `edited_by`, so past nights keep the
 * inventory, prices and status they had.
 */

/** A refusal with its HTTP status (404 for another club's id, 409 for a clash). */
export class SettingsError extends Error {
  constructor(
    public code: string,
    public status: 400 | 404 | 409,
  ) {
    super(code);
  }
}

export type SettingsActor = Actor & { ip?: string };

/** The club's current night date (Bangkok); price and inventory changes start here. */
export const clubToday = (club: Club, now: Date) => currentNightDate(now, club.settings.nightEndHour);

/** One `audit_log` row for a club-data change, attributed to the staff member or founder. */
export async function auditClubChange(
  db: Db,
  club: Club,
  actor: SettingsActor,
  row: { action: string; entity: string; entityId: string; before?: unknown; after?: unknown },
  now: Date,
) {
  await db.insert(auditLog).values({
    id: newId(),
    clubId: club.id,
    actor: actor.type,
    actorType: actor.type,
    actorId: actor.id ?? null,
    sessionId: actor.sessionId ?? null,
    supportGrantId: actor.supportGrantId ?? null,
    ip: actor.ip ?? null,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId,
    before: row.before ?? null,
    after: row.after ?? null,
    at: now,
  });
}

type ClubEvent = Omit<EventInput, 'clubId' | 'occurredAt' | 'actorType' | 'actorId' | 'dataOrigin' | 'isTest'>;

/** An event for `club`, attributed to `actor` (test data on a demo club). */
export function clubChangeEvent(db: Db, club: Club, actor: SettingsActor, now: Date, e: ClubEvent) {
  return emit(db, {
    ...e,
    clubId: club.id,
    occurredAt: now,
    actorType: actor.type,
    actorId: actor.id,
    dataOrigin: 'first_party',
    isTest: club.status === 'demo',
  });
}

async function inTx<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (txRaw) => fn(txRaw as unknown as Db));
}

// ---------- Prices ----------

const satang = z.number().int().min(0).max(1_000_000_000);

export const priceBody = z
  .object({
    scope: z.enum(['club', 'zone', 'table']),
    scopeId: z.string().min(1).nullable().optional(),
    weekday: z.number().int().min(0).max(6).nullable().optional(),
    minSpendSatang: satang,
    depositSatang: satang,
  })
  .strict()
  .refine((b) => (b.scope === 'club') === !b.scopeId, { message: 'scopeId is required for zone and table rules only' });
export type PriceInput = z.infer<typeof priceBody> & { nightId?: string | null };

/**
 * Rule priority for B9b's "highest priority wins": table over zone over club, and a weekday rule
 * over a plain one, an event-night rule over both.
 */
export function rulePriority(r: { scope: 'club' | 'zone' | 'table'; weekday?: number | null; nightId?: string | null }): number {
  return { club: 0, zone: 1, table: 2 }[r.scope] + (r.weekday != null ? 10 : 0) + (r.nightId ? 20 : 0);
}

/**
 * Sets the price for one (scope, scope id, weekday, night) from today on. The open rule for that
 * key is closed at yesterday (`valid_to` is inclusive) and a new rule opens today, so every past
 * night keeps its price. A rule that itself started today is changed in place. Emits
 * `club.price_changed` and writes the audit row.
 */
export async function setPriceRule(db: Db, club: Club, input: PriceInput, actor: SettingsActor, now: Date, opts: { nightDate?: string } = {}): Promise<PriceRule> {
  const scopeId = input.scope === 'club' ? null : input.scopeId!;
  const weekday = input.weekday ?? null;
  const nightId = input.nightId ?? null;
  if (input.scope === 'zone' && !(await db.query.zones.findFirst({ where: and(eq(zones.id, scopeId!), eq(zones.clubId, club.id)) }))) {
    throw new SettingsError('not_found', 404);
  }
  if (input.scope === 'table' && !(await db.query.tables.findFirst({ where: and(eq(tables.id, scopeId!), eq(tables.clubId, club.id)) }))) {
    throw new SettingsError('not_found', 404);
  }
  const today = clubToday(club, now);
  const priority = rulePriority({ scope: input.scope, weekday, nightId });
  return inTx(db, async (tx) => {
    const [open] = await tx
      .select()
      .from(priceRules)
      .where(
        and(
          eq(priceRules.clubId, club.id),
          eq(priceRules.scope, input.scope),
          scopeId ? eq(priceRules.scopeId, scopeId) : isNull(priceRules.scopeId),
          weekday != null ? eq(priceRules.weekday, weekday) : isNull(priceRules.weekday),
          nightId ? eq(priceRules.nightId, nightId) : isNull(priceRules.nightId),
          isNull(priceRules.validTo),
        ),
      )
      .limit(1);
    let rule: PriceRule;
    const prices = { minSpendSatang: input.minSpendSatang, depositSatang: input.depositSatang };
    if (open && open.validFrom === today) {
      [rule] = (await tx.update(priceRules).set({ ...prices, priority }).where(eq(priceRules.id, open.id)).returning()) as [PriceRule];
    } else {
      if (open) await tx.update(priceRules).set({ validTo: addDays(today, -1) }).where(eq(priceRules.id, open.id));
      [rule] = (await tx
        .insert(priceRules)
        .values({ id: `price_${newId()}`, clubId: club.id, scope: input.scope, scopeId, weekday, nightId, ...prices, priority, validFrom: today, validTo: null })
        .returning()) as [PriceRule];
    }
    await clubChangeEvent(tx, club, actor, now, {
      type: 'club.price_changed',
      zoneId: input.scope === 'zone' ? scopeId! : undefined,
      tableId: input.scope === 'table' ? scopeId! : undefined,
      nightDate: opts.nightDate,
      props: {
        scope: input.scope,
        scopeId,
        weekday,
        nightId,
        minSpendSatang: input.minSpendSatang,
        depositSatang: input.depositSatang,
        previousMinSpendSatang: open?.minSpendSatang ?? null,
        previousDepositSatang: open?.depositSatang ?? null,
        validFrom: rule.validFrom,
      },
    });
    await auditClubChange(tx, club, actor, { action: 'club.price_changed', entity: 'price_rules', entityId: rule.id, before: open ?? null, after: rule }, now);
    return rule;
  });
}

/** Rules in force today or later (closed rules of past nights are left out). */
export async function currentPriceRules(db: Db, club: Club, now: Date): Promise<PriceRule[]> {
  const today = clubToday(club, now);
  return db
    .select()
    .from(priceRules)
    .where(and(eq(priceRules.clubId, club.id), or(isNull(priceRules.validTo), gte(priceRules.validTo, today))))
    .orderBy(asc(priceRules.priority));
}

// ---------- Nights ----------

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const nightBody = z
  .object({
    date: dateString,
    status: z.enum(['open', 'closed']).optional(),
    closedReason: z.string().trim().min(1).max(200).nullable().optional(),
    eventType: z.string().trim().max(60).nullable().optional(),
    eventName: z.string().trim().max(200).nullable().optional(),
    lineup: z.array(z.string().trim().min(1).max(120)).max(30).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    eventPrice: z.object({ minSpendSatang: satang, depositSatang: satang }).strict().optional(),
  })
  .strict()
  .refine((b) => b.status !== 'closed' || Boolean(b.closedReason), { message: 'closedReason is required to close a night', path: ['closedReason'] });
export type NightInput = z.infer<typeof nightBody>;

/**
 * Creates or edits the club's `nights` row for one date and sets `edited_by`, so the nights job
 * (B8b) never overwrites it. Closing needs a reason; opening clears it. The first time a night gets
 * an event name, `club.event_night_created` is emitted. `eventPrice` writes an event-night
 * `price_rules` row (`night_id`).
 */
export async function upsertNight(db: Db, club: Club, input: NightInput, actor: SettingsActor, now: Date): Promise<{ night: Night; created: boolean }> {
  const result = await inTx(db, async (tx) => {
    const before = await tx.query.nights.findFirst({ where: and(eq(nights.clubId, club.id), eq(nights.date, input.date)) });
    const status = input.status ?? before?.status ?? 'open';
    const pick = <K extends 'eventType' | 'eventName' | 'lineup' | 'notes'>(k: K) => (input[k] !== undefined ? input[k] : (before?.[k] ?? null));
    const values = {
      status,
      closedReason: status === 'closed' ? (input.closedReason ?? before?.closedReason ?? null) : null,
      eventType: pick('eventType'),
      eventName: pick('eventName'),
      lineup: pick('lineup') as unknown,
      notes: pick('notes'),
      editedBy: actor.id ?? actor.type,
    };
    const [night] = (before
      ? await tx.update(nights).set(values).where(eq(nights.id, before.id)).returning()
      : await tx.insert(nights).values({ id: `night_${newId()}`, clubId: club.id, date: input.date, ...values }).returning()) as [Night];
    const created = Boolean(night.eventName) && !before?.eventName;
    if (created) {
      await clubChangeEvent(tx, club, actor, now, {
        type: 'club.event_night_created',
        nightDate: input.date,
        props: { nightId: night.id, eventName: night.eventName, eventType: night.eventType },
      });
    }
    await auditClubChange(tx, club, actor, { action: 'club.night_changed', entity: 'nights', entityId: night.id, before: before ?? null, after: night }, now);
    return { night, created };
  });
  if (input.eventPrice) {
    await setPriceRule(db, club, { scope: 'club', ...input.eventPrice, nightId: result.night.id }, actor, now, { nightDate: input.date });
  }
  return result;
}

/** The club's `nights` rows from `from` for `days` days (dates with no row are not listed). */
export async function listNights(db: Db, club: Club, from: string, days: number): Promise<Night[]> {
  return db
    .select()
    .from(nights)
    .where(and(eq(nights.clubId, club.id), gte(nights.date, from), lte(nights.date, addDays(from, days - 1))))
    .orderBy(asc(nights.date));
}

/** Parses `?from=YYYY-MM-DD&days=N` (default: today, 60 days, at most 400). */
export function nightsRange(club: Club, now: Date, q: { from?: string; days?: string }): { from: string; days: number } {
  const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : clubToday(club, now);
  const n = Number(q.days);
  const days = Number.isInteger(n) && n > 0 ? Math.min(n, 400) : 60;
  return { from, days };
}
