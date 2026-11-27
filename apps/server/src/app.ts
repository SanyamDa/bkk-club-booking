import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { Notifier } from './bot/notify.js';
import type { BotDeps } from './bot/flow.js';
import { Links } from './bot/links.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { devRoutes } from './http/dev.js';
import type { AppContext } from './http/context.js';
import { liffRoutes } from './http/liff.js';
import { mediaRoutes } from './http/media.js';
import { staffRoutes } from './http/staff.js';
import { webhookRoutes } from './http/webhook.js';
import { GatewayRegistry } from './line/gateway.js';
import { lineIdTokenVerifier } from './line/idtoken.js';
import { realSetupClients } from './line/setup.js';
import { Outbox } from './line/outbox.js';

export function createApp(
  config: Config,
  db: Db,
  opts: {
    now?: () => Date;
    log?: BotDeps['log'];
    lineSetupClients?: AppContext['lineSetupClients'];
    verifyIdToken?: AppContext['verifyIdToken'];
  } = {},
) {
  const log = opts.log ?? ((msg: string, err?: unknown) => (err ? console.error(msg, err) : console.log(msg)));
  const pending = new Set<Promise<unknown>>();
  const deps: BotDeps = {
    db,
    outbox: new Outbox(db, log),
    links: new Links(config.PUBLIC_URL, config.APP_SECRET),
    uploadsDir: join(config.DATA_DIR, 'uploads'),
    now: opts.now ?? (() => new Date()),
    log,
  };
  const gateways = new GatewayRegistry();
  const ctx: AppContext = {
    config,
    deps,
    gateways,
    notifier: new Notifier(deps, gateways),
    track: (p) => {
      pending.add(p);
      void p.catch((err) => log('Background task failed', err)).finally(() => pending.delete(p));
    },
    lineSetupClients: opts.lineSetupClients ?? realSetupClients,
    verifyIdToken: opts.verifyIdToken ?? lineIdTokenVerifier(),
  };

  const app = new Hono();
  app.use('*', secureHeaders({ crossOriginResourcePolicy: false, xFrameOptions: false }));
  app.get('/health', (c) => c.json({ ok: true }));
  app.route('/line/webhook', webhookRoutes(ctx));
  app.route('/media', mediaRoutes(ctx));
  app.route('/api/liff', liffRoutes(ctx));
  app.route('/api/staff', staffRoutes(ctx));
  if (config.DEV_SIMULATOR) app.route('/api/dev', devRoutes(ctx));
  app.onError((err, c) => {
    log(`Unhandled error on ${c.req.method} ${c.req.path}`, err);
    return c.json({ error: 'server_error' }, 500);
  });

  // In production the server also serves the built web app (dashboard + guest pages).
  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(webDist)) {
    app.use('/assets/*', serveStatic({ root: webDist }));
    app.get('*', async (c) => {
      if (c.req.path.startsWith('/api/')) return c.json({ error: 'not_found' }, 404);
      return c.html(await readFile(join(webDist, 'index.html'), 'utf8'));
    });
  }

  return { app, ctx, settle: () => Promise.allSettled([...pending]) };
}
