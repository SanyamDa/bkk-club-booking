import { useEffect, useState } from 'react';
import { api, ApiError, staffPath } from '../../api';
import { useStaff } from './Layout';

interface ClubReport {
  weekStart: string;
  weekEnd: string;
  bookings: number;
  cancelled: number;
  deposits: { count: number; satang: number };
  noShowRate: number | null;
  noStaffHelpRate: number | null;
  busiestNights: { nightDate: string; bookings: number }[];
  zones: { zoneId: string; name: string; nameTh: string; bookings: number }[];
  averageSpendSatang: number | null;
  deflection: { conversations: number; deflected: number; rate: number | null };
  takeoversByTopic: { topic: string; n: number }[];
  door: { count: number; bookedPax: number; peakHour: number | null };
  topPromoters?: { promoterId: string; name: string; code: string; bookings: number; pax: number }[] | null;
  vip?: { guests: number; bookings: number; arrived: number; spendSatang: number };
}

const pct = (r: number | null) => (r === null ? '–' : `${Math.round(r * 100)}%`);
const baht = (satang: number) => `฿${(satang / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

function shiftWeek(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Weekly club report (spec §14.10): the same figures the staff LINE group gets every Monday. */
export function Report() {
  const { club } = useStaff();
  const [week, setWeek] = useState<string | null>(null);
  const [report, setReport] = useState<ClubReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    const q = week ? `?week=${week}` : '';
    api<{ report: ClubReport }>(staffPath(club, `/report${q}`))
      .then((d) => setReport(d.report))
      .catch((err) => setError(err instanceof ApiError && err.status === 403 ? 'Only owners and managers can see the report.' : 'Could not load the report.'));
  }, [club, week]);

  if (error) return <p className="muted">{error}</p>;
  if (!report) return <div className="muted">Loading…</div>;
  const r = report;
  const tile = (label: string, value: string | number, sub?: string) => (
    <div className="card">
      <div className="faint">{label}</div>
      <b style={{ fontSize: 22 }}>{value}</b>
      {sub && <div className="faint">{sub}</div>}
    </div>
  );

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="spread wrap">
        <div>
          <h1>Weekly report</h1>
          <p className="faint" style={{ margin: '4px 0 0' }}>
            Nights {r.weekStart} to {r.weekEnd}. Sent to the staff LINE group every Monday morning.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn small" onClick={() => setWeek(shiftWeek(r.weekStart, -7))}>Previous week</button>
          <button className="btn small" onClick={() => setWeek(shiftWeek(r.weekStart, 7))}>Next week</button>
        </div>
      </div>
      <div className="row wrap" style={{ gap: 12 }}>
        {tile('Bookings', r.bookings, `${r.cancelled} cancelled`)}
        {tile('Deposits', baht(r.deposits.satang), `${r.deposits.count} verified`)}
        {tile('No-show rate', pct(r.noShowRate))}
        {tile('Booked with no staff help', pct(r.noStaffHelpRate))}
        {tile('Average spend', r.averageSpendSatang === null ? '–' : baht(r.averageSpendSatang), 'POS bills')}
        {tile('Deflection', pct(r.deflection.rate), `${r.deflection.deflected} of ${r.deflection.conversations} chats`)}
        {tile('Door count', r.door.count, `${r.door.bookedPax} booked · peak ${r.door.peakHour === null ? '–' : `${String(r.door.peakHour).padStart(2, '0')}:00`}`)}
        {r.vip && tile('VIP bookings', r.vip.bookings, `${r.vip.arrived} arrived · ${r.vip.guests} guests · ${baht(r.vip.spendSatang)}`)}
      </div>
      {r.topPromoters && (
        <div className="card stack">
          <b>Top promoters</b>
          {r.topPromoters.length === 0 && <span className="muted">No promoter bookings</span>}
          {r.topPromoters.map((p) => <div key={p.promoterId}>{p.name} <span className="faint">{p.code}</span> · {p.bookings} bookings · {p.pax} guests</div>)}
        </div>
      )}
      <div className="row wrap" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="card stack">
          <b>Busiest nights</b>
          {r.busiestNights.length === 0 && <span className="muted">No bookings</span>}
          {r.busiestNights.map((n) => <div key={n.nightDate}>{n.nightDate} · {n.bookings}</div>)}
        </div>
        <div className="card stack">
          <b>Zones</b>
          {r.zones.length === 0 && <span className="muted">No bookings</span>}
          {r.zones.map((z) => <div key={z.zoneId}>{z.name} <span className="faint">{z.nameTh}</span> · {z.bookings}</div>)}
        </div>
        <div className="card stack">
          <b>Takeovers by topic</b>
          {r.takeoversByTopic.length === 0 && <span className="muted">None</span>}
          {r.takeoversByTopic.map((t) => <div key={t.topic}>{t.topic} · {t.n}</div>)}
        </div>
      </div>
      <p className="faint">Top promoters arrive in Phase 3.</p>
    </div>
  );
}
