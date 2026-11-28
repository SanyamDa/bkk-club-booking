import type { messagingApi, webhook } from '@line/bot-sdk';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { holdTable } from '../src/bookings/service.js';
import { handleEvent } from '../src/bot/flow.js';
import { Links } from '../src/bot/links.js';
import { guests } from '../src/db/schema.js';
import { DevLineGateway } from '../src/line/gateway.js';
import { sampleMessages } from '../src/line/samples.js';
import { renderRichMenuPng, richMenuRequest, runLineSetup, type SetupClients } from '../src/line/setup.js';
import { FRIDAY, FRIDAY_AFTERNOON, makeGuest, setupDb } from './helpers.js';
import { testConfig } from './helpers/track-a.js';

const config = testConfig({ PUBLIC_URL: 'https://demo-tunnel.example.com', DEV_SIMULATOR: false });

let ctx: Awaited<ReturnType<typeof setupDb>>;
beforeEach(async () => {
  ctx = await setupDb();
});
afterEach(async () => {
  await ctx.close();
  vi.unstubAllEnvs();
});

function fakeClients(overrides: Partial<SetupClients['api']> = {}) {
  const calls = { webhook: '', menu: null as messagingApi.RichMenuRequest | null, image: 0, defaultMenu: '', validated: 0, liff: '' };
  const clients: SetupClients = {
    api: {
      getBotInfo: async () => ({ userId: 'Ubot', basicId: '@velorademo', displayName: 'Velora (Demo)', chatMode: 'chat', markAsReadMode: 'auto' }),
      setWebhookEndpoint: async (req) => {
        calls.webhook = req.endpoint;
        return {};
      },
      getWebhookEndpoint: async () => ({ endpoint: calls.webhook, active: true }),
      testWebhookEndpoint: async () => ({ success: true, timestamp: new Date(), statusCode: 200, reason: 'OK', detail: '200' }),
      getRichMenuList: async () => ({ richmenus: [] }),
      deleteRichMenu: async () => ({}),
      createRichMenu: async (req) => {
        calls.menu = req;
        return { richMenuId: 'richmenu-1' };
      },
      setDefaultRichMenu: async (id) => {
        calls.defaultMenu = id;
        return {};
      },
      validateReply: async () => {
        calls.validated++;
        return {};
      },
      getMessageQuota: async () => ({ type: 'limited', value: 300 }),
      getMessageQuotaConsumption: async () => ({ totalUsage: 12 }),
      ...overrides,
    } as SetupClients['api'],
    blob: {
      setRichMenuImage: async () => {
        calls.image++;
        return {};
      },
    } as unknown as SetupClients['blob'],
    updateLiffEndpoint: async (_id, url) => {
      calls.liff = url;
    },
  };
  return { clients, calls };
}

const links = new Links(config.PUBLIC_URL, config.APP_SECRET);

describe('LINE setup', () => {
  it('points the webhook here, installs the menu, updates LIFF and validates every message', async () => {
    const club = { ...ctx.club, liffId: '1234567890-abcdefgh' };
    const { clients, calls } = fakeClients();
    const msgs = await sampleMessages(ctx.db, club, links, FRIDAY_AFTERNOON);
    const report = await runLineSetup({ club, clients, publicUrl: config.PUBLIC_URL, sampleMessages: msgs, retryDelayMs: 0 });
    expect(report.steps.filter((s) => !s.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(calls.webhook).toBe('https://demo-tunnel.example.com/line/webhook/demo');
    expect(calls.menu?.areas).toHaveLength(5); // Book, My booking, Location, Talk to a host, Privacy (spec §5.5)
    expect(calls.image).toBe(1);
    expect(calls.defaultMenu).toBe('richmenu-1');
    expect(calls.liff).toBe('https://demo-tunnel.example.com/liff/details');
    expect(calls.validated).toBe(Math.ceil(msgs.length / 5));
    expect(report.bot?.addFriendUrl).toBe('https://line.me/R/ti/p/%40velorademo');
  });

  it('refuses a non-HTTPS public URL before touching the webhook', async () => {
    const { clients, calls } = fakeClients();
    const report = await runLineSetup({ club: ctx.club, clients, publicUrl: 'http://localhost:5173', sampleMessages: [] });
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)?.name).toBe('Public URL');
    expect(calls.webhook).toBe('');
  });

  it('reports a webhook LINE cannot reach', async () => {
    const { clients } = fakeClients({
      testWebhookEndpoint: async () => ({ success: false, timestamp: new Date(), statusCode: 502, reason: 'BAD_GATEWAY', detail: 'tunnel down' }),
    });
    const report = await runLineSetup({ club: ctx.club, clients, publicUrl: config.PUBLIC_URL, sampleMessages: [], webhookRetries: 2, retryDelayMs: 0 });
    const hook = report.steps.find((s) => s.name === 'Webhook')!;
    expect(hook.ok).toBe(false);
    expect(hook.detail).toContain('502');
  });

  it('renders a rich menu image at LINE’s required size', () => {
    const png = renderRichMenuPng(ctx.club);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(2500); // IHDR width
    expect(png.readUInt32BE(20)).toBe(843); // IHDR height
    expect(png.length).toBeLessThan(1024 * 1024); // LINE limit: 1 MB
    const areas = richMenuRequest(ctx.club).areas!;
    expect(areas.reduce((w, a) => w + a.bounds!.width!, 0)).toBe(2500);
  });
});

describe('every message respects LINE limits (offline check)', () => {
  it('labels, alt text and sizes', async () => {
    const msgs = await sampleMessages(ctx.db, ctx.club, links, FRIDAY_AFTERNOON);
    expect(msgs.length).toBeGreaterThan(30);
    const problems: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      if (n.type === 'button' && typeof (n.action as { label?: string })?.label === 'string') {
        const label = (n.action as { label: string }).label;
        if (label.length > 40) problems.push(`${path}: button label "${label}" > 40`);
      }
      if ((n.type === 'carousel') && Array.isArray(n.contents) && n.contents.length > 12) problems.push(`${path}: carousel > 12 bubbles`);
      for (const [k, v] of Object.entries(n)) walk(v, `${path}.${k}`);
    };
    msgs.forEach((m, i) => {
      const msg = m as messagingApi.Message & { altText?: string; text?: string };
      if (msg.altText && msg.altText.length > 400) problems.push(`#${i}: altText > 400`);
      if (msg.text && msg.text.length > 5000) problems.push(`#${i}: text > 5000`);
      for (const item of msg.quickReply?.items ?? []) {
        const label = (item.action as { label?: string }).label ?? '';
        if (label.length > 20) problems.push(`#${i}: quick reply "${label}" > 20`);
      }
      if ((msg.quickReply?.items?.length ?? 0) > 13) problems.push(`#${i}: > 13 quick replies`);
      if (msg.type === 'image' && !msg.originalContentUrl.startsWith('https://')) problems.push(`#${i}: image URL must be https`);
      if (JSON.stringify(m).length > 30_000) problems.push(`#${i}: flex JSON > 30KB`);
      walk(m, `#${i}`);
    });
    expect(problems).toEqual([]);
  });
});

describe('real-LINE behaviour', () => {
  const base = (userId: string) => ({
    timestamp: Date.now(),
    mode: 'active' as const,
    webhookEventId: crypto.randomUUID(),
    deliveryContext: { isRedelivery: false },
    source: { type: 'user' as const, userId },
  });

  it('stops pushing to guests who block the club, and resumes when they come back', async () => {
    const app = createApp(config, ctx.db, { bot: { log: () => {} } });
    const gw = new DevLineGateway();
    const push = vi.spyOn(gw, 'push');
    await handleEvent(app.ctx.deps, ctx.club, gw, { ...base('Ureal1'), type: 'unfollow' } as webhook.Event);
    const g = (await ctx.db.query.guests.findFirst({ where: eq(guests.lineUserId, 'Ureal1') }))!;
    expect(g.unfollowedAt).not.toBeNull();
    await app.ctx.deps.outbox.toGuest(gw, ctx.club, g, [{ type: 'text', text: 'reminder' }]);
    expect(push).not.toHaveBeenCalled();

    await handleEvent(app.ctx.deps, ctx.club, gw, { ...base('Ureal1'), type: 'follow', replyToken: 'r1', follow: { isUnblocked: true } } as webhook.Event);
    const back = (await ctx.db.query.guests.findFirst({ where: eq(guests.lineUserId, 'Ureal1') }))!;
    expect(back.unfollowedAt).toBeNull();
  });

  it('explains how to link alerts when the bot is added to a group', async () => {
    const app = createApp(config, ctx.db, { bot: { log: () => {} } });
    const gw = new DevLineGateway();
    const reply = vi.spyOn(gw, "reply");
    await handleEvent(app.ctx.deps, ctx.club, gw, {
      ...base('x'),
      source: { type: 'group', groupId: 'Cgroup1' },
      type: 'join',
      replyToken: 'r2',
      join: {},
    } as unknown as webhook.Event);
    expect(reply).toHaveBeenCalledOnce();
    expect(JSON.stringify(reply.mock.calls[0] as unknown[])).toContain('link');
  });

  it('requires the guest’s own LINE login on the booking form when LINE Login is configured', async () => {
    vi.stubEnv('DEMO_LINE_LOGIN_CHANNEL_ID', '2000000000');
    vi.stubEnv('DEMO_LINE_LOGIN_CHANNEL_SECRET', 'login-secret');
    const verify = vi.fn(async (token: string) => (token === 'good-token' ? { sub: 'Uowner' } : token === 'other-token' ? { sub: 'Usomeoneelse' } : null));
    const app = createApp(config, ctx.db, { bot: { now: () => FRIDAY_AFTERNOON, log: () => {} }, verifyIdToken: verify });
    const guest = await makeGuest(ctx.db, { lineUserId: 'Uowner' });
    const booking = await holdTable(ctx.db, ctx.club, { guestId: guest.id, tableId: 'table_demo_B4', nightDate: FRIDAY, pax: 6 }, FRIDAY_AFTERNOON);
    const t = links.detailsToken(booking, FRIDAY_AFTERNOON);
    const submit = (idToken?: string) =>
      app.app.request('/api/liff/booking/details', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: booking.refCode, t, name: 'Ari', phone: '0812345678', nationality: 'Thai', pax: 6, acceptRules: true, viaChat: true, idToken }),
      });
    expect((await submit()).status).toBe(401);
    expect((await submit('other-token')).status).toBe(403);
    expect((await submit('good-token')).status).toBe(200);
    expect(verify).toHaveBeenCalledWith('good-token', '2000000000');
  });
});
