import { useEffect, useState } from 'react';
import { api, ApiError, staffPath, Status } from '../../api';

interface PanelBooking {
  id: string;
  ref: string;
  status: string;
  nightDate: string;
  pax: number;
  table: string;
  zone: string;
  minSpend: string;
  deposit: string;
  holdExpiresAt: string | null;
}
interface PanelData {
  conversation: { id: string; mode: string; guestName: string | null };
  bookings: PanelBooking[];
}

/** Chatwoot's dashboard-app context message (sent after we ask with `chatwoot-dashboard-app:fetch-info`). */
interface AppContext {
  conversation?: { id?: number; account_id?: number };
}

function parseContext(raw: unknown): AppContext | null {
  try {
    const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (msg && typeof msg === 'object' && (msg as { event?: string }).event === 'appContext') return (msg as { data: AppContext }).data;
  } catch {
    // Not Chatwoot's message.
  }
  return null;
}

/**
 * Booking and table panel shown inside Chatwoot beside each conversation (spec §6.3, plan A13).
 * Chatwoot loads it as a dashboard app at `/inbox-panel?club=<slug>` and tells it which
 * conversation is open. The server answers 404 for a conversation or Chatwoot account that is not
 * this club's, and the panel then shows nothing about it.
 */
export function InboxPanel() {
  const club = new URLSearchParams(window.location.search).get('club') ?? '';
  const [ids, setIds] = useState<{ account: number; conversation: number } | null>(null);
  const [data, setData] = useState<PanelData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const ctx = parseContext(e.data);
      const conv = ctx?.conversation;
      if (conv?.id && conv.account_id) setIds({ account: conv.account_id, conversation: conv.id });
    };
    window.addEventListener('message', onMessage);
    window.parent?.postMessage('chatwoot-dashboard-app:fetch-info', '*');
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!club || !ids) return;
    setData(null);
    setError(null);
    api<PanelData>(staffPath(club, `/inbox-panel?account=${ids.account}&conversation=${ids.conversation}`))
      .then(setData)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) setError('Sign in to the staff dashboard in this browser, then reload.');
        else if (err instanceof ApiError && (err.status === 404 || err.status === 403)) setError('This conversation is not linked to a guest of this club.');
        else setError('Could not load bookings.');
      });
  }, [club, ids]);

  if (!club) return <div className="muted" style={{ padding: 12 }}>Missing club.</div>;
  if (error) return <div className="muted" style={{ padding: 12 }}>{error}</div>;
  if (!ids) return <div className="muted" style={{ padding: 12 }}>Waiting for the inbox…</div>;
  if (!data) return <div className="muted" style={{ padding: 12 }}>Loading…</div>;

  return (
    <div className="stack" style={{ gap: 12, padding: 12 }}>
      <div>
        <h2 style={{ margin: 0 }}>{data.conversation.guestName ?? 'Guest'}</h2>
        <p className="faint" style={{ margin: '4px 0 0' }}>{data.conversation.mode === 'human' ? 'A host is answering' : 'The bot is answering'}</p>
      </div>
      {data.bookings.length === 0 ? (
        <p className="muted">No bookings yet.</p>
      ) : (
        data.bookings.map((b) => (
          <a key={b.id} className="card" href={`/staff/bookings/${b.id}`} target="_blank" rel="noreferrer" style={{ display: 'block' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <b>{b.ref}</b>
              <Status status={b.status} />
            </div>
            <div className="faint">
              {b.nightDate} · {b.zone} {b.table} · {b.pax} pax
            </div>
            <div className="faint">
              Min spend {b.minSpend} · deposit {b.deposit}
            </div>
          </a>
        ))
      )}
    </div>
  );
}

/** "Open inbox" for the staff dashboard: fetches a single sign-on link into this club's Chatwoot account. */
export function OpenInboxButton({ club }: { club: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  async function open() {
    setBusy(true);
    setNote(null);
    try {
      const { url } = await api<{ url: string }>(staffPath(club, '/inbox-sso'));
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      const code = err instanceof ApiError ? err.body.error : undefined;
      setNote(code === 'inbox_not_provisioned' ? 'The inbox is not set up for this club yet.' : code === 'inbox_not_configured' ? 'The inbox is not available yet.' : 'Could not open the inbox.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <span>
      <button type="button" className="btn small" onClick={open} disabled={busy}>
        Open inbox
      </button>
      {note && <span className="faint"> {note}</span>}
    </span>
  );
}
