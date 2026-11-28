import { useEffect, useState } from 'react';
import { adminApi, api } from '../../api';
import { errText, fmtTime, Ok } from './AdminLayout';

/** The §12.2 minute table, in the same order as the server's ONBOARDING_STEPS (plan A17). */
export const MINUTE_TABLE = [
  { step: 'login', minute: '0–1', title: 'Open the wizard; club admin logs in to LINE OA Manager', who: 'Both' },
  { step: 'messaging_api', minute: '1–4', title: 'Enable the Messaging API, own provider (permanent)', who: 'Club admin' },
  { step: 'credentials', minute: '4–5', title: 'Paste Channel ID and Channel secret', who: 'Club admin' },
  { step: 'connect', minute: '5–6', title: 'Wizard connects everything', who: 'Automatic' },
  { step: 'response_settings', minute: '6–8', title: 'Response settings', who: 'Club admin' },
  { step: 'live_test', minute: '8–10', title: 'Live test from a fresh phone', who: 'Both' },
  { step: 'staff_login', minute: '10–12', title: 'Manager and hosts log in; FAQ answers checked', who: 'Club' },
  { step: 'plan_check', minute: '12–15', title: 'Plan check and POS vendor', who: 'Both' },
  { step: 'go_live', minute: '15', title: 'Switch the club to live', who: 'Both' },
] as const;

type StepTiming = { startedAt: string | null; endedAt: string | null; durationMs: number | null };
type Checks = Record<string, boolean>;
type ApplyStep = { name: string; status: string; count?: number; detail?: string };
type OnboardingState = {
  link: { createdAt: string; expiresAt: string; expired: boolean } | null;
  submission: { submittedAt: string; data: { zones: unknown[]; tables: unknown[]; faqs: unknown[]; contact?: { name?: string; lineAdmin?: boolean; desktop?: boolean; noOtherBot?: boolean } } } | null;
  timing: { steps: Record<string, StepTiming>; appliedAt: string | null; totalMs: number | null };
  checks: Checks;
};

const base = (slug: string) => `/api/admin/clubs/${encodeURIComponent(slug)}/onboarding`;
/** A17 calls, kept here so the shared api.tsx needs no change. */
export const onboardingApi = {
  get: (slug: string) => api<OnboardingState>(base(slug)),
  link: (slug: string) => api<{ url: string; expiresAt: string }>(`${base(slug)}/link`, { body: {} }),
  apply: (slug: string) => api<{ steps: ApplyStep[] }>(`${base(slug)}/apply`, { body: {} }),
  timing: (slug: string, step: string, event: 'start' | 'end') => api<{ timing: StepTiming; totalMs: number | null }>(`${base(slug)}/timing`, { body: { step, event } }),
};

const mins = (ms: number | null | undefined) => (ms == null ? '–' : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`);

const CHECK_LABELS: [string, string][] = [
  ['formSubmitted', 'Pre-call form submitted'],
  ['tables', 'Tables loaded'],
  ['prices', 'Prices loaded'],
  ['rules', 'House rules (TH and EN)'],
  ['profile', 'Club profile'],
  ['lineConnected', 'LINE connected'],
  ['webhookOk', 'Webhook correct and active'],
  ['loginConfigured', 'Login channel and LIFF'],
  ['promptpay', 'PromptPay ID'],
  ['staffGroupLinked', 'Staff alert group (can follow the call)'],
];

/**
 * Plan A17 (spec §12.2): pre-call form link, applying the answers, live checks, the timed minute
 * table and the go-live switch (A5's PATCH status). Shown at the top of the LINE wizard.
 */
export function OnboardingPanel({ slug }: { slug: string }) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [applied, setApplied] = useState<ApplyStep[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => onboardingApi.get(slug).then(setState).catch((e) => setError(errText(e)));
  useEffect(() => {
    void load();
    const id = setInterval(load, 5000); // live checks
    return () => clearInterval(id);
  }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const makeLink = () => run(async () => setLinkUrl((await onboardingApi.link(slug)).url));
  const apply = () => run(async () => setApplied((await onboardingApi.apply(slug)).steps));
  const mark = (step: string, event: 'start' | 'end') => run(async () => void (await onboardingApi.timing(slug, step, event)));
  const goLive = () =>
    run(async () => {
      await adminApi.setStatus(slug, 'live');
      await onboardingApi.timing(slug, 'go_live', 'end');
    });

  const sub = state?.submission;
  const checks = state?.checks ?? {};
  const ready = ['tables', 'prices', 'rules', 'profile', 'lineConnected', 'loginConfigured'].every((k) => checks[k]);

  return (
    <div className="card stack">
      <div className="spread wrap">
        <h2>Onboarding</h2>
        <span className="faint">Total {mins(state?.timing.totalMs)}{state?.timing.appliedAt ? ` · form applied ${fmtTime(state.timing.appliedAt)}` : ''}</span>
      </div>

      <h3>Before the call</h3>
      <div className="row wrap">
        <button className="btn small" disabled={busy} onClick={makeLink}>{state?.link ? 'New form link (old one stops working)' : 'Make pre-call form link'}</button>
        {state?.link && <span className="faint">Link expires {fmtTime(state.link.expiresAt)}{state.link.expired ? ' (expired)' : ''}</span>}
      </div>
      {linkUrl && (
        <div className="stack" style={{ gap: 4 }}>
          <span className="mono" style={{ wordBreak: 'break-all' }}>{linkUrl}</span>
          <span className="faint">Shown once. Send it to the club now.</span>
        </div>
      )}
      {sub ? (
        <div className="stack" style={{ gap: 4 }}>
          <div className="faint">Submitted {fmtTime(sub.submittedAt)}: {sub.data.zones.length} zones, {sub.data.tables.length} tables, {sub.data.faqs.length} FAQs</div>
          {sub.data.contact && (
            <div className="faint">On the call: {sub.data.contact.name || '?'} · LINE OA admin {sub.data.contact.lineAdmin ? 'yes' : 'no'} · desktop {sub.data.contact.desktop ? 'yes' : 'no'} · no other bot {sub.data.contact.noOtherBot ? 'yes' : 'no'}</div>
          )}
          <button className="btn small primary" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={apply}>Load answers into the club</button>
        </div>
      ) : (
        <div className="faint">No form answers yet.</div>
      )}
      {applied && (
        <div className="stack" style={{ gap: 4 }}>
          {applied.map((a) => (
            <div key={a.name} className="row">
              <Ok ok={a.status === 'done' ? true : a.status === 'skipped' ? undefined : false} yes="Done" no={a.status === 'failed' ? 'Failed' : 'By hand'} />
              <span><b>{a.name}</b>{a.count != null ? ` (${a.count})` : ''}{a.detail ? ` · ${a.detail}` : ''}</span>
            </div>
          ))}
        </div>
      )}

      <h3>Live checks</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
        {CHECK_LABELS.map(([k, label]) => (
          <div key={k} className="row"><Ok ok={state ? Boolean(checks[k]) : undefined} yes="OK" no="Missing" /> <span>{label}</span></div>
        ))}
      </div>

      <h3>Minute table</h3>
      <div className="stack" style={{ gap: 6 }}>
        {MINUTE_TABLE.map((m) => {
          const t = state?.timing.steps[m.step];
          return (
            <div key={m.step} className="spread wrap" style={{ gap: 8 }}>
              <span><span className="mono faint">{m.minute}</span> {m.title} <span className="faint">· {m.who}</span></span>
              <span className="row">
                <span className="mono faint">{t?.durationMs != null ? mins(t.durationMs) : t?.startedAt ? 'running' : ''}</span>
                <button className="btn small" disabled={busy} onClick={() => mark(m.step, 'start')}>Start</button>
                <button className="btn small" disabled={busy || !t?.startedAt} onClick={() => mark(m.step, 'end')}>Done</button>
              </span>
            </div>
          );
        })}
      </div>

      <h3>Go live</h3>
      {checks.live ? (
        <span className="chip s-confirmed">Live</span>
      ) : (
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy || !ready} onClick={goLive}>Switch the club to live</button>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
