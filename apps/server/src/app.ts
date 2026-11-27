import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { buildBotDeps, type BotDepOptions } from './bot/deps.js';
import { Notifier } from './bot/notify.js';
import { isDevOrTest, type Config } from './config.js';
import type { Db } from './db/client.js';
import { jsonLog } from './lib/log.js';
import { authRoutes } from './http/auth.js';
import { devRoutes } from './http/dev.js';
import type { AppContext } from './http/context.js';
import { liffRoutes } from './http/liff.js';
import { mediaRoutes } from './http/media.js';
import { staffRoutes } from './http/staff.js';
import { webhookRoutes } from './http/webhook.js';
import { dbCredentialStore, envCredentialStore, onlyDemoClubs } from './line/credentials.js';
import { GatewayRegistry } from './line/gateway.js';
import { lineIdTokenVerifier } from './line/idtoken.js';
import { fakeLiffEndpointUpdater, fakeSetupClients, realLiffEndpointUpdater, realSetupClients } from './line/setup.js';
import { fakeLineTokenIssuer, realLineTokenIssuer } from './line/tokens.js';

/** What `opts.onResponse` sees for every JSON response (test hook: secret-leak checks). */
export interface ResponseRecord {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

export function createApp(
  config: Config,
  db: Db,
  opts: {
    bot?: BotDepOptions;
    credentials?: AppContext['credentials'];
    lineSetupClients?: AppContext['lineSetupClients'];
    verifyIdToken?: AppContext['verifyIdToken'];
    updateLiffEndpoint?: AppContext['updateLiffEndpoint'];
    /** Test hook: called with every JSON response body. */
    onResponse?: (r: ResponseRecord) => void;
  } = {},
) {
  // Structured JSON log lines on stdout (A7) unless the caller (tests) passes its own logger.
  const deps = buildBotDeps(config, db, { ...opts.bot, log: opts.bot?.log ?? jsonLog });
  const log = deps.log;
  const pending = new Set<Promise<unknown>>();
  // Club secrets live encrypted in the database (A4). The env store is only a development
  // fallback for the demo club. LINE_FAKE (development/test only) swaps in a local fake LINE.
  const devOrTest = isDevOrTest(config.NODE_ENV);
  const credentials =
    opts.credentials ??
    dbCredentialStore(
      db,
      config.CREDENTIALS_KEY,
      config.LINE_FAKE ? fakeLineTokenIssuer() : realLineTokenIssuer(),
      devOrTest ? onlyDemoClubs(envCredentialStore()) : undefined,
    );
  const gateways = new GatewayRegistry(credentials);
  const ctx: AppContext = {
    config,
    deps,
    gateways,
    credentials,
    notifier: new Notifier(deps, gateways),
    track: (p) => {
      pending.add(p);
      void p.catch((err) => log('Background task failed', err)).finally(() => pending.delete(p));
    },
    lineSetupClients: opts.lineSetupClients ?? (config.LINE_FAKE ? fakeSetupClients : realSetupClients),
    verifyIdToken: opts.verifyIdToken ?? lineIdTokenVerifier(),
    updateLiffEndpoint: opts.updateLiffEndpoint ?? (config.LINE_FAKE ? fakeLiffEndpointUpdater : realLiffEndpointUpdater),
  };

  const app = new Hono();
  const onResponse = opts.onResponse;
  if (onResponse) {
    app.use('*', async (c, next) => {
      await next();
      if (!c.res.headers.get('content-type')?.includes('application/json')) return;
      const body = await c.res.clone().json().catch(() => undefined);
      onResponse({ method: c.req.method, path: c.req.path, status: c.res.status, body });
    });
  }
  app.use('*', secureHeaders({ crossOriginResourcePolicy: false, xFrameOptions: false }));
  app.get('/health', (c) => c.json({ ok: true }));
  app.route('/line/webhook', webhookRoutes(ctx));
  app.route('/media', mediaRoutes(ctx));
  app.route('/api/liff', liffRoutes(ctx));
  app.route('/api/auth', authRoutes(ctx));
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
