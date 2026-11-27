import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../../api';
import { errText, fmtTime } from './AdminLayout';

const DAY = 24 * 60 * 60 * 1000;

/** §14.6 Data health: a club that goes silent is visible at a glance. */
export function DataHealth() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    adminApi.dataHealth().then((d) => setRows(d.clubs)).catch((e) => { setError(errText(e)); setRows([]); });
  }, []);

  return (
    <div className="stack">
      <h1>Data health</h1>
      {error && <div className="error">{error}</div>}
      {!rows ? (
        <div className="muted">Loading…</div>
      ) : (
        <div className="scroll-x">
          <table className="list">
            <thead>
              <tr><th>Club</th><th>Events per day (newest first)</th><th>Last event</th><th>Rejected</th><th>Guests with a notice</th><th>Pending removals</th></tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const last = c.lastEventAt ? new Date(c.lastEventAt).getTime() : 0;
                const silent = !last || Date.now() - last > DAY;
                const perDay: { day: string; count: number }[] = Array.isArray(c.eventsPerDay) ? c.eventsPerDay : [];
                const share = typeof c.noticeShare === 'number' ? c.noticeShare : null;
                return (
                  <tr key={c.slug ?? c.clubId}>
                    <td><Link to={`/admin/events?club=${c.slug ?? c.clubId}`}>{c.name ?? c.slug ?? c.clubId}</Link></td>
                    <td className="mono faint">{perDay.length ? [...perDay].reverse().slice(0, 7).map((d) => d.count).join(' · ') : '0'}</td>
                    <td className={silent ? 'error' : ''}>{fmtTime(c.lastEventAt)}{silent ? ' (silent)' : ''}</td>
                    <td className={c.rejectedEvents ? 'error' : ''}>{c.rejectedEvents ?? 0}</td>
                    <td>{share === null ? '—' : `${Math.round(share * 100)}%`}</td>
                    <td className={c.pendingRemovals ? 'error' : ''}>{c.pendingRemovals ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && !error && <div className="muted">No clubs.</div>}
        </div>
      )}
    </div>
  );
}
