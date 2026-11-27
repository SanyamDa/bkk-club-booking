import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, staffPath } from '../../api';
import { useStaff } from './Layout';

interface Promoter { id: string; code: string; name: string; commissionBps: number; disabled: boolean; link: string }
interface ReportRow { promoterId: string; name: string; code: string; bookings: number; arrived: number; noShows: number; pax: number; spendSatang: number; commissionSatang: number }
interface Mine {
  promoter: { code: string; name: string; commissionBps: number; link: string };
  last90Days: { bookings: number; arrived: number; pax: number; commissionSatang: number } | null;
  bookings: { id: string; ref: string; nightDate: string; status: string; pax: number; tableCode: string | null }[];
}

const baht = (satang: number) => `฿${(satang / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const pct = (bps: number) => `${bps / 100}%`;

/** A promoter's own page (spec §4): their link, bookings and commission. No guest details. */
function PromoterHome({ mine }: { mine: Mine }) {
  return (
    <div className="stack" style={{ gap: 16 }}>
      <h1>Your bookings</h1>
      <div className="card stack">
        <div className="faint">Your link (commission {pct(mine.promoter.commissionBps)})</div>
        <input className="input" readOnly value={mine.promoter.link} onFocus={(e) => e.currentTarget.select()} aria-label="Promoter link" />
        {mine.last90Days && (
          <div className="faint">
            Last 90 days: {mine.last90Days.bookings} bookings, {mine.last90Days.arrived} arrived, {mine.last90Days.pax} guests, commission {baht(mine.last90Days.commissionSatang)}
          </div>
        )}
      </div>
      <div className="card stack">
        {mine.bookings.length === 0 && <div className="muted">No bookings yet.</div>}
        {mine.bookings.map((b) => (
          <div key={b.id} className="spread">
            <span>{b.nightDate} · {b.tableCode ?? '–'} · {b.pax} pax</span>
            <span className="faint">{b.ref} · {b.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Promoters (plan A20a): codes and links, commission rates, and who brought which bookings. */
export function Promoters() {
  const { club } = useStaff();
  const [list, setList] = useState<Promoter[] | null>(null);
  const [report, setReport] = useState<ReportRow[]>([]);
  const [mine, setMine] = useState<Mine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [rate, setRate] = useState('10');

  async function load() {
    setError(null);
    try {
      const [p, r] = await Promise.all([
        api<{ promoters: Promoter[] }>(staffPath(club, '/promoters')),
        api<{ report: ReportRow[] }>(staffPath(club, '/promoters/report')),
      ]);
      setList(p.promoters);
      setReport(r.report);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        try {
          setMine(await api<Mine>(staffPath(club, '/promoter/me')));
        } catch {
          setError('Only owners and managers can manage promoters.');
        }
      } else setError('Could not load promoters.');
    }
  }
  useEffect(() => {
    void load();
  }, [club]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(staffPath(club, '/promoters'), { body: { name, code, commissionBps: Math.round(Number(rate) * 100) } });
      setName('');
      setCode('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? 'That code is taken.' : 'Check the name and code (letters, digits, dashes).');
    }
  }

  async function toggle(p: Promoter) {
    await api(staffPath(club, `/promoters/${p.id}`), { method: 'PATCH', body: { disabled: !p.disabled } });
    await load();
  }

  if (mine) return <PromoterHome mine={mine} />;
  if (error && !list) return <p className="muted">{error}</p>;
  if (!list) return <div className="muted">Loading…</div>;
  const byId = new Map(report.map((r) => [r.promoterId, r]));

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div>
        <h1>Promoters</h1>
        <p className="faint" style={{ margin: '4px 0 0' }}>Last 30 nights. Commission is on POS spend, or the minimum spend without a bill, for arrived tables.</p>
      </div>
      {error && <div className="error">{error}</div>}
      <form className="card stack" onSubmit={create}>
        <div className="row wrap">
          <div className="field" style={{ flex: '2 1 180px' }}>
            <label htmlFor="p-name">Name</label>
            <input id="p-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field" style={{ flex: '1 1 120px' }}>
            <label htmlFor="p-code">Code</label>
            <input id="p-code" className="input" value={code} onChange={(e) => setCode(e.target.value)} required />
          </div>
          <div className="field" style={{ flex: '1 1 90px' }}>
            <label htmlFor="p-rate">Commission %</label>
            <input id="p-rate" className="input" type="number" min="0" max="100" step="0.5" value={rate} onChange={(e) => setRate(e.target.value)} />
          </div>
        </div>
        <div className="row"><button className="btn primary" disabled={!name || !code}>Add promoter</button></div>
      </form>
      <div className="card stack">
        {list.length === 0 && <div className="muted">No promoters yet.</div>}
        {list.map((p) => {
          const r = byId.get(p.id);
          return (
            <div key={p.id} className="stack" style={{ gap: 4 }}>
              <div className="spread wrap">
                <b>{p.name} <span className="faint">({p.code}, {pct(p.commissionBps)})</span>{p.disabled && <span className="faint"> · disabled</span>}</b>
                <button className="btn small" onClick={() => void toggle(p)}>{p.disabled ? 'Enable' : 'Disable'}</button>
              </div>
              <input className="input" readOnly value={p.link} onFocus={(e) => e.currentTarget.select()} aria-label={`Link for ${p.name}`} />
              {r && (
                <div className="faint">
                  {r.bookings} bookings · {r.arrived} arrived · {r.noShows} no-show · {r.pax} guests · spend {baht(r.spendSatang)} · commission {baht(r.commissionSatang)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
