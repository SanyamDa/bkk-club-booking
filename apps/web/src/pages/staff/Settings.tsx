import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, staffPath } from '../../api';
import { useStaff } from './Layout';

interface SettingsData {
  name: string;
  staffGroupLinked: boolean;
  /** A new group typed a code while another group is linked; a second code there replaces it (B5). */
  staffGroupPending: boolean;
  /** §9 staff_groups: purposes with their own LINE group; the rest go to the main group. */
  staffGroups?: { purpose: StaffPurpose; linkedAt: string }[];
  lineConnected: boolean;
  webhookUrl: string;
  liffEndpoint: string;
  liffConfigured: boolean;
  promptpayConfigured: boolean;
  secondFactorEnrolled: boolean;
  settings: {
    openWeekdays: number[];
    holdMinutes: number;
    arrivalBy: string;
    bookingWindowDays: number;
    handoffTimeoutMinutes: number;
    rules: { en: string[]; th: string[] };
    greeting: { en: string; th: string };
    mapUrl: string;
    arrivalGraceMinutes?: number;
    reminderTime?: string;
    cancellationPolicy?: { en: string; th: string };
    requiredFields?: ('nationality' | 'birthDate' | 'occasion')[];
    tone?: 'formal' | 'casual';
    hostHours?: { from: string; to: string };
    afterVisitMessage?: boolean;
  };
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

  const load = () => api<LineStatus>(staffPath(club, '/line-status')).then(setStatus).catch(() => setStatus({ connected: false }));
  useEffect(() => { void load(); }, [club]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runSetup(refreshMenu: boolean) {
    setBusy(true);
    setError('');
    try {
      setReport(await api<SetupReport>(staffPath(club, '/line-setup'), { body: { refreshMenu } }));
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

/**
 * B5: "Issue link code" makes a fresh single-use code (10 minutes) and shows it once; the server
 * keeps only its hash. Replacing an already linked group needs a second code typed in the new group.
 */
type StaffPurpose = 'bookings' | 'payments' | 'handoff';
const STAFF_PURPOSES: { value: StaffPurpose; label: string }[] = [
  { value: 'bookings', label: 'Bookings (new, late, cancelled, not arrived, pre-orders)' },
  { value: 'payments', label: 'Payments (slips to check)' },
  { value: 'handoff', label: 'Guest chats (wants a host, complaints)' },
];

function StaffLinkHint({ club, pending, groups = [], onChanged }: { club: string; pending: boolean; groups?: { purpose: StaffPurpose; linkedAt: string }[]; onChanged?: () => void }) {
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | null>(null);
  const [err, setErr] = useState('');
  const [purpose, setPurpose] = useState<'' | StaffPurpose>('');
  const unlink = async (p: StaffPurpose) => {
    setErr('');
    try {
      await api(staffPath(club, `/staff-groups/${p}`), { method: 'DELETE' });
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    }
  };
  const issue = async () => {
    setErr('');
    try {
      setIssued(await api<{ code: string; expiresAt: string }>(staffPath(club, '/staff-link-code'), { method: 'POST', body: purpose ? { purpose } : {} }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    }
  };
  const until = issued ? new Date(issued.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <span className="stack" style={{ gap: 6 }}>
      <span>
        Invite the club’s LINE account to your staff group, press Issue link code, and type <code className="mono">link</code> followed by the code in the group.
        {pending && ' A new group is waiting: issue a second code and type it in that new group to move alerts there.'}
      </span>
      <span>
        <select value={purpose} onChange={(e) => setPurpose(e.target.value as '' | StaffPurpose)} aria-label="Group for">
          <option value="">Main staff group (everything)</option>
          {STAFF_PURPOSES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>{' '}
        <button className="btn" type="button" onClick={issue}>Issue link code</button>
        {issued && <> <code className="mono">link {issued.code}</code> <span className="faint">works once, until {until}</span></>}
        {err && <span className="error"> {err}</span>}
      </span>
      {groups.length > 0 && (
        <span className="stack" style={{ gap: 4 }}>
          <span className="faint">Own groups (other alerts still go to the main group):</span>
          {groups.map((g) => (
            <span key={g.purpose}>
              <b>{STAFF_PURPOSES.find((p) => p.value === g.purpose)?.label ?? g.purpose}</b>{' '}
              <span className="faint">linked {new Date(g.linkedAt).toLocaleDateString()}</span>{' '}
              <button className="btn" type="button" onClick={() => unlink(g.purpose)}>Unlink</button>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** Setup checklist, live LINE status, and the manager's club settings (plan A9). */
export function Settings() {
  const { club } = useStaff();
  const [s, setS] = useState<SettingsData | null>(null);
  const reload = () => { api<SettingsData>(staffPath(club, '/settings')).then(setS); };
  useEffect(reload, [club]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return <div className="muted">Loading…</div>;

  return (
    <div className="stack" style={{ gap: 20, maxWidth: 760 }}>
      <h1>Setup · {s.name}</h1>
      <LinePanel club={club} />
      <div className="card stack">
        <Check ok={s.lineConnected} label="LINE Messaging API connected" hint={<>Set the channel secret and access token in <code>apps/server/.env</code>, then run <code>npm run live</code>. It points LINE’s webhook here for you (currently <code>{s.webhookUrl}</code>).</>} />
        <Check ok={s.liffConfigured} label="Booking form inside LINE (LIFF)" hint={<>Create a LIFF app (endpoint <code>{s.liffEndpoint}</code>), put its ID in <code>DEMO_LIFF_ID</code> and the LINE Login channel ID/secret in <code>.env</code>, so the endpoint follows the tunnel automatically. Until then the form opens in the browser.</>} />
        <Check ok={s.staffGroupLinked} label="Staff LINE group" hint={<StaffLinkHint club={club} pending={s.staffGroupPending} groups={s.staffGroups} onChanged={reload} />} />
        <Check ok={s.promptpayConfigured} label="PromptPay deposits" hint={<>Set <code>DEMO_PROMPTPAY_ID</code> to the account deposits are paid to. Without it the bot runs in demo mode (no real QR).</>} />
      </div>
      <QuotaPanel club={club} />
      <RulesEditor club={club} settings={s.settings} onSaved={reload} />
      <PolicyEditor club={club} settings={s.settings} onSaved={reload} />
      <RichMenuEditor club={club} />
      <TablesEditor club={club} />
      {s.secondFactorEnrolled ? (
        <SensitiveEditor club={club} settings={s.settings} promptpayConfigured={s.promptpayConfigured} onSaved={reload} />
      ) : (
        <div className="card stack">
          <h2>Greeting, map and PromptPay</h2>
          <p className="faint" style={{ margin: 0 }}>Changing these needs an authenticator code, and your account has no second factor yet. Ask the platform team to make the change for you.</p>
        </div>
      )}
      <ProfileEditor club={club} />
    </div>
  );
}

/* ---------- A9 editors (spec §6.2 Settings, §11.1.4, §12.3, §14.3) ---------- */

const errText = (e: unknown) => (e instanceof ApiError ? (e.body.issues?.map((i) => `${i.field ?? ''} ${i.message}`).join('; ') || e.message) : e instanceof Error ? e.message : 'Failed');
const baht = (satang: number) => (satang / 100).toLocaleString('en-US');
const toSatang = (v: string) => Math.round(Number(v) * 100);

function useSave() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setError('');
    setMsg('');
    try {
      await fn();
      setMsg(ok);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  const status = (
    <>
      {error && <div className="error">{error}</div>}
      {msg && <div className="faint">{msg}</div>}
    </>
  );
  return { busy, run, status };
}

function QuotaPanel({ club }: { club: string }) {
  const [q, setQ] = useState<{ quota: { used: number; limit: number; pct: number; warn: boolean } | null; checkedAt: string | null } | null>(null);
  useEffect(() => { api(staffPath(club, '/quota')).then(setQ).catch(() => setQ(null)); }, [club]);
  if (!q) return null;
  const quota = q.quota;
  return (
    <div className="card stack">
      <h2>Push messages this month</h2>
      {!quota ? (
        <p className="faint" style={{ margin: 0 }}>No reading yet. Run LINE setup to read the plan quota.</p>
      ) : (
        <>
          <div>{quota.used.toLocaleString('en-US')}{quota.limit > 0 ? ` of ${quota.limit.toLocaleString('en-US')} (${quota.pct}%)` : ' (no limit)'}</div>
          {quota.limit > 0 && (
            <div style={{ height: 8, background: 'var(--line, #ddd)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, quota.pct)}%`, height: '100%', background: quota.warn ? 'var(--danger, #c33)' : 'var(--accent, #3a7)' }} />
            </div>
          )}
          {quota.warn && <div className="error">80% or more of this month’s push messages are used. Upgrade the plan in LINE OA Manager, or answer more chats in the LINE app (free).</div>}
          {q.checkedAt && <div className="faint">Read {new Date(q.checkedAt).toLocaleString()}</div>}
        </>
      )}
    </div>
  );
}

function RulesEditor({ club, settings, onSaved }: { club: string; settings: SettingsData['settings']; onSaved: () => void }) {
  const [days, setDays] = useState<number[]>(settings.openWeekdays);
  const [hold, setHold] = useState(String(settings.holdMinutes));
  const [arrivalBy, setArrivalBy] = useState(settings.arrivalBy);
  const [windowDays, setWindowDays] = useState(String(settings.bookingWindowDays));
  const [handoff, setHandoff] = useState(String(settings.handoffTimeoutMinutes));
  const [rulesEn, setRulesEn] = useState(settings.rules.en.join('\n'));
  const [rulesTh, setRulesTh] = useState(settings.rules.th.join('\n'));
  const { busy, run, status } = useSave();
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

  function save(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api(staffPath(club, '/settings'), {
        method: 'PATCH',
        body: {
          openWeekdays: [...days].sort(),
          holdMinutes: Number(hold),
          arrivalBy,
          bookingWindowDays: Number(windowDays),
          handoffTimeoutMinutes: Number(handoff),
          rules: { en: lines(rulesEn), th: lines(rulesTh) },
        },
      });
      onSaved();
    }, 'Booking rules saved.');
  }

  return (
    <form className="card stack" onSubmit={save}>
      <h2>Booking rules</h2>
      <div className="row wrap">
        {DAYS.map((d, i) => (
          <label key={d} className="row">
            <input type="checkbox" checked={days.includes(i)} onChange={(e) => setDays(e.target.checked ? [...days, i] : days.filter((x) => x !== i))} /> {d}
          </label>
        ))}
      </div>
      <div className="row wrap">
        <div className="field"><label htmlFor="r-hold">Hold time (min)</label><input id="r-hold" className="input" inputMode="numeric" value={hold} onChange={(e) => setHold(e.target.value)} /></div>
        <div className="field"><label htmlFor="r-arr">Arrive by</label><input id="r-arr" className="input" value={arrivalBy} onChange={(e) => setArrivalBy(e.target.value)} placeholder="23:30" /></div>
        <div className="field"><label htmlFor="r-win">Booking window (days)</label><input id="r-win" className="input" inputMode="numeric" value={windowDays} onChange={(e) => setWindowDays(e.target.value)} /></div>
        <div className="field"><label htmlFor="r-ho">Handoff timeout (min)</label><input id="r-ho" className="input" inputMode="numeric" value={handoff} onChange={(e) => setHandoff(e.target.value)} /></div>
      </div>
      <div className="field"><label htmlFor="r-en">Rules (English, one per line)</label><textarea id="r-en" className="input" rows={4} value={rulesEn} onChange={(e) => setRulesEn(e.target.value)} /></div>
      <div className="field"><label htmlFor="r-th">Rules (Thai, one per line)</label><textarea id="r-th" className="input" rows={4} value={rulesTh} onChange={(e) => setRulesTh(e.target.value)} /></div>
      <p className="faint" style={{ margin: 0 }}>Closed dates and event nights are on the Calendar page.</p>
      {status}
      <button className="btn primary" disabled={busy} style={{ alignSelf: 'flex-start' }}>{busy ? 'Saving…' : 'Save rules'}</button>
    </form>
  );
}

const GUEST_FIELDS = [['nationality', 'Nationality'], ['birthDate', 'Date of birth'], ['occasion', 'Occasion']] as const;

/** §6.2 Settings, Rules and Bot content: grace, reminder time, cancellation policy, required fields, tone, host hours, after-visit. */
function PolicyEditor({ club, settings, onSaved }: { club: string; settings: SettingsData['settings']; onSaved: () => void }) {
  const [grace, setGrace] = useState(String(settings.arrivalGraceMinutes ?? 30));
  const [reminder, setReminder] = useState(settings.reminderTime ?? '18:00');
  const [policyEn, setPolicyEn] = useState(settings.cancellationPolicy?.en ?? '');
  const [policyTh, setPolicyTh] = useState(settings.cancellationPolicy?.th ?? '');
  const [fields, setFields] = useState<string[]>(settings.requiredFields ?? ['nationality']);
  const [tone, setTone] = useState(settings.tone ?? 'formal');
  const [hostFrom, setHostFrom] = useState(settings.hostHours?.from ?? '');
  const [hostTo, setHostTo] = useState(settings.hostHours?.to ?? '');
  const [after, setAfter] = useState(Boolean(settings.afterVisitMessage));
  const { busy, run, status } = useSave();

  function save(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api(staffPath(club, '/policy'), {
        method: 'PATCH',
        body: {
          arrivalGraceMinutes: Number(grace),
          reminderTime: reminder,
          cancellationPolicy: { en: policyEn, th: policyTh },
          requiredFields: fields,
          tone,
          hostHours: hostFrom && hostTo ? { from: hostFrom, to: hostTo } : null,
          afterVisitMessage: after,
        },
      });
      onSaved();
    }, 'Policy saved.');
  }

  return (
    <form className="card stack" onSubmit={save}>
      <h2>Guest policy and bot</h2>
      <div className="row wrap">
        <div className="field"><label htmlFor="p-grace">Grace period (min)</label><input id="p-grace" className="input" inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value)} /></div>
        <div className="field"><label htmlFor="p-rem">Reminder time</label><input id="p-rem" className="input" value={reminder} onChange={(e) => setReminder(e.target.value)} placeholder="18:00" /></div>
        <div className="field"><label htmlFor="p-tone">Tone</label>
          <select id="p-tone" className="input" value={tone} onChange={(e) => setTone(e.target.value as 'formal' | 'casual')}><option value="formal">Formal (ค่ะ/ครับ)</option><option value="casual">Casual</option></select>
        </div>
        <div className="field"><label htmlFor="p-hf">Hosts online from</label><input id="p-hf" className="input" value={hostFrom} onChange={(e) => setHostFrom(e.target.value)} placeholder="18:00" /></div>
        <div className="field"><label htmlFor="p-ht">until</label><input id="p-ht" className="input" value={hostTo} onChange={(e) => setHostTo(e.target.value)} placeholder="03:00" /></div>
      </div>
      <div className="field"><label htmlFor="p-cen">Cancellation policy (English)</label><textarea id="p-cen" className="input" rows={2} value={policyEn} onChange={(e) => setPolicyEn(e.target.value)} placeholder="Empty: the first house rule is shown" /></div>
      <div className="field"><label htmlFor="p-cth">Cancellation policy (Thai)</label><textarea id="p-cth" className="input" rows={2} value={policyTh} onChange={(e) => setPolicyTh(e.target.value)} /></div>
      <div className="row wrap">
        <span className="faint">Required guest fields (name and phone always are):</span>
        {GUEST_FIELDS.map(([k, label]) => (
          <label key={k} className="row"><input type="checkbox" checked={fields.includes(k)} onChange={(e) => setFields(e.target.checked ? [...fields, k] : fields.filter((x) => x !== k))} /> {label}</label>
        ))}
      </div>
      <label className="check"><input type="checkbox" checked={after} onChange={(e) => setAfter(e.target.checked)} /><span>Send “Thanks for coming” the day after a visit (uses LINE quota)</span></label>
      {status}
      <button className="btn primary" disabled={busy} style={{ alignSelf: 'flex-start' }}>{busy ? 'Saving…' : 'Save policy'}</button>
    </form>
  );
}

interface RichMenuCellOption { id: string; en: string; th: string; available: boolean }
interface RichMenuSaved { cells: string[]; refreshed: boolean; report: { steps: { name: string; ok: boolean; detail: string }[] } | null }
/** Always in the menu: Book a table (§5.1) and the Privacy link (§5.5). */
const REQUIRED_CELLS = ['book', 'privacy'];

/** A10b (§6.2 Bot content, §11.1.1): which rich menu buttons the club shows, left to right. Saving rebuilds the menu on LINE. */
function RichMenuEditor({ club }: { club: string }) {
  const [allowed, setAllowed] = useState<RichMenuCellOption[]>([]);
  const [cells, setCells] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const { busy, run, status } = useSave();
  useEffect(() => {
    api<{ cells: string[]; allowed: RichMenuCellOption[] }>(staffPath(club, '/rich-menu'))
      .then((r) => { setAllowed(r.allowed); setCells(r.cells); })
      .catch(() => setAllowed([]));
  }, [club]);
  if (allowed.length === 0) return null;
  const label = (id: string) => allowed.find((a) => a.id === id)?.en ?? id;
  const move = (i: number, d: -1 | 1) => {
    const next = [...cells];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    setCells(next);
  };

  function save(e: FormEvent) {
    e.preventDefault();
    setNote('');
    void run(async () => {
      const r = await api<RichMenuSaved>(staffPath(club, '/rich-menu'), { method: 'PUT', body: { cells } });
      const step = r.report?.steps.find((s) => s.name === 'Rich menu');
      setNote(r.refreshed ? 'Updated in LINE.' : r.report ? `LINE update failed: ${step?.detail ?? 'run LINE setup'}` : 'It goes live when LINE is connected.');
    }, 'Menu saved.');
  }

  return (
    <form className="card stack" onSubmit={save}>
      <h2>LINE menu buttons</h2>
      <p className="faint" style={{ margin: 0 }}>Up to 6 buttons. Book a table and Privacy are always shown.</p>
      <div className="row wrap">
        {allowed.map((a) => (
          <label key={a.id} className="row" title={a.available ? a.th : 'Add a drinks menu link first'}>
            <input
              type="checkbox"
              disabled={REQUIRED_CELLS.includes(a.id) || (!a.available && !cells.includes(a.id))}
              checked={cells.includes(a.id)}
              onChange={(e) => setCells(e.target.checked ? [...cells, a.id] : cells.filter((x) => x !== a.id))}
            /> {a.en}
          </label>
        ))}
      </div>
      <ol className="stack" style={{ margin: 0, paddingLeft: 20 }}>
        {cells.map((id, i) => (
          <li key={id} className="row">
            <span style={{ minWidth: 140 }}>{label(id)}</span>
            <button type="button" className="btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${label(id)} left`}>←</button>
            <button type="button" className="btn" disabled={i === cells.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${label(id)} right`}>→</button>
          </li>
        ))}
      </ol>
      {status}
      {note && <div className="faint">{note}</div>}
      <button className="btn primary" disabled={busy || cells.length > 6} style={{ alignSelf: 'flex-start' }}>{busy ? 'Saving…' : 'Save menu'}</button>
    </form>
  );
}

interface ZoneRow { id: string; name: string; nameTh: string; sort: number; minSpendSatang: number; depositSatang: number }
interface TableRow { id: string; code: string; zoneId: string; minPax: number; maxPax: number; active: boolean }
interface PriceRuleRow { id: string; scope: 'club' | 'zone' | 'table'; scopeId: string | null; weekday: number | null; nightId: string | null; minSpendSatang: number; depositSatang: number; validFrom: string | null; validTo: string | null }

function PriceForm({ club, scope, scopeId, onSaved }: { club: string; scope: 'zone' | 'table'; scopeId: string; onSaved: () => void }) {
  const [min, setMin] = useState('');
  const [dep, setDep] = useState('');
  const [weekday, setWeekday] = useState('');
  const { busy, run, status } = useSave();
  return (
    <form
      className="row wrap"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(staffPath(club, '/prices'), { method: 'PUT', body: { scope, scopeId, weekday: weekday === '' ? null : Number(weekday), minSpendSatang: toSatang(min), depositSatang: toSatang(dep) } });
          setMin('');
          setDep('');
          onSaved();
        }, 'Price saved from tonight on.');
      }}
    >
      <input className="input" style={{ width: 110 }} inputMode="decimal" placeholder="Min spend ฿" value={min} onChange={(e) => setMin(e.target.value)} aria-label="Minimum spend" />
      <input className="input" style={{ width: 100 }} inputMode="decimal" placeholder="Deposit ฿" value={dep} onChange={(e) => setDep(e.target.value)} aria-label="Deposit" />
      <select className="input" style={{ width: 'auto' }} value={weekday} onChange={(e) => setWeekday(e.target.value)} aria-label="Weekday">
        <option value="">Every night</option>
        {DAYS.map((d, i) => <option key={d} value={i}>{d} only</option>)}
      </select>
      <button className="btn small" disabled={busy || !min || !dep}>Set price</button>
      {status}
    </form>
  );
}

function TablesEditor({ club }: { club: string }) {
  const [data, setData] = useState<{ zones: ZoneRow[]; tables: TableRow[]; priceRules: PriceRuleRow[] } | null>(null);
  const [zone, setZone] = useState({ name: '', nameTh: '', min: '', dep: '' });
  const [table, setTable] = useState({ code: '', zoneId: '', minPax: '2', maxPax: '6' });
  const { busy, run, status } = useSave();
  const load = () => api(staffPath(club, '/tables')).then(setData).catch(() => setData(null));
  useEffect(() => { void load(); }, [club]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;

  const rulesFor = (scope: string, id: string) => data.priceRules.filter((r) => r.scope === scope && r.scopeId === id && !r.nightId);
  const ruleText = (r: PriceRuleRow) => `฿${baht(r.minSpendSatang)} / ฿${baht(r.depositSatang)}${r.weekday != null ? ` (${DAYS[r.weekday]})` : ''}${r.validTo ? ` until ${r.validTo}` : ` from ${r.validFrom}`}`;

  return (
    <div className="card stack">
      <h2>Zones, tables and prices</h2>
      <p className="faint" style={{ margin: 0 }}>A price change starts tonight; past nights keep the price they had. The booking flow uses these prices; a table with no price rule uses its zone's base price.</p>
      {data.zones.map((z) => (
        <div key={z.id} className="stack" style={{ gap: 6, borderTop: '1px solid var(--line, #eee)', paddingTop: 8 }}>
          <div className="spread wrap">
            <b>{z.name} · {z.nameTh}</b>
            <span className="faint">base ฿{baht(z.minSpendSatang)} / ฿{baht(z.depositSatang)}</span>
          </div>
          {rulesFor('zone', z.id).map((r) => <div key={r.id} className="faint">Rule: {ruleText(r)}</div>)}
          <PriceForm club={club} scope="zone" scopeId={z.id} onSaved={load} />
          {data.tables.filter((t) => t.zoneId === z.id).map((t) => (
            <div key={t.id} className="stack" style={{ gap: 4, paddingLeft: 12 }}>
              <div className="row wrap">
                <b className="mono">{t.code}</b>
                <span className="faint">{t.minPax}–{t.maxPax} pax</span>
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() => void run(async () => { await api(staffPath(club, `/tables/${t.id}`), { method: 'PATCH', body: { active: !t.active } }); await load(); }, t.active ? `${t.code} taken out.` : `${t.code} back in use.`)}
                >
                  {t.active ? 'Take out' : 'Put back'}
                </button>
              </div>
              {rulesFor('table', t.id).map((r) => <div key={r.id} className="faint">Rule: {ruleText(r)}</div>)}
              {t.active && <PriceForm club={club} scope="table" scopeId={t.id} onSaved={load} />}
            </div>
          ))}
        </div>
      ))}
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api(staffPath(club, '/zones'), { body: { name: zone.name, nameTh: zone.nameTh, minSpendSatang: toSatang(zone.min), depositSatang: toSatang(zone.dep) } });
            setZone({ name: '', nameTh: '', min: '', dep: '' });
            await load();
          }, 'Zone added.');
        }}
      >
        <input className="input" style={{ width: 120 }} placeholder="Zone name" value={zone.name} onChange={(e) => setZone({ ...zone, name: e.target.value })} aria-label="Zone name" />
        <input className="input" style={{ width: 120 }} placeholder="Thai name" value={zone.nameTh} onChange={(e) => setZone({ ...zone, nameTh: e.target.value })} aria-label="Zone Thai name" />
        <input className="input" style={{ width: 110 }} inputMode="decimal" placeholder="Min spend ฿" value={zone.min} onChange={(e) => setZone({ ...zone, min: e.target.value })} aria-label="Zone minimum spend" />
        <input className="input" style={{ width: 100 }} inputMode="decimal" placeholder="Deposit ฿" value={zone.dep} onChange={(e) => setZone({ ...zone, dep: e.target.value })} aria-label="Zone deposit" />
        <button className="btn small" disabled={busy || !zone.name || !zone.nameTh || !zone.min || !zone.dep}>Add zone</button>
      </form>
      {data.zones.length > 0 && (
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(staffPath(club, '/tables'), { body: { code: table.code, zoneId: table.zoneId || data.zones[0]!.id, minPax: Number(table.minPax), maxPax: Number(table.maxPax) } });
              setTable({ ...table, code: '' });
              await load();
            }, 'Table added.');
          }}
        >
          <input className="input mono" style={{ width: 80 }} placeholder="Code" value={table.code} onChange={(e) => setTable({ ...table, code: e.target.value })} aria-label="Table code" />
          <select className="input" style={{ width: 'auto' }} value={table.zoneId || data.zones[0]!.id} onChange={(e) => setTable({ ...table, zoneId: e.target.value })} aria-label="Table zone">
            {data.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
          <input className="input" style={{ width: 70 }} inputMode="numeric" value={table.minPax} onChange={(e) => setTable({ ...table, minPax: e.target.value })} aria-label="Minimum guests" />
          <input className="input" style={{ width: 70 }} inputMode="numeric" value={table.maxPax} onChange={(e) => setTable({ ...table, maxPax: e.target.value })} aria-label="Maximum guests" />
          <button className="btn small" disabled={busy || !table.code}>Add table</button>
        </form>
      )}
      {status}
    </div>
  );
}

/** Greeting, map link and PromptPay ID: each needs a fresh authenticator code (spec §12.3). */
function SensitiveEditor({ club, settings, promptpayConfigured, onSaved }: { club: string; settings: SettingsData['settings']; promptpayConfigured: boolean; onSaved: () => void }) {
  const [en, setEn] = useState(settings.greeting.en);
  const [th, setTh] = useState(settings.greeting.th);
  const [mapUrl, setMapUrl] = useState(settings.mapUrl);
  const [promptpayId, setPromptpayId] = useState('');
  const [promptpayName, setPromptpayName] = useState('');
  const [totp, setTotp] = useState('');
  const { busy, run, status } = useSave();

  return (
    <div className="card stack">
      <h2>Greeting, map and PromptPay</h2>
      <p className="faint" style={{ margin: 0 }}>These changes need a code from your authenticator app. The staff group is told about each one.</p>
      <div className="field"><label htmlFor="g-en">Greeting (English)</label><textarea id="g-en" className="input" rows={3} value={en} onChange={(e) => setEn(e.target.value)} /></div>
      <div className="field"><label htmlFor="g-th">Greeting (Thai)</label><textarea id="g-th" className="input" rows={3} value={th} onChange={(e) => setTh(e.target.value)} /></div>
      <div className="field"><label htmlFor="g-map">Map link</label><input id="g-map" className="input" value={mapUrl} onChange={(e) => setMapUrl(e.target.value)} /></div>
      <div className="row wrap">
        <div className="field"><label htmlFor="pp-id">New PromptPay ID {promptpayConfigured ? '(one is set)' : '(not set)'}</label><input id="pp-id" className="input mono" value={promptpayId} onChange={(e) => setPromptpayId(e.target.value)} placeholder="phone or tax ID" /></div>
        <div className="field"><label htmlFor="pp-name">Account name</label><input id="pp-name" className="input" value={promptpayName} onChange={(e) => setPromptpayName(e.target.value)} /></div>
      </div>
      <div className="field"><label htmlFor="s-totp">Authenticator code</label><input id="s-totp" className="input mono" style={{ width: 140 }} inputMode="numeric" autoComplete="one-time-code" value={totp} onChange={(e) => setTotp(e.target.value)} /></div>
      {status}
      <div className="row wrap">
        <button
          className="btn"
          disabled={busy || !totp}
          onClick={() => void run(async () => { await api(staffPath(club, '/greeting'), { method: 'PUT', body: { greeting: { en, th }, ...(mapUrl ? { mapUrl } : {}), totp } }); setTotp(''); onSaved(); }, 'Greeting saved.')}
        >
          Save greeting and map
        </button>
        <button
          className="btn primary"
          disabled={busy || !totp || !promptpayId.trim()}
          onClick={() => void run(async () => { await api(staffPath(club, '/promptpay'), { method: 'PUT', body: { promptpayId: promptpayId.trim(), ...(promptpayName.trim() ? { promptpayName: promptpayName.trim() } : {}), totp } }); setTotp(''); setPromptpayId(''); onSaved(); }, 'PromptPay ID changed.')}
        >
          Change PromptPay ID
        </button>
      </div>
    </div>
  );
}

const PROFILE_FIELDS: { key: string; label: string; kind: 'number' | 'text' | 'list' }[] = [
  { key: 'capacityStanding', label: 'Capacity standing', kind: 'number' },
  { key: 'capacitySeated', label: 'Capacity seated', kind: 'number' },
  { key: 'district', label: 'District', kind: 'text' },
  { key: 'venueType', label: 'Venue type', kind: 'text' },
  { key: 'genres', label: 'Music genres (comma separated)', kind: 'list' },
  { key: 'priceBand', label: 'Price band', kind: 'text' },
  { key: 'usualPeakHour', label: 'Usual peak hour (0–23)', kind: 'number' },
  { key: 'licenceType', label: 'Licence type', kind: 'text' },
  { key: 'posVendor', label: 'POS vendor', kind: 'text' },
];

function ProfileEditor({ club }: { club: string }) {
  const [f, setF] = useState<Record<string, string> | null>(null);
  const { busy, run, status } = useSave();
  useEffect(() => {
    api<{ profile: Record<string, unknown> | null }>(staffPath(club, '/profile'))
      .then(({ profile }) => setF(Object.fromEntries(PROFILE_FIELDS.map(({ key }) => { const v = profile?.[key]; return [key, v == null ? '' : Array.isArray(v) ? v.join(', ') : String(v)]; }))))
      .catch(() => setF(null));
  }, [club]);
  if (!f) return null;

  function save(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    for (const { key, kind } of PROFILE_FIELDS) {
      const v = f![key]!.trim();
      body[key] = !v ? null : kind === 'number' ? Number(v) : kind === 'list' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v;
    }
    void run(() => api(staffPath(club, '/profile'), { method: 'PUT', body }), 'Profile saved.');
  }

  return (
    <form className="card stack" onSubmit={save}>
      <h2>Club profile</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
        {PROFILE_FIELDS.map(({ key, label, kind }) => (
          <div className="field" key={key}>
            <label htmlFor={`cp-${key}`}>{label}</label>
            <input id={`cp-${key}`} className="input" inputMode={kind === 'number' ? 'numeric' : undefined} value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
          </div>
        ))}
      </div>
      {status}
      <button className="btn primary" disabled={busy} style={{ alignSelf: 'flex-start' }}>{busy ? 'Saving…' : 'Save profile'}</button>
    </form>
  );
}
