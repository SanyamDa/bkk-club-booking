import { useEffect, useState, type FormEvent } from 'react';
import { adminApi, type AdminClub } from '../../api';
import { errText, fmtTime, TotpField } from './AdminLayout';

/** Per-club controls on the club page: pause the bot, send a test message (never to a guest). */
export function ClubControls({ club, onChange }: { club: AdminClub; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError('');
    setMsg('');
    try {
      await fn();
      setMsg(done);
      onChange();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h2>Controls</h2>
      <div className="spread wrap">
        <div>
          <b>Bot {club.botPaused ? 'paused' : 'running'}</b>
          <div className="faint">Paused: messages are stored, no automatic replies, staff are alerted.</div>
        </div>
        <button
          className={`btn small ${club.botPaused ? 'primary' : 'danger'}`}
          disabled={busy}
          onClick={() => run(() => adminApi.pause(club.slug, !club.botPaused), club.botPaused ? 'Bot resumed. The staff group was told.' : 'Bot paused. The staff group was told.')}
        >
          {club.botPaused ? 'Resume bot' : 'Pause bot'}
        </button>
      </div>
      <div className="row wrap">
        <button className="btn small" disabled={busy} onClick={() => run(() => adminApi.testMessage(club.slug, 'self'), 'Test message sent to our LINE account.')}>Test message to us</button>
        <button className="btn small" disabled={busy} onClick={() => run(() => adminApi.testMessage(club.slug, 'staff_group'), 'Test message sent to the staff group.')}>Test message to staff group</button>
      </div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="faint">{msg}</div>}
      <ClubFeatures slug={club.slug} />
    </div>
  );
}

const FEATURE_LABELS: Record<string, string> = {
  ai_answers: 'AI answers from the club brain',
  learning_loop: 'Brain learns from host takeovers',
  instagram: 'Instagram messages',
  pos_sync: 'POS sync',
  alerts_line: 'Alerts to the staff LINE group',
  payment_gateway: 'Deposits through the payment gateway (instead of slips)',
};

/** A17b: per-club feature switches. Each change applies on the next request, no deploy. */
function ClubFeatures({ slug }: { slug: string }) {
  const [features, setFeatures] = useState<Record<string, boolean> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    adminApi.features(slug).then((d) => setFeatures(d.features)).catch((e) => setError(errText(e)));
  }, [slug]);

  async function toggle(key: string, on: boolean) {
    setBusy(true);
    setError('');
    try {
      const d = await adminApi.setFeatures(slug, { [key]: on });
      setFeatures(d.features);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <h3 style={{ margin: 0 }}>Feature switches</h3>
      {!features ? (
        !error && <div className="muted">Loading…</div>
      ) : (
        Object.entries(features).map(([key, on]) => (
          <label key={key} className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={on} disabled={busy} onChange={(e) => toggle(key, e.target.checked)} />
            <span>{FEATURE_LABELS[key] ?? key}</span>
          </label>
        ))
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function PlatformLoginForm() {
  const [summary, setSummary] = useState<{ liffId: string; last4: string; setBy: string; setAt: string } | null | undefined>(undefined);
  const [channelId, setChannelId] = useState('');
  const [channelSecret, setChannelSecret] = useState('');
  const [liffId, setLiffId] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => adminApi.platformLogin().then((d) => setSummary(d.loginChannel ?? null)).catch(() => setSummary(null));
  useEffect(() => { void load(); }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await adminApi.setPlatformLogin({ channelId: channelId.trim(), channelSecret, liffId: liffId.trim(), totp });
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      // Write-only: the secret never stays in the page.
      setChannelSecret('');
      setTotp('');
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={save} autoComplete="off">
      <h2>Platform LINE Login channel</h2>
      <p className="faint" style={{ margin: 0 }}>One LINE Login channel and LIFF app under our own provider serve every club. Write-only.</p>
      {summary === undefined ? (
        <div className="muted">Loading…</div>
      ) : summary ? (
        <div className="faint">LIFF {summary.liffId} · secret ••••{summary.last4}, set by {summary.setBy}, {fmtTime(summary.setAt)}</div>
      ) : (
        <div className="error">Not set: console-created clubs cannot go live until it is.</div>
      )}
      <div className="field">
        <label htmlFor="pl-id">Channel ID</label>
        <input id="pl-id" className="input mono" value={channelId} onChange={(e) => setChannelId(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="pl-secret">Channel secret</label>
        <input id="pl-secret" className="input mono" type="password" autoComplete="new-password" value={channelSecret} onChange={(e) => setChannelSecret(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="pl-liff">LIFF ID</label>
        <input id="pl-liff" className="input mono" value={liffId} onChange={(e) => setLiffId(e.target.value)} />
      </div>
      <TotpField id="pl-totp" value={totp} onChange={setTotp} />
      {error && <div className="error">{error}</div>}
      <button className="btn primary" disabled={busy || !channelId.trim() || !channelSecret || !liffId.trim() || totp.length !== 6} style={{ alignSelf: 'flex-start' }}>
        {busy ? 'Saving…' : 'Save login channel'}
      </button>
    </form>
  );
}

function GlobalStop() {
  const [state, setState] = useState<{ stopped: boolean; updatedAt: string | null } | null>(null);
  const load = () => adminApi.globalStopState().then(setState).catch(() => {});
  useEffect(() => { void load(); }, []);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  async function set(stopped: boolean) {
    if (stopped && !window.confirm('Stop the bot for every club?')) return;
    setBusy(true);
    setError('');
    setMsg('');
    try {
      await adminApi.globalStop(stopped);
      setMsg(stopped ? 'Global stop is on: no club bot replies.' : 'Global stop is off.');
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h2>Global stop</h2>
      <p className="faint" style={{ margin: 0 }}>Stops automatic replies for all clubs at once, without a deploy.</p>
      {state && (
        <div>{state.stopped ? <span className="chip s-rejected">Stopped</span> : <span className="chip s-confirmed">Running</span>} <span className="faint">since {fmtTime(state.updatedAt)}</span></div>
      )}
      <div className="row wrap">
        <button className="btn danger" disabled={busy} onClick={() => set(true)}>Stop all clubs</button>
        <button className="btn" disabled={busy} onClick={() => set(false)}>Resume all clubs</button>
      </div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="faint">{msg}</div>}
    </div>
  );
}

export function Controls() {
  return (
    <div className="stack" style={{ gap: 20, maxWidth: 760 }}>
      <h1>Controls</h1>
      <GlobalStop />
      <PlatformLoginForm />
      <p className="faint" style={{ margin: 0 }}>Per-club pause and test messages are on each club's page.</p>
    </div>
  );
}
