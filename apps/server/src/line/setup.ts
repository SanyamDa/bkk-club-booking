import { channelAccessToken, HTTPFetchError, liff, messagingApi } from '@line/bot-sdk';
import { Resvg } from '@resvg/resvg-js';
import type { Club } from '../db/schema.js';
import type { LoginChannel } from './credentials.js';
import type { Message } from './gateway.js';

/**
 * Connects a club's LINE Official Account to this server: webhook, rich menu, LIFF endpoint,
 * and a check of every message the bot can send against LINE's own validator.
 * Safe to run repeatedly (e.g. every time the tunnel URL changes).
 */

export const RICH_MENU_PREFIX = 'club-booking';
const MENU_W = 2500;
const MENU_H = 843;

// ---------- Rich menu ----------

interface MenuCell {
  x: number;
  w: number;
  en: string;
  th: string;
  primary?: boolean;
  action: messagingApi.Action;
}

function menuCells(club: Club): MenuCell[] {
  return [
    { x: 0, w: 1000, en: 'Book a table', th: 'จองโต๊ะ', primary: true, action: { type: 'postback', label: 'Book a table', data: 'a=book', displayText: 'Book a table' } },
    { x: 1000, w: 500, en: 'My booking', th: 'การจองของฉัน', action: { type: 'postback', label: 'My booking', data: 'a=my', displayText: 'My booking' } },
    { x: 1500, w: 500, en: 'Location', th: 'แผนที่', action: { type: 'uri', label: 'Location', uri: club.settings.mapUrl } },
    { x: 2000, w: 500, en: 'Talk to a host', th: 'คุยกับพนักงาน', action: { type: 'postback', label: 'Talk to a host', data: 'a=host', displayText: 'Talk to a host' } },
  ];
}

export function richMenuRequest(club: Club): messagingApi.RichMenuRequest {
  return {
    size: { width: MENU_W, height: MENU_H },
    selected: true,
    name: `${RICH_MENU_PREFIX}:${club.slug}`.slice(0, 300),
    chatBarText: 'Book a table · จองโต๊ะ',
    areas: menuCells(club).map((c) => ({
      bounds: { x: c.x, y: 0, width: c.w, height: MENU_H },
      action: c.action,
    })),
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function richMenuSvg(club: Club): string {
  const accent = club.settings.accentColor;
  const cells = menuCells(club)
    .map((c) => {
      const cx = c.x + c.w / 2;
      const bg = c.primary ? accent : '#141316';
      const fg = c.primary ? '#141008' : '#F3EFE6';
      const sub = c.primary ? '#3A2D12' : '#A8A39A';
      return `
        <rect x="${c.x}" y="0" width="${c.w}" height="${MENU_H}" fill="${bg}"/>
        <text x="${cx}" y="${MENU_H / 2 - 10}" text-anchor="middle" font-size="${c.primary ? 104 : 60}" font-weight="600" fill="${fg}" font-family="Helvetica Neue, Arial, sans-serif">${esc(c.en)}</text>
        <text x="${cx}" y="${MENU_H / 2 + 100}" text-anchor="middle" font-size="${c.primary ? 80 : 54}" fill="${sub}" font-family="Thonburi, Noto Sans Thai, Tahoma, sans-serif">${esc(c.th)}</text>`;
    })
    .join('');
  const dividers = [1500, 2000]
    .map((x) => `<rect x="${x - 1}" y="120" width="2" height="${MENU_H - 240}" fill="#2C2A30"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${MENU_W}" height="${MENU_H}" viewBox="0 0 ${MENU_W} ${MENU_H}">${cells}${dividers}</svg>`;
}

export function renderRichMenuPng(club: Club): Buffer {
  return Buffer.from(new Resvg(richMenuSvg(club), { font: { loadSystemFonts: true } }).render().asPng());
}

// ---------- Report ----------

export interface SetupStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SetupReport {
  ok: boolean;
  steps: SetupStep[];
  bot?: { displayName: string; basicId: string; chatMode: string; addFriendUrl: string };
}

export function describeLineError(err: unknown): string {
  if (err instanceof HTTPFetchError) {
    let body = err.body;
    try {
      const parsed = JSON.parse(err.body) as { message?: string; details?: { message?: string; property?: string }[] };
      body = [parsed.message, ...(parsed.details ?? []).map((d) => `${d.property ?? ''}: ${d.message ?? ''}`)].filter(Boolean).join(' · ');
    } catch {
      /* keep raw body */
    }
    return `LINE API ${err.status}: ${body}`;
  }
  return err instanceof Error ? err.message : String(err);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SetupClients {
  api: Pick<
    messagingApi.MessagingApiClient,
    | 'getBotInfo'
    | 'setWebhookEndpoint'
    | 'getWebhookEndpoint'
    | 'testWebhookEndpoint'
    | 'getRichMenuList'
    | 'deleteRichMenu'
    | 'createRichMenu'
    | 'setDefaultRichMenu'
    | 'validateReply'
    | 'getMessageQuota'
    | 'getMessageQuotaConsumption'
  >;
  blob: Pick<messagingApi.MessagingApiBlobClient, 'setRichMenuImage'>;
  /** Updates the LIFF app's endpoint URL using the LINE Login channel. */
  updateLiffEndpoint?: (liffId: string, url: string) => Promise<void>;
}

export function realSetupClients(accessToken: string, login: LoginChannel | null): SetupClients {
  return {
    api: new messagingApi.MessagingApiClient({ channelAccessToken: accessToken }),
    blob: new messagingApi.MessagingApiBlobClient({ channelAccessToken: accessToken }),
    updateLiffEndpoint: login
      ? async (liffId, url) => {
          const tokens = new channelAccessToken.ChannelAccessTokenClient({});
          const { access_token } = await tokens.issueChannelToken('client_credentials', login.channelId, login.channelSecret);
          await new liff.LiffClient({ channelAccessToken: access_token }).updateLIFFApp(liffId, { view: { type: 'tall', url } });
        }
      : undefined,
  };
}

export async function runLineSetup(opts: {
  club: Club;
  clients: SetupClients;
  publicUrl: string;
  sampleMessages: Message[];
  refreshRichMenu?: boolean;
  webhookRetries?: number;
  retryDelayMs?: number;
}): Promise<SetupReport> {
  const { club, clients, sampleMessages } = opts;
  const base = opts.publicUrl.replace(/\/$/, '');
  const steps: SetupStep[] = [];
  const report: SetupReport = { ok: false, steps };
  const step = (name: string, ok: boolean, detail: string) => steps.push({ name, ok, detail });

  // 1. Credentials work?
  try {
    const bot = await clients.api.getBotInfo();
    report.bot = {
      displayName: bot.displayName,
      basicId: bot.basicId,
      chatMode: bot.chatMode,
      addFriendUrl: `https://line.me/R/ti/p/${encodeURIComponent(bot.basicId)}`,
    };
    step('LINE credentials', true, `Connected to "${bot.displayName}" (${bot.basicId})`);
    step(
      'Chat mode',
      true,
      bot.chatMode === 'chat'
        ? 'Chat is on: hosts can also reply from LINE OA Manager. Make sure auto-reply and greeting messages are off there.'
        : 'Bot mode: only the bot replies. Turn Chat on in OA Manager if hosts should reply from their phones.',
    );
  } catch (err) {
    step('LINE credentials', false, `${describeLineError(err)}. Check the channel access token in .env.`);
    return report;
  }

  if (!base.startsWith('https://')) {
    step('Public URL', false, `PUBLIC_URL is ${base}. LINE needs a public HTTPS address: run "npm run live" to start a tunnel.`);
    return report;
  }

  // 2. Webhook: point it here, then ask LINE to call it.
  const endpoint = `${base}/line/webhook/${club.slug}`;
  try {
    await clients.api.setWebhookEndpoint({ endpoint });
    let last = '';
    let ok = false;
    for (let i = 0; i < (opts.webhookRetries ?? 6) && !ok; i++) {
      if (i > 0) await sleep(opts.retryDelayMs ?? 3000);
      try {
        const res = await clients.api.testWebhookEndpoint({ endpoint });
        ok = Boolean(res.success);
        last = ok ? `LINE reached ${endpoint}` : `LINE got ${res.statusCode} ${res.reason}: ${res.detail}`;
      } catch (err) {
        last = describeLineError(err);
      }
    }
    step('Webhook', ok, ok ? `${last}. Make sure "Use webhook" is on in the Messaging API tab.` : `${last}. Is the tunnel and "npm run dev" running?`);
  } catch (err) {
    step('Webhook', false, describeLineError(err));
  }

  // 3. Rich menu (the button panel under the chat).
  try {
    const { richmenus } = await clients.api.getRichMenuList();
    const ours = richmenus.filter((m) => m.name.startsWith(`${RICH_MENU_PREFIX}:${club.slug}`));
    if (ours.length > 0 && !opts.refreshRichMenu) {
      step('Rich menu', true, 'Already installed (use --refresh-menu to rebuild it).');
    } else {
      for (const m of ours) await clients.api.deleteRichMenu(m.richMenuId);
      const { richMenuId } = await clients.api.createRichMenu(richMenuRequest(club));
      const png = renderRichMenuPng(club);
      await clients.blob.setRichMenuImage(richMenuId, new Blob([new Uint8Array(png)], { type: 'image/png' }));
      await clients.api.setDefaultRichMenu(richMenuId);
      step('Rich menu', true, 'Installed: Book a table · My booking · Location · Talk to a host.');
    }
  } catch (err) {
    step('Rich menu', false, describeLineError(err));
  }

  // 4. LIFF (the booking form inside LINE) must point at the current URL.
  const liffUrl = `${base}/liff/details`;
  if (!club.liffId) {
    step('Booking form (LIFF)', true, 'No LIFF ID set: the form opens in the phone browser. Optional, see docs/LINE-SETUP.md step 6.');
  } else if (!clients.updateLiffEndpoint) {
    step('Booking form (LIFF)', true, `Set the LIFF endpoint to ${liffUrl} in LINE Developers (or add the LINE Login channel ID/secret to .env and this is automatic).`);
  } else {
    try {
      await clients.updateLiffEndpoint(club.liffId, liffUrl);
      step('Booking form (LIFF)', true, `LIFF ${club.liffId} now opens ${liffUrl}`);
    } catch (err) {
      step('Booking form (LIFF)', false, describeLineError(err));
    }
  }

  // 5. Every message type the bot sends, checked by LINE before a guest ever sees it.
  const failures: string[] = [];
  for (let i = 0; i < sampleMessages.length; i += 5) {
    const batch = sampleMessages.slice(i, i + 5);
    try {
      await clients.api.validateReply({ messages: batch });
    } catch (err) {
      failures.push(`messages ${i + 1}–${i + batch.length}: ${describeLineError(err)}`);
    }
  }
  step(
    'Message check',
    failures.length === 0,
    failures.length === 0 ? `All ${sampleMessages.length} message types accepted by LINE.` : failures.join('\n'),
  );

  // 6. Quota: pushes (reminders, staff-triggered messages) count against it.
  try {
    const [quota, used] = await Promise.all([clients.api.getMessageQuota(), clients.api.getMessageQuotaConsumption()]);
    const limit = quota.type === 'limited' ? quota.value : undefined;
    step('Message quota', true, limit ? `${used.totalUsage} of ${limit} push messages used this month.` : `${used.totalUsage} push messages used this month (no limit).`);
  } catch (err) {
    step('Message quota', true, `Could not read quota: ${describeLineError(err)}`);
  }

  report.ok = steps.every((s) => s.ok);
  return report;
}
