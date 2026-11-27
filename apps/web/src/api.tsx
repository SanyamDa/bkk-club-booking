import { useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: { error?: string; message?: string; issues?: { field?: string; message: string }[] },
  ) {
    super(body.message ?? body.error ?? `HTTP ${status}`);
  }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  if (path.startsWith('/api/staff/clubs/')) noteSupportHeader(res.headers.get('x-support-session'));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/** Club-scoped staff API URL (plan A2): every staff route lives under /api/staff/clubs/:slug. */
export const staffPath = (club: string, path: string) => `/api/staff/clubs/${encodeURIComponent(club)}${path}`;

export const STATUS_LABEL: Record<string, string> = {
  held: 'Held',
  awaiting_payment: 'Awaiting deposit',
  payment_review: 'Check slip',
  confirmed: 'Confirmed',
  arrived: 'Arrived',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
  expired: 'Expired',
  abandoned: 'Abandoned',
  rejected: 'Rejected',
};

export function Status({ status }: { status: string }) {
  return <span className={`chip s-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

/* ---------- Founder console (A6): support-session header and admin API helpers ---------- */

let supportHeader: string | null = null;
const supportListeners = new Set<(h: string | null) => void>();

/** Called by api() for every club-scoped staff response; the server sets X-Support-Session under a grant. */
function noteSupportHeader(raw: string | null) {
  // The server percent-encodes the value (a Thai club name is not a valid header ByteString).
  let h = raw;
  if (raw !== null) {
    try {
      h = decodeURIComponent(raw);
    } catch {
      h = raw;
    }
  }
  if (h === supportHeader) return;
  supportHeader = h;
  supportListeners.forEach((f) => f(h));
}

/** The latest X-Support-Session header value ("<club name>, ends <HH:MM>"), or null. */
export function useSupportHeader(): string | null {
  const [h, setH] = useState(supportHeader);
  useEffect(() => {
    supportListeners.add(setH);
    setH(supportHeader);
    return () => { supportListeners.delete(setH); };
  }, []);
  return h;
}

/** Support sessions this browser opened, keyed by club slug, so the banner can end or elevate them. */
export interface StoredSupport { id: string; clubSlug: string; clubName: string; mode: 'read' | 'write'; expiresAt: string }
const SUPPORT_KEY = 'supportSessions';
export function storedSupport(): StoredSupport[] {
  try {
    const all = JSON.parse(localStorage.getItem(SUPPORT_KEY) ?? '[]') as StoredSupport[];
    return all.filter((s) => new Date(s.expiresAt).getTime() > Date.now());
  } catch {
    return [];
  }
}
export function saveSupport(s: StoredSupport) {
  const rest = storedSupport().filter((x) => x.id !== s.id && x.clubSlug !== s.clubSlug);
  try { localStorage.setItem(SUPPORT_KEY, JSON.stringify([...rest, s])); } catch { /* ignore */ }
}
export function forgetSupport(id: string) {
  try { localStorage.setItem(SUPPORT_KEY, JSON.stringify(storedSupport().filter((x) => x.id !== id))); } catch { /* ignore */ }
}

export interface SetupReport { ok: boolean; steps: { name: string; ok: boolean; detail: string }[]; bot?: { displayName: string; basicId: string; chatMode: string; addFriendUrl: string } }
export interface CredentialSummary { kind: string; last4: string; setBy: string; setAt: string }
export interface AdminClub {
  slug: string;
  name: string;
  status: 'onboarding' | 'live' | 'paused' | 'demo';
  lineConnected?: boolean;
  webhookOk?: boolean;
  lineCheckedAt?: string | null;
  lastInboundAt?: string | null;
  failures24h?: number;
  quota?: { used: number; limit: number; pct?: number; warn?: boolean } | null;
  handoffsPastTimeout?: number;
  depositsInReview?: number;
  staffGroupLinked?: boolean;
  botPaused?: boolean;
}
export interface LineStatusAdmin {
  webhookActive: boolean;
  chatMode: string;
  quota: { limit: number; used: number; pct: number; warn: boolean };
  planCheck: { expectedMonthlyPushes: number; recommendUpgrade: boolean };
  liveTest: 'pending' | 'pass' | 'fail';
}
export interface PlanInputs { expectedBookings: number; hostReplies: number; staffAlerts: number; groupSize: number }

const adm = (slug: string) => `/api/admin/clubs/${encodeURIComponent(slug)}`;
const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Admin API calls, coded against the A5 decisions in the build plan. */
export const adminApi = {
  me: () => api<{ user: { id: string; email: string; name: string; platformRole: string | null } }>('/api/auth/me'),
  clubs: () => api<{ clubs: AdminClub[] }>('/api/admin/clubs'),
  createClub: (b: { name: string; slug: string; template: 'blank' | 'velora-like' }) => api('/api/admin/clubs', { body: b }),
  /** Optional detail route (profile + credential summary); pages tolerate 404. */
  club: (slug: string) => api<{ health?: AdminClub; profile?: Record<string, unknown> | null; credentials?: CredentialSummary[] }>(adm(slug)),
  setStatus: (slug: string, status: AdminClub['status']) => api(adm(slug), { method: 'PATCH', body: { status } }),
  putProfile: (slug: string, profile: Record<string, unknown>) => api(adm(slug) + '/profile', { method: 'PUT', body: profile }),
  connectLine: (slug: string, b: { channelId: string; channelSecret: string; totp: string; loginChannelId?: string; loginChannelSecret?: string; liffId?: string }) =>
    api<SetupReport & { credential?: CredentialSummary; credentials?: CredentialSummary[] }>(adm(slug) + '/line', { body: b }),
  lineStatus: (slug: string, p?: Partial<PlanInputs>) => api<LineStatusAdmin>(adm(slug) + '/line/status' + qs({ ...p })),
  liveTest: (slug: string) => api(adm(slug) + '/line/live-test', { body: {} }),
  testerCode: (slug: string) => api<{ code: string; expiresAt?: string }>(adm(slug) + '/tester-code', { body: {} }),
  startSupport: (b: { clubSlug: string; reason: string; ticketRef?: string }) =>
    api<{ id: string; mode: 'read' | 'write'; expiresAt: string }>('/api/admin/support', { body: b }),
  elevateSupport: (id: string, reason: string) => api(`/api/admin/support/${encodeURIComponent(id)}/elevate`, { body: { reason } }),
  endSupport: (id: string) => api(`/api/admin/support/${encodeURIComponent(id)}/end`, { body: {} }),
  webhooks: (slug: string, p: { limit?: number; before?: string } = {}) => api<{ webhooks: any[] }>(adm(slug) + '/webhooks' + qs(p)),
  replay: (slug: string, id: string) => api<{ replies?: unknown[] }>(adm(slug) + `/webhooks/${encodeURIComponent(id)}/replay`, { body: {} }),
  messages: (slug: string, p: { limit?: number; before?: string } = {}) => api<{ messages: any[] }>(adm(slug) + '/messages' + qs(p)),
  timeline: (slug: string, kind: 'conversations' | 'bookings', id: string) => api<{ items?: any[]; history?: any[] }>(adm(slug) + `/${kind}/${encodeURIComponent(id)}/timeline`),
  testMessage: (slug: string, to: 'self' | 'staff_group') => api(adm(slug) + '/test-message', { body: { to } }),
  pause: (slug: string, paused: boolean) => api(adm(slug) + '/pause', { body: { paused } }),
  /** A17b per-club feature switches. */
  features: (slug: string) => api<{ features: Record<string, boolean> }>(adm(slug) + '/features'),
  setFeatures: (slug: string, b: Record<string, boolean>) => api<{ features: Record<string, boolean> }>(adm(slug) + '/features', { method: 'PATCH', body: b }),
  globalStop: (stopped: boolean) => api('/api/admin/global-stop', { body: { stopped } }),
  globalStopState: () => api<{ stopped: boolean; updatedBy: string | null; updatedAt: string | null }>('/api/admin/global-stop'),
  platformLogin: () => api<{ loginChannel: { liffId: string; last4: string; setBy: string; setAt: string } | null }>('/api/admin/platform/line-login'),
  setPlatformLogin: (b: { channelId: string; channelSecret: string; liffId: string; totp: string }) =>
    api<{ last4: string; setAt: string }>('/api/admin/platform/line-login', { body: b }),
  dataHealth: () => api<{ clubs: any[] }>('/api/admin/data/health'),
  events: (p: { club?: string; conversation?: string; booking?: string; guest?: string; before?: string; limit?: number }) =>
    api<{ events: any[] }>('/api/admin/events' + qs(p)),
  /** A9 event calendar (nights rows) for one club. */
  nights: (slug: string, from: string, days: number) => api<{ nights: any[] }>(adm(slug) + '/nights' + qs({ from, days })),
  saveNight: (slug: string, b: Record<string, unknown>) => api(adm(slug) + '/nights', { method: 'PUT', body: b }),
};
