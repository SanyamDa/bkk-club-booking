/**
 * npm run load -w @club/server -- [flags] — peak-load test (spec §13 Peak load, plan A12).
 *
 * Drives simulated guests against a RUNNING server: 50 bookings/min per club and 1,000 inbound
 * messages/min in total, shaped like a Friday night 22:00-01:00 (ramp up, peak 23:30-00:30,
 * taper), compressed into --duration seconds. Open loop: requests go out on schedule whether or
 * not earlier ones have answered, like real guests. Reports p50/p95/p99 reply latency; the target
 * is p95 < 3 s with under 1% errors. Exit code 1 when the target is missed.
 *
 * Modes:
 *   --mode sim      (default) POST /api/dev/:slug/event. Needs DEV_SIMULATOR=1. The route runs the
 *                   whole bot turn before answering, so the response time IS the reply latency.
 *   --mode webhook  POST /line/webhook/:slug, signed with LOAD_CHANNEL_SECRET (the club's channel
 *                   secret) exactly as LINE signs. The route answers before the bot turn runs, so
 *                   this measures the ack time LINE sees, not the reply. Replies go to the real LINE
 *                   API with fake reply tokens: use it only against a staging club whose access
 *                   token points at nothing real.
 *
 * Flags: --base http://127.0.0.1:8787  --clubs demo,other  --duration 30  --scale 1
 *        --bookings 50 (per club per min)  --inbound 1000 (total per min)  --target-ms 3000
 * Env:   LOAD_CHANNEL_SECRET (webhook mode)  LOAD_COOKIE (sim mode: a platform-admin `sid=...` cookie; /api/dev needs admin login, B8)
 *
 * A booking is two events from one guest: the "book" postback, then the night pick. Other
 * inbound traffic is free text (location, menu, unknown) from many guests.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export type Mode = 'sim' | 'webhook';

export interface LoadArgs {
  mode: Mode;
  base: string;
  clubs: string[];
  durationSec: number;
  scale: number;
  bookingsPerMin: number;
  inboundPerMin: number;
  targetMs: number;
}

/**
 * Traffic multiplier (0-1] over the Friday window, f = 0 at 22:00 and f = 1 at 01:00.
 * 0.4 at 22:00, rising to the peak at 23:30, flat to 00:30, down to 0.6 at 01:00.
 */
export function fridayShape(f: number): number {
  const x = Math.min(1, Math.max(0, f));
  if (x < 0.5) return 0.4 + (0.6 * x) / 0.5;
  if (x <= 5 / 6) return 1;
  return 1 - (0.4 * (x - 5 / 6)) / (1 / 6);
}

/**
 * Arrival offsets (ms from start) for a stream whose rate is `peakPerMin * shape(t / duration)`.
 * Deterministic: an arrival each time the expected count crosses the next whole number.
 */
export function scheduleArrivals(durationMs: number, peakPerMin: number, shape: (f: number) => number, stepMs = 10): number[] {
  const out: number[] = [];
  if (peakPerMin <= 0 || durationMs <= 0) return out;
  let expected = 0;
  let next = 0;
  for (let t = 0; t < durationMs; t += stepMs) {
    if (expected >= next) {
      out.push(t);
      next += 1;
    }
    expected += (peakPerMin * shape(t / durationMs) * stepMs) / 60_000;
  }
  return out;
}

export interface Stream {
  club: string;
  kind: 'booking' | 'chat';
  /** Flows per minute at the peak. */
  perMin: number;
  /** Inbound events per flow. */
  eventsPer: number;
}

/** Peak-rate streams: one booking stream per club, the rest of the inbound total as chat, split evenly. */
export function buildPlan(o: { clubs: string[]; scale: number; bookingsPerMin: number; inboundPerMin: number }): Stream[] {
  const bookingEvents = o.bookingsPerMin * 2 * o.clubs.length;
  const chatPerClub = Math.max(0, o.inboundPerMin - bookingEvents) / o.clubs.length;
  return o.clubs.flatMap((club) => [
    { club, kind: 'booking' as const, perMin: o.bookingsPerMin * o.scale, eventsPer: 2 },
    { club, kind: 'chat' as const, perMin: chatPerClub * o.scale, eventsPer: 1 },
  ]);
}

/** Nearest-rank percentile; NaN for no samples. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

export interface Summary {
  count: number;
  errors: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  pass: boolean;
}

/** Pass: p95 below the target and at most 1% of requests failed. */
export function summarize(latenciesMs: number[], errors: number, targetMs: number): Summary {
  const total = latenciesMs.length + errors;
  const errorRate = total === 0 ? 0 : errors / total;
  const p95 = percentile(latenciesMs, 95);
  return {
    count: latenciesMs.length,
    errors,
    errorRate,
    p50: percentile(latenciesMs, 50),
    p95,
    p99: percentile(latenciesMs, 99),
    max: latenciesMs.length ? Math.max(...latenciesMs) : NaN,
    pass: latenciesMs.length > 0 && p95 < targetMs && errorRate <= 0.01,
  };
}

/** LINE's x-line-signature: base64 HMAC-SHA256 of the raw body with the channel secret. */
export function signBody(body: string, channelSecret: string): string {
  return createHmac('sha256', channelSecret).update(body).digest('base64');
}

export function parseArgs(argv: string[]): LoadArgs {
  const a: LoadArgs = {
    mode: 'sim',
    base: 'http://127.0.0.1:8787',
    clubs: ['demo'],
    durationSec: 30,
    scale: 1,
    bookingsPerMin: 50,
    inboundPerMin: 1000,
    targetMs: 3000,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const v = argv[++i];
    if (v === undefined) throw new Error(`missing value for ${flag}`);
    const num = () => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} needs a non-negative number`);
      return n;
    };
    switch (flag) {
      case '--mode':
        if (v !== 'sim' && v !== 'webhook') throw new Error('--mode is sim or webhook');
        a.mode = v;
        break;
      case '--base': a.base = v.replace(/\/$/, ''); break;
      case '--clubs': a.clubs = v.split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--duration': a.durationSec = num(); break;
      case '--scale': a.scale = num(); break;
      case '--bookings': a.bookingsPerMin = num(); break;
      case '--inbound': a.inboundPerMin = num(); break;
      case '--target-ms': a.targetMs = num(); break;
      default: throw new Error(`unknown flag ${flag}`);
    }
  }
  if (a.clubs.length === 0) throw new Error('--clubs is empty');
  return a;
}

// ---------- Runner (not unit tested: needs a running server) ----------

type SimEvent = { type: 'text'; text: string } | { type: 'postback'; data: string };

const CHAT_TEXTS = ['where are you', 'hello', 'สวัสดีครับ', 'what time do you open', 'แผนที่', 'menu please'];

/** Tonight in Asia/Bangkok as YYYY-MM-DD (the night pick). */
function bangkokDate(now = new Date()): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

function webhookBody(userId: string, ev: SimEvent): string {
  const base = {
    timestamp: Date.now(),
    mode: 'active',
    webhookEventId: randomUUID(),
    deliveryContext: { isRedelivery: false },
    source: { type: 'user', userId },
    replyToken: randomUUID(),
  };
  const event =
    ev.type === 'text'
      ? { ...base, type: 'message', message: { type: 'text', id: randomUUID(), text: ev.text, quoteToken: 'load' } }
      : { ...base, type: 'postback', postback: { data: ev.data } };
  return JSON.stringify({ destination: 'load', events: [event] });
}

async function sendOne(args: LoadArgs, club: string, userId: string, ev: SimEvent): Promise<number> {
  const started = performance.now();
  let res: Response;
  if (args.mode === 'sim') {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (process.env.LOAD_COOKIE) headers.cookie = process.env.LOAD_COOKIE;
    res = await fetch(`${args.base}/api/dev/${club}/event`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId, displayName: 'Load guest', lang: 'en', ...ev }),
    });
  } else {
    const secret = process.env.LOAD_CHANNEL_SECRET!;
    // Real-looking LINE user id (U + 32 hex) so the webhook path treats it as a LINE guest.
    const body = webhookBody(`U${createHash('md5').update(userId).digest('hex')}`, ev);
    res = await fetch(`${args.base}/line/webhook/${club}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-line-signature': signBody(body, secret) },
      body,
    });
  }
  await res.arrayBuffer();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return performance.now() - started;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'webhook' && !process.env.LOAD_CHANNEL_SECRET) throw new Error('webhook mode needs LOAD_CHANNEL_SECRET');
  const durationMs = args.durationSec * 1000;
  const plan = buildPlan(args);
  const latencies: number[] = [];
  const errorKinds = new Map<string, number>();
  let errors = 0;
  const pending: Promise<void>[] = [];
  const run = Date.now().toString(36);
  let seq = 0;

  const record = async (club: string, userId: string, ev: SimEvent) => {
    try {
      latencies.push(await sendOne(args, club, userId, ev));
    } catch (err) {
      errors++;
      const k = (err as Error).message;
      errorKinds.set(k, (errorKinds.get(k) ?? 0) + 1);
    }
  };

  console.log(`load: mode=${args.mode} base=${args.base} clubs=${args.clubs.join(',')} duration=${args.durationSec}s scale=${args.scale}`);
  for (const s of plan) console.log(`  ${s.club} ${s.kind}: peak ${s.perMin.toFixed(1)}/min x ${s.eventsPer} event(s)`);

  const t0 = performance.now();
  for (const s of plan) {
    for (const at of scheduleArrivals(durationMs, s.perMin, fridayShape)) {
      pending.push(
        new Promise<void>((resolve) =>
          setTimeout(async () => {
            const userId = `load-${run}-${(seq++).toString(36)}`;
            if (s.kind === 'booking') {
              await record(s.club, userId, { type: 'postback', data: 'a=book' });
              await record(s.club, userId, { type: 'postback', data: `a=night&d=${bangkokDate()}` });
            } else {
              await record(s.club, userId, { type: 'text', text: CHAT_TEXTS[seq % CHAT_TEXTS.length]! });
            }
            resolve();
          }, Math.max(0, at - (performance.now() - t0))),
        ),
      );
    }
  }
  await Promise.all(pending);
  const wallSec = (performance.now() - t0) / 1000;

  const s = summarize(latencies, errors, args.targetMs);
  const ms = (n: number) => (Number.isNaN(n) ? '-' : `${Math.round(n)} ms`);
  console.log(`\nsent ${s.count + s.errors} events in ${wallSec.toFixed(1)} s (${(((s.count + s.errors) / wallSec) * 60).toFixed(0)}/min average)`);
  console.log(`ok ${s.count}  errors ${s.errors} (${(s.errorRate * 100).toFixed(2)}%)`);
  for (const [k, n] of errorKinds) console.log(`  ${k}: ${n}`);
  console.log(`latency p50 ${ms(s.p50)}  p95 ${ms(s.p95)}  p99 ${ms(s.p99)}  max ${ms(s.max)}`);
  console.log(`${args.mode === 'sim' ? 'reply' : 'webhook ack'} p95 target < ${args.targetMs} ms: ${s.pass ? 'PASS' : 'FAIL'}`);
  process.exitCode = s.pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
