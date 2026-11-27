import { messagingApi } from '@line/bot-sdk';
import type { Club } from '../db/schema.js';
import type { CredentialStore } from './credentials.js';

export type { ClubLineCredentials } from './credentials.js';

export type Message = messagingApi.Message;

/** Everything the app needs from LINE. Swapped for a fake in development and tests. */
export interface LineGateway {
  readonly live: boolean;
  reply(replyToken: string, messages: Message[]): Promise<void>;
  push(to: string, messages: Message[]): Promise<void>;
  getContent(messageId: string): Promise<Buffer>;
  getProfile(userId: string): Promise<{ displayName: string; language?: string } | null>;
  /** Shows LINE's "typing" animation while something slow happens. Best effort. */
  loading(userId: string): Promise<void>;
}

export class RealLineGateway implements LineGateway {
  readonly live = true;
  private api: messagingApi.MessagingApiClient;
  private blob: messagingApi.MessagingApiBlobClient;

  constructor(channelAccessToken: string) {
    this.api = new messagingApi.MessagingApiClient({ channelAccessToken });
    this.blob = new messagingApi.MessagingApiBlobClient({ channelAccessToken });
  }

  async reply(replyToken: string, messages: Message[]) {
    await this.api.replyMessage({ replyToken, messages });
  }

  async push(to: string, messages: Message[]) {
    await this.api.pushMessage({ to, messages });
  }

  async getContent(messageId: string) {
    const stream = await this.blob.getMessageContent(messageId);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async getProfile(userId: string) {
    try {
      const p = await this.api.getProfile(userId);
      return { displayName: p.displayName, language: p.language };
    } catch {
      return null;
    }
  }

  async loading(userId: string) {
    try {
      await this.api.showLoadingAnimation({ chatId: userId, loadingSeconds: 10 });
    } catch {
      /* cosmetic only */
    }
  }
}

/**
 * Development gateway: sends nothing to LINE. Outbound messages are still written to the
 * `messages` table by the outbox, which is what the local chat simulator displays.
 */
export class DevLineGateway implements LineGateway {
  readonly live = false;
  private images = new Map<string, Buffer>();
  private profiles = new Map<string, { displayName: string; language?: string }>();

  async reply() {}
  async push() {}
  async loading() {}

  async getContent(messageId: string) {
    const img = this.images.get(messageId);
    if (!img) throw new Error(`No simulated image ${messageId}`);
    return img;
  }

  async getProfile(userId: string) {
    return this.profiles.get(userId) ?? { displayName: 'Simulator guest', language: 'en' };
  }

  addImage(messageId: string, data: Buffer) {
    this.images.set(messageId, data);
  }

  setProfile(userId: string, profile: { displayName: string; language?: string }) {
    this.profiles.set(userId, profile);
  }
}

/** Real LINE user ids start with "U"; simulator ids start with this, so they can never collide. */
export const SIM_USER_PREFIX = 'SIM-';

export class GatewayRegistry {
  /** At most one live gateway per club, keyed by club id but rebuilt whenever the token changes. */
  private real = new Map<string, { token: string; gateway: RealLineGateway }>();
  readonly dev = new DevLineGateway();

  constructor(private credentials: CredentialStore) {}

  /**
   * The live gateway for a club, or the dev gateway when the club has no LINE credentials.
   * Simulator guests (ids starting with SIM_USER_PREFIX) always use the dev gateway.
   * Reads the credentials on every call: access tokens can be short-lived.
   */
  async forClub(club: Club, lineUserId?: string | null): Promise<LineGateway> {
    if (lineUserId?.startsWith(SIM_USER_PREFIX)) return this.dev;
    const creds = await this.credentials.line(club);
    if (!creds) return this.dev;
    const cached = this.real.get(club.id);
    if (cached && cached.token === creds.accessToken) return cached.gateway;
    const gateway = new RealLineGateway(creds.accessToken);
    this.real.set(club.id, { token: creds.accessToken, gateway });
    return gateway;
  }
}
