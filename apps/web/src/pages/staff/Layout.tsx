import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useOutletContext } from 'react-router-dom';
import { api, ApiError, staffPath, storedSupport } from '../../api';
import { SupportBanner } from '../admin/SupportBanner';

interface StaffCtx {
  club: string;
  clubName: string;
  handoffCount: number;
  setHandoffCount: (n: number) => void;
}

export const useStaff = () => useOutletContext<StaffCtx>();

export function StaffLayout() {
  const navigate = useNavigate();
  const [clubs, setClubs] = useState<{ slug: string; name: string }[] | null>(null);
  const [club, setClub] = useState<string>(() => localStorage.getItem('club') ?? '');
  const [handoffCount, setHandoffCount] = useState(0);

  useEffect(() => {
    api<{ clubs: { slug: string; name: string }[] }>('/api/auth/me')
      .then((d) => {
        // A founder under a support session sees that club too (A6); the server checks the grant.
        const support = storedSupport().filter((s) => !d.clubs.some((c) => c.slug === s.clubSlug)).map((s) => ({ slug: s.clubSlug, name: s.clubName }));
        const all = [...d.clubs, ...support];
        setClubs(all);
        if (!all.some((c) => c.slug === club)) setClub(all[0]?.slug ?? '');
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) navigate('/staff/login', { replace: true });
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (club) localStorage.setItem('club', club);
  }, [club]);

  // Keep the handoff badge fresh on every page.
  useEffect(() => {
    if (!club) return;
    const load = () =>
      api<{ handoffs: unknown[] }>(staffPath(club, '/handoffs'))
        .then((d) => setHandoffCount(d.handoffs.length))
        .catch(() => {});
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [club]);

  if (!clubs || !club) return <div className="staff muted">Loading…</div>;
  const clubName = clubs.find((c) => c.slug === club)?.name ?? club;

  async function logout() {
    await api('/api/auth/logout', { body: {} });
    navigate('/staff/login');
  }

  return (
    <div className="staff">
      <header className="topbar">
        <div className="row">
          <div className="brand">Club<span>·</span>Booking</div>
          {clubs.length > 1 ? (
            <select className="input" style={{ minHeight: 34, width: 'auto' }} value={club} onChange={(e) => setClub(e.target.value)} aria-label="Club">
              {clubs.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </select>
          ) : (
            <span className="muted">{clubName}</span>
          )}
        </div>
        <nav className="nav" aria-label="Dashboard">
          <NavLink to="/staff" end>Tonight</NavLink>
          <NavLink to="/staff/handoffs">
            Chats{handoffCount > 0 && <span className="badge">{handoffCount}</span>}
          </NavLink>
          <NavLink to="/staff/feed">Alerts</NavLink>
          <NavLink to="/staff/new">New booking</NavLink>
          <NavLink to="/staff/pos">POS import</NavLink>
          <NavLink to="/staff/calendar">Calendar</NavLink>
          <NavLink to="/staff/settings">Setup</NavLink>
          <NavLink to="/staff/team">Team</NavLink>
          <button className="btn small" onClick={logout}>Log out</button>
        </nav>
      </header>
      <SupportBanner club={club} />
      <Outlet context={{ club, clubName, handoffCount, setHandoffCount } satisfies StaffCtx} />
    </div>
  );
}
