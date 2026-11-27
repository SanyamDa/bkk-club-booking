import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { recordRawWebhook } from '../src/data/raw-webhooks.js';
import { opsEvents, type Club } from '../src/db/schema.js';
import { newId } from '../src/lib/util.js';
import { setupTwoClubs } from './helpers.js';

/**
 * Plan A12: "uptime alert fires on webhook error rate". Runs the SQL of
 * infra/check-webhook-errors.sh against seeded PGlite rows, then runs the script itself with a
 * stand-in `psql` that prints those rows, and checks the exit code and the ALERT_URL call.
 */
const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'infra', 'check-webhook-errors.sh');

/** The script's query with the window filled in (the text between `<<SQL` and the closing `SQL`). */
function scriptSql(windowMin: number): string {
  const src = readFileSync(SCRIPT, 'utf8');
  const m = /<<SQL\n([\s\S]*?)\nSQL\n/.exec(src);
  if (!m) throw new Error('SQL block not found in check-webhook-errors.sh');
  return m[1]!.replaceAll('${WINDOW_MIN}', String(windowMin));
}

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let dir: string;
let server: Server;
let alerts: string[];
let alertUrl: string;

beforeEach(async () => {
  ({ db, close, clubA } = await setupTwoClubs());
  dir = mkdtempSync(join(tmpdir(), 'webhook-check-'));
  alerts = [];
  server = createServer((req, res) => {
    alerts.push(new URL(req.url ?? '/', 'http://x').searchParams.get('msg') ?? '');
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  alertUrl = `http://127.0.0.1:${addr.port}/fail`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
  await close();
});

async function seed(errors: number, inbound: number) {
  const at = new Date(Date.now() - 60_000);
  for (let i = 0; i < errors; i++) await db.insert(opsEvents).values({ id: newId(), clubId: clubA.id, kind: 'send_failed', detail: {}, at });
  // An error outside the window and a non-error kind are not counted.
  await db.insert(opsEvents).values({ id: newId(), clubId: clubA.id, kind: 'send_failed', detail: {}, at: new Date(Date.now() - 60 * 60_000) });
  await db.insert(opsEvents).values({ id: newId(), clubId: clubA.id, kind: 'line_setup', detail: {}, at });
  // The denominator is LINE deliveries in raw_webhooks (B3); other channels are not counted.
  for (let i = 0; i < inbound; i++) {
    await recordRawWebhook(db, { clubId: clubA.id, channel: 'line', body: { events: [] }, signatureOk: true, receivedAt: at });
  }
  await recordRawWebhook(db, { clubId: clubA.id, channel: 'pos:papaya', body: {}, signatureOk: true, receivedAt: at });
}

/** Runs the script's SQL on PGlite and prints rows the way `psql -AtF '|'` does. */
async function psqlOutput(): Promise<string> {
  const res = (await db.execute(sql.raw(scriptSql(15)))) as unknown as { rows: Record<string, unknown>[] };
  return res.rows.map((r) => Object.values(r).map((v) => String(v ?? '')).join('|')).join('\n');
}

async function runScript(out: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string }> {
  writeFileSync(join(dir, 'out.txt'), out ? out + '\n' : '');
  writeFileSync(join(dir, 'psql'), `#!/bin/sh\ncat "${join(dir, 'out.txt')}"\n`);
  chmodSync(join(dir, 'psql'), 0o755);
  return new Promise((resolve) => {
    execFile(
      'bash',
      [SCRIPT],
      { env: { PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: 'postgres://stand-in', ALERT_URL: alertUrl, ...env } },
      (err, stdout) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout }),
    );
  });
}

describe('webhook error-rate alert (plan A12, infra/check-webhook-errors.sh)', () => {
  it('the query counts errors in the window and LINE deliveries per club', async () => {
    await seed(3, 40);
    expect(await psqlOutput()).toBe(`${clubA.id}|3|40|7.5|send_failed`);
  });

  it('alerts and exits 1 when errors reach THRESHOLD', async () => {
    await seed(5, 0);
    const r = await runScript(await psqlOutput());
    expect(r.code).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(`club ${clubA.id}: 5 webhook/send errors`);
  });

  it('alerts when the error rate is above MAX_RATE_PCT with enough inbound', async () => {
    await seed(3, 40); // 7.5% of 40 inbound, below THRESHOLD 5
    const r = await runScript(await psqlOutput());
    expect(r.code).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('error rate 7.5%');
  });

  it('stays quiet below both THRESHOLD and MAX_RATE_PCT', async () => {
    await seed(2, 100); // 2 errors, 2%
    const r = await runScript(await psqlOutput());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"msg":"ok"');
    expect(alerts).toHaveLength(0);
  });

  it('a high rate with fewer than MIN_INBOUND inbound messages does not alert', async () => {
    await seed(3, 10); // 30%, but only 10 inbound
    const r = await runScript(await psqlOutput());
    expect(r.code).toBe(0);
    expect(alerts).toHaveLength(0);
  });
});
