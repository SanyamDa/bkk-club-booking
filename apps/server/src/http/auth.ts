import { and, asc, eq, gt, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  clubMemberships,
  clubs,
  supportGrants,
  users,
  type Club,
  type ClubMembership,
  type MembershipRole,
  type Session,
  type SupportGrant,
  type User,
} from '../db/schema.js';
import { emit } from '../data/events.js';
import { dummyHash, verifyPassword } from '../platform/passwords.js';
import { createSession, loadSession, revokeSession, SESSION_COOKIE } from '../platform/sessions.js';
import { base32Decode, verifyTotp } from '../platform/totp.js';
import type { AppContext } from './context.js';

export type Role = MembershipRole;

/** What the auth middleware puts on `c.var`. */
export type AuthEnv = {
  Variables: {
    user: User;
    session: Session;
    /** Set by `requireClubRole`. */
    club: Club;
    /** The user's membership of `club`, or null when access comes from a support grant. */
    membership: ClubMembership | null;
    supportGrant: SupportGrant | null;
  };
};

const MAX_FAILURES = 5;
const MAX_LOCK_MINUTES = 60;

export const clientIp = (c: Context): string | undefined => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || undefined;

/** Loads the session from the `sid` cookie; 401 without a live one. Sets `c.var.user` and `c.var.session`. */
export function requireUser(app: AppContext): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const sid = getCookie(c, SESSION_COOKIE);
    const found = sid ? await loadSession(app.deps.db, sid, app.deps.now()) : null;
    if (!found) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', found.user);
    c.set('session', found.session);
    await next();
  };
}

/** A live session of a user with `platform_role = 'admin'`; 403 for anyone else. */
export function requirePlatformAdmin(app: AppContext): MiddlewareHandler<AuthEnv> {
  const user = requireUser(app);
  return async (c, next) =>
    user(c, async () => {
      if (c.var.user.platformRole !== 'admin') {
        c.res = c.json({ error: 'forbidden' }, 403);
        return;
      }
      await next();
    });
}

/**
 * Reads `:slug`, loads the club, and allows the request when the user has one of `roles` there
 * (any role when none are given) or an active support grant for it. Sets `c.var.club`, `c.var.user`,
 * `c.var.membership` and `c.var.supportGrant`. A missing club answers 404; a club the user cannot use answers 403.
 */
export function requireClubRole(app: AppContext, ...roles: Role[]): MiddlewareHandler<AuthEnv> {
  const user = requireUser(app);
  const { db } = app.deps;
  return async (c, next) =>
    user(c, async () => {
      const slug = c.req.param('slug');
      const club = slug ? await db.query.clubs.findFirst({ where: eq(clubs.slug, slug) }) : undefined;
      const access = club ? await clubAccess(db, c.var.user.id, club.id, app.deps.now()) : null;
      const allowed =
        access && (access.supportGrant || (access.membership && (roles.length === 0 || roles.includes(access.membership.role))));
      if (!club) {
        c.res = c.json({ error: 'not_found' }, 404);
        return;
      }
      // Plan A2 ("another club's slug returns 403") and A5 (expired grant → 403): refuse before any id lookup.
      if (!access || !allowed) {
        c.res = c.json({ error: 'forbidden' }, 403);
        return;
      }
      c.set('club', club);
      c.set('membership', access.membership);
      c.set('supportGrant', access.supportGrant);
      await next();
    });
}

/**
 * Club check for routes addressed by a row id (the club comes from the row). `not_found` when the
 * user has no membership or active support grant there (the row's existence is not revealed),
 * `forbidden` when the membership's role is not one of `roles` (any role when none are given).
 */
export async function checkClubAccess(
  app: AppContext,
  userId: string,
  clubId: string,
  roles: Role[] = [],
): Promise<'ok' | 'not_found' | 'forbidden'> {
  const access = await clubAccess(app.deps.db, userId, clubId, app.deps.now());
  if (!access) return 'not_found';
  if (access.supportGrant) return 'ok';
  return roles.length === 0 || roles.includes(access.membership!.role) ? 'ok' : 'forbidden';
}

async function clubAccess(
  db: Db,
  userId: string,
  clubId: string,
  now: Date,
): Promise<{ membership: ClubMembership | null; supportGrant: SupportGrant | null } | null> {
  const [membership] = await db
    .select()
    .from(clubMemberships)
    .where(and(eq(clubMemberships.userId, userId), eq(clubMemberships.clubId, clubId)));
  if (membership) return { membership, supportGrant: null };
  const [grant] = await db
    .select()
    .from(supportGrants)
    .where(
      and(
        eq(supportGrants.userId, userId),
        eq(supportGrants.clubId, clubId),
        isNull(supportGrants.endedAt),
        gt(supportGrants.expiresAt, now),
      ),
    )
    .limit(1);
  return grant ? { membership: null, supportGrant: grant } : null;
}

/** Clubs the user is a member of (never the clubs a support grant opens). */
export async function clubsOfUser(db: Db, userId: string) {
  return db
    .select({ slug: clubs.slug, name: clubs.name, role: clubMemberships.role })
    .from(clubMemberships)
    .innerJoin(clubs, eq(clubs.id, clubMemberships.clubId))
    .where(eq(clubMemberships.userId, userId))
    .orderBy(asc(clubs.name));
}

const loginBody = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1000),
  totp: z.string().max(20).optional(),
});

/** POST /login, POST /logout, GET /me. Mounted at /api/auth. */
export function authRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  const secure = app.config.PUBLIC_URL.startsWith('https://');
  const invalid = (c: Context) => c.json({ error: 'invalid_login' }, 401);

  /**
   * Atomic increment in SQL, so parallel wrong guesses each count (a read-modify-write from the
   * row read at request start would let a batch of concurrent guesses all write the same count).
   * The lock is computed from the returned count and never moves an existing lock earlier.
   */
  async function recordFailure(user: User, now: Date) {
    const [row] = await db
      .update(users)
      .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
      .where(eq(users.id, user.id))
      .returning({ failures: users.failedLoginCount });
    const failures = row?.failures ?? 0;
    if (failures < MAX_FAILURES) return;
    const lockedUntil = new Date(now.getTime() + Math.min(2 ** (failures - MAX_FAILURES), MAX_LOCK_MINUTES) * 60_000);
    await db
      .update(users)
      .set({ lockedUntil })
      .where(and(eq(users.id, user.id), or(isNull(users.lockedUntil), lt(users.lockedUntil, lockedUntil))));
  }

  r.post('/login', async (c) => {
    const parsed = loginBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    const { email, password } = parsed.data;
    const now = app.deps.now();
    const user = await db.query.users.findFirst({ where: eq(sql`lower(${users.email})`, email.trim().toLowerCase()) });

    // Same answer for unknown email, wrong password and locked account (no account probing).
    if (!user || !user.passwordHash || user.disabledAt) {
      await verifyPassword(password, await dummyHash());
      return invalid(c);
    }
    const passwordOk = await verifyPassword(password, user.passwordHash);
    if (user.lockedUntil && user.lockedUntil > now) {
      if (!passwordOk) await recordFailure(user, now);
      return invalid(c);
    }
    if (!passwordOk) {
      await recordFailure(user, now);
      return invalid(c);
    }

    if (user.platformRole === 'admin') {
      const code = parsed.data.totp?.replace(/\s/g, '');
      if (!code) return c.json({ error: 'totp_required' }, 401);
      if (!user.totpSecret || !verifyTotp(base32Decode(user.totpSecret), code, now)) {
        await recordFailure(user, now);
        return c.json({ error: 'invalid_totp' }, 401);
      }
    }

    const memberships = await db
      .select({ club: clubs })
      .from(clubMemberships)
      .innerJoin(clubs, eq(clubs.id, clubMemberships.clubId))
      .where(eq(clubMemberships.userId, user.id));

    const session = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      // Re-check the lock on the current row, not the one read at request start: a guess that ran
      // in parallel with failures that locked the account must not get a session.
      const reset = await tx
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now })
        .where(and(eq(users.id, user.id), or(isNull(users.lockedUntil), lte(users.lockedUntil, now))))
        .returning({ id: users.id });
      if (reset.length === 0) return null;
      const s = await createSession(tx, user.id, { ip: clientIp(c), userAgent: c.req.header('user-agent') }, now);
      for (const { club } of memberships) {
        await emit(tx, {
          clubId: club.id,
          type: 'staff.login',
          occurredAt: now,
          actorType: 'staff',
          actorId: user.id,
          dataOrigin: 'first_party',
          isTest: club.status === 'demo',
        });
      }
      return s;
    });
    if (!session) return invalid(c);

    setCookie(c, SESSION_COOKIE, session.sid, {
      httpOnly: true,
      sameSite: 'Lax',
      secure,
      path: '/',
      expires: session.expiresAt,
    });
    return c.json({ ok: true, expiresAt: session.expiresAt.toISOString() });
  });

  r.post('/logout', async (c) => {
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid) await revokeSession(db, sid, app.deps.now());
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  r.get('/me', requireUser(app), async (c) => {
    const u = c.var.user;
    return c.json({
      user: { id: u.id, email: u.email, name: u.name, platformRole: u.platformRole ?? null },
      clubs: await clubsOfUser(db, u.id),
    });
  });

  return r;
}
