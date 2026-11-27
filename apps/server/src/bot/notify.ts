import { and, eq } from 'drizzle-orm';
import { getBookingView, type Actor } from '../bookings/service.js';
import { listMenu } from '../bookings/preorders.js';
import { WAITLIST_OFFER_MINUTES, type WaitlistOffer } from '../bookings/waitlist.js';
import { clubs, guests, type Booking, type Club } from '../db/schema.js';
import type { GatewayRegistry } from '../line/gateway.js';
import { formatNight } from '../lib/time.js';
import type { BotDeps } from './flow.js';
import { langOf, t } from './i18n.js';
import * as M from './messages.js';
import { alertBookingConfirmed, alertCancellation } from './alerts.js';

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
      M.confirmation(c.club, c.lang, c.view, this.deps.links.pass(c.view.booking), this.deps.links),
      // B22: [Pre-order bottles] when the club has an active bottle menu.
      ...((await listMenu(this.deps.db, c.club.id, { activeOnly: true })).length ? [M.preorderPrompt(c.lang, c.view.booking.id)] : []),
    ]);
    // B19b: a new confirmed booking is information (§6.4): the feed, and LINE only if the club switched it on.
    await alertBookingConfirmed(this.deps.db, c.view, this.deps.now());
  }

  /** B22: a freed table offered to a waiting guest (push, from the `waitlist` job). */
  async waitlistOffer(offer: WaitlistOffer) {
    const { club, guest, entry } = offer;
    if (guest.clubId !== club.id || entry.clubId !== club.id) return;
    const gateway = await this.gateways.forClub(club, guest.lineUserId);
    await this.deps.outbox.toGuest(gateway, club, guest, [
      M.waitlistOffer(langOf(guest.lang), entry.nightDate, entry.paxRange, entry.id, WAITLIST_OFFER_MINUTES),
    ]);
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
    // B19b: a cancellation is information (§6.4).
    await alertCancellation(this.deps.db, c.view, this.deps.now());
  }

  async holdExpired(booking: Booking) {
    const c = await this.ctx(booking.clubId, booking.id);
    if (!c) return;
    await this.deps.outbox.toGuest(c.gateway, c.club, c.view.guest, [
      M.plain(t(c.lang, 'holdExpired', { code: c.view.table.code, night: formatNight(booking.nightDate, c.lang) }), [
        M.quickPostback(t(c.lang, 'tryAgain'), { a: 'book', s: 'retry_book' }),
      ]),
    ]);
  }

  /** B10: day-of reminder with [Running late] [Need to cancel] [Location]. A push (counts against quota). */
  async reminder(booking: Booking) {
    const c = await this.ctx(booking.clubId, booking.id);
    if (!c) return;
    await this.deps.outbox.toGuest(c.gateway, c.club, c.view.guest, [M.reminder(c.club, c.lang, c.view)]);
  }

  /**
   * Hourly "how full now?" to the club's staff group, where the door and host staff are (spec §14.3,
   * plan B12). Staff answer 1–5 on the door screen or the dashboard.
   */
  async crowdPrompt(club: Club, nightDate: string) {
    const gateway = await this.gateways.forClub(club);
    await this.deps.outbox.toStaff(gateway, club, [
      M.plain(
        `📊 ${formatNight(nightDate, 'en')}: how full is it now? Rate 1–5 on the door screen or the dashboard.\n` +
          `📊 ${formatNight(nightDate, 'th')}: ตอนนี้คนเยอะแค่ไหน? ให้คะแนน 1–5 ที่หน้าจอประตูหรือแดชบอร์ด`,
      ),
    ]);
  }

  /** Free-text reply typed by a host in the dashboard. */
  async hostReply(clubId: string, guestId: string, text: string, actor: Actor) {
    const guest = await this.deps.db.query.guests.findFirst({
      where: and(eq(guests.id, guestId), eq(guests.clubId, clubId)),
    });
    if (!guest) return;
    const club = await this.deps.db.query.clubs.findFirst({ where: eq(clubs.id, clubId) });
    if (!club) return;
    const gateway = await this.gateways.forClub(club, guest.lineUserId);
    // B4: stored with the staff member as author (author_type 'staff', author_id = actor.id).
    await this.deps.outbox.toGuest(gateway, club, guest, [M.plain(text)], undefined, actor);
  }
}
