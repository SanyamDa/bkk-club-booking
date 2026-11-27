import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, staffPath } from '../../api';
import { useStaff } from './Layout';

/** One `nights` row as the API returns it (plan A9). */
export interface NightRow {
  id: string;
  date: string;
  status: 'open' | 'closed' | 'sold_out';
  closedReason: string | null;
  eventType: string | null;
  eventName: string | null;
  lineup: string[] | null;
  notes: string | null;
  editedBy: string | null;
}
export interface NightSave {
  date: string;
  status?: 'open' | 'closed';
  closedReason?: string | null;
  eventType?: string | null;
  eventName?: string | null;
  lineup?: string[] | null;
  notes?: string | null;
  eventPrice?: { minSpendSatang: number; depositSatang: number };
}
export interface NightsApi {
  list: (from: string, days: number) => Promise<{ nights: NightRow[] }>;
  save: (b: NightSave) => Promise<unknown>;
}

const DAYS = 42;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CLOSED_REASONS = ['alcohol_ban', 'private_event', 'holiday', 'renovation', 'weather', 'other'];
const EVENT_TYPES = ['guest_dj', 'live_band', 'party', 'theme_night', 'holiday', 'other'];

/** Bangkok date (UTC+7) as YYYY-MM-DD. */
function bangkokToday(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const toSatang = (baht: string) => Math.round(Number(baht) * 100);

function NightEditor({ date, row, onSave, onClose }: { date: string; row: NightRow | undefined; onSave: (b: NightSave) => Promise<void>; onClose: () => void }) {
  const [status, setStatus] = useState<'open' | 'closed'>(row?.status === 'closed' ? 'closed' : 'open');
  const [closedReason, setClosedReason] = useState(row?.closedReason ?? '');
  const [eventName, setEventName] = useState(row?.eventName ?? '');
  const [eventType, setEventType] = useState(row?.eventType ?? '');
  const [lineup, setLineup] = useState((row?.lineup ?? []).join(', '));
  const [notes, setNotes] = useState(row?.notes ?? '');
  const [minSpend, setMinSpend] = useState('');
  const [deposit, setDeposit] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (status === 'closed' && !closedReason.trim()) return setError('Choose why the club is closed.');
    if ((minSpend && !deposit) || (!minSpend && deposit)) return setError('Enter both the minimum spend and the deposit, or neither.');
    setBusy(true);
    setError('');
    try {
      await onSave({
        date,
        status,
        closedReason: status === 'closed' ? closedReason.trim() : null,
        eventName: eventName.trim() || null,
        eventType: eventType || null,
        lineup: lineup.trim() ? lineup.split(',').map((s) => s.trim()).filter(Boolean) : null,
        notes: notes.trim() || null,
        ...(minSpend && deposit ? { eventPrice: { minSpendSatang: toSatang(minSpend), depositSatang: toSatang(deposit) } } : {}),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <div className="spread">
        <h2>{WEEKDAYS[weekdayOf(date)]} {date}</h2>
        <button type="button" className="btn small" onClick={onClose}>Close</button>
      </div>
      <div className="row wrap">
        <label className="row"><input type="radio" checked={status === 'open'} onChange={() => setStatus('open')} /> Open</label>
        <label className="row"><input type="radio" checked={status === 'closed'} onChange={() => setStatus('closed')} /> Closed</label>
      </div>
      {status === 'closed' ? (
        <div className="field">
          <label htmlFor="n-reason">Why closed</label>
          <select id="n-reason" className="input" value={closedReason} onChange={(e) => setClosedReason(e.target.value)}>
            <option value="">Choose…</option>
            {CLOSED_REASONS.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
          </select>
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="n-name">Event name</label>
            <input id="n-name" className="input" value={eventName} onChange={(e) => setEventName(e.target.value)} placeholder="Leave empty for a normal night" />
          </div>
          <div className="field">
            <label htmlFor="n-type">Event type</label>
            <select id="n-type" className="input" value={eventType} onChange={(e) => setEventType(e.target.value)}>
              <option value="">None</option>
              {EVENT_TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="n-lineup">Line-up (comma separated)</label>
            <input id="n-lineup" className="input" value={lineup} onChange={(e) => setLineup(e.target.value)} />
          </div>
          <div className="row wrap">
            <div className="field">
              <label htmlFor="n-min">Event minimum spend (฿, whole club)</label>
              <input id="n-min" className="input" inputMode="decimal" value={minSpend} onChange={(e) => setMinSpend(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="n-dep">Event deposit (฿)</label>
              <input id="n-dep" className="input" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
            </div>
          </div>
          <p className="faint" style={{ margin: 0 }}>Event prices apply once the booking flow reads price rules (Track B, B9b).</p>
        </>
      )}
      <div className="field">
        <label htmlFor="n-notes">Notes</label>
        <input id="n-notes" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {error && <div className="error">{error}</div>}
      <button className="btn primary" disabled={busy} style={{ alignSelf: 'flex-start' }}>{busy ? 'Saving…' : 'Save night'}</button>
    </form>
  );
}

/**
 * The next six weeks of nights: open, closed (with the reason) and event nights. Used by the
 * staff Calendar page and the founder console's club page (spec §12.3 event calendar).
 */
export function NightsCalendar({ nightsApi, openWeekdays }: { nightsApi: NightsApi; openWeekdays?: number[] }) {
  const from = useMemo(bangkokToday, []);
  const [rows, setRows] = useState<NightRow[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const load = () => nightsApi.list(from, DAYS).then((r) => setRows(r.nights)).catch((e) => setError(e instanceof Error ? e.message : 'Could not load nights'));
  useEffect(() => { void load(); }, [from]); // eslint-disable-line react-hooks/exhaustive-deps

  const byDate = new Map((rows ?? []).map((r) => [r.date, r]));
  const dates = Array.from({ length: DAYS }, (_, i) => addDays(from, i));

  return (
    <div className="stack" style={{ gap: 16 }}>
      {error && <div className="error">{error}</div>}
      {editing && (
        <NightEditor
          key={editing}
          date={editing}
          row={byDate.get(editing)}
          onClose={() => setEditing(null)}
          onSave={async (b) => { await nightsApi.save(b); await load(); }}
        />
      )}
      {!rows ? (
        <div className="muted">Loading…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
          {dates.map((d) => {
            const row = byDate.get(d);
            const usual = openWeekdays ? openWeekdays.includes(weekdayOf(d)) : true;
            const status = row?.status ?? (usual ? 'open' : 'closed');
            return (
              <button
                key={d}
                type="button"
                className="card"
                onClick={() => setEditing(d)}
                style={{ textAlign: 'left', padding: 10, opacity: status === 'closed' ? 0.65 : 1, cursor: 'pointer' }}
              >
                <div className="faint">{WEEKDAYS[weekdayOf(d)]} {d.slice(5)}</div>
                <div><span className={`chip ${status === 'closed' ? 's-cancelled' : row?.eventName ? 's-confirmed' : 's-held'}`}>{status === 'closed' ? 'Closed' : row?.eventName ? 'Event' : 'Open'}</span></div>
                {row?.eventName && <div><b>{row.eventName}</b></div>}
                {row?.closedReason && <div className="faint">{row.closedReason.replace('_', ' ')}</div>}
                {!row && !usual && <div className="faint">usual day off</div>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Staff Calendar page (manager only): close a date with a reason, create or edit event nights. */
export function Calendar() {
  const { club } = useStaff();
  const [openWeekdays, setOpenWeekdays] = useState<number[] | undefined>();
  useEffect(() => {
    api<{ settings: { openWeekdays: number[] } }>(staffPath(club, '/settings')).then((s) => setOpenWeekdays(s.settings.openWeekdays)).catch(() => setOpenWeekdays(undefined));
  }, [club]);
  const nightsApi = useMemo<NightsApi>(
    () => ({
      list: (from, days) => api<{ nights: NightRow[] }>(staffPath(club, `/nights?from=${from}&days=${days}`)),
      save: (b) => api(staffPath(club, '/nights'), { method: 'PUT', body: b }),
    }),
    [club],
  );
  return (
    <div className="stack" style={{ gap: 20, maxWidth: 960 }}>
      <h1>Calendar</h1>
      <p className="faint" style={{ margin: 0 }}>Tap a night to close it (with the reason) or to name an event, its line-up and its price. Nights you edit here are never changed by the automatic calendar.</p>
      <NightsCalendar key={club} nightsApi={nightsApi} openWeekdays={openWeekdays} />
    </div>
  );
}
