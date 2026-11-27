import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { bookings, deposits, rawWebhooks, type Club } from '../src/db/schema.js';
import { purgeRawWebhooks, purgeSlips } from '../src/jobs/retention.js';
import { newId } from '../src/lib/util.js';
import { FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupDb } from './helpers.js';

const DAY = 86_400_000;
const now = FRIDAY_AFTERNOON;
const ago = (days: number) => new Date(now.getTime() - days * DAY);

let ctx: Awaited<ReturnType<typeof setupDb>>;
let db: Db;
let club: Club;
let uploads: string;
beforeEach(async () => {
  ctx = await setupDb();
  ({ db, club } = ctx);
  uploads = await mkdtemp(join(tmpdir(), 'retention-'));
});
afterEach(async () => {
  await ctx.close();
  await rm(uploads, { recursive: true, force: true });
});

describe('retention (B10b)', () => {
  it('raw webhooks older than 30 days are purged, unprocessed ones kept', async () => {
    const row = (id: string, receivedAt: Date, processedAt: Date | null) => ({
      id, clubId: club.id, channel: 'line', receivedAt, processedAt, body: { events: [] }, signatureOk: true,
    });
    await db.insert(rawWebhooks).values([
      row('old_done', ago(31), ago(31)),
      row('old_unprocessed', ago(40), null),
      row('recent_done', ago(29), ago(29)),
    ]);
    expect(await purgeRawWebhooks(db, now)).toBe(1);
    const left = (await db.select({ id: rawWebhooks.id }).from(rawWebhooks)).map((r) => r.id).sort();
    expect(left).toEqual(['old_unprocessed', 'recent_done']);
    expect(await purgeRawWebhooks(db, now)).toBe(0);
  });

  it('slips older than 1 year are purged', async () => {
    const guest = await makeGuest(db);
    await mkdir(join(uploads, club.id), { recursive: true });
    const slip = async (n: string, receivedAt: Date) => {
      const bookingId = newId();
      await db.insert(bookings).values({
        id: bookingId, clubId: club.id, refCode: `VL-RT${n}`, guestId: guest.id, tableId: `table_demo_B${n}`, nightDate: FRIDAY,
        pax: 4, status: 'confirmed', source: 'line', minSpendSatang: 800_000, depositSatang: 300_000,
      });
      const rel = join(club.id, `${bookingId}.jpg`);
      await writeFile(join(uploads, rel), Buffer.from([0xff, 0xd8, 0xff]));
      await db.insert(deposits).values({
        id: `dep_${n}`, clubId: club.id, bookingId, amountSatang: 300_000, method: 'promptpay_slip', status: 'verified', slipPath: rel, slipReceivedAt: receivedAt,
      });
      return rel;
    };
    const oldRel = await slip('1', ago(366));
    const newRel = await slip('2', ago(364));

    expect(await purgeSlips(db, now, uploads)).toBe(1);
    expect(existsSync(join(uploads, oldRel))).toBe(false);
    expect(existsSync(join(uploads, newRel))).toBe(true);
    expect((await db.select().from(deposits).where(eq(deposits.id, 'dep_1')))[0]!.slipPath).toBeNull();
    expect((await db.select().from(deposits).where(eq(deposits.id, 'dep_2')))[0]!.slipPath).toBe(newRel);
    expect(await purgeSlips(db, now, uploads)).toBe(0);
  });
});
