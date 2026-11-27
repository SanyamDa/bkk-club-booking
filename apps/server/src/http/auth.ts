import { AsyncLocalStorage } from 'node:async_hooks';
import { and, asc, eq, gt, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { Actor } from '../bookings/service.js';
import { bangkokParts } from '../lib/time.js';
import { newId } from '../lib/util.js';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  auditLog,
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
    /**
     * Who acts: `{ type: 'staff', id, sessionId }`, or `{ type: 'platform', id, sessionId, supportGrantId }`
     * under a support grant (and for platform admins). Pass it to the booking service.
     */
    actor: Actor;
  };
};

/** HTTP methods that change something; under a support grant they need mode `write` (spec §12.3). */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Per-request state for support grants. `requireUser` opens it so that `checkClubAccess` (which
 * gets no request context) can still refuse a read-only write, audit the request and set the banner.
 */
type GrantScope = {
  c: Context<AuthEnv>;
  grant?: SupportGrant;
  club?: Club;
  audited: boolean;
  readOnlyRefused: boolean;
};
const grantScope = new AsyncLocalStorage<GrantScope>();

const ENTITY_SEGMENTS = /\/(bookings|conversations|deposits|guests|webhooks|messages|tables|zones)\/([^/]+)/g;

/** Entity ids named in the path (`/bookings/<id>` and the like) plus the route params. */
function entityIdsOf(c: Context): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const m of c.req.path.matchAll(ENTITY_SEGMENTS)) ids[m[1]!.replace(/s$/, '')] = decodeURIComponent(m[2]!);
  for (const [k, v] of Object.entries(c.req.param() as Record<string, string>)) if (k !== 'slug' && v) ids[k] = v;
  return ids;
}

/**
 * `X-Support-Session` value: `<club name>, ends <HH:MM>` (Bangkok time) for the dashboard banner,
 * percent-encoded with `encodeURIComponent` (header values must be ByteStrings, and a Thai club
 * name is not). The web app decodes it with `decodeURIComponent`.
 */
export function supportSessionHeader(club: Club, grant: SupportGrant): string {
  const p = bangkokParts(grant.expiresAt);
  return encodeURIComponent(`${club.name}, ends ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`);
}

/**
 * Applies a support grant to the current request: sets the platform actor, writes the one
 * `audit_log` row for the request (views included), and answers whether the request may go on
 * (false for a write under a read-only grant).
 */
async function applyGrant(db: Db, scope: GrantScope, club: Club, grant: SupportGrant, now: Date): Promise<boolean> {
  const c = scope.c;
  scope.grant = grant;
  scope.club = club;
  c.set('supportGrant', grant);
  c.set('actor', { type: 'platform', id: c.var.user.id, sessionId: c.var.session.idHash, supportGrantId: grant.id });
  const refused = WRITE_METHODS.has(c.req.method) && grant.mode !== 'write';
  if (!scope.audited) {
    scope.audited = true;
    const ids = entityIdsOf(c);
    const [entity, entityId] = Object.entries(ids).find(([k]) => k !== 'id') ?? (ids.id ? ['row', ids.id] : ['club', club.id]);
    await db.insert(auditLog).values({
      id: newId(),
      clubId: club.id,
      actor: 'platform',
      actorType: 'platform',
      actorId: c.var.user.id,
      sessionId: c.var.session.idHash,
      supportGrantId: grant.id,
      reason: grant.reason,
      ip: clientIp(c) ?? null,
      action: 'support.request',
      entity,
      entityId,
      data: { method: c.req.method, path: c.req.path, entityIds: ids, ...(refused ? { refused: 'support_read_only' } : {}) },
      at: now,
    });
  }
  if (refused) scope.readOnlyRefused = true;
  return !refused;
}

const readOnly = (c: Context) => c.json({ error: 'support_read_only' }, 403);

const MAX_FAILURES = 5;
const MAX_LOCK_MINUTES = 60;

/**
 * Counts one failed sign-in or second-factor check for `userId`. Atomic increment in SQL, so
 * parallel wrong guesses each count (a read-modify-write from the row read at request start would
 * let a batch of concurrent guesses all write the same count). From MAX_FAILURES on, it locks the
 * account; the lock is computed from the returned count and never moves an existing lock earlier.
 * Returns the new failure count.
 */
export async function recordAuthFailure(db: Db, userId: string, now: Date): Promise<number> {
  const [row] = await db
    .update(users)
    .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
    .where(eq(users.id, userId))
    .returning({ failures: users.failedLoginCount });
  const failures = row?.failures ?? 0;
  if (failures < MAX_FAILURES) return failures;
  const lockedUntil = new Date(now.getTime() + Math.min(2 ** (failures - MAX_FAILURES), MAX_LOCK_MINUTES) * 60_000);
  await db
    .update(users)
    .set({ lockedUntil })
    .where(and(eq(users.id, userId), or(isNull(users.lockedUntil), lt(users.lockedUntil, lockedUntil))));
  return failures;
}

export const MAX_AUTH_FAILURES = MAX_FAILURES;

export const clientIp = (c: Context): string | undefined => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || undefined;

/** Loads the session from the `sid` cookie; 401 without a live one. Sets `c.var.user` and `c.var.session`. */
export function requireUser(app: AppContext): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const sid = getCookie(c, SESSION_COOKIE);
    const found = sid ? await loadSession(app.deps.db, sid, app.deps.now()) : null;
    if (!found) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', found.user);
    c.set('session', found.session);
    if (!c.var.supportGrant) {
      c.set('actor', {
        type: found.user.platformRole === 'admin' ? 'platform' : 'staff',
        id: found.user.id,
        sessionId: found.session.idHash,
      });
    }
    if (grantScope.getStore()) return next();
    const scope: GrantScope = { c, audited: false, readOnlyRefused: false };
    await grantScope.run(scope, next);
    // A route addressed by row id learns of the grant in `checkClubAccess`; its refusal and banner land here.
    if (scope.readOnlyRefused) c.res = readOnly(c);
    if (scope.grant && scope.club) {
      // The banner is cosmetic: a header failure must never turn a committed write into a 500.
      try {
        c.res.headers.set('X-Support-Session', supportSessionHeader(scope.club, scope.grant));
      } catch {
        /* response headers immutable or value rejected: send the response without the banner */
      }
    }
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
      if (access.supportGrant) {
        const scope = grantScope.getStore() ?? { c, audited: false, readOnlyRefused: false };
        if (!(await applyGrant(db, scope, club, access.supportGrant, app.deps.now()))) {
          c.res = readOnly(c);
          return;
        }
      } else {
        c.set('supportGrant', null);
      }
      await next();
    });
}

/**
 * Club check for routes addressed by a row id (the club comes from the row). `not_found` when the
 * user has no membership or active support grant there (the row's existence is not revealed),
 * `forbidden` when the membership's role is not one of `roles` (any role when none are given).
 * Under a support grant the request is audited and gets the banner header; a write under a
 * read-only grant answers `forbidden` here and `requireUser` turns the response into 403 `support_read_only`.
 */
export async function checkClubAccess(
  app: AppContext,
  userId: string,
  clubId: string,
  roles: Role[] = [],
): Promise<'ok' | 'not_found' | 'forbidden'> {
  const { db } = app.deps;
  const now = app.deps.now();
  const access = await clubAccess(db, userId, clubId, now);
  if (!access) return 'not_found';
  if (access.supportGrant) {
    const scope = grantScope.getStore();
    // Outside a request (no method to check, nowhere to audit) a grant opens nothing.
    if (!scope) return 'forbidden';
    const club = await db.query.clubs.findFirst({ where: eq(clubs.id, clubId) });
    if (!club) return 'not_found';
    return (await applyGrant(db, scope, club, access.supportGrant, now)) ? 'ok' : 'forbidden';
  }
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

  const recordFailure = (user: User, now: Date) => recordAuthFailure(db, user.id, now);

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
