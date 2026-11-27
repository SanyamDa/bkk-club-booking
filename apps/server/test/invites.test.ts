import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { auditLog, clubMemberships, events, invites, sessions, supportGrants, users, type Club } from '../src/db/schema.js';
import type { Db } from '../src/db/client.js';
import { newId } from '../src/lib/util.js';
import { inviteTokenHash } from '../src/platform/invites.js';
import { FRIDAY_AFTERNOON, setupTwoClubs } from './helpers.js';
import { loginAs, makeUser, staffUrl, testConfig } from './helpers/track-a.js';

let db: Db;
let close: () => Promise<void>;
let clubA: Club;
let clubB: Club;
let clock: Date;
let app: ReturnType<typeof createApp>;
const config = testConfig();

beforeEach(async () => {
  ({ db, close, clubA, clubB } = await setupTwoClubs());
  clock = FRIDAY_AFTERNOON;
  app = createApp(config, db, { bot: { now: () => clock, log: () => {} } });
});
afterEach(async () => {
  await close();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonResponse = Omit<Response, 'json'> & { json(): Promise<any> };

async function req(method: string, path: string, cookie?: string, body?: unknown): Promise<JsonResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return app.app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const cookieOf = (res: JsonResponse) => res.headers.get('set-cookie')!.split(';')[0]!;
const tokenOf = (link: string) => new URL(link).hash.slice(1);

async function signIn(email: string, role: 'owner' | 'manager' | 'host' | 'door' = 'manager', club: Club = clubA) {
  const u = await makeUser(db, { email, clubId: club.id, role });
  return { user: u, cookie: await loginAs(app, u) };
}

async function invite(cookie: string, body: Record<string, unknown>, club: Club = clubA) {
  return req('POST', staffUrl(club.slug, '/team/invites'), cookie, body);
}

describe('staff invites (A8)', () => {
  it('invite accepted creates membership with the role', async () => {
    const { cookie } = await signIn('manager@test.local');
    const res = await invite(cookie, { email: 'New.Host@Test.local', role: 'host' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invite).toMatchObject({ email: 'new.host@test.local', role: 'host' });
    expect(body.link).toMatch(/\/invite#/);

    const accept = await req('POST', '/api/auth/invites/accept', undefined, {
      token: tokenOf(body.link),
      name: 'New Host',
      password: 'a-long-password',
    });
    expect(accept.status).toBe(200);
    expect(await accept.json()).toMatchObject({ ok: true, club: { slug: clubA.slug }, role: 'host' });

    const [user] = await db.select().from(users).where(eq(users.email, 'new.host@test.local'));
    const [m] = await db.select().from(clubMemberships).where(eq(clubMemberships.userId, user!.id));
    expect(m).toMatchObject({ clubId: clubA.id, role: 'host' });

    // The accept response signs the new person in.
    const me = await req('GET', '/api/auth/me', cookieOf(accept));
    expect((await me.json()).clubs).toEqual([{ slug: clubA.slug, name: clubA.name, role: 'host' }]);
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, 'team.invite_accepted'));
    expect(audit).toHaveLength(1);
  });

  it('invite token is stored only as a hash and works once', async () => {
    const { cookie } = await signIn('manager@test.local');
    const body = await (await invite(cookie, { email: 'once@test.local', role: 'door' })).json();
    const token = tokenOf(body.link);
    const [row] = await db.select().from(invites).where(eq(invites.id, body.invite.id));
    expect(row!.tokenHash).toBe(inviteTokenHash(config.APP_SECRET, token));
    expect(row!.tokenHash).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token);

    const first = await req('POST', '/api/auth/invites/accept', undefined, { token, name: 'Once', password: 'a-long-password' });
    expect(first.status).toBe(200);
    const second = await req('POST', '/api/auth/invites/accept', undefined, { token, name: 'Once', password: 'a-long-password' });
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: 'invalid_invite' });
  });

  it('expired invite is refused', async () => {
    const { cookie } = await signIn('manager@test.local');
    const body = await (await invite(cookie, { email: 'late@test.local', role: 'host' })).json();
    clock = new Date(FRIDAY_AFTERNOON.getTime() + 8 * 86_400_000);
    const res = await req('POST', '/api/auth/invites/accept', undefined, { token: tokenOf(body.link), name: 'Late', password: 'a-long-password' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_invite' });
  });

  it('revoked invite cannot be accepted', async () => {
    const { cookie } = await signIn('manager@test.local');
    const body = await (await invite(cookie, { email: 'revoked@test.local', role: 'host' })).json();
    const del = await req('DELETE', staffUrl(clubA.slug, `/team/invites/${body.invite.id}`), cookie, {});
    expect(del.status).toBe(200);
    const res = await req('POST', '/api/auth/invites/accept', undefined, { token: tokenOf(body.link), name: 'R', password: 'a-long-password' });
    expect(res.status).toBe(400);
    const team = await (await req('GET', staffUrl(clubA.slug, '/team'), cookie)).json();
    expect(team.invites).toEqual([]);
  });

  it("invite for an existing account needs that account's password", async () => {
    const other = await makeUser(db, { email: 'two-clubs@test.local', clubId: clubB.id, role: 'owner' });
    const { cookie } = await signIn('manager@test.local');
    const body = await (await invite(cookie, { email: 'two-clubs@test.local', role: 'manager' })).json();
    const token = tokenOf(body.link);

    const preview = await req('POST', '/api/auth/invites/preview', undefined, { token });
    const shown = await preview.json();
    expect(shown).toMatchObject({ club: { name: clubA.name }, email: 'two-clubs@test.local', role: 'manager' });
    expect(shown).not.toHaveProperty('hasAccount');
    // A short password gets the same answer as for a new account.
    const short = await req('POST', '/api/auth/invites/accept', undefined, { token, password: 'short' });
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: 'weak_password' });

    const wrong = await req('POST', '/api/auth/invites/accept', undefined, { token, password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'invalid_login' });
    const ok = await req('POST', '/api/auth/invites/accept', undefined, { token, password: other.password });
    expect(ok.status).toBe(200);
    const rows = await db.select().from(clubMemberships).where(eq(clubMemberships.userId, other.id));
    expect(rows.map((r) => [r.clubId, r.role]).sort()).toEqual([[clubA.id, 'manager'], [clubB.id, 'owner']].sort());
  });

  it('new account needs a password of at least 10 characters', async () => {
    const { cookie } = await signIn('manager@test.local');
    const body = await (await invite(cookie, { email: 'short@test.local', role: 'host' })).json();
    const res = await req('POST', '/api/auth/invites/accept', undefined, { token: tokenOf(body.link), name: 'S', password: 'short' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'weak_password' });
    // The invite is still usable.
    const ok = await req('POST', '/api/auth/invites/accept', undefined, { token: tokenOf(body.link), name: 'S', password: 'long-enough-pw' });
    expect(ok.status).toBe(200);
  });

  it('LINE invite returns a LINE share link', async () => {
    const { cookie } = await signIn('manager@test.local');
    const res = await invite(cookie, { email: 'line@test.local', role: 'host', via: 'line' });
    const body = await res.json();
    expect(body.lineShareUrl).toMatch(/^https:\/\/line\.me\/R\/share\?text=/);
    expect(decodeURIComponent(body.lineShareUrl)).toContain(body.link);
  });

  it('host cannot invite (owner or manager only)', async () => {
    const { cookie } = await signIn('host@test.local', 'host');
    const res = await invite(cookie, { email: 'x@test.local', role: 'host' });
    expect(res.status).toBe(403);
    expect((await req('GET', staffUrl(clubA.slug, '/team'), cookie)).status).toBe(403);
  });

  it('manager cannot invite or set an owner', async () => {
    const { cookie } = await signIn('manager@test.local');
    const res = await invite(cookie, { email: 'boss@test.local', role: 'owner' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden_role' });

    const host = await makeUser(db, { email: 'h@test.local', clubId: clubA.id, role: 'host' });
    const set = await req('PATCH', staffUrl(clubA.slug, `/team/members/${host.id}`), cookie, { role: 'owner' });
    expect(set.status).toBe(403);
    const owner = await makeUser(db, { email: 'o@test.local', clubId: clubA.id, role: 'owner' });
    const demote = await req('PATCH', staffUrl(clubA.slug, `/team/members/${owner.id}`), cookie, { role: 'host' });
    expect(demote.status).toBe(403);
  });

  it('set role changes the membership role', async () => {
    const { cookie } = await signIn('owner@test.local', 'owner');
    const host = await makeUser(db, { email: 'h@test.local', clubId: clubA.id, role: 'host' });
    const res = await req('PATCH', staffUrl(clubA.slug, `/team/members/${host.id}`), cookie, { role: 'manager' });
    expect(res.status).toBe(200);
    const [m] = await db.select().from(clubMemberships).where(eq(clubMemberships.userId, host.id));
    expect(m!.role).toBe('manager');
    const team = await (await req('GET', staffUrl(clubA.slug, '/team'), cookie)).json();
    expect(team.members.find((x: { userId: string }) => x.userId === host.id)).toMatchObject({ role: 'manager', email: 'h@test.local' });
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, 'team.role_changed'));
    expect(audit[0]).toMatchObject({ clubId: clubA.id, entityId: host.id, before: { role: 'host' }, after: { role: 'manager' } });
  });

  it('nobody changes their own role, and the last owner cannot be demoted', async () => {
    const { user, cookie } = await signIn('owner@test.local', 'owner');
    const self = await req('PATCH', staffUrl(clubA.slug, `/team/members/${user.id}`), cookie, { role: 'host' });
    expect(self.status).toBe(400);
    expect(await self.json()).toEqual({ error: 'self' });

    // A founder under a write support session (no membership) still cannot remove the only owner.
    const admin = await makeUser(db, { email: 'founder@test.local', platformAdmin: true });
    await db.insert(supportGrants).values({
      id: newId(),
      userId: admin.id,
      clubId: clubA.id,
      reason: 'onboarding',
      mode: 'write',
      startedAt: clock,
      expiresAt: new Date(clock.getTime() + 3_600_000),
    });
    const founder = await loginAs(app, admin);
    const demote = await req('PATCH', staffUrl(clubA.slug, `/team/members/${user.id}`), founder, { role: 'manager' });
    expect(demote.status).toBe(400);
    expect(await demote.json()).toEqual({ error: 'last_owner' });
    const disable = await req('POST', staffUrl(clubA.slug, `/team/members/${user.id}/disable`), founder, {});
    expect(disable.status).toBe(400);
    // With a second owner, the founder may demote the first.
    await makeUser(db, { email: 'owner2@test.local', clubId: clubA.id, role: 'owner' });
    expect((await req('PATCH', staffUrl(clubA.slug, `/team/members/${user.id}`), founder, { role: 'manager' })).status).toBe(200);
  });

  it("disabled user's sessions revoked", async () => {
    const { cookie } = await signIn('manager@test.local');
    const host = await makeUser(db, { email: 'h@test.local', clubId: clubA.id, role: 'host' });
    const hostCookie = await loginAs(app, host);
    const hostCookie2 = await loginAs(app, host);
    expect((await req('GET', staffUrl(clubA.slug, '/night'), hostCookie)).status).toBe(200);

    const res = await req('POST', staffUrl(clubA.slug, `/team/members/${host.id}/disable`), cookie, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sessionsRevoked: 2, accountDisabled: true });

    const live = await db.select().from(sessions).where(and(eq(sessions.userId, host.id), isNull(sessions.revokedAt)));
    expect(live).toHaveLength(0);
    expect((await req('GET', staffUrl(clubA.slug, '/night'), hostCookie)).status).toBe(401);
    expect((await req('GET', '/api/auth/me', hostCookie2)).status).toBe(401);
    const login = await req('POST', '/api/auth/login', undefined, { email: host.email, password: host.password });
    expect(login.status).toBe(401);
    const [u] = await db.select().from(users).where(eq(users.id, host.id));
    expect(u!.disabledAt).not.toBeNull();
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, 'team.member_disabled'));
    expect(audit).toHaveLength(1);
  });

  it('disabling a member of two clubs removes only this club', async () => {
    const { cookie } = await signIn('manager@test.local');
    const both = await makeUser(db, { email: 'both@test.local', clubId: clubA.id, role: 'host' });
    await db.insert(clubMemberships).values({ userId: both.id, clubId: clubB.id, role: 'owner' });
    const bothCookie = await loginAs(app, both);
    const res = await req('POST', staffUrl(clubA.slug, `/team/members/${both.id}/disable`), cookie, {});
    expect(await res.json()).toMatchObject({ ok: true, sessionsRevoked: 1, accountDisabled: false });
    expect((await req('GET', '/api/auth/me', bothCookie)).status).toBe(401);
    const rows = await db.select().from(clubMemberships).where(eq(clubMemberships.userId, both.id));
    expect(rows.map((r) => r.clubId)).toEqual([clubB.id]);
    const again = await loginAs(app, both);
    expect((await req('GET', staffUrl(clubB.slug, '/night'), again)).status).toBe(200);
    expect((await req('GET', staffUrl(clubA.slug, '/night'), again)).status).toBe(403);
  });

  it("another club's member id answers 404 on own slug", async () => {
    const { cookie } = await signIn('manager@test.local');
    const b = await makeUser(db, { email: 'b@test.local', clubId: clubB.id, role: 'host' });
    expect((await req('PATCH', staffUrl(clubA.slug, `/team/members/${b.id}`), cookie, { role: 'door' })).status).toBe(404);
    expect((await req('POST', staffUrl(clubA.slug, `/team/members/${b.id}/disable`), cookie, {})).status).toBe(404);
    const [m] = await db.select().from(clubMemberships).where(eq(clubMemberships.userId, b.id));
    expect(m!.role).toBe('host');
  });

  it('accepting as a platform admin adds the membership but needs a normal login (TOTP)', async () => {
    const admin = await makeUser(db, { email: 'founder@test.local', platformAdmin: true });
    const { cookie } = await signIn('owner@test.local', 'owner');
    const body = await (await invite(cookie, { email: admin.email, role: 'owner' })).json();
    const res = await req('POST', '/api/auth/invites/accept', undefined, { token: tokenOf(body.link), password: admin.password });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, loginRequired: true });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('team changes emit staff.invited, staff.invite_accepted, staff.role_changed and staff.disabled', async () => {
    const { user: manager, cookie } = await signIn('manager@test.local');
    const body = await (await invite(cookie, { email: 'n@test.local', role: 'host', via: 'line' })).json();
    const accept = await req('POST', '/api/auth/invites/accept', undefined, { token: tokenOf(body.link), name: 'N', password: 'a-long-password' });
    expect(accept.status).toBe(200);
    const [newUser] = await db.select().from(users).where(eq(users.email, 'n@test.local'));
    expect((await req('PATCH', staffUrl(clubA.slug, `/team/members/${newUser!.id}`), cookie, { role: 'door' })).status).toBe(200);
    expect((await req('POST', staffUrl(clubA.slug, `/team/members/${newUser!.id}/disable`), cookie, {})).status).toBe(200);

    const rows = await db.select().from(events).where(eq(events.clubId, clubA.id));
    const of = (type: string) => rows.filter((r) => r.type === type);
    expect(of('staff.invited')).toEqual([expect.objectContaining({ actorType: 'staff', actorId: manager.id, props: { inviteId: body.invite.id, role: 'host', via: 'line' } })]);
    expect(of('staff.invite_accepted')).toEqual([expect.objectContaining({ actorId: newUser!.id, props: { inviteId: body.invite.id, role: 'host' } })]);
    expect(of('staff.role_changed')).toEqual([expect.objectContaining({ props: { from: 'host', to: 'door' } })]);
    expect(of('staff.disabled')).toEqual([expect.objectContaining({ props: { role: 'door', sessionsRevoked: 1, accountDisabled: true } })]);
    // The email stays in audit_log; no event carries it.
    expect(JSON.stringify(rows.map((r) => r.props))).not.toContain('n@test.local');
  });
});
