import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { auditLog, bookings, conversations, guests, tables, zones } from '../db/schema.js';
import { formatBaht, newId } from '../lib/util.js';
import { ChatwootError, chatwootConversationRef, chatwootState, InboxNotProvisioned, inboxSsoUrl, type ChatwootRole } from '../integrations/chatwoot/provision.js';
import { requireClubRole, type AuthEnv } from './auth.js';
import type { AppContext } from './context.js';

/**
 * Inbox routes (spec §6.3, plan A13), mounted by `staffRoutes`:
 * - `GET /clubs/:slug/inbox-sso`: a Chatwoot single sign-on link into this club's account only.
 *   Owners and managers become Chatwoot administrators, hosts agents. A platform user under a
 *   write-mode support grant gets an agent login and one audit row (spec §13); a read-only grant
 *   is 403 `support_read_only` (an agent can message guests). The login is revoked when the grant
 *   ends or expires (`sweepGrantInboxUsers`), and a member's when they are disabled or change role.
 * - `GET /clubs/:slug/inbox-panel?account=<chatwoot account id>&conversation=<chatwoot conversation id>`:
 *   the booking panel shown beside a Chatwoot conversation. The account must be this club's and the
 *   conversation must be this club's (`conversations.external_ref = cw:<account>:<conversation>`),
 *   otherwise 404.
 */
export function staffInboxRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const { db } = app.deps;
  const inboxUsers = requireClubRole(app, 'owner', 'manager', 'host');

  r.get('/clubs/:slug/inbox-sso', inboxUsers, async (c) => {
    const cw = app.chatwoot;
    if (!cw) return c.json({ error: 'inbox_not_configured' }, 503);
    const club = c.var.club;
    const grant = c.var.supportGrant;
    // A Chatwoot agent can reply to guests: a read-only grant gets no inbox login (spec §13).
    if (grant && grant.mode !== 'write') return c.json({ error: 'support_read_only' }, 403);
    const memberRole = c.var.membership?.role;
    const role: ChatwootRole = !grant && (memberRole === 'owner' || memberRole === 'manager') ? 'administrator' : 'agent';
    const now = app.deps.now();
    try {
      const url = await inboxSsoUrl(db, cw, club, { id: c.var.user.id, name: c.var.user.name ?? c.var.user.email }, role, now, grant?.id ?? null);
      if (grant) {
        await db.insert(auditLog).values({
          id: newId(),
          clubId: club.id,
          actor: 'platform',
          actorType: 'platform',
          actorId: c.var.user.id,
          sessionId: c.var.session.idHash,
          supportGrantId: grant.id,
          action: 'inbox.sso_opened',
          entity: 'clubs',
          entityId: club.id,
          at: now,
        });
      }
      return c.json({ url });
    } catch (err) {
      if (err instanceof InboxNotProvisioned) return c.json({ error: 'inbox_not_provisioned' }, 409);
      if (err instanceof ChatwootError) {
        app.deps.log('Chatwoot SSO failed', err);
        return c.json({ error: 'inbox_unavailable' }, 502);
      }
      throw err;
    }
  });

  r.get('/clubs/:slug/inbox-panel', inboxUsers, async (c) => {
    const club = c.var.club;
    const account = c.req.query('account') ?? '';
    const conversation = c.req.query('conversation') ?? '';
    if (!/^\d+$/.test(account) || !/^\d+$/.test(conversation)) return c.json({ error: 'bad_request' }, 400);
    const state = await chatwootState(db, club.id);
    if (!state?.accountId || String(state.accountId) !== account) return c.json({ error: 'not_found' }, 404);
    const [conv] = await db
      .select({ id: conversations.id, mode: conversations.mode, guestId: conversations.guestId, guestName: guests.displayName })
      .from(conversations)
      .innerJoin(guests, eq(guests.id, conversations.guestId))
      .where(and(eq(conversations.clubId, club.id), eq(conversations.externalRef, chatwootConversationRef(account, conversation))))
      .limit(1);
    if (!conv) return c.json({ error: 'not_found' }, 404);
    const rows = await db
      .select({ booking: bookings, table: tables.code, zone: zones.name })
      .from(bookings)
      .innerJoin(tables, eq(tables.id, bookings.tableId))
      .innerJoin(zones, eq(zones.id, tables.zoneId))
      .where(and(eq(bookings.clubId, club.id), eq(bookings.guestId, conv.guestId)))
      .orderBy(desc(bookings.nightDate), desc(bookings.createdAt))
      .limit(20);
    return c.json({
      conversation: { id: conv.id, mode: conv.mode, guestName: conv.guestName },
      bookings: rows.map(({ booking: b, table, zone }) => ({
        id: b.id,
        ref: b.refCode,
        status: b.status,
        nightDate: b.nightDate,
        pax: b.pax,
        table,
        zone,
        minSpend: formatBaht(b.minSpendSatang),
        deposit: formatBaht(b.depositSatang),
        holdExpiresAt: b.holdExpiresAt?.toISOString() ?? null,
      })),
    });
  });

  return r;
}
