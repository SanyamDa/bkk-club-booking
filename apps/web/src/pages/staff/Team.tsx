import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, staffPath } from '../../api';
import { useStaff } from './Layout';

type Role = 'owner' | 'manager' | 'host' | 'door' | 'promoter';
const ROLES: Role[] = ['owner', 'manager', 'host', 'door', 'promoter'];
const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', manager: 'Manager', host: 'Host', door: 'Door', promoter: 'Promoter' };

interface Member { userId: string; email: string; name: string | null; role: Role; lastLoginAt: string | null }
interface PendingInvite { id: string; email: string; role: Role; expiresAt: string }
interface Team { members: Member[]; invites: PendingInvite[]; canManageOwners: boolean }
interface Created { link: string; mailtoUrl: string; lineShareUrl?: string; invite: PendingInvite }

const ERRORS: Record<string, string> = {
  forbidden_role: 'Only an owner can do that to an owner.',
  last_owner: 'The club needs at least one owner.',
  self: 'You cannot change your own access.',
  invalid: 'Check the email address.',
};
const message = (err: unknown) => (err instanceof ApiError ? ERRORS[err.body.error ?? ''] ?? err.message : 'Something went wrong.');

/** Staff accounts (plan A8): invite by email or LINE link, set roles, disable a person. Owners and managers only. */
export function Team() {
  const { club } = useStaff();
  const [team, setTeam] = useState<Team | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('host');
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setTeam(await api<Team>(staffPath(club, '/team')));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError(message(err));
    }
  }, [club]);

  useEffect(() => {
    void load();
  }, [load]);

  async function invite(e: FormEvent, via: 'email' | 'line') {
    e.preventDefault();
    setError('');
    setCopied(false);
    try {
      const d = await api<Created>(staffPath(club, '/team/invites'), { body: { email, role, via } });
      setCreated(d);
      setEmail('');
      await load();
    } catch (err) {
      setError(message(err));
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setError('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError(message(err));
    }
  }

  const setMemberRole = (m: Member, r: Role) => act(() => api(staffPath(club, `/team/members/${m.userId}`), { method: 'PATCH', body: { role: r } }));
  const disable = (m: Member) => {
    if (!confirm(`Remove ${m.name ?? m.email} from this club? They are signed out everywhere.`)) return;
    void act(() => api(staffPath(club, `/team/members/${m.userId}/disable`), { body: {} }));
  };
  const revoke = (i: PendingInvite) => act(() => api(staffPath(club, `/team/invites/${i.id}`), { method: 'DELETE', body: {} }));

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (forbidden) return <div className="muted">Only owners and managers can manage staff accounts.</div>;
  if (!team) return <div className="muted">{error || 'Loading…'}</div>;
  const roles = team.canManageOwners ? ROLES : ROLES.filter((r) => r !== 'owner');

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div>
        <h1>Team</h1>
        <p className="faint" style={{ margin: '4px 0 0' }}>
          Everyone signs in with their own account. An invite link works once and expires after 7 days.
        </p>
      </div>
      {error && <div className="error">{error}</div>}

      <form className="card stack" onSubmit={(e) => invite(e, 'email')}>
        <h2>Invite someone</h2>
        <div className="row wrap">
          <div className="field" style={{ flex: '2 1 220px' }}>
            <label htmlFor="invite-email">Email</label>
            <input id="invite-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field" style={{ flex: '1 1 140px' }}>
            <label htmlFor="invite-role">Role</label>
            <select id="invite-role" className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </div>
        </div>
        <div className="row wrap">
          <button className="btn primary" disabled={!email}>Invite by email</button>
          <button className="btn" type="button" disabled={!email} onClick={(e) => invite(e, 'line')}>Invite by LINE</button>
        </div>
        {created && (
          <div className="stack">
            <p className="faint" style={{ margin: 0 }}>Invite for {created.invite.email} ({ROLE_LABEL[created.invite.role]}). Send this link; it is shown only now.</p>
            <input className="input" readOnly value={created.link} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
            <div className="row wrap">
              <button className="btn small" type="button" onClick={() => copy(created.link)}>{copied ? 'Copied' : 'Copy link'}</button>
              <a className="btn small" href={created.mailtoUrl}>Open email</a>
              {created.lineShareUrl && <a className="btn small primary" href={created.lineShareUrl} target="_blank" rel="noreferrer">Send in LINE</a>}
            </div>
          </div>
        )}
      </form>

      <div className="card stack">
        <h2>Members</h2>
        {team.members.map((m) => {
          const locked = m.role === 'owner' && !team.canManageOwners;
          return (
            <div key={m.userId} className="spread wrap">
              <div>
                <div>{m.name ?? m.email}</div>
                <div className="faint">{m.email}{m.lastLoginAt ? ` · last sign-in ${new Date(m.lastLoginAt).toLocaleDateString()}` : ' · never signed in'}</div>
              </div>
              <div className="row">
                <select className="input" style={{ minHeight: 34, width: 'auto' }} value={m.role} disabled={locked} aria-label={`Role of ${m.email}`} onChange={(e) => setMemberRole(m, e.target.value as Role)}>
                  {(locked ? ROLES : roles).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
                <button className="btn small danger" disabled={locked} onClick={() => disable(m)}>Disable</button>
              </div>
            </div>
          );
        })}
      </div>

      {team.invites.length > 0 && (
        <div className="card stack">
          <h2>Pending invites</h2>
          {team.invites.map((i) => (
            <div key={i.id} className="spread wrap">
              <div>
                <div>{i.email}</div>
                <div className="faint">{ROLE_LABEL[i.role]} · expires {new Date(i.expiresAt).toLocaleDateString()}</div>
              </div>
              <button className="btn small" onClick={() => revoke(i)}>Cancel invite</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
