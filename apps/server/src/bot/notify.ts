import { eq } from 'drizzle-orm';
import { getBookingView } from '../bookings/service.js';
import { clubs, guests, type Booking } from '../db/schema.js';
import type { GatewayRegistry } from '../line/gateway.js';
import { formatNight } from '../lib/time.js';
import type { BotDeps } from './flow.js';
import { langOf, t } from './i18n.js';
import * as M from './messages.js';

/**
 * Messages triggered by staff or by time (not by a guest message), so they go out as pushes
 * and count against the club's LINE quota (spec §11.1.4).
 */
export class Notifier {
  constructor(
    private deps: BotDeps,
    private gateways: GatewayRegistry,
  ) {}

  private async ctx(bookingId: string) {
    const view = await getBookingView(this.deps.db, { id: bookingId });
    if (!view) return null;
    const club = (await this.deps.db.query.clubs.findFirst({ where: eq(clubs.id, view.booking.clubId) }))!;
    return { view, club, gateway: this.gateways.forClub(club, view.guest.lineUserId), lang: langOf(view.guest.lang) };
  }

  async confirmed(bookingId: string) {
    const c = await this.ctx(bookingId);
    if (!c) return;
    await this.deps.outbox.toGuest(c.gateway, c.club, c.view.guest, [
      M.confirmation(c.club, c.lang, c.view, this.deps.links.pass(c.view.booking)),
    ]);
    await this.deps.outbox.toStaff(c.gateway, c.club, [M.staffNewBooking(c.view, 'confirmed')]);
  }

  async rejected(bookingId: string) {
    const c = await this.ctx(bookingId);
    if (!c) return;
    await this.deps.outbox.toGuest(c.gateway, c.club, c.view.guest, [
      M.plain(t(c.lang, 'paymentRejected', { ref: c.view.booking.refCode })),
    ]);
  }

  async cancelled(bookingId: string, reason: string) {
    const c = await this.ctx(bookingId);
    if (!c) return;
    await this.deps.outbox.toGuest(c.gateway, c.club, c.view.guest, [
      M.plain(
        t(c.lang, 'cancelledByClub', {
          ref: c.view.booking.refCode,
          night: formatNight(c.view.booking.nightDate, c.lang),
          reason,
        }),
      ),
    ]);
  }

  async holdExpired(booking: Booking) {
    const c = await this.ctx(booking.id);
    if (!c) return;
    await this.deps.outbox.toGuest(c.gateway, c.club, c.view.guest, [
      M.plain(t(c.lang, 'holdExpired', { code: c.view.table.code, night: formatNight(booking.nightDate, c.lang) }), [
        M.quickPostback(t(c.lang, 'tryAgain'), { a: 'book' }),
      ]),
    ]);
  }

  /** Free-text reply typed by a host in the dashboard. */
  async hostReply(guestId: string, text: string) {
    const guest = await this.deps.db.query.guests.findFirst({ where: eq(guests.id, guestId) });
    if (!guest) return;
    const club = (await this.deps.db.query.clubs.findFirst({ where: eq(clubs.id, guest.clubId) }))!;
    await this.deps.outbox.toGuest(this.gateways.forClub(club, guest.lineUserId), club, guest, [M.plain(text)]);
  }
}
