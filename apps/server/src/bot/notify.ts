import { and, eq } from 'drizzle-orm';
import { getBookingView, type Actor } from '../bookings/service.js';
import { clubs, guests, type Booking } from '../db/schema.js';
import type { GatewayRegistry } from '../line/gateway.js';
import { formatNight } from '../lib/time.js';
import type { BotDeps } from './flow.js';
import { langOf, t } from './i18n.js';
import * as M from './messages.js';

/**
 * Messages triggered by staff or by time (not by a guest message), so they go out as pushes
 * and count against the club's LINE quota (spec §11.1.4).
 * Every method takes the club id from its caller and sends nothing when the booking or guest
 * belongs to another club.
 */
export class Notifier {
  constructor(
    private deps: BotDeps,
    private gateways: GatewayRegistry,
  ) {}

  private async ctx(clubId: string, bookingId: string) {
    const view = await getBookingView(this.deps.db, { clubId, id: bookingId });
    if (!view) return null;
    const club = await this.deps.db.query.clubs.findFirst({ where: eq(clubs.id, clubId) });
    if (!club) return null;
    const gateway = await this.gateways.forClub(club, view.guest.lineUserId);
    return { view, club, gateway, lang: langOf(view.guest.lang) };
  }

  async confirmed(clubId: string, bookingId: string) {
    const c = await this.ctx(clubId, bookingId);
    if (!c) return;
    await this.deps.outbox.toGuest(c.gateway, c.club, c.view.guest, [
      M.confirmation(c.club, c.lang, c.view, this.deps.links.pass(c.view.booking)),
    ]);
    await this.deps.outbox.toStaff(c.gateway, c.club, [M.staffNewBooking(c.view, 'confirmed')]);
  }

  async rejected(clubId: string, bookingId: string) {
    const c = await this.ctx(clubId, bookingId);
    if (!c) return;
    await this.deps.outbox.toGuest(c.gateway, c.club, c.view.guest, [
      M.plain(t(c.lang, 'paymentRejected', { ref: c.view.booking.refCode })),
    ]);
  }

  /** `reasonText` is the free text shown to the guest, not a reason code. */
  async cancelled(clubId: string, bookingId: string, reasonText: string) {
    const c = await this.ctx(clubId, bookingId);
    if (!c) return;
    await this.deps.outbox.toGuest(c.gateway, c.club, c.view.guest, [
      M.plain(
        t(c.lang, 'cancelledByClub', {
          ref: c.view.booking.refCode,
          night: formatNight(c.view.booking.nightDate, c.lang),
          reason: reasonText,
        }),
      ),
    ]);
  }

  async holdExpired(booking: Booking) {
    const c = await this.ctx(booking.clubId, booking.id);
    if (!c) return;
    await this.deps.outbox.toGuest(c.gateway, c.club, c.view.guest, [
      M.plain(t(c.lang, 'holdExpired', { code: c.view.table.code, night: formatNight(booking.nightDate, c.lang) }), [
        M.quickPostback(t(c.lang, 'tryAgain'), { a: 'book' }),
      ]),
    ]);
  }

  /** B10: day-of reminder with [Running late] [Need to cancel] [Location]. A push (counts against quota). */
  async reminder(booking: Booking) {
    const c = await this.ctx(booking.clubId, booking.id);
    if (!c) return;
    await this.deps.outbox.toGuest(c.gateway, c.club, c.view.guest, [M.reminder(c.club, c.lang, c.view)]);
  }

  /** B10: the no-show job released a table; the staff group is told. */
  async noShowReleased(booking: Booking) {
    const c = await this.ctx(booking.clubId, booking.id);
    if (!c) return;
    await this.deps.outbox.toStaff(c.gateway, c.club, [M.staffNoShow(c.view)]);
  }

  /** Free-text reply typed by a host in the dashboard. */
  async hostReply(clubId: string, guestId: string, text: string, _actor: Actor) {
    const guest = await this.deps.db.query.guests.findFirst({
      where: and(eq(guests.id, guestId), eq(guests.clubId, clubId)),
    });
    if (!guest) return;
    const club = await this.deps.db.query.clubs.findFirst({ where: eq(clubs.id, clubId) });
    if (!club) return;
    const gateway = await this.gateways.forClub(club, guest.lineUserId);
    await this.deps.outbox.toGuest(gateway, club, guest, [M.plain(text)]);
  }
}
