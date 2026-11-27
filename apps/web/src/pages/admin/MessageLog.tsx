import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { adminApi } from '../../api';
import { errText, fmtTime } from './AdminLayout';

const PAGE = 50;

/** Every message with reply or push, sent or failed, and LINE's error. */
export function MessageLog() {
  const { slug = '' } = useParams();
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(true);

  const load = async (before?: string) => {
    try {
      const { messages } = await adminApi.messages(slug, { limit: PAGE, before });
      setRows((r) => (before && r ? [...r, ...messages] : messages));
      setMore(messages.length === PAGE);
    } catch (e) {
      setError(errText(e));
      setRows((r) => r ?? []);
    }
  };
  useEffect(() => { void load(); }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const last = rows?.[rows.length - 1];
  return (
    <div className="stack">
      <div className="spread wrap">
        <h1>Message log · <span className="mono">{slug}</span></h1>
        <Link className="btn small" to={`/admin/clubs/${slug}`}>Back to club</Link>
      </div>
      {error && <div className="error">{error}</div>}
      {!rows ? (
        <div className="muted">Loading…</div>
      ) : (
        <div className="scroll-x">
          <table className="list">
            <thead>
              <tr><th>Time</th><th>Dir</th><th>Sent via</th><th>Status</th><th>Text</th><th>LINE error</th><th>Trace</th></tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td>{fmtTime(m.createdAt ?? m.sentAt)}</td>
                  <td>{m.direction ?? ''}</td>
                  <td>{m.sentVia ?? ''}{m.target ? ` (${m.target})` : ''}</td>
                  <td>
                    <span className={`chip ${m.deliveryStatus === 'failed' ? 's-rejected' : m.deliveryStatus === 'sent' ? 's-confirmed' : ''}`}>{m.deliveryStatus ?? '—'}</span>
                  </td>
                  <td style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.payload?.text ?? m.payload?.message?.text ?? m.payload?.postback?.data ?? m.kind ?? ''}</td>
                  <td className="error">{typeof m.error === 'string' ? m.error : m.error ? JSON.stringify(m.error) : ''}</td>
                  <td>{m.conversationId ? <Link className="mono" to={`/admin/clubs/${slug}/conversations/${m.conversationId}`}>open</Link> : m.guestId ? <Link to={`/admin/events?club=${slug}&guest=${m.guestId}`}>guest events</Link> : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="muted">No messages yet.</div>}
        </div>
      )}
      {rows && more && last && (
        <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => load(String(last.createdAt ?? last.id))}>Older</button>
      )}
    </div>
  );
}
