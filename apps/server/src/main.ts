import 'dotenv/config';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { createApp } from './app.js';
import { expireStaleHolds } from './bookings/service.js';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { clubs } from './db/schema.js';
import { DEMO_CLUB_SLUG, seedDemoClub } from './db/seed.js';

const config = loadConfig();
const { db, close } = await openDb({ url: config.DATABASE_URL, dataDir: config.DATA_DIR });
await seedDemoClub(db);
const { app, ctx } = createApp(config, db);

// Release holds whose time ran out and tell the guest (spec §5.2 step 6).
const sweeper = setInterval(async () => {
  try {
    const expired = await expireStaleHolds(db, new Date());
    for (const b of expired) await ctx.notifier.holdExpired(b);
  } catch (err) {
    console.error('Hold sweeper failed', err);
  }
}, 30_000);

const server = serve({ fetch: app.fetch, port: config.API_PORT }, (info) => {
  const demo = `${config.PUBLIC_URL.replace(/\/$/, '')}`;
  console.log(`\nClub booking server on http://localhost:${info.port}`);
  console.log(`  Dashboard:  ${demo}/staff`);
  if (config.DEV_SIMULATOR) console.log(`  Simulator:  ${demo}/dev/simulator`);
  console.log(`  Webhook:    ${demo}/line/webhook/${DEMO_CLUB_SLUG}\n`);
});

void db.query.clubs.findFirst({ where: eq(clubs.slug, DEMO_CLUB_SLUG) }).then((club) => {
  if (club) console.log(`  Staff group link code for ${club.name}: type "link ${club.staffLinkCode}" in your staff LINE group.\n`);
});

async function shutdown() {
  clearInterval(sweeper);
  server.close();
  await close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
