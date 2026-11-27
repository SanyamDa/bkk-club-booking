import { eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { auditLog, clubs, users, type MembershipRole } from '../db/schema.js';
import { newId } from '../lib/util.js';
import {
  acceptInvite,
  createInvite,
  disableMember,
  INVITE_ROLES,
  InviteError,
  listMembers,
  membershipOf,
  MIN_PASSWORD_LENGTH,
  normalEmail,
  pendingInvite,
  pendingInvites,
  revokeInvite,
  setMemberRole,
} from '../platform/invites.js';
import { dummyHash, verifyPassword } from '../platform/passwords.js';
import { createSession, SESSION_COOKIE } from '../platform/sessions.js';
import { clientIp, recordAuthFailure, requireClubRole, type AuthEnv } from './auth.js';
import type { AppContext } from './context.js';

type TeamContext = Context<AuthEnv>;

const inviteBody = z.object({
  email: z.string().trim().email().max(320),
  role: z.enum(INVITE_ROLES),
  via: z.enum(['email', 'line']).optional(),
});
const roleBody = z.object({ role: z.enum(INVITE_ROLES) });

/** The invite link: the token sits in the URL fragment, so it never reaches server logs or a Referer. */
export const inviteLink = (publicUrl: string, token: string) => `${publicUrl.replace(/\/$/, '')}/invite#${token}`;

function inviteView(i: { id: string; email: string; role: MembershipRole; expiresAt: Date; createdBy: string | null }) {
  return { id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString(), createdBy: i.createdBy };
}

async function audit(db: Db, c: TeamContext, action: string, entity: string, entityId: string, extra: { data?: unknown; before?: unknown; after?: unknown }, now: Date) {
  const actor = c.var.actor;
  await db.insert(auditLog).values({
    id: newId(),
    clubId: c.var.club.id,
    actor: actor.type,
    actorType: actor.type,
    actorId: actor.id ?? null,
    sessionId: actor.sessionId ?? null,
    supportGrantId: actor.supportGrantId ?? null,
    ip: clientIp(c) ?? null,
    action,
    entity,
    entityId,
    data: extra.data ?? null,
    before: extra.before ?? null,
    after: extra.after ?? null,
    at: now,
  });
}

/**
 * Team routes (plan A8), mounted inside `staffRoutes` so every path is `/clubs/:slug/team...`
 * and goes through `requireClubRole(app, 'owner', 'manager')`. A manager cannot invite, promote,
 * change or disable an owner; nobody changes or disables themselves; the last owner stays. A founder
 * under a write support session acts with owner rights (spec §12.3 Onboarding: "Invite staff and set roles").
 */
export function teamRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  const managers = requireClubRole(app, 'owner', 'manager');
  const isOwnerLevel = (c: TeamContext) => !c.var.membership || c.var.membership.role === 'owner';
  const inviteError = (c: TeamContext, err: unknown) => {
    if (!(err instanceof InviteError)) throw err;
    return c.json({ error: err.code }, err.code === 'not_found' ? 404 : 400);
  };

  r.get('/clubs/:slug/team', managers, async (c) => {
    const now = app.deps.now();
    const [members, pending] = await Promise.all([listMembers(db, c.var.club.id), pendingInvites(db, c.var.club.id, now)]);
    return c.json({
      members: members.map((m) => ({ ...m, lastLoginAt: m.lastLoginAt?.toISOString() ?? null, since: m.since.toISOString() })),
      invites: pending.map(inviteView),
      canManageOwners: isOwnerLevel(c),
    });
  });

  r.post('/clubs/:slug/team/invites', managers, async (c) => {
    const parsed = inviteBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) }, 400);
    const { email, role, via } = parsed.data;
    if (role === 'owner' && !isOwnerLevel(c)) return c.json({ error: 'forbidden_role' }, 403);
    const now = app.deps.now();
    const { invite, token } = await createInvite(db, app.config.APP_SECRET, { clubId: c.var.club.id, email, role, createdBy: c.var.user.id }, now);
    await audit(db, c, 'team.invite_created', 'invite', invite.id, { data: { email: invite.email, role, via: via ?? 'email' } }, now);
    const link = inviteLink(app.config.PUBLIC_URL, token);
    const text = `You're invited to join ${c.var.club.name} as ${role}. Open this link to set up your account: ${link}`;
    return c.json(
      {
        invite: inviteView(invite),
        link,
        mailtoUrl: `mailto:${encodeURIComponent(invite.email)}?subject=${encodeURIComponent(`Join ${c.var.club.name}`)}&body=${encodeURIComponent(text)}`,
        ...(via === 'line' ? { lineShareUrl: `https://line.me/R/share?text=${encodeURIComponent(text)}` } : {}),
      },
      201,
    );
  });

  r.delete('/clubs/:slug/team/invites/:id', managers, async (c) => {
    const now = app.deps.now();
    try {
      const invite = await revokeInvite(db, c.var.club.id, c.req.param('id'), now);
      await audit(db, c, 'team.invite_revoked', 'invite', invite.id, { data: { email: invite.email, role: invite.role } }, now);
      return c.json({ ok: true });
    } catch (err) {
      return inviteError(c, err);
    }
  });

  /** Shared checks for changing a member; the row is looked up before the body is read (another club's id answers 404). */
  async function guardMember(c: TeamContext) {
    const userId = c.req.param('userId')!;
    const target = await membershipOf(db, c.var.club.id, userId);
    if (!target) return { res: c.json({ error: 'not_found' }, 404) };
    if (userId === c.var.user.id) return { res: c.json({ error: 'self' }, 400) };
    if (target.role === 'owner' && !isOwnerLevel(c)) return { res: c.json({ error: 'forbidden_role' }, 403) };
    return { target };
  }

  r.patch('/clubs/:slug/team/members/:userId', managers, async (c) => {
    const g = await guardMember(c);
    if (g.res) return g.res;
    const parsed = roleBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid' }, 400);
    if (parsed.data.role === 'owner' && !isOwnerLevel(c)) return c.json({ error: 'forbidden_role' }, 403);
    const now = app.deps.now();
    try {
      const change = await setMemberRole(db, c.var.club.id, g.target.userId, parsed.data.role);
      await audit(db, c, 'team.role_changed', 'user', g.target.userId, { before: { role: change.before }, after: { role: change.after } }, now);
      return c.json({ ok: true, role: change.after });
    } catch (err) {
      return inviteError(c, err);
    }
  });

  r.post('/clubs/:slug/team/members/:userId/disable', managers, async (c) => {
    const g = await guardMember(c);
    if (g.res) return g.res;
    const now = app.deps.now();
    try {
      const out = await disableMember(db, c.var.club.id, g.target.userId, now);
      await audit(db, c, 'team.member_disabled', 'user', g.target.userId, { before: { role: out.role }, data: out }, now);
      return c.json({ ok: true, sessionsRevoked: out.sessionsRevoked, accountDisabled: out.accountDisabled });
    } catch (err) {
      return inviteError(c, err);
    }
  });

  return r;
}

const tokenBody = z.object({ token: z.string().min(1).max(200) });
const acceptBody = tokenBody.extend({ name: z.string().trim().max(100).optional(), password: z.string().min(1).max(1000) });

/**
 * Invite acceptance, mounted at /api/auth/invites (no session needed: the one-time token is the proof).
 * POST /preview { token } and POST /accept { token, name?, password }. A new person picks a password;
 * an existing account proves its password. A platform admin is not signed in by the accept (their
 * login needs TOTP), so the answer says `loginRequired`.
 *
 * Neither route says whether the email already has an account (anyone who can invite holds the
 * token, so that would let a manager probe any email): the preview has no account flag, and a
 * short password is refused with `weak_password` before any account lookup.
 */
export function inviteAcceptRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  const secret = app.config.APP_SECRET;
  const secure = app.config.PUBLIC_URL.startsWith('https://');
  const invalidInvite = (c: Context) => c.json({ error: 'invalid_invite' }, 400);
  const findUser = (email: string) => db.query.users.findFirst({ where: eq(sql`lower(${users.email})`, normalEmail(email)) });

  r.post('/preview', async (c) => {
    const parsed = tokenBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalidInvite(c);
    const invite = await pendingInvite(db, secret, parsed.data.token, app.deps.now());
    if (!invite) return invalidInvite(c);
    const club = await db.query.clubs.findFirst({ where: eq(clubs.id, invite.clubId) });
    return c.json({
      club: { name: club?.name ?? '' },
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt.toISOString(),
    });
  });

  r.post('/accept', async (c) => {
    const parsed = acceptBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalidInvite(c);
    const { token, name, password } = parsed.data;
    const now = app.deps.now();
    const invite = await pendingInvite(db, secret, token, now);
    if (!invite) return invalidInvite(c);
    // Same answer for an existing and a new account, so the length check runs before the lookup.
    if (password.length < MIN_PASSWORD_LENGTH) return c.json({ error: 'weak_password' }, 400);
    const user = await findUser(invite.email);

    let account: { userId: string } | { name: string; password: string };
    if (user?.passwordHash) {
      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok || (user.lockedUntil && user.lockedUntil > now)) {
        if (!ok) await recordAuthFailure(db, user.id, now);
        return c.json({ error: 'invalid_login' }, 401);
      }
      account = { userId: user.id };
    } else {
      if (!user) await verifyPassword(password, await dummyHash()).catch(() => false);
      account = { name: name ?? '', password };
    }

    let accepted;
    try {
      accepted = await acceptInvite(db, secret, token, account, now);
    } catch (err) {
      if (err instanceof InviteError) return c.json({ error: err.code }, 400);
      throw err;
    }
    const club = (await db.query.clubs.findFirst({ where: eq(clubs.id, accepted.clubId) }))!;
    await db.insert(auditLog).values({
      id: newId(),
      clubId: club.id,
      actor: 'staff',
      actorType: 'staff',
      actorId: accepted.userId,
      ip: clientIp(c) ?? null,
      action: 'team.invite_accepted',
      entity: 'invite',
      entityId: accepted.invite.id,
      data: { email: accepted.invite.email, role: accepted.role, createdBy: accepted.invite.createdBy },
      at: now,
    });

    const result = { ok: true, club: { slug: club.slug, name: club.name }, role: accepted.role };
    const fresh = await db.query.users.findFirst({ where: eq(users.id, accepted.userId) });
    if (fresh?.platformRole === 'admin') return c.json({ ...result, loginRequired: true });
    const session = await createSession(db, accepted.userId, { ip: clientIp(c), userAgent: c.req.header('user-agent') }, now);
    await db.update(users).set({ lastLoginAt: now, failedLoginCount: 0 }).where(eq(users.id, accepted.userId));
    setCookie(c, SESSION_COOKIE, session.sid, { httpOnly: true, sameSite: 'Lax', secure, path: '/', expires: session.expiresAt });
    return c.json({ ...result, expiresAt: session.expiresAt.toISOString() });
  });

  return r;
}
