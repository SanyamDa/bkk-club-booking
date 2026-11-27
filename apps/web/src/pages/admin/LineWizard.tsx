import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { adminApi, api, ApiError, type CredentialSummary, type LineStatusAdmin, type PlanInputs, type SetupReport } from '../../api';

type RichMenuChange = { richMenuId: string; previousRichMenuId: string | null };
type MigrateResult = { greeting: { en: string; th: string }; report: SetupReport; richMenu: RichMenuChange | null };

/** A10 calls, kept here so this page does not touch the shared api.tsx. */
const migrationApi = {
  migrate: (slug: string, b: { totp: string; greeting?: { en?: string; th?: string } }) =>
    api<MigrateResult>(`/api/admin/clubs/${encodeURIComponent(slug)}/line/migrate`, { body: b }),
  rollbackMenu: (slug: string) => api<{ ok: true; richMenuId: string }>(`/api/admin/clubs/${encodeURIComponent(slug)}/line/rich-menu/rollback`, { body: {} }),
};

/**
 * Step 7 (plan A10): the club's old greeting moves into our settings (we send it from now on) and
 * the rich menu is replaced; the old menu is kept so it can be put back.
 */
function Migration({ slug }: { slug: string }) {
  const [en, setEn] = useState('');
  const [th, setTh] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<MigrateResult | null>(null);
  const [rolledBack, setRolledBack] = useState('');

  async function migrate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setRolledBack('');
    try {
      const greeting = en.trim() || th.trim() ? { ...(en.trim() ? { en: en.trim() } : {}), ...(th.trim() ? { th: th.trim() } : {}) } : undefined;
      setResult(await migrationApi.migrate(slug, { totp, ...(greeting ? { greeting } : {}) }));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 422 ? 'LINE does not let us read the greeting. Paste the club’s current greeting text above.' : errText(err));
    } finally {
      setTotp('');
      setBusy(false);
    }
  }

  async function rollback() {
    setError('');
    try {
      setRolledBack((await migrationApi.rollbackMenu(slug)).richMenuId);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? 'Nothing to roll back.' : errText(err));
    }
  }

  return (
    <form className="stack" onSubmit={migrate} autoComplete="off">
      <p className="faint" style={{ margin: 0 }}>Copy the greeting from OA Manager before switching it off. Leave both empty to read it from LINE where possible.</p>
      <div className="field">
        <label htmlFor="m-en">Current greeting (English)</label>
        <textarea id="m-en" className="input" rows={3} value={en} onChange={(e) => setEn(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="m-th">Current greeting (Thai)</label>
        <textarea id="m-th" className="input" rows={3} value={th} onChange={(e) => setTh(e.target.value)} />
      </div>
      <TotpField id="m-totp" value={totp} onChange={setTotp} />
      {error && <div className="error">{error}</div>}
      <div className="row wrap">
        <button className="btn primary" disabled={busy || totp.length !== 6}>{busy ? 'Migrating…' : 'Import greeting and replace menu'}</button>
        {result?.richMenu?.previousRichMenuId && !rolledBack && (
          <button type="button" className="btn small" onClick={rollback}>Roll back rich menu</button>
        )}
      </div>
      {result && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="faint" style={{ whiteSpace: 'pre-wrap' }}>Greeting saved. EN: {result.greeting.en}{'\n'}TH: {result.greeting.th}</div>
          {result.report.steps.filter((st) => st.name === 'Rich menu').map((st) => (
            <div key={st.name} className="row"><Ok ok={st.ok} /> <span>{st.detail}</span></div>
          ))}
          {result.richMenu && (
            <div className="faint mono">New menu {result.richMenu.richMenuId} · old menu {result.richMenu.previousRichMenuId ?? '(none)'} kept for rollback</div>
          )}
        </div>
      )}
      {rolledBack && <div className="faint">Old menu {rolledBack} is the default again.</div>}
    </form>
  );
}
import { errText, fmtTime, Ok, TotpField } from './AdminLayout';
import { OnboardingPanel } from './OnboardingPanel';

/**
 * Deep link placeholders. The exact LINE URLs and the Thai/English screenshots are added after
 * the first real Thai OA test (spec §16.1 questions 1–2).
 */
const LINKS = {
  oaManager: 'https://manager.line.biz/',
  messagingApi: 'https://manager.line.biz/',
  developers: 'https://developers.line.biz/console/',
  responseSettings: 'https://manager.line.biz/',
};

function Step({ n, minute, title, who, done, children }: { n: number; minute: string; title: string; who: string; done: boolean | undefined; children: ReactNode }) {
  return (
    <div className="card stack">
      <div className="spread wrap">
        <div className="row">
          <span className="mono faint">{n}</span>
          <h2>{title}</h2>
        </div>
        <div className="row">
          <span className="faint">min {minute} · {who}</span>
          <Ok ok={done} yes="Done" no="Not yet" />
        </div>
      </div>
      {children}
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function LineWizard() {
  const { slug = '' } = useParams();
  const [loggedIn, setLoggedIn] = useState(false);
  const [apiEnabled, setApiEnabled] = useState(false);

  // Step 3: credentials (write-only).
  const [channelId, setChannelId] = useState('');
  const [channelSecret, setChannelSecret] = useState('');
  const [ownLogin, setOwnLogin] = useState(false);
  const [loginChannelId, setLoginChannelId] = useState('');
  const [loginChannelSecret, setLoginChannelSecret] = useState('');
  const [liffId, setLiffId] = useState('');
  const [totp, setTotp] = useState('');
  const [creds, setCreds] = useState<CredentialSummary[]>([]);
  const [report, setReport] = useState<SetupReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Steps 5–6.
  const [status, setStatus] = useState<LineStatusAdmin | null>(null);
  const [autoOff, setAutoOff] = useState(false);
  const [greetingOff, setGreetingOff] = useState(false);
  const [tester, setTester] = useState<string>('');
  const [testerError, setTesterError] = useState('');
  const [liveError, setLiveError] = useState('');
  const [oneReplyOnPhone, setOneReplyOnPhone] = useState(false);
  const [plan, setPlan] = useState<PlanInputs>({ expectedBookings: 200, hostReplies: 100, staffAlerts: 50, groupSize: 5 });

  const loadStatus = () => adminApi.lineStatus(slug, plan).then(setStatus).catch(() => {});
  useEffect(() => {
    adminApi.club(slug).then((d) => setCreds(d.credentials ?? [])).catch(() => {});
    void loadStatus();
  }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll status while the manual switches or the live test are in progress.
  useEffect(() => {
    if (!report) return;
    const id = setInterval(loadStatus, 4000);
    return () => clearInterval(id);
  }, [report, plan]); // eslint-disable-line react-hooks/exhaustive-deps

  async function connect(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await adminApi.connectLine(slug, {
        channelId: channelId.trim(),
        channelSecret,
        totp,
        ...(ownLogin ? { loginChannelId: loginChannelId.trim(), loginChannelSecret, liffId: liffId.trim() } : {}),
      });
      setReport({ ok: r.ok, steps: r.steps, bot: r.bot });
      if (r.credentials) setCreds(r.credentials);
      else if (r.credential) setCreds((cs) => [...cs.filter((c) => c.kind !== r.credential!.kind), r.credential!]);
      else adminApi.club(slug).then((d) => setCreds(d.credentials ?? [])).catch(() => {});
      setChannelId('');
      setLoginChannelId('');
      setLiffId('');
      await loadStatus();
    } catch (err) {
      setError(errText(err));
    } finally {
      // Write-only: secrets and the code never stay in the page.
      setChannelSecret('');
      setLoginChannelSecret('');
      setTotp('');
      setBusy(false);
    }
  }

  async function issueTester() {
    setTesterError('');
    try {
      setTester((await adminApi.testerCode(slug)).code);
    } catch (e) {
      setTesterError(errText(e));
    }
  }

  async function startLive() {
    setLiveError('');
    try {
      await adminApi.liveTest(slug);
      await loadStatus();
    } catch (e) {
      setLiveError(errText(e));
    }
  }

  const switchesOk = status ? status.webhookActive && Boolean(status.chatMode) && autoOff && greetingOff : undefined;

  return (
    <div className="stack" style={{ gap: 16, maxWidth: 860 }}>
      <div className="spread wrap">
        <h1>LINE wizard · <span className="mono">{slug}</span></h1>
        <Link className="btn small" to={`/admin/clubs/${slug}`}>Back to club</Link>
      </div>

      <OnboardingPanel slug={slug} />

      <Step n={1} minute="0–1" title="Log in to LINE OA Manager" who="Both" done={loggedIn}>
        <p className="faint" style={{ margin: 0 }}>The club admin logs in to the club's LINE Official Account as admin, at a desktop browser.</p>
        <a href={LINKS.oaManager} target="_blank" rel="noreferrer">Open LINE OA Manager (link placeholder)</a>
        <Check label="Club admin is logged in" checked={loggedIn} onChange={setLoggedIn} />
      </Step>

      <Step n={2} minute="1–4" title="Enable the Messaging API" who="Club admin" done={apiEnabled}>
        <p className="faint" style={{ margin: 0 }}>Settings, Messaging API, Enable. Choose the club's own provider. <b>This is permanent.</b> Check no other bot tool is connected to the OA.</p>
        <a href={LINKS.messagingApi} target="_blank" rel="noreferrer">Open Messaging API settings (link placeholder)</a>
        <Check label="Messaging API enabled under the club's own provider" checked={apiEnabled} onChange={setApiEnabled} />
      </Step>

      <Step n={3} minute="4–5" title="Paste Channel ID and Channel secret" who="Club admin" done={creds.some((c) => c.kind === 'line_messaging') || undefined}>
        <a href={LINKS.developers} target="_blank" rel="noreferrer">Open LINE Developers Console, Basic settings (link placeholder)</a>
        {creds.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            {creds.map((c) => <div key={c.kind} className="faint">{c.kind}: ••••{c.last4}, set by {c.setBy}, {fmtTime(c.setAt)}</div>)}
          </div>
        )}
        <form className="stack" onSubmit={connect} autoComplete="off">
          <div className="field">
            <label htmlFor="w-id">Channel ID</label>
            <input id="w-id" className="input mono" value={channelId} onChange={(e) => setChannelId(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="w-secret">Channel secret</label>
            <input id="w-secret" className="input mono" type="password" autoComplete="new-password" value={channelSecret} onChange={(e) => setChannelSecret(e.target.value)} />
          </div>
          <Check label="This club uses its own LINE Login channel (most clubs use ours)" checked={ownLogin} onChange={setOwnLogin} />
          {ownLogin && (
            <>
              <div className="field">
                <label htmlFor="w-lid">Login channel ID</label>
                <input id="w-lid" className="input mono" value={loginChannelId} onChange={(e) => setLoginChannelId(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="w-lsecret">Login channel secret</label>
                <input id="w-lsecret" className="input mono" type="password" autoComplete="new-password" value={loginChannelSecret} onChange={(e) => setLoginChannelSecret(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="w-liff">LIFF ID</label>
                <input id="w-liff" className="input mono" value={liffId} onChange={(e) => setLiffId(e.target.value)} />
              </div>
            </>
          )}
          <TotpField id="w-totp" value={totp} onChange={setTotp} />
          {error && <div className="error">{error}</div>}
          <button
            className="btn primary"
            style={{ alignSelf: 'flex-start' }}
            disabled={busy || !channelId.trim() || !channelSecret || totp.length !== 6 || (ownLogin && (!loginChannelId.trim() || !loginChannelSecret || !liffId.trim()))}
          >
            {busy ? 'Connecting…' : 'Connect and run setup'}
          </button>
        </form>
      </Step>

      <Step n={4} minute="5–6" title="Wizard connects everything" who="Automatic" done={report ? report.ok : undefined}>
        <p className="faint" style={{ margin: 0 }}>Tokens, webhook set and tested, rich menu, message check, quota read.</p>
        {!report ? (
          <div className="faint">Runs after step 3.</div>
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            {report.bot && <div className="faint">{report.bot.displayName} · {report.bot.basicId}</div>}
            {report.steps.map((st) => (
              <div key={st.name} className="row" style={{ alignItems: 'flex-start' }}>
                <Ok ok={st.ok} />
                <div><b>{st.name}</b><div className="faint" style={{ whiteSpace: 'pre-wrap' }}>{st.detail}</div></div>
              </div>
            ))}
          </div>
        )}
      </Step>

      <Step n={5} minute="6–8" title="Response settings" who="Club admin" done={switchesOk}>
        <a href={LINKS.responseSettings} target="_blank" rel="noreferrer">Open Response settings in OA Manager (link placeholder)</a>
        <div className="row"><Ok ok={status?.webhookActive} yes="On" no="Off" /> Webhook switch (read from LINE)</div>
        <div className="row"><Ok ok={status ? Boolean(status.chatMode) : undefined} yes={status?.chatMode === 'chat' ? 'Bot + chat' : status?.chatMode === 'bot' ? 'Bot' : 'Read'} no="Unknown" /> Chat response method (read from LINE; check the hours too)</div>
        <Check label="Auto-response is off" checked={autoOff} onChange={setAutoOff} />
        <Check label="Greeting message is off" checked={greetingOff} onChange={setGreetingOff} />
        <p className="faint" style={{ margin: 0 }}>LINE does not let us read the last two; the live test confirms them.</p>
        <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => loadStatus()}>Re-check</button>
      </Step>

      <Step n={6} minute="8–15" title="Live test and plan check" who="Both" done={status ? status.liveTest === 'pass' && oneReplyOnPhone : undefined}>
        <p className="faint" style={{ margin: 0 }}>From a phone that has not added the account: add it (exactly one greeting), type the tester code, send one message.</p>
        <div className="row wrap">
          <button className="btn small" onClick={issueTester}>Show tester code</button>
          {tester && <span className="mono" style={{ fontSize: 20 }}>{tester}</span>}
        </div>
        {tester && <div className="faint">Shown once. Note it now.</div>}
        {testerError && <div className="error">{testerError}</div>}
        <div className="row wrap">
          <button className="btn small primary" onClick={startLive}>Start live test (60 s)</button>
          {status && (
            <span className={`chip ${status.liveTest === 'pass' ? 's-confirmed' : status.liveTest === 'fail' ? 's-rejected' : 's-payment_review'}`}>
              {status.liveTest === 'pass' ? 'One message, one reply' : status.liveTest === 'fail' ? 'No reply' : 'Waiting'}
            </span>
          )}
        </div>
        {liveError && <div className="error">{liveError}</div>}
        <Check label="On the phone, exactly one reply arrived (LINE's own auto-reply never reaches us)" checked={oneReplyOnPhone} onChange={setOneReplyOnPhone} />

        <h3>Plan check</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
          {([
            ['expectedBookings', 'Expected bookings / month'],
            ['hostReplies', 'Host replies / month'],
            ['staffAlerts', 'Staff alerts / month'],
            ['groupSize', 'Staff group size'],
          ] as [keyof PlanInputs, string][]).map(([k, label]) => (
            <div className="field" key={k}>
              <label htmlFor={`pc-${k}`}>{label}</label>
              <input id={`pc-${k}`} className="input" inputMode="numeric" value={plan[k]} onChange={(e) => setPlan({ ...plan, [k]: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
            </div>
          ))}
        </div>
        <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => loadStatus()}>Check plan</button>
        {status && (
          <dl className="summary" style={{ margin: 0 }}>
            <dt>Quota this month</dt>
            <dd className={status.quota.warn ? 'error' : ''}>{status.quota.used} of {status.quota.limit} ({Math.round(status.quota.pct)}%){status.quota.warn ? ' · 80% warning' : ''}</dd>
            <dt>Expected pushes / month</dt><dd>{status.planCheck.expectedMonthlyPushes}</dd>
            <dt>Plan</dt>
            <dd>{status.planCheck.recommendUpgrade ? <span className="error">Upgrade the LINE message plan</span> : <span className="chip s-confirmed">Current plan is enough</span>}</dd>
          </dl>
        )}
        <p className="faint" style={{ margin: 0 }}>When everything is green, switch the club to live on the club page.</p>
      </Step>

      <Step n={7} minute="any time" title="Greeting and rich menu migration" who="Platform" done={undefined}>
        <Migration slug={slug} />
      </Step>
    </div>
  );
}
