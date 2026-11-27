import { useEffect, useState } from 'react';
import { api, ApiError, staffPath } from '../../api';
import { useStaff } from './Layout';

interface ClubStats {
  from: string;
  to: string;
  bookings: { total: number; bot: number; manual: number; cancelled: number };
  noStaffHelpRate: number | null;
  deflection: { conversations: number; deflected: number; rate: number | null };
  takeoversByTopic: { topic: string; n: number }[];
  firstResponse: { medianMs: number | null; answered: number; unanswered: number };
  handoffResponse: { medianMs: number | null; replied: number; waiting: number };
  bookingTime: { medianMs: number | null; bookings: number };
  deposits: { count: number; satang: number };
  minSpendBookedSatang: number;
  noShowRate: number | null;
  messagesByChannel: { channel: string; in: number; out: number }[];
  pushQuota: { limit: number; used: number; pct: number; warn: boolean } | null;
  aiCost: { rangeUsdMicros: number; monthUsdMicros: number; capUsdMicros: number | null };
  funnel: { step: string; n: number; dropOff: number }[];
}

const pct = (r: number | null) => (r === null ? '–' : `${Math.round(r * 100)}%`);
const baht = (satang: number) => `฿${(satang / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

function duration(ms: number | null) {
  if (ms === null) return '–';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

const CHANNEL: Record<string, string> = { line: 'LINE', instagram: 'Instagram', whatsapp: 'WhatsApp', web: 'Web' };

/** Club stats (spec §6.5): the goal figures for any range of nights. Owners and managers only. */
export function Stats() {
  const { club } = useStaff();
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [draft, setDraft] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [stats, setStats] = useState<ClubStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    const q = range ? `?from=${range.from}&to=${range.to}` : '';
    api<{ stats: ClubStats }>(staffPath(club, `/stats${q}`))
      .then((d) => {
        setStats(d.stats);
        setDraft({ from: d.stats.from, to: d.stats.to });
      })
      .catch((err) =>
        setError(
          err instanceof ApiError && err.status === 403
            ? 'Only owners and managers can see the stats.'
            : err instanceof ApiError && err.status === 400
              ? 'Pick a start night on or before the end night, at most one year apart.'
              : 'Could not load the stats.',
        ),
      );
  }, [club, range]);

  const tile = (label: string, value: string | number, sub?: string) => (
    <div className="card">
      <div className="faint">{label}</div>
      <b style={{ fontSize: 22 }}>{value}</b>
      {sub && <div className="faint">{sub}</div>}
    </div>
  );

  const picker = (
    <form
      className="row wrap"
      style={{ gap: 8, alignItems: 'flex-end' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.from && draft.to) setRange({ ...draft });
      }}
    >
      <label className="stack">
        <span className="faint">From night</span>
        <input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
      </label>
      <label className="stack">
        <span className="faint">To night</span>
        <input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
      </label>
      <button className="btn small" type="submit">Show</button>
    </form>
  );

  if (error)
    return (
      <div className="stack" style={{ gap: 16 }}>
        {picker}
        <p className="muted">{error}</p>
      </div>
    );
  if (!stats) return <div className="muted">Loading…</div>;
  const s = stats;
  const maxFunnel = Math.max(1, ...s.funnel.map((f) => f.n));

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="spread wrap">
        <div>
          <h1>Stats</h1>
          <p className="faint" style={{ margin: '4px 0 0' }}>
            Nights {s.from} to {s.to}.
          </p>
        </div>
        {picker}
      </div>

      <div className="row wrap" style={{ gap: 12 }}>
        {tile('Bookings', s.bookings.total, `${s.bookings.bot} by the bot · ${s.bookings.manual} by staff · ${s.bookings.cancelled} cancelled`)}
        {tile('Booked with no staff help', pct(s.noStaffHelpRate), 'Goal 70% or more')}
        {tile('Deflection', pct(s.deflection.rate), `${s.deflection.deflected} of ${s.deflection.conversations} chats without a takeover`)}
        {tile('First response', duration(s.firstResponse.medianMs), `median · ${s.firstResponse.unanswered} unanswered`)}
        {tile('Handoff reply', duration(s.handoffResponse.medianMs), `median · ${s.handoffResponse.waiting} with no staff reply`)}
        {tile('Booking time', duration(s.bookingTime.medianMs), `median, first step to confirmed · ${s.bookingTime.bookings} bookings`)}
        {tile('Deposits', baht(s.deposits.satang), `${s.deposits.count} verified`)}
        {tile('Minimum spend booked', baht(s.minSpendBookedSatang))}
        {tile('No-show rate', pct(s.noShowRate))}
        {tile(
          'Push messages this month',
          s.pushQuota ? (s.pushQuota.limit > 0 ? `${s.pushQuota.used} / ${s.pushQuota.limit}` : s.pushQuota.used) : '–',
          s.pushQuota ? (s.pushQuota.limit > 0 ? `${s.pushQuota.pct}% of the plan` : 'No limit on the plan') : 'No LINE check yet',
        )}
        {tile(
          'AI cost this month',
          usd(s.aiCost.monthUsdMicros),
          `${s.aiCost.capUsdMicros === null ? 'No cap set' : `cap ${usd(s.aiCost.capUsdMicros)}`} · ${usd(s.aiCost.rangeUsdMicros)} in these nights`,
        )}
      </div>

      <div className="row wrap" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="card stack">
          <b>Takeovers by topic</b>
          {s.takeoversByTopic.length === 0 && <span className="muted">None</span>}
          {s.takeoversByTopic.map((t) => <div key={t.topic}>{t.topic} · {t.n}</div>)}
        </div>
        <div className="card stack">
          <b>Messages by channel</b>
          {s.messagesByChannel.length === 0 && <span className="muted">No messages</span>}
          {s.messagesByChannel.map((m) => (
            <div key={m.channel}>
              {CHANNEL[m.channel] ?? m.channel} · {m.in} in · {m.out} out
            </div>
          ))}
        </div>
        <div className="card stack" style={{ minWidth: 260, flex: 1 }}>
          <b>Booking funnel</b>
          {s.funnel.map((f) => (
            <div key={f.step} className="stack" style={{ gap: 2 }}>
              <div className="spread">
                <span>{f.step}</span>
                <span>
                  {f.n}
                  {f.dropOff > 0 && <span className="faint"> (−{f.dropOff})</span>}
                </span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--line, #ddd)' }}>
                <div style={{ height: 6, borderRadius: 3, width: `${(f.n / maxFunnel) * 100}%`, background: 'var(--accent, #C9A45C)' }} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <p className="faint">Test bookings and test guests are not counted, except on the demo club.</p>
    </div>
  );
}
