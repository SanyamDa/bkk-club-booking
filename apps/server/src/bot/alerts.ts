import type { BookingView } from '../bookings/service.js';
import type { Db } from '../db/client.js';
import type { Club } from '../db/schema.js';
import { formatNight } from '../lib/time.js';
import { formatBaht } from '../lib/util.js';
import { openAlert, raiseAlert } from '../platform/alerts.js';

/**
 * Plan B19b: every staff alert from Track B code goes through A15's `raiseAlert`, at the §6.4
 * level. Urgent ones reach the inbox feed and the staff LINE group in the same call; needs-input
 * ones only the feed and counter; information ones the feed (LINE only when the club switched it on).
 */

/**
 * Complaint and safety words (spec §6.4, §8.1), used when the club has not set its own list in
 * `settings.urgentWords`. Matched case-insensitively as substrings (Thai has no word breaks).
 */
export const DEFAULT_URGENT_WORDS: readonly string[] = [
  // English
  'complaint',
  'complain',
  'refund',
  'police',
  'ambulance',
  'hospital',
  'injured',
  'hurt',
  'assault',
  'harass',
  'spiked',
  'drugged',
  'unsafe',
  'emergency',
  'stolen',
  'scam',
  'fight',
  // Thai
  'ร้องเรียน',
  'คืนเงิน',
  'ตำรวจ',
  'แจ้งความ',
  'รถพยาบาล',
  'โรงพยาบาล',
  'บาดเจ็บ',
  'ทำร้าย',
  'ล่วงละเมิด',
  'คุกคาม',
  'ไม่ปลอดภัย',
  'ฉุกเฉิน',
  'ขโมย',
  'โกง',
  'ทะเลาะ',
];

/** The first complaint or safety word in `text`, from the club's list or the default one. */
export function urgentWordIn(club: Club, text: string): string | null {
  const words = club.settings.urgentWords?.length ? club.settings.urgentWords : DEFAULT_URGENT_WORDS;
  const hay = text.toLowerCase();
  for (const w of words) {
    const word = w.trim().toLowerCase();
    if (word && hay.includes(word)) return w;
  }
  return null;
}

const guestName = (v: BookingView) => v.guest.name ?? v.guest.displayName ?? 'Guest';

/** The §6.1 booking lines (table, night, pax, guest, min spend, deposit, ref, request), per language. */
function bookingLines(v: BookingView, lang: 'en' | 'th'): string {
  const b = v.booking;
  const lines = [
    `${v.table.code} · ${formatNight(b.nightDate, lang)} · ${b.pax} ${lang === 'th' ? 'คน' : 'pax'}`,
    `${guestName(v)}${v.guest.nationality ? ` (${v.guest.nationality})` : ''}${v.guest.phone ? ` · ${v.guest.phone}` : ''}`,
    lang === 'th'
      ? `ขั้นต่ำ ${formatBaht(b.minSpendSatang)} · มัดจำ ${formatBaht(b.depositSatang)} · ${b.refCode}`
      : `Min ${formatBaht(b.minSpendSatang)} · Deposit ${formatBaht(b.depositSatang)} · ${b.refCode}`,
  ];
  if (b.specialRequest) lines.push(`${lang === 'th' ? 'คำขอ' : 'Request'}: ${b.specialRequest}`);
  return lines.join('\n');
}

const bookingText = (v: BookingView, en: string, th: string) => ({
  en: `${en}\n${bookingLines(v, 'en')}`,
  th: `${th}\n${bookingLines(v, 'th')}`,
});

/** New confirmed booking: information (§6.4). */
export function alertBookingConfirmed(db: Db, v: BookingView, now: Date): Promise<void> {
  return raiseAlert(
    db,
    { clubId: v.booking.clubId, level: 'info', kind: 'booking_confirmed', bookingId: v.booking.id, text: bookingText(v, 'New booking', 'จองใหม่') },
    now,
  );
}

/** A slip waiting for staff review: urgent. `extra` is a line staff need (e.g. the table was lost). */
export function alertPaymentReview(db: Db, v: BookingView, now: Date, opts: { conversationId?: string; extra?: string } = {}): Promise<void> {
  const text = bookingText(v, 'Slip to check', 'ตรวจสลิป');
  if (opts.extra) {
    text.en += `\n${opts.extra}`;
    text.th += `\n${opts.extra}`;
  }
  return raiseAlert(
    db,
    { clubId: v.booking.clubId, level: 'urgent', kind: 'payment_review', bookingId: v.booking.id, conversationId: opts.conversationId, text },
    now,
  );
}

/** B10 no-show job: release time passed and the table has not arrived. Urgent. */
export function alertNoArrival(db: Db, v: BookingView, now: Date): Promise<void> {
  return raiseAlert(
    db,
    {
      clubId: v.booking.clubId,
      level: 'urgent',
      kind: 'no_arrival',
      bookingId: v.booking.id,
      text: bookingText(v, 'Not arrived at release time', 'ยังไม่มาถึงเวลาปล่อยโต๊ะ'),
    },
    now,
  );
}

/** B10: guest says they are running late. Information. */
export function alertRunningLate(db: Db, v: BookingView, now: Date, conversationId?: string): Promise<void> {
  return raiseAlert(
    db,
    { clubId: v.booking.clubId, level: 'info', kind: 'running_late', bookingId: v.booking.id, conversationId, text: bookingText(v, 'Running late', 'มาสาย') },
    now,
  );
}

/** B10: a booking was cancelled. Information. */
export function alertCancellation(db: Db, v: BookingView, now: Date): Promise<void> {
  return raiseAlert(
    db,
    { clubId: v.booking.clubId, level: 'info', kind: 'cancellation', bookingId: v.booking.id, text: bookingText(v, 'Booking cancelled', 'ยกเลิกการจอง') },
    now,
  );
}

/**
 * B18 brain drafts and gaps: needs input (feed and counter, never the group). One open alert per
 * kind per club; staff resolve it once they have worked through the queue.
 */
export async function alertBrainWaiting(
  db: Db,
  input: { clubId: string; kind: 'brain_draft_waiting' | 'gap_waiting'; count: number },
  now: Date,
): Promise<void> {
  if (input.count <= 0 || (await openAlert(db, input.clubId, input.kind))) return;
  const text =
    input.kind === 'brain_draft_waiting'
      ? { en: `${input.count} drafted brain note(s) waiting for approval`, th: `มีร่างบันทึก ${input.count} รายการรออนุมัติ` }
      : { en: `${input.count} unanswered question(s) waiting for a written answer`, th: `มีคำถาม ${input.count} ข้อรอคำตอบ` };
  await raiseAlert(db, { clubId: input.clubId, level: 'needs_input', kind: input.kind, text }, now);
}

/** B16: AI spend is near the club's cap. Urgent, so the owner hears before answers stop. */
export function alertCostCap(db: Db, clubId: string, spentSatang: number, capSatang: number, now: Date): Promise<void> {
  const text = {
    en: `AI answers have used ${formatBaht(spentSatang)} of the ${formatBaht(capSatang)} monthly cap. At the cap, chats go to a host.`,
    th: `ค่าใช้จ่าย AI ใช้ไป ${formatBaht(spentSatang)} จากเพดาน ${formatBaht(capSatang)} ต่อเดือน เมื่อถึงเพดาน แชทจะส่งต่อให้พนักงาน`,
  };
  return raiseAlert(db, { clubId, level: 'urgent', kind: 'ai_cost_cap', text }, now);
}

/** A bot error while handling a guest event: urgent, at most one open per club until resolved. */
export async function alertBotError(db: Db, clubId: string, now: Date): Promise<void> {
  if (await openAlert(db, clubId, 'bot_error')) return;
  await raiseAlert(
    db,
    {
      clubId,
      level: 'urgent',
      kind: 'bot_error',
      text: {
        en: 'The bot hit an error answering a guest. Check the inbox; the platform team has the details.',
        th: 'บอทเกิดข้อผิดพลาดขณะตอบลูกค้า กรุณาตรวจสอบกล่องข้อความ ทีมแพลตฟอร์มมีรายละเอียดแล้ว',
      },
    },
    now,
  );
}

/** The alert kind for a handoff trigger (§6.4: a person asked for, or the bot could not answer). */
export function handoffAlertKind(trigger: string): string {
  if (trigger === 'guest_request' || trigger === 'large_group') return 'guest_wants_human';
  if (trigger === 'paid_after_expiry') return 'payment_review';
  if (trigger === 'complaint') return 'complaint';
  return 'bot_unanswered';
}
