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

/** Spec §5.3: a guest with an upcoming booking blocked the club's LINE account. Information. */
export function alertGuestUnfollowed(db: Db, v: BookingView, now: Date): Promise<void> {
  return raiseAlert(
    db,
    {
      clubId: v.booking.clubId,
      level: 'info',
      kind: 'guest_unfollowed',
      bookingId: v.booking.id,
      text: bookingText(v, "Guest blocked the LINE account and can't be messaged", 'ลูกค้าบล็อกบัญชี LINE ส่งข้อความหาไม่ได้'),
    },
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

/** B10: guest says they are running late. Information. `late` adds the minutes and the new release time. */
export function alertRunningLate(
  db: Db,
  v: BookingView,
  now: Date,
  conversationId?: string,
  late?: { minutes: number; releaseTime: string },
): Promise<void> {
  const text = late
    ? bookingText(
        v,
        `Running late: ${late.minutes} min, release at ${late.releaseTime}`,
        `มาสาย ${late.minutes} นาที ปล่อยโต๊ะเวลา ${late.releaseTime}`,
      )
    : bookingText(v, 'Running late', 'มาสาย');
  return raiseAlert(db, { clubId: v.booking.clubId, level: 'info', kind: 'running_late', bookingId: v.booking.id, conversationId, text }, now);
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

/**
 * B16: AI spend near (`reached: false`, at the warning share) or at the club's monthly cap. Urgent
 * `ai_cost_cap` both times, so the owner hears before answers stop. Amounts are US$ micros, the
 * unit of the `ai.call` events' `cost_usd_micros`.
 */
export function alertCostCap(
  db: Db,
  clubId: string,
  input: { spentUsdMicros: number; capUsdMicros: number; reached: boolean },
  now: Date,
): Promise<void> {
  const usd = (n: number) => `US$${(n / 1_000_000).toFixed(2)}`;
  const spent = usd(input.spentUsdMicros);
  const cap = usd(input.capUsdMicros);
  const text = input.reached
    ? {
        en: `AI answers reached the ${cap} monthly cap. Guest questions now go to a host until next month.`,
        th: `ระบบตอบอัตโนมัติถึงเพดาน ${cap} ต่อเดือนแล้ว คำถามของลูกค้าจะส่งให้พนักงานจนถึงเดือนหน้า`,
      }
    : {
        en: `AI answers have used ${spent} of the ${cap} monthly cap. At the cap, guest questions go to a host.`,
        th: `ระบบตอบอัตโนมัติใช้ไปแล้ว ${spent} จากเพดาน ${cap} ต่อเดือน เมื่อถึงเพดาน คำถามของลูกค้าจะส่งให้พนักงาน`,
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
