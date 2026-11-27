import type { BotDeps } from '../bot/flow.js';
import type { Notifier } from '../bot/notify.js';
import type { Config } from '../config.js';
import type { GatewayRegistry } from '../line/gateway.js';
import type { IdTokenVerifier } from '../line/idtoken.js';
import type { CredentialStore, LoginChannel } from '../line/credentials.js';
import type { LiffEndpointUpdater, SetupClients } from '../line/setup.js';

export interface AppContext {
  config: Config;
  deps: BotDeps;
  gateways: GatewayRegistry;
  /** Where each club's LINE secrets come from. */
  credentials: CredentialStore;
  notifier: Notifier;
  /** Registers background work so tests (and shutdown) can wait for it. */
  track: (p: Promise<unknown>) => void;
  /** LINE API clients for setup/status. Replaced by fakes in tests. */
  lineSetupClients: (accessToken: string, login: LoginChannel | null) => SetupClients;
  verifyIdToken: IdTokenVerifier;
  /** Sets the shared LIFF app's endpoint when the platform login channel is saved (A4b). Fake with LINE_FAKE. */
  updateLiffEndpoint: LiffEndpointUpdater;
}
