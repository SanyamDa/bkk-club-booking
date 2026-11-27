import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { api, ApiError, staffPath, storedSupport } from '../../api';
import { SupportBanner } from '../admin/SupportBanner';
import { OpenInboxButton } from './InboxPanel';

interface StaffCtx {
  club: string;
  clubName: string;
  handoffCount: number;
  setHandoffCount: (n: number) => void;
}

export const useStaff = () => useOutletContext<StaffCtx>();

export function StaffLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [clubs, setClubs] = useState<{ slug: string; name: string; role?: string }[] | null>(null);
  const [club, setClub] = useState<string>(() => localStorage.getItem('club') ?? '');
  const [handoffCount, setHandoffCount] = useState(0);

  useEffect(() => {
    api<{ clubs: { slug: string; name: string; role: string }[] }>('/api/auth/me')
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

  // A promoter login sees only its own promoter page (plan A20a); every other staff page is 403.
  const isPromoter = clubs?.find((c) => c.slug === club)?.role === 'promoter';
  useEffect(() => {
    if (isPromoter && pathname !== '/staff/promoters') navigate('/staff/promoters', { replace: true });
  }, [isPromoter, pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  // A door login goes straight to door mode (plan B11).
  const isDoor = clubs?.find((c) => c.slug === club)?.role === 'door';
  useEffect(() => {
    if (isDoor) navigate('/door', { replace: true });
  }, [isDoor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the handoff badge fresh on every page.
  useEffect(() => {
    if (!club || isPromoter) return;
    const load = () =>
      api<{ handoffs: unknown[] }>(staffPath(club, '/handoffs'))
        .then((d) => setHandoffCount(d.handoffs.length))
        .catch(() => {});
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [club, isPromoter]);

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
        {isPromoter ? (
        <nav className="nav" aria-label="Dashboard">
          <NavLink to="/staff/promoters">My link</NavLink>
          <button className="btn small" onClick={logout}>Log out</button>
        </nav>
        ) : (
        <nav className="nav" aria-label="Dashboard">
          <NavLink to="/staff" end>Tonight</NavLink>
          <NavLink to="/staff/handoffs">
            Chats{handoffCount > 0 && <span className="badge">{handoffCount}</span>}
          </NavLink>
          <NavLink to="/staff/feed">Alerts</NavLink>
          <NavLink to="/door">Door</NavLink>
          <NavLink to="/staff/new">New booking</NavLink>
          <NavLink to="/staff/pos">POS import</NavLink>
          <NavLink to="/staff/calendar">Calendar</NavLink>
          <NavLink to="/staff/report">Report</NavLink>
          <NavLink to="/staff/stats">Stats</NavLink>
          <NavLink to="/staff/guests">Guests</NavLink>
          <NavLink to="/staff/promoters">Promoters</NavLink>
          <NavLink to="/staff/brain">Brain</NavLink>
          <NavLink to="/staff/extras">Bottles</NavLink>
          <NavLink to="/staff/settings">Setup</NavLink>
          <NavLink to="/staff/team">Team</NavLink>
          {club && <OpenInboxButton club={club} />}
          <button className="btn small" onClick={logout}>Log out</button>
        </nav>
        )}
      </header>
      <SupportBanner club={club} />
      <Outlet context={{ club, clubName, handoffCount, setHandoffCount } satisfies StaffCtx} />
    </div>
  );
}
