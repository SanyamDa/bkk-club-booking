import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, staffPath } from '../../api';
import { useStaff } from './Layout';

type Level = 'urgent' | 'needs_input' | 'info';

interface FeedAlert {
  id: string;
  level: Level;
  kind: string;
  conversationId: string | null;
  bookingId: string | null;
  text: { en: string; th: string };
  createdAt: string;
  resolvedAt: string | null;
  sentLine: boolean;
}

const LEVEL: Record<Level, { label: string; color: string }> = {
  urgent: { label: 'Urgent', color: 'var(--danger, #c0392b)' },
  needs_input: { label: 'Needs input', color: 'var(--warn, #b7791f)' },
  info: { label: 'Info', color: 'var(--muted, #6b7280)' },
};

function when(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'short' });
}

/** Alerts feed (spec §6.4): urgent and needs-input items to clear, information to read. */
export function Feed() {
  const { club } = useStaff();
  const [list, setList] = useState<FeedAlert[] | null>(null);
  const [counts, setCounts] = useState<Record<Level, number>>({ urgent: 0, needs_input: 0, info: 0 });
  const [infoToLine, setInfoToLine] = useState<boolean | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const load = useCallback(async () => {
    const d = await api<{ alerts: FeedAlert[]; counts: Record<Level, number> }>(staffPath(club, '/feed'));
    setList(d.alerts);
    setCounts(d.counts);
  }, [club]);

  useEffect(() => {
    void load();
    const id = setInterval(load, 5_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    // Only owners and managers may see or change the switch; others get 403 and the switch stays hidden.
    api<{ infoToLine: boolean }>(staffPath(club, '/alert-settings'))
      .then((d) => setInfoToLine(d.infoToLine))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) setInfoToLine(null);
      });
  }, [club]);

  async function resolve(id: string) {
    await api(staffPath(club, `/feed/${id}/resolve`), { body: {} });
    await load();
  }

  async function toggle(on: boolean) {
    const d = await api<{ infoToLine: boolean }>(staffPath(club, '/alert-settings'), { method: 'PUT', body: { infoToLine: on } });
    setInfoToLine(d.infoToLine);
  }

  if (!list) return <div className="muted">Loading…</div>;
  const shown = list.filter((a) => showResolved || !a.resolvedAt || a.level === 'info');

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div>
        <h1>Alerts</h1>
        <p className="faint" style={{ margin: '4px 0 0' }}>
          Urgent alerts also go to the staff LINE group. Needs-input and information stay here, so they cost no LINE messages.
        </p>
      </div>
      <div className="row wrap" style={{ gap: 12 }}>
        <div className="card"><b>{counts.urgent}</b> urgent open</div>
        <div className="card"><b>{counts.needs_input}</b> need input</div>
      </div>
      {infoToLine !== null && (
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={infoToLine} onChange={(e) => void toggle(e.target.checked)} />
          Also send information alerts (new booking, cancellation, daily summary) to the staff LINE group.
          <span className="faint">Each alert counts once per group member against the LINE quota.</span>
        </label>
      )}
      <label className="row faint" style={{ gap: 8 }}>
        <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
        Show resolved
      </label>
      {shown.length === 0 && <p className="muted">Nothing needs you right now.</p>}
      {shown.map((a) => (
        <div key={a.id} className="card stack" style={{ borderLeft: `4px solid ${LEVEL[a.level].color}`, opacity: a.resolvedAt ? 0.6 : 1 }}>
          <div className="spread wrap">
            <div>
              <b style={{ color: LEVEL[a.level].color }}>{LEVEL[a.level].label}</b>
              <span className="faint"> · {when(a.createdAt)}{a.sentLine ? ' · sent to LINE' : ''}</span>
            </div>
            {a.level !== 'info' && !a.resolvedAt && (
              <button className="btn small" onClick={() => void resolve(a.id)}>Resolve</button>
            )}
          </div>
          <div>{a.text.en}</div>
          <div className="faint">{a.text.th}</div>
          <div className="row" style={{ gap: 12 }}>
            {a.bookingId && <Link to={`/staff/bookings/${a.bookingId}`}>Open booking</Link>}
            {a.conversationId && <Link to="/staff/handoffs">Open chats</Link>}
          </div>
        </div>
      ))}
    </div>
  );
}
