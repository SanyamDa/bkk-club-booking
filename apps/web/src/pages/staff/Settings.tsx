import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { useStaff } from './Layout';

interface SettingsData {
  name: string;
  staffLinkCode: string;
  staffGroupLinked: boolean;
  lineConnected: boolean;
  webhookUrl: string;
  liffEndpoint: string;
  liffConfigured: boolean;
  promptpayConfigured: boolean;
  settings: { openWeekdays: number[]; holdMinutes: number; arrivalBy: string; rules: { en: string[] } };
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Check({ ok, label, hint }: { ok: boolean; label: string; hint: ReactNode }) {
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <span className={`chip ${ok ? 's-confirmed' : 's-payment_review'}`}>{ok ? 'Done' : 'To do'}</span>
      <div><b>{label}</b><div className="faint">{hint}</div></div>
    </div>
  );
}

interface LineStatus {
  connected: boolean;
  error?: string;
  bot?: { displayName: string; basicId: string; chatMode: string; addFriendUrl: string };
  webhook?: { endpoint: string; active: boolean; matches: boolean; expected: string };
  quota?: { limit: number | null; used: number };
}
interface SetupReport { ok: boolean; steps: { name: string; ok: boolean; detail: string }[] }

function LinePanel({ club }: { club: string }) {
  const [status, setStatus] = useState<LineStatus | null>(null);
  const [report, setReport] = useState<SetupReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api<LineStatus>(`/api/staff/clubs/${club}/line-status`).then(setStatus).catch(() => setStatus({ connected: false }));
  useEffect(() => { void load(); }, [club]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runSetup(refreshMenu: boolean) {
    setBusy(true);
    setError('');
    try {
      setReport(await api<SetupReport>(`/api/staff/clubs/${club}/line-setup`, { body: { refreshMenu } }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Setup failed');
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <div className="card muted">Checking LINE…</div>;
  return (
    <div className="card stack">
      <div className="spread wrap">
        <h2>LINE account</h2>
        {status.connected && (
          <div className="row wrap">
            <button className="btn small" disabled={busy} onClick={() => runSetup(true)}>Rebuild menu</button>
            <button className="btn small primary" disabled={busy} onClick={() => runSetup(false)}>{busy ? 'Running…' : 'Run LINE setup'}</button>
          </div>
        )}
      </div>
      {!status.connected ? (
        <p className="faint" style={{ margin: 0 }}>{status.error ?? 'Not connected. Add the LINE keys to .env, then run "npm run live" (see docs/LINE-SETUP.md).'}</p>
      ) : (
        <dl className="summary" style={{ margin: 0 }}>
          <dt>Account</dt><dd>{status.bot?.displayName} · {status.bot?.basicId}</dd>
          <dt>Webhook</dt>
          <dd>
            <span className={`chip ${status.webhook?.matches && status.webhook.active ? 's-confirmed' : 's-payment_review'}`}>
              {status.webhook?.matches ? (status.webhook.active ? 'Pointing here' : 'Use webhook is off') : 'Points elsewhere'}
            </span>
          </dd>
          <dt>Chat mode</dt><dd>{status.bot?.chatMode === 'chat' ? 'Bot + hosts in OA Manager' : 'Bot only'}</dd>
          <dt>Push messages this month</dt><dd>{status.quota?.used}{status.quota?.limit ? ` of ${status.quota.limit}` : ''}</dd>
          <dt>Add friend</dt><dd><a href={status.bot?.addFriendUrl} target="_blank" rel="noreferrer">{status.bot?.addFriendUrl}</a></dd>
        </dl>
      )}
      {error && <div className="error">{error}</div>}
      {report && (
        <div className="stack" style={{ gap: 6 }}>
          {report.steps.map((st) => (
            <div key={st.name} className="row" style={{ alignItems: 'flex-start' }}>
              <span className={`chip ${st.ok ? 's-confirmed' : 's-rejected'}`}>{st.ok ? 'OK' : 'Fix'}</span>
              <div><b>{st.name}</b><div className="faint" style={{ whiteSpace: 'pre-wrap' }}>{st.detail}</div></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Setup checklist and live LINE status. Editing club settings in the dashboard comes in Phase 1. */
export function Settings() {
  const { club } = useStaff();
  const [s, setS] = useState<SettingsData | null>(null);
  useEffect(() => { api<SettingsData>(`/api/staff/clubs/${club}/settings`).then(setS); }, [club]);
  if (!s) return <div className="muted">Loading…</div>;

  return (
    <div className="stack" style={{ gap: 20, maxWidth: 760 }}>
      <h1>Setup · {s.name}</h1>
      <LinePanel club={club} />
      <div className="card stack">
        <Check ok={s.lineConnected} label="LINE Messaging API connected" hint={<>Set the channel secret and access token in <code>apps/server/.env</code>, then run <code>npm run live</code>. It points LINE’s webhook here for you (currently <code>{s.webhookUrl}</code>).</>} />
        <Check ok={s.liffConfigured} label="Booking form inside LINE (LIFF)" hint={<>Create a LIFF app (endpoint <code>{s.liffEndpoint}</code>), put its ID in <code>DEMO_LIFF_ID</code> and the LINE Login channel ID/secret in <code>.env</code>, so the endpoint follows the tunnel automatically. Until then the form opens in the browser.</>} />
        <Check ok={s.staffGroupLinked} label="Staff LINE group" hint={<>Invite the club’s LINE account to your staff group and type <code className="mono">link {s.staffLinkCode}</code> in the group.</>} />
        <Check ok={s.promptpayConfigured} label="PromptPay deposits" hint={<>Set <code>DEMO_PROMPTPAY_ID</code> to the account deposits are paid to. Without it the bot runs in demo mode (no real QR).</>} />
      </div>
      <div className="card stack">
        <h2>Booking rules</h2>
        <dl className="summary" style={{ margin: 0 }}>
          <dt>Open nights</dt><dd>{s.settings.openWeekdays.map((d) => DAYS[d]).join(', ')}</dd>
          <dt>Hold time</dt><dd>{s.settings.holdMinutes} min</dd>
          <dt>Arrive by</dt><dd>{s.settings.arrivalBy}</dd>
        </dl>
        <ul className="rules">{s.settings.rules.en.map((r) => <li key={r}>{r}</li>)}</ul>
        <p className="faint" style={{ margin: 0 }}>Editing tables, prices and rules from here comes in Phase 1. For now they live in <code>apps/server/src/db/seed.ts</code>.</p>
      </div>
    </div>
  );
}
