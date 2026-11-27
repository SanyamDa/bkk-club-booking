import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useOutletContext } from 'react-router-dom';
import { api, ApiError } from '../../api';

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
    api<{ clubs: { slug: string; name: string }[] }>('/api/staff/me')
      .then((d) => {
        setClubs(d.clubs);
        if (!d.clubs.some((c) => c.slug === club)) setClub(d.clubs[0]?.slug ?? '');
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
      api<{ handoffs: unknown[] }>(`/api/staff/clubs/${club}/handoffs`)
        .then((d) => setHandoffCount(d.handoffs.length))
        .catch(() => {});
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [club]);

  if (!clubs || !club) return <div className="staff muted">Loading…</div>;
  const clubName = clubs.find((c) => c.slug === club)?.name ?? club;

  async function logout() {
    await api('/api/staff/logout', { body: {} });
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
          <NavLink to="/staff/new">New booking</NavLink>
          <NavLink to="/staff/settings">Setup</NavLink>
          <button className="btn small" onClick={logout}>Log out</button>
        </nav>
      </header>
      <Outlet context={{ club, clubName, handoffCount, setHandoffCount } satisfies StaffCtx} />
    </div>
  );
}
