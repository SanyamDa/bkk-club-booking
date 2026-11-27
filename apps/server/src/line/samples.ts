import { listTableOptions, upcomingNights, type BookingView } from '../bookings/service.js';
import type { Links } from '../bot/links.js';
import * as M from '../bot/messages.js';
import type { Db } from '../db/client.js';
import type { Club } from '../db/schema.js';
import type { Message } from './gateway.js';

/**
 * One example of every message the bot can send, in both languages, built with the real
 * message builders. Used to have LINE validate them (line setup) before guests see them.
 */
export async function sampleMessages(db: Db, club: Club, links: Links, now: Date): Promise<Message[]> {
  const options = await listTableOptions(db, club.id);
  const option = options[0];
  if (!option) return [];
  const nights = upcomingNights(club, now, 4);
  const night = nights[0] ?? '2026-12-04';
  const booking = {
    id: 'sample-booking',
    clubId: club.id,
    refCode: `${club.settings.refPrefix}-SAMP`,
    guestId: 'sample-guest',
    tableId: option.table.id,
    nightDate: night,
    pax: option.table.maxPax,
    status: 'confirmed' as const,
    source: 'line' as const,
    holdExpiresAt: new Date(now.getTime() + 10 * 60_000),
    minSpendSatang: option.minSpendSatang,
    depositSatang: option.depositSatang,
    rulesVersion: club.settings.rulesVersion,
    rulesAcceptedAt: now,
    specialRequest: 'Birthday, cake at 1am',
    notes: null,
    statusReason: null,
    createdAt: now,
    updatedAt: now,
  };
  const view: BookingView = {
    booking,
    table: option.table,
    zone: option.zone,
    guest: {
      id: 'sample-guest',
      clubId: club.id,
      lineUserId: 'Usample',
      displayName: 'Sample',
      name: 'Sample Guest',
      phone: '0812345678',
      nationality: 'Thai',
      lang: 'en',
      consentAt: now,
      unfollowedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    deposit: {
      id: 'sample-deposit',
      bookingId: booking.id,
      amountSatang: booking.depositSatang,
      method: 'promptpay_slip',
      status: 'verified',
      slipPath: null,
      slipReceivedAt: now,
      verifiedBy: 'staff',
      verifiedAt: now,
      note: null,
      createdAt: now,
    },
  };
  // A real https URL is required by LINE for images; the PromptPay route exists even in demo mode.
  const qr = links.promptpayQr({ ...club, promptpayId: club.promptpayId ?? '0000000000' }, booking);

  const out: Message[] = [];
  for (const lang of ['en', 'th'] as const) {
    out.push(
      ...M.greeting(club, lang),
      M.menu(club, lang),
      M.askNight(club, lang, nights, now),
      M.askPax(lang, night),
      ...M.tablesCarousel(club, lang, options, night, '5–8'),
      M.noTables(lang, night, '5–8'),
      M.held(club, lang, view, links.details(club, booking)),
      M.review(club, lang, view),
      ...M.payment(club, lang, view, qr),
      ...M.payment(club, lang, view, null),
      M.confirmation(club, lang, view, links.pass(booking)),
      M.inProgress(lang, option.table.code, night, booking.id),
      M.alreadyBooked(club, lang, view),
    );
  }
  out.push(M.staffNewBooking(view, 'confirmed'), M.staffNewBooking(view, 'review'), M.staffHandoff('Sample Guest', 'Guest tapped "Talk to a host"'));
  return out;
}
