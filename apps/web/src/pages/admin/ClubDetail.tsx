import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { adminApi, api, saveSupport, type AdminClub, type CredentialSummary } from '../../api';
import { NightsCalendar, type NightsApi } from '../staff/Calendar';
import { errText, fmtTime } from './AdminLayout';

/** The club's event calendar, edited on its behalf (spec §12.3 Club data; plan A9). */
function EventCalendar({ slug, openWeekdays }: { slug: string; openWeekdays?: number[] }) {
  const nightsApi = useMemo<NightsApi>(() => ({ list: (from, days) => adminApi.nights(slug, from, days), save: (b) => adminApi.saveNight(slug, { ...b }) }), [slug]);
  return (
    <div className="card stack">
      <h2>Event calendar</h2>
      <p className="faint" style={{ margin: 0 }}>Close a night with its reason, or name an event night.</p>
      <NightsCalendar key={slug} nightsApi={nightsApi} openWeekdays={openWeekdays} />
      <CityDayForm />
    </div>
  );
}

/** Founder-only city calendar entry (spec §14.3; plan A9 and B13): elections and city events, for every club. */
function CityDayForm() {
  const [f, setF] = useState({ date: '', kind: 'election' as 'election' | 'city_event', name: '', notes: '' });
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMsg('');
    try {
      await adminApi.saveCalendarDay({ date: f.date, kind: f.kind, name: f.name.trim(), ...(f.notes.trim() ? { notes: f.notes.trim() } : {}) });
      setMsg(`Saved ${f.name.trim()} on ${f.date}.`);
      setF((p) => ({ ...p, name: '', notes: '' }));
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={save}>
      <h3 style={{ margin: 0 }}>City calendar day</h3>
      <p className="faint" style={{ margin: 0 }}>Elections and city events, as they are announced. Holidays and alcohol-ban days are already loaded.</p>
      <label>
        Date
        <input type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
      </label>
      <label>
        Kind
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'election' | 'city_event' })}>
          <option value="election">Election</option>
          <option value="city_event">City event (concert, festival)</option>
        </select>
      </label>
      <label>
        Name
        <input required maxLength={200} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </label>
      <label>
        Notes
        <input maxLength={1000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </label>
      <button type="submit" disabled={busy || !f.date || !f.name.trim()}>Save day</button>
      {msg && <p className="faint" style={{ margin: 0 }}>{msg}</p>}
      {error && <div className="error">{error}</div>}
    </form>
  );
}
import { HealthTile } from './Clubs';
import { ClubControls } from './Controls';

const STATUSES: AdminClub['status'][] = ['onboarding', 'live', 'paused', 'demo'];

type ProfileForm = Record<
  'capacityStanding' | 'capacitySeated' | 'lat' | 'lng' | 'district' | 'venueType' | 'genres' | 'priceBand' | 'openingHours' | 'usualPeakHour' | 'licenceType' | 'posVendor',
  string
>;
const EMPTY: ProfileForm = { capacityStanding: '', capacitySeated: '', lat: '', lng: '', district: '', venueType: '', genres: '', priceBand: '', openingHours: '', usualPeakHour: '', licenceType: '', posVendor: '' };
const LABELS: Record<keyof ProfileForm, string> = {
  capacityStanding: 'Capacity standing',
  capacitySeated: 'Capacity seated',
  lat: 'Latitude',
  lng: 'Longitude',
  district: 'District',
  venueType: 'Venue type',
  genres: 'Music genres (comma separated)',
  priceBand: 'Price band',
  openingHours: 'Opening hours (JSON, e.g. {"wed":"21:00-02:00"})',
  usualPeakHour: 'Usual peak hour (0–23)',
  licenceType: 'Licence type',
  posVendor: 'POS vendor',
};
const NUMERIC = new Set<keyof ProfileForm>(['capacityStanding', 'capacitySeated', 'lat', 'lng', 'usualPeakHour']);

function toForm(p: Record<string, unknown> | null | undefined): ProfileForm {
  if (!p) return EMPTY;
  const f = { ...EMPTY };
  for (const k of Object.keys(EMPTY) as (keyof ProfileForm)[]) {
    const v = p[k];
    if (v == null) continue;
    f[k] = k === 'genres' && Array.isArray(v) ? v.join(', ') : k === 'openingHours' ? JSON.stringify(v) : String(v);
  }
  return f;
}

function ProfileEditor({ slug, initial }: { slug: string; initial: Record<string, unknown> | null | undefined }) {
  const [f, setF] = useState<ProfileForm>(() => toForm(initial));
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(toForm(initial)), [initial]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMsg('');
    try {
      const body: Record<string, unknown> = {};
      for (const k of Object.keys(f) as (keyof ProfileForm)[]) {
        const v = f[k].trim();
        if (!v) { body[k] = null; continue; }
        if (NUMERIC.has(k)) body[k] = Number(v);
        else if (k === 'genres') body[k] = v.split(',').map((s) => s.trim()).filter(Boolean);
        else if (k === 'openingHours') body[k] = JSON.parse(v);
        else body[k] = v;
      }
      await adminApi.putProfile(slug, body);
      setMsg('Profile saved.');
    } catch (err) {
      setError(err instanceof SyntaxError ? 'Opening hours is not valid JSON.' : errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={save}>
      <h2>Club profile</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {(Object.keys(LABELS) as (keyof ProfileForm)[]).map((k) => (
          <div className="field" key={k}>
            <label htmlFor={`p-${k}`}>{LABELS[k]}</label>
            <input id={`p-${k}`} className="input" inputMode={NUMERIC.has(k) ? 'decimal' : undefined} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </div>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="faint">{msg}</div>}
      <button className="btn primary" disabled={busy} style={{ alignSelf: 'flex-start' }}>{busy ? 'Saving…' : 'Save profile'}</button>
    </form>
  );
}

function SupportStart({ club }: { club: AdminClub }) {
  const navigate = useNavigate();
  const [reason, setReason] = useState('');
  const [ticketRef, setTicketRef] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const g = await adminApi.startSupport({ clubSlug: club.slug, reason: reason.trim(), ...(ticketRef.trim() ? { ticketRef: ticketRef.trim() } : {}) });
      saveSupport({ id: g.id, clubSlug: club.slug, clubName: club.name, mode: g.mode ?? 'read', expiresAt: g.expiresAt });
      try { localStorage.setItem('club', club.slug); } catch { /* ignore */ }
      navigate('/staff');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={start}>
      <h2>Open the club's dashboard</h2>
      <p className="faint" style={{ margin: 0 }}>Starts a read-only support session for this club only. It ends after 60 minutes. Every view is written to the audit log.</p>
      <div className="field">
        <label htmlFor="s-reason">Reason</label>
        <input id="s-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="s-ticket">Ticket reference (optional)</label>
        <input id="s-ticket" className="input" value={ticketRef} onChange={(e) => setTicketRef(e.target.value)} />
      </div>
      {error && <div className="error">{error}</div>}
      <button className="btn primary" disabled={busy || !reason.trim()} style={{ alignSelf: 'flex-start' }}>Start support session</button>
    </form>
  );
}

/** Demo controls (spec §12.4): one-click reset and fast-forward for one booking. Demo clubs only. */
function DemoControls({ slug }: { slug: string }) {
  const [what, setWhat] = useState<'hold_expiry' | 'reminder' | 'release'>('hold_expiry');
  const [bookingId, setBookingId] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError('');
    setMsg('');
    try {
      setMsg(await fn());
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  const reset = () =>
    run(async () => {
      if (!window.confirm('Reset the demo club? Everything from the last demo is cleared.')) return '';
      const r = await api<{ nightDate: string }>(`/api/admin/demo/${encodeURIComponent(slug)}/reset`, { body: {} });
      return `Reset done. Tonight is ${r.nightDate}.`;
    });
  const fastForward = () =>
    run(async () => {
      const r = await api<{ booking: { refCode: string; status: string } }>(`/api/admin/demo/${encodeURIComponent(slug)}/fast-forward`, {
        body: { what, bookingId: bookingId.trim() },
      });
      return `Booking ${r.booking.refCode} is now ${r.booking.status}.`;
    });

  return (
    <div className="card stack">
      <h2>Demo controls</h2>
      <button className="btn primary" disabled={busy} style={{ alignSelf: 'flex-start' }} onClick={reset}>Reset demo</button>
      <div className="row wrap">
        <select className="input" style={{ width: 'auto', minHeight: 34 }} value={what} onChange={(e) => setWhat(e.target.value as typeof what)} aria-label="Fast-forward to">
          <option value="hold_expiry">Hold expires</option>
          <option value="reminder">Reminder sends</option>
          <option value="release">Release time</option>
        </select>
        <input className="input mono" style={{ width: 220, minHeight: 34 }} placeholder="booking id" value={bookingId} onChange={(e) => setBookingId(e.target.value)} aria-label="Booking id" />
        <button className="btn small" disabled={busy || !bookingId.trim()} onClick={fastForward}>Fast-forward</button>
      </div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="faint">{msg}</div>}
    </div>
  );
}

function TimelineJump({ slug }: { slug: string }) {
  const navigate = useNavigate();
  const [kind, setKind] = useState<'conversations' | 'bookings'>('conversations');
  const [id, setId] = useState('');
  return (
    <form className="row wrap" onSubmit={(e) => { e.preventDefault(); if (id.trim()) navigate(`/admin/clubs/${slug}/${kind}/${encodeURIComponent(id.trim())}`); }}>
      <select className="input" style={{ width: 'auto', minHeight: 34 }} value={kind} onChange={(e) => setKind(e.target.value as 'conversations' | 'bookings')} aria-label="Timeline kind">
        <option value="conversations">Conversation</option>
        <option value="bookings">Booking</option>
      </select>
      <input className="input mono" style={{ width: 240, minHeight: 34 }} placeholder="id" value={id} onChange={(e) => setId(e.target.value)} aria-label="Timeline id" />
      <button className="btn small" disabled={!id.trim()}>Open timeline</button>
    </form>
  );
}

export function ClubDetail() {
  const { slug = '' } = useParams();
  const [club, setClub] = useState<AdminClub | null>(null);
  const [profile, setProfile] = useState<Record<string, unknown> | null | undefined>(undefined);
  const [creds, setCreds] = useState<CredentialSummary[]>([]);
  const [openWeekdays, setOpenWeekdays] = useState<number[] | undefined>();
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');

  const load = async () => {
    try {
      const { clubs } = await adminApi.clubs();
      setClub(clubs.find((c) => c.slug === slug) ?? null);
      if (!clubs.some((c) => c.slug === slug)) setError('No such club.');
    } catch (e) {
      setError(errText(e));
    }
    // Optional detail route; the profile form starts empty without it.
    adminApi.club(slug).then((d) => {
      setProfile(d.profile ?? null);
      setCreds(d.credentials ?? []);
      setOpenWeekdays((d as { settings?: { openWeekdays?: number[] } }).settings?.openWeekdays);
    }).catch(() => setProfile(null));
  };
  useEffect(() => { void load(); }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  async function changeStatus(status: AdminClub['status']) {
    setStatusError('');
    try {
      await adminApi.setStatus(slug, status);
      await load();
    } catch (e) {
      setStatusError(errText(e));
    }
  }

  if (error) return <div className="error">{error}</div>;
  if (!club) return <div className="muted">Loading…</div>;

  return (
    <div className="split">
      <div className="main stack" style={{ gap: 20 }}>
        <div className="spread wrap">
          <h1>{club.name} <span className="faint mono">{club.slug}</span></h1>
          <div className="row wrap">
            <Link className="btn small primary" to={`/admin/clubs/${slug}/line`}>LINE wizard</Link>
            <Link className="btn small" to={`/admin/clubs/${slug}/webhooks`}>Webhook log</Link>
            <Link className="btn small" to={`/admin/clubs/${slug}/messages`}>Message log</Link>
            <Link className="btn small" to={`/admin/events?club=${slug}`}>Events</Link>
          </div>
        </div>
        <div className="card stack">
          <div className="spread wrap">
            <h2>Health</h2>
            <label className="row faint">
              Status
              <select className="input" style={{ width: 'auto', minHeight: 34 }} value={club.status} onChange={(e) => changeStatus(e.target.value as AdminClub['status'])}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          </div>
          {statusError && <div className="error">{statusError}</div>}
          <HealthTile c={club} />
          {creds.length > 0 && (
            <div className="stack" style={{ gap: 4 }}>
              <b>Credentials</b>
              {creds.map((c) => (
                <div key={c.kind} className="faint">{c.kind}: ••••{c.last4}, set by {c.setBy}, {fmtTime(c.setAt)}</div>
              ))}
            </div>
          )}
          <TimelineJump slug={slug} />
        </div>
        {profile !== undefined && <ProfileEditor slug={slug} initial={profile} />}
        <EventCalendar slug={slug} openWeekdays={openWeekdays} />
      </div>
      <div className="side stack" style={{ gap: 20 }}>
        <SupportStart club={club} />
        {club.status === 'demo' && <DemoControls slug={slug} />}
        <ClubControls club={club} onChange={load} />
      </div>
    </div>
  );
}
