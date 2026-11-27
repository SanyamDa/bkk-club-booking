import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi, forgetSupport, saveSupport, storedSupport, useSupportHeader } from '../../api';
import { errText } from './AdminLayout';

/**
 * Banner shown on the staff dashboard while a founder works under a support session.
 * It appears when a club response carries X-Support-Session ("<club name>, ends <HH:MM>").
 */
export function SupportBanner({ club }: { club: string }) {
  const navigate = useNavigate();
  const header = useSupportHeader();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!header) return null;
  const session = storedSupport().find((s) => s.clubSlug === club);

  async function end() {
    if (!session) return;
    setBusy(true);
    setError('');
    try {
      await adminApi.endSupport(session.id);
      forgetSupport(session.id);
      navigate(`/admin/clubs/${club}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function elevate() {
    if (!session) return;
    const reason = window.prompt('Reason for making changes on the club’s behalf');
    if (!reason?.trim()) return;
    setBusy(true);
    setError('');
    try {
      await adminApi.elevateSupport(session.id, reason.trim());
      saveSupport({ ...session, mode: 'write' });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      className="spread wrap"
      style={{ background: '#2a1f10', border: '1px solid var(--warn)', borderRadius: 10, padding: '8px 12px', marginBottom: 16, color: 'var(--warn)' }}
    >
      <b>Support access: {header}</b>
      <div className="row wrap">
        {session?.mode === 'read' && <span className="faint">Read-only</span>}
        {session?.mode === 'read' && <button className="btn small" disabled={busy} onClick={elevate}>Allow changes</button>}
        {session && <button className="btn small danger" disabled={busy} onClick={end}>End now</button>}
        {error && <span className="error">{error}</span>}
      </div>
    </div>
  );
}
