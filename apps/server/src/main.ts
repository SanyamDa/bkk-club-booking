import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { seedCalendarDays } from './data/calendar.js';
import { DEMO_CLUB_SLUG, seedDemoClub } from './db/seed.js';
import { startBackground } from './jobs/index.js';
import { logLine } from './lib/log.js';

const config = loadConfig();
const { db, close } = await openDb({ url: config.DATABASE_URL, dataDir: config.DATA_DIR });
await seedDemoClub(db);
await seedCalendarDays(db); // B13: the city calendar seed; existing rows are kept
const { app, ctx } = createApp(config, db);

const stopBackground = await startBackground(ctx, () => new Date());

const server = serve({ fetch: app.fetch, port: config.API_PORT }, (info) => {
  const base = `${config.PUBLIC_URL.replace(/\/$/, '')}`;
  logLine('info', 'server started', {
    port: info.port,
    dashboard: `${base}/staff`,
    simulator: config.DEV_SIMULATOR ? `${base}/dev/simulator` : null,
    webhook: `${base}/line/webhook/${DEMO_CLUB_SLUG}`,
  });
});

async function shutdown() {
  logLine('info', 'server stopping');
  await stopBackground();
  server.close();
  await close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
