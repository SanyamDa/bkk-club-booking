import { Fragment, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { adminApi } from '../../api';
import { errText, fmtTime, Json } from './AdminLayout';

const PAGE = 50;

/** Every webhook delivery we received for the club, raw, with its processing result. */
export function WebhookLog() {
  const { slug = '' } = useParams();
  const [rows, setRows] = useState<any[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [replays, setReplays] = useState<Record<string, unknown>>({});
  const [error, setError] = useState('');
  const [more, setMore] = useState(true);

  const load = async (before?: string) => {
    try {
      const { webhooks } = await adminApi.webhooks(slug, { limit: PAGE, before });
      setRows((r) => (before && r ? [...r, ...webhooks] : webhooks));
      setMore(webhooks.length === PAGE);
    } catch (e) {
      setError(errText(e));
      setRows((r) => r ?? []);
    }
  };
  useEffect(() => { void load(); }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  async function replay(id: string) {
    try {
      const r = await adminApi.replay(slug, id);
      setReplays((m) => ({ ...m, [id]: r }));
    } catch (e) {
      setReplays((m) => ({ ...m, [id]: { error: errText(e) } }));
    }
  }

  const last = rows?.[rows.length - 1];
  return (
    <div className="stack">
      <div className="spread wrap">
        <h1>Webhook log · <span className="mono">{slug}</span></h1>
        <Link className="btn small" to={`/admin/clubs/${slug}`}>Back to club</Link>
      </div>
      {error && <div className="error">{error}</div>}
      {!rows ? (
        <div className="muted">Loading…</div>
      ) : (
        <div className="scroll-x">
          <table className="list">
            <thead>
              <tr><th>Received</th><th>Result</th><th>Error</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <Fragment key={w.id}>
                  <tr>
                    <td>{fmtTime(w.receivedAt ?? w.createdAt)}</td>
                    <td><span className="chip">{w.status ?? w.result ?? (w.processedAt ? 'processed' : 'pending')}</span></td>
                    <td className="error">{w.error ?? ''}</td>
                    <td className="row">
                      <button className="btn small" onClick={() => setOpen(open === w.id ? null : w.id)}>{open === w.id ? 'Hide' : 'Raw'}</button>
                      <button className="btn small" onClick={() => replay(w.id)}>Dry-run replay</button>
                    </td>
                  </tr>
                  {(open === w.id || replays[w.id] !== undefined) && (
                    <tr>
                      <td colSpan={4}>
                        {open === w.id && <Json value={w.body ?? w.raw ?? w} />}
                        {replays[w.id] !== undefined && (
                          <div>
                            <b>Dry run (nothing sent)</b>
                            <Json value={replays[w.id]} />
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="muted">No deliveries yet.</div>}
        </div>
      )}
      {rows && more && last && (
        <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => load(String(last.receivedAt ?? last.createdAt ?? last.id))}>Older</button>
      )}
    </div>
  );
}
