import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

/** Both drivers expose the same query-builder API; we type against node-postgres. */
export type Db = NodePgDatabase<typeof schema>;

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

/**
 * Opens the database and applies migrations.
 * - With a Postgres URL: connects to that server.
 * - Without one: uses PGlite (embedded Postgres) in `dataDir`, or in memory when dataDir is 'memory'.
 */
export async function openDb(opts: { url?: string; dataDir: string }): Promise<DbHandle> {
  if (opts.url) {
    const pool = new pg.Pool({ connectionString: opts.url });
    const db = drizzlePg(pool, { schema });
    await migratePg(db, { migrationsFolder });
    return { db, close: () => pool.end() };
  }
  let client: PGlite;
  if (opts.dataDir === 'memory') {
    client = new PGlite();
  } else {
    mkdirSync(opts.dataDir, { recursive: true });
    client = new PGlite(`${opts.dataDir}/pglite`);
  }
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => client.close() };
}

/** Postgres unique-violation check that works across drivers and Drizzle's error wrapping. */
export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    if (typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === '23505') {
      return true;
    }
    e = typeof e === 'object' && e !== null && 'cause' in e ? (e as { cause: unknown }).cause : undefined;
  }
  return false;
}
