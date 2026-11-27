/**
 * npm run live — run the bot against a real LINE Official Account from this laptop.
 *
 * 1. Starts an HTTPS tunnel (cloudflared quick tunnel, or ngrok; NGROK_DOMAIN gives a fixed URL)
 * 2. Writes the tunnel URL to PUBLIC_URL in apps/server/.env
 * 3. Starts the app (npm run dev)
 * 4. Connects LINE: webhook, rich menu, LIFF endpoint, message check, quota
 * 5. Prints a QR code: scan it with your phone to add the bot as a friend
 *
 * Flags: --no-tunnel (use PUBLIC_URL as is, e.g. a deployed server)  --refresh-menu (rebuild the rich menu)
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import type { SetupReport } from '../line/setup.js';

const serverDir = fileURLToPath(new URL('../../', import.meta.url));
const rootDir = fileURLToPath(new URL('../../../../', import.meta.url));
const envPath = `${serverDir}.env`;
const args = new Set(process.argv.slice(2));
const API = 'http://127.0.0.1:8787';
const WEB = 'http://127.0.0.1:5173';
const children: ChildProcess[] = [];

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function fail(msg: string): never {
  console.error(`\n${red('✗')} ${msg}\n`);
  shutdown(1);
  throw new Error('unreachable');
}

function shutdown(code = 0) {
  for (const c of children) {
    try {
      if (c.pid) process.kill(-c.pid, 'SIGTERM'); // whole process group (npm → tsx/vite)
    } catch {
      c.kill('SIGTERM');
    }
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const has = (cmd: string) => spawnSync('which', [cmd]).status === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(url: string, label: string, seconds: number) {
  for (let i = 0; i < seconds; i++) {
    if (await reachable(url)) return;
    await sleep(1000);
  }
  fail(`${label} did not come up at ${url} within ${seconds}s.`);
}

function setEnvValue(key: string, value: string) {
  const text = readFileSync(envPath, 'utf8');
  const line = `${key}=${value}`;
  const next = new RegExp(`^${key}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line) : `${text.trimEnd()}\n${line}\n`;
  writeFileSync(envPath, next);
}

function startTunnel(): Promise<string> {
  const ngrokDomain = process.env.NGROK_DOMAIN;
  if (has('cloudflared') && !ngrokDomain) {
    console.log(dim('Starting Cloudflare quick tunnel…'));
    const p = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:5173', '--no-autoupdate'], { detached: true });
    children.push(p);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cloudflared did not print a URL within 30s')), 30_000);
      const onData = (d: Buffer) => {
        const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      };
      p.stdout?.on('data', onData);
      p.stderr?.on('data', onData);
      p.on('exit', (code) => reject(new Error(`cloudflared exited (${code})`)));
    });
  }
  if (has('ngrok')) {
    console.log(dim(`Starting ngrok tunnel${ngrokDomain ? ` on ${ngrokDomain}` : ''}…`));
    const help = spawnSync('ngrok', ['http', '--help']).stdout?.toString() ?? '';
    const domainFlag = ngrokDomain ? [help.includes('--url') ? `--url=${ngrokDomain}` : `--domain=${ngrokDomain}`] : [];
    const p = spawn('ngrok', ['http', '5173', ...domainFlag, '--log', 'stdout'], { detached: true });
    children.push(p);
    let output = '';
    p.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    p.stderr?.on('data', (d: Buffer) => (output += d.toString()));
    return new Promise((resolve, reject) => {
      p.on('exit', (code) => reject(new Error(`ngrok exited (${code}). ${output.split('\n').filter((l) => /err|ERR|authtoken/i.test(l)).slice(-3).join(' ')}`)));
      (async () => {
        for (let i = 0; i < 30; i++) {
          await sleep(1000);
          try {
            const res = await fetch('http://127.0.0.1:4040/api/tunnels');
            const data = (await res.json()) as { tunnels: { public_url: string }[] };
            const url = data.tunnels.map((t) => t.public_url).find((u) => u.startsWith('https://'));
            if (url) return resolve(url);
          } catch {
            /* not up yet */
          }
        }
        reject(new Error('ngrok did not report a tunnel URL within 30s'));
      })();
    });
  }
  return Promise.reject(
    new Error('No tunnel tool found. Install one:\n    brew install cloudflared\n  or install ngrok and run "ngrok config add-authtoken <token>"'),
  );
}

async function main() {
  console.log(bold('\nGoing live on LINE\n'));
  if (!existsSync(envPath)) fail('apps/server/.env not found. Copy .env.example to .env first (see README).');
  const env = dotenv.parse(readFileSync(envPath));
  Object.assign(process.env, { NGROK_DOMAIN: env.NGROK_DOMAIN ?? process.env.NGROK_DOMAIN });
  if (!env.DEMO_LINE_CHANNEL_SECRET || !env.DEMO_LINE_ACCESS_TOKEN) {
    fail('DEMO_LINE_CHANNEL_SECRET and DEMO_LINE_ACCESS_TOKEN are empty in apps/server/.env.\n  Follow docs/LINE-SETUP.md steps 1–3 to get them.');
  }
  if (await reachable(`${API}/health`)) {
    fail('The app is already running. Stop it first (it must restart to pick up the new public URL).');
  }

  let publicUrl = env.PUBLIC_URL ?? '';
  if (args.has('--no-tunnel')) {
    if (!publicUrl.startsWith('https://')) fail(`--no-tunnel needs an https PUBLIC_URL in .env (it is "${publicUrl}").`);
  } else {
    try {
      publicUrl = await startTunnel();
    } catch (err) {
      fail((err as Error).message);
    }
    setEnvValue('PUBLIC_URL', publicUrl);
  }
  console.log(`${green('✓')} Public URL ${bold(publicUrl)}`);

  console.log(dim('Starting the app…'));
  const dev = spawn('npm', ['run', 'dev'], { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  children.push(dev);
  dev.stdout?.on('data', (d: Buffer) => process.stdout.write(dim(d.toString())));
  dev.stderr?.on('data', (d: Buffer) => process.stderr.write(dim(d.toString())));
  dev.on('exit', (code) => fail(`The app stopped (exit ${code}).`));
  await waitFor(`${API}/health`, 'API server', 90);
  await waitFor(`${WEB}/health`, 'Web server', 60);
  await waitFor(`${publicUrl}/health`, 'Tunnel', 60);

  console.log(dim('Connecting LINE…'));
  const login = await fetch(`${API}/api/staff/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: env.STAFF_PASSWORD }),
  });
  if (!login.ok) fail('Could not sign in with STAFF_PASSWORD from .env.');
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const res = await fetch(`${API}/api/staff/clubs/demo/line-setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ refreshMenu: args.has('--refresh-menu') }),
  });
  const report = (await res.json()) as SetupReport & { error?: string; message?: string };
  if (!res.ok) fail(report.message ?? report.error ?? `Setup failed (${res.status})`);

  console.log('');
  for (const s of report.steps) {
    console.log(`${s.ok ? green('✓') : red('✗')} ${bold(s.name)}  ${s.detail.replace(/\n/g, '\n    ')}`);
  }

  if (report.bot) {
    console.log(`\n${bold('Add the bot on your phone')} (scan with the LINE app, or open ${report.bot.addFriendUrl})\n`);
    console.log(await QRCode.toString(report.bot.addFriendUrl, { type: 'terminal', small: true }));
  }
  console.log(`${bold('Staff dashboard')}  ${publicUrl}/staff`);
  console.log(report.ok ? green('\nAll set. Message the bot "book a table". Ctrl+C to stop.\n') : red('\nSome steps need attention (see ✗ above). The app keeps running. Ctrl+C to stop.\n'));
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
