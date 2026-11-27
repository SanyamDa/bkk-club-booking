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
import { adminRoutes } from './http/admin/index.js';
import { demoRoutes } from './http/demo.js';
import { onboardPublicRoutes } from './http/admin/onboarding.js';
import { authRoutes } from './http/auth.js';
import { integrationRoutes } from './http/integrations.js';
import { devRoutes } from './http/dev.js';
import { crowdRatingRoutes } from './http/door.js';
import type { AppContext } from './http/context.js';
import { liffRoutes } from './http/liff.js';
import { mediaRoutes } from './http/media.js';
import { privacyRoutes, redirectRoutes } from './http/redirect.js';
import { staffRoutes } from './http/staff.js';
import { inviteAcceptRoutes } from './http/team.js';
import { webhookRoutes } from './http/webhook.js';
import { dbCredentialStore, envCredentialStore, onlyDemoClubs } from './line/credentials.js';
import { GatewayRegistry, type LineGateway, type Message } from './line/gateway.js';
import { lineIdTokenVerifier } from './line/idtoken.js';
import { registerStaffAlertSender } from './platform/alerts.js';
import { fakeLiffEndpointUpdater, fakeSetupClients, realLiffEndpointUpdater, realSetupClients } from './line/setup.js';
import { fakeLineTokenIssuer, realLineTokenIssuer } from './line/tokens.js';
import { chatwootClient } from './integrations/chatwoot/provision.js';
import { configuredPaymentGateways } from './integrations/payments/opn.js';
import { paymentWebhookRoutes } from './http/payments.js';

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
    /** LINE token issuer (default: the fake one with LINE_FAKE, else the real one). */
    lineTokens?: AppContext['lineTokens'];
    /** Test hook: called with every JSON response body. */
    onResponse?: (r: ResponseRecord) => void;
    /** fetch used for Chatwoot calls (A13); tests pass a fake Chatwoot. */
    chatwootFetch?: typeof fetch;
    /** fetch used for live POS calls (A19, check-in bill); tests pass a fake POS. */
    posFetch?: AppContext['posFetch'];
    /** Payment gateways (A20b); default: Opn from config when both Opn keys are set. */
    payments?: AppContext['payments'];
  } = {},
) {
  // Structured JSON log lines on stdout (A7) unless the caller (tests) passes its own logger.
  const payments = opts.payments ?? configuredPaymentGateways(config);
  const deps = buildBotDeps(config, db, { ...opts.bot, payments, log: opts.bot?.log ?? jsonLog });
  const log = deps.log;
  const pending = new Set<Promise<unknown>>();
  // Club secrets live encrypted in the database (A4). The env store is only a development
  // fallback for the demo club. LINE_FAKE (development/test only) swaps in a local fake LINE.
  const devOrTest = isDevOrTest(config.NODE_ENV);
  const lineTokens = opts.lineTokens ?? (config.LINE_FAKE ? fakeLineTokenIssuer() : realLineTokenIssuer());
  const credentials =
    opts.credentials ??
    dbCredentialStore(
      db,
      config.CREDENTIALS_KEY,
      lineTokens,
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
    lineTokens,
    lineSetupClients: opts.lineSetupClients ?? (config.LINE_FAKE ? fakeSetupClients : realSetupClients),
    verifyIdToken: opts.verifyIdToken ?? lineIdTokenVerifier(),
    updateLiffEndpoint: opts.updateLiffEndpoint ?? (config.LINE_FAKE ? fakeLiffEndpointUpdater : realLiffEndpointUpdater),
    chatwoot: chatwootClient(config, opts.chatwootFetch),
    posFetch: opts.posFetch,
    payments,
  };

  // A15: urgent alerts (and info ones the club switched on) reach the staff LINE group through the outbox.
  // When the club's LINE token cannot be issued (bad credentials: the line_disconnected case), the
  // staff row is still recorded and the outbox logs the failed push; the throw tells raiseAlert
  // the alert was not sent, and raiseAlert never passes it on.
  registerStaffAlertSender(db, async (club, text) => {
    const msgs = [{ type: 'text', text } as Message];
    let gateway: LineGateway;
    try {
      gateway = await gateways.forClub(club);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const down = { push: async () => { throw new Error(`club LINE channel unavailable: ${reason}`); } } as unknown as LineGateway;
      await deps.outbox.toStaff(down, club, msgs);
      throw err;
    }
    await deps.outbox.toStaff(gateway, club, msgs);
  });

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
  app.route('/r', redirectRoutes(ctx)); // B4: counted redirects (link.opened) and promoter links
  app.route('/privacy', privacyRoutes()); // B4: the data notice page (spec §5.5)
  app.route('/api/liff', liffRoutes(ctx));
  app.route('/api/auth/invites', inviteAcceptRoutes(ctx)); // A8
  app.route('/api/auth', authRoutes(ctx));
  app.route('/api/staff', staffRoutes(ctx));
  app.route('/api/staff', crowdRatingRoutes(ctx)); // B12: door crowd rating (B11 adds the door screen in http/door.ts)
  app.route('/api/admin', adminRoutes(ctx));
  app.route('/api/admin/demo', demoRoutes(ctx)); // B7: Velora reset and fast-forward (platform admin)
  app.route('/api/onboard', onboardPublicRoutes(ctx)); // A17 pre-call form (token in the path, hashed at rest)
  app.route('/integrations', integrationRoutes(ctx)); // A19
  app.route('/webhooks/payments', paymentWebhookRoutes(ctx)); // A20b
  app.route('/api/admin/sim', devRoutes(ctx)); // B8: simulator behind platform-admin login, every environment
  if (config.DEV_SIMULATOR) app.route('/api/dev', devRoutes(ctx)); // B8: same routes and login; loadConfig keeps it dev/test only
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
