import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { DEMO_CLUB_SLUG, seedDemoClub } from './db/seed.js';
import { startBackground } from './jobs/index.js';

const config = loadConfig();
const { db, close } = await openDb({ url: config.DATABASE_URL, dataDir: config.DATA_DIR });
await seedDemoClub(db);
const { app, ctx } = createApp(config, db);

const stopBackground = await startBackground(ctx, () => new Date());

const server = serve({ fetch: app.fetch, port: config.API_PORT }, (info) => {
  const demo = `${config.PUBLIC_URL.replace(/\/$/, '')}`;
  console.log(`\nClub booking server on http://localhost:${info.port}`);
  console.log(`  Dashboard:  ${demo}/staff`);
  if (config.DEV_SIMULATOR) console.log(`  Simulator:  ${demo}/dev/simulator`);
  console.log(`  Webhook:    ${demo}/line/webhook/${DEMO_CLUB_SLUG}\n`);
});

async function shutdown() {
  await stopBackground();
  server.close();
  await close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
