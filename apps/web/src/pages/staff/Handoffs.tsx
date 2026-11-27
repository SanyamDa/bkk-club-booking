import { useCallback, useEffect, useState } from 'react';
import { api, staffPath } from '../../api';
import { useStaff } from './Layout';
import { MessageThread, type ThreadMessage } from './MessageThread';

interface Handoff {
  id: string;
  guestName: string;
  reason: string | null;
  requestedAt: string | null;
  messages: ThreadMessage[];
}

function ago(iso: string | null) {
  if (!iso) return '';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return min < 1 ? 'just now' : `${min} min ago`;
}

export function Handoffs() {
  const { club, setHandoffCount } = useStaff();
  const [list, setList] = useState<Handoff[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const d = await api<{ handoffs: Handoff[] }>(staffPath(club, '/handoffs'));
    setList(d.handoffs);
    setHandoffCount(d.handoffs.length);
  }, [club, setHandoffCount]);

  useEffect(() => {
    void load();
    const id = setInterval(load, 8_000);
    return () => clearInterval(id);
  }, [load]);

  async function reply(id: string) {
    const text = drafts[id]?.trim();
    if (!text) return;
    await api(staffPath(club, `/conversations/${id}/reply`), { body: { text } });
    setDrafts({ ...drafts, [id]: '' });
    setSent({ ...sent, [id]: true });
    await load();
  }

  async function resolve(id: string) {
    await api(staffPath(club, `/conversations/${id}/resolve`), { body: {} });
    await load();
  }

  if (!list) return <div className="muted">Loading…</div>;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div>
        <h1>Guests waiting for a host</h1>
        <p className="faint" style={{ margin: '4px 0 0' }}>
          The bot stays silent in these chats. Reply here or in LINE OA Manager, then tap <b>Hand back to bot</b>.
          Replies sent from here are push messages and count against the club’s LINE quota.
        </p>
      </div>
      {list.length === 0 && <p className="muted">Nobody is waiting. 🎉</p>}
      {list.map((h) => (
        <div key={h.id} className="card stack">
          <div className="spread wrap">
            <div>
              <h2>{h.guestName}</h2>
              <div className="faint">{ago(h.requestedAt)} · {h.reason}</div>
            </div>
            <button className="btn" onClick={() => resolve(h.id)}>Hand back to bot</button>
          </div>
          <MessageThread messages={h.messages} />
          <div className="row">
            <input
              className="input"
              placeholder="Type a reply to the guest…"
              value={drafts[h.id] ?? ''}
              onChange={(e) => setDrafts({ ...drafts, [h.id]: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && reply(h.id)}
              aria-label={`Reply to ${h.guestName}`}
            />
            <button className="btn primary" onClick={() => reply(h.id)} disabled={!drafts[h.id]?.trim()}>Send</button>
          </div>
          {sent[h.id] && <div className="faint">Sent.</div>}
        </div>
      ))}
    </div>
  );
}
