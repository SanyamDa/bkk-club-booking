import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { adminApi, type AdminClub } from '../../api';
import { errText, fmtTime, Ok } from './AdminLayout';

/** One club's health tile (§12.3 Clubs). */
export function HealthTile({ c }: { c: AdminClub }) {
  return (
    <dl className="summary" style={{ margin: 0 }}>
      <dt>LINE</dt><dd><Ok ok={c.lineConnected} yes="Connected" no="Not connected" /></dd>
      <dt>Webhook</dt><dd>{c.lineConnected ? <Ok ok={c.webhookOk} yes="Correct, on" no="Wrong or off" /> : '—'}</dd>
      <dt>LINE checked</dt><dd>{fmtTime(c.lineCheckedAt)}</dd>
      <dt>Last message in</dt><dd>{fmtTime(c.lastInboundAt)}</dd>
      <dt>Failures (24 h)</dt><dd className={c.failures24h ? 'error' : ''}>{c.failures24h ?? 0}</dd>
      <dt>Quota</dt>
      <dd className={c.quota?.warn ? 'error' : ''}>
        {c.quota ? `${c.quota.used} of ${c.quota.limit}${c.quota.warn ? ' (80%+)' : ''}` : '—'}
      </dd>
      <dt>Handoffs past timeout</dt><dd className={c.handoffsPastTimeout ? 'error' : ''}>{c.handoffsPastTimeout ?? 0}</dd>
      <dt>Slips to review</dt><dd>{c.depositsInReview ?? 0}</dd>
      <dt>Staff alert group</dt><dd>{c.staffGroupLinked === false ? <span className="error">No alert reaches a phone</span> : <Ok ok={c.staffGroupLinked} yes="Linked" />}</dd>
      <dt>Bot</dt><dd>{c.botPaused ? <span className="chip s-payment_review">Paused</span> : <span className="chip s-confirmed">Running</span>}</dd>
    </dl>
  );
}

export function Clubs() {
  const navigate = useNavigate();
  const [clubs, setClubs] = useState<AdminClub[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [template, setTemplate] = useState<'blank' | 'velora-like'>('blank');
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState('');

  const load = () => adminApi.clubs().then((d) => setClubs(d.clubs)).catch((e) => setError(errText(e)));
  useEffect(() => { void load(); }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setCreateError('');
    try {
      await adminApi.createClub({ name: name.trim(), slug: slug.trim(), template });
      navigate(`/admin/clubs/${slug.trim()}`);
    } catch (err) {
      setCreateError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <h1>Clubs</h1>
      {error && <div className="error">{error}</div>}
      {!clubs ? (
        <div className="muted">Loading…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
          {clubs.map((c) => (
            <Link key={c.slug} to={`/admin/clubs/${c.slug}`} className="card stack" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="spread">
                <h2>{c.name}</h2>
                <span className="chip">{c.status}</span>
              </div>
              <HealthTile c={c} />
            </Link>
          ))}
          {clubs.length === 0 && <div className="muted">No clubs yet.</div>}
        </div>
      )}
      <form className="card stack" style={{ maxWidth: 520 }} onSubmit={create}>
        <h2>Create a club</h2>
        <div className="field">
          <label htmlFor="cname">Name</label>
          <input id="cname" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="cslug">Slug (lowercase, used in links)</label>
          <input id="cslug" className="input mono" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
        </div>
        <div className="field">
          <label htmlFor="ctpl">Template</label>
          <select id="ctpl" className="input" value={template} onChange={(e) => setTemplate(e.target.value as 'blank' | 'velora-like')}>
            <option value="blank">Blank (no zones, tables or prices)</option>
            <option value="velora-like">Velora-like (demo zones, tables and prices)</option>
          </select>
        </div>
        <p className="faint" style={{ margin: 0 }}>The club starts as onboarding.</p>
        {createError && <div className="error">{createError}</div>}
        <button className="btn primary" disabled={busy || !name.trim() || slug.length < 2}>{busy ? 'Creating…' : 'Create club'}</button>
      </form>
    </div>
  );
}
