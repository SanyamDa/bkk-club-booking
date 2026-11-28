import { eq, sql, type SQL } from 'drizzle-orm';
import type { Actor } from '../bookings/service.js';
import type { Db } from '../db/client.js';
import { auditLog, clubs, type Club } from '../db/schema.js';
import type { AppContext } from '../http/context.js';
import { newId } from '../lib/util.js';

/**
 * Deleting a club made in demo step 7 (spec §12.4 "Reset ... deletes the club created in step 7
 * and clears the spare account's webhook"). Only a club marked `settings.demoOf` at creation and
 * still in status `demo` can be deleted; every other club is refused (`not_demo_spare`, 409).
 */
export class ClubDeleteError extends Error {
  constructor(readonly code: 'not_found' | 'not_demo_spare') {
    super(code);
    this.name = 'ClubDeleteError';
  }
}

/** True for a club made from the demo flow (step 7) that has not been turned into a real club. */
export const isDemoSpare = (club: Club): boolean => Boolean(club.settings.demoOf) && club.status === 'demo';

/** `audit_log` is the record of what happened, so the deletion keeps the club's audit rows. */
const KEPT_TABLES = new Set(['audit_log']);

type Fk = { child: string; ccol: string; parent: string; pcol: string };

const ident = (name: string) => sql.raw(`"${name.replace(/"/g, '""')}"`);
const rowsOf = <T>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? (res as T[]));

/**
 * Which tables hold the club's rows, read from the database catalog so a table added later is
 * covered without a code change: every table with a `club_id` column (except `audit_log`), plus
 * every table whose foreign key points at a row of one of those (for example
 * `booking_status_history` through `bookings`). Returns them children first, so no delete
 * breaks a foreign key, with the SQL condition that picks the club's rows in each.
 */
async function clubOwnedTables(tx: Db, clubId: string): Promise<{ table: string; where: SQL }[]> {
  const owned = new Set(
    rowsOf<{ t: string }>(
      await tx.execute(sql`
        select c.table_name as t from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = current_schema() and t.table_type = 'BASE TABLE' and c.column_name = 'club_id'`),
    )
      .map((r) => r.t)
      .filter((t) => !KEPT_TABLES.has(t)),
  );
  const fks = rowsOf<Fk>(
    await tx.execute(sql`
      select cl.relname as child, ca.attname as ccol, pl.relname as parent, pa.attname as pcol
      from pg_constraint k
      join pg_class cl on cl.oid = k.conrelid
      join pg_class pl on pl.oid = k.confrelid
      join pg_attribute ca on ca.attrelid = k.conrelid and ca.attnum = k.conkey[1]
      join pg_attribute pa on pa.attrelid = k.confrelid and pa.attnum = k.confkey[1]
      where k.contype = 'f' and k.connamespace = current_schema()::regnamespace and array_length(k.conkey, 1) = 1`),
  );

  // Tables with no club_id whose rows hang off a doomed row (repeat until nothing new is found).
  const doomed = new Set([...owned, 'clubs']);
  for (let grew = true; grew; ) {
    grew = false;
    for (const fk of fks) {
      if (doomed.has(fk.parent) && !doomed.has(fk.child) && !KEPT_TABLES.has(fk.child) && fk.child !== 'clubs') {
        doomed.add(fk.child);
        grew = true;
      }
    }
  }

  const where = new Map<string, SQL>();
  const whereOf = (table: string, seen: Set<string> = new Set()): SQL => {
    const known = where.get(table);
    if (known) return known;
    let cond: SQL;
    if (table === 'clubs') cond = sql`${ident('id')} = ${clubId}`;
    else if (owned.has(table)) cond = sql`${ident('club_id')} = ${clubId}`;
    else {
      const parts = fks
        .filter((fk) => fk.child === table && doomed.has(fk.parent) && !seen.has(fk.parent))
        .map((fk) => sql`${ident(fk.ccol)} in (select ${ident(fk.pcol)} from ${ident(fk.parent)} where ${whereOf(fk.parent, new Set([...seen, table]))})`);
      cond = sql.join(parts, sql` or `);
    }
    where.set(table, cond);
    return cond;
  };

  // Children first: a table is deleted only after every doomed table that points at it.
  const order: string[] = [];
  const left = new Set(doomed);
  while (left.size) {
    const ready = [...left].filter((t) => !fks.some((fk) => fk.parent === t && fk.child !== t && left.has(fk.child)));
    if (!ready.length) throw new Error(`deleteClub: foreign keys form a cycle among ${[...left].join(', ')}`);
    for (const t of ready.sort()) {
      order.push(t);
      left.delete(t);
    }
  }
  // Conditions are built before any delete runs, while every parent row still exists.
  return order.map((table) => ({ table, where: whereOf(table) }));
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/**
 * Deletes a club made in demo step 7 and every row it owns, in one transaction (spec §12.4). The
 * club must be marked `settings.demoOf` at creation and still be status `demo`; any other club is
 * refused with `ClubDeleteError('not_demo_spare')`. Also removes the club's `platform_flags`
 * (keys `<prefix>:<clubId>` and `<prefix>:<clubId>:...`). The club's `audit_log` rows are kept
 * and one `club.deleted` audit row is added (`after` holds the rows deleted per table). Does not
 * touch LINE: the caller clears the spare account's webhook first (`clearClubWebhook`), while the
 * club's credentials still exist.
 */
export async function deleteClub(db: Db, clubId: string, actor: Actor, now: Date): Promise<{ club: Club; rows: Record<string, number> }> {
  const club = await db.query.clubs.findFirst({ where: eq(clubs.id, clubId) });
  if (!club) throw new ClubDeleteError('not_found');
  if (!isDemoSpare(club)) throw new ClubDeleteError('not_demo_spare');
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // Re-read inside the transaction, so a club turned real a moment ago is still refused.
    const fresh = await tx.query.clubs.findFirst({ where: eq(clubs.id, clubId) });
    if (!fresh || !isDemoSpare(fresh)) throw new ClubDeleteError('not_demo_spare');
    const rows: Record<string, number> = {};
    for (const { table, where } of await clubOwnedTables(tx, clubId)) {
      const res = rowsOf<{ n: number | string }>(await tx.execute(sql`with d as (delete from ${ident(table)} where ${where} returning 1) select count(*) as n from d`));
      const n = Number(res[0]?.n ?? 0);
      if (n) rows[table] = n;
    }
    const id = likeEscape(clubId);
    const flags = rowsOf<{ n: number | string }>(
      await tx.execute(
        sql`with d as (delete from platform_flags where key like ${`%:${id}`} or key like ${`%:${id}:%`} returning 1) select count(*) as n from d`,
      ),
    );
    if (Number(flags[0]?.n ?? 0)) rows.platform_flags = Number(flags[0]!.n);
    await tx.insert(auditLog).values({
      id: newId(),
      clubId,
      actor: actor.type,
      actorType: actor.type,
      actorId: actor.id ?? null,
      sessionId: actor.sessionId ?? null,
      supportGrantId: actor.supportGrantId ?? null,
      action: 'club.deleted',
      entity: 'clubs',
      entityId: clubId,
      before: { slug: club.slug, name: club.name, status: club.status, demoOf: club.settings.demoOf },
      after: { rows },
      at: now,
    });
    return { club, rows };
  });
}

/**
 * Where a spare LINE account's webhook is pointed when its club is deleted. LINE's API has no way
 * to remove a webhook URL and refuses an empty one, so "clearing" points it at a path no club can
 * own (slugs start with a letter or digit): our server answers 404 and keeps nothing.
 */
export const PARKED_WEBHOOK_PATH = '/line/webhook/_parked';
export const parkedWebhookUrl = (publicUrl: string) => `${publicUrl.replace(/\/$/, '')}${PARKED_WEBHOOK_PATH}`;

export type WebhookClear = 'cleared' | 'no_credentials' | 'failed' | 'skipped';

/**
 * Clears the club's LINE webhook through the LINE client (`ctx.lineSetupClients`, a fake in tests).
 * Never throws: a LINE failure is logged and reported as `failed`, so a demo reset still goes on
 * (the next demo step 7 points the webhook at the new club anyway).
 */
export async function clearClubWebhook(ctx: AppContext, club: Club): Promise<WebhookClear> {
  try {
    const creds = await ctx.credentials.line(club);
    if (!creds) return 'no_credentials';
    const clients = ctx.lineSetupClients(creds.accessToken, null);
    await clients.api.setWebhookEndpoint({ endpoint: parkedWebhookUrl(ctx.config.PUBLIC_URL) });
    return 'cleared';
  } catch (err) {
    ctx.deps.log(`demo: clearing the LINE webhook of ${club.slug} failed`, err);
    return 'failed';
  }
}

/** The clubs made by the demo of `demoClubId` (step 7). */
export async function demoSpareClubs(db: Db, demoClubId: string): Promise<Club[]> {
  const rows = await db.select().from(clubs).where(sql`${clubs.settings} ->> 'demoOf' = ${demoClubId}`);
  return rows.filter(isDemoSpare);
}
