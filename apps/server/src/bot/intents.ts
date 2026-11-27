/**
 * Phase 0/1 intent detection: keyword rules in English and Thai. Phase 2 replaces the
 * fallback branch with an AI model, but these deterministic rules stay as the first pass.
 */
export type Intent =
  | { kind: 'details_sent'; ref: string }
  | { kind: 'handoff' }
  | { kind: 'my_booking' }
  | { kind: 'book' }
  | { kind: 'location' }
  | { kind: 'staff_link'; code: string }
  | { kind: 'remove_data' }
  | { kind: 'stop_marketing' }
  | { kind: 'unknown' };

const DETAILS_SENT = /(?:Details sent|ส่งข้อมูลแล้ว)\s*·\s*([A-Z0-9]{2,4}-[A-Z0-9]{4})/;
const HANDOFF =
  /\b(talk|speak|chat)\s+(to|with)\s+(a\s+)?(person|human|staff|host|someone|real person|manager)\b|\b(human|agent|operator|admin|real person)\b|แอดมิน|พนักงาน|คุยกับคน|ขอคุย|ติดต่อเจ้าหน้าที่/i;
const MY_BOOKING = /\bmy\s+(booking|reservation|table)\b|การจองของฉัน|เช็คการจอง|ดูการจอง/i;
const BOOK = /\b(book|booking|reserve|reservation|table|tables)\b|จอง|โต๊ะ/i;
const LOCATION = /\b(location|address|where are you|map|directions)\b|แผนที่|ที่อยู่|อยู่ที่ไหน|ไปยังไง/i;
/** `link <code>`: the 8-character code from the dashboard's "Issue link code" button (bot/staff-link.ts). */
const STAFF_LINK = /^\s*link\s+([A-Z0-9]{8})\s*$/i;
/** B10b: removal request (spec §14.9). The bot asks for one confirm tap before writing it. */
const REMOVE_DATA = /\b(delete|remove|erase)\s+(all\s+)?my\s+(data|details|information|info)\b|\bforget\s+me\b|ลบข้อมูล/i;
/** B10b: stop marketing (spec §5.5). English only as the whole message, so "can't stop" is not an opt-out. */
const STOP_MARKETING = /^\s*(stop|unsubscribe|stop promotions|stop marketing)\s*[.!]*\s*$|ยกเลิกรับข่าวสาร|ไม่รับข่าวสาร|หยุดส่ง|^\s*หยุด\s*$/i;

export function detectIntent(text: string): Intent {
  const details = text.match(DETAILS_SENT);
  if (details) return { kind: 'details_sent', ref: details[1]! };
  const link = text.match(STAFF_LINK);
  if (link) return { kind: 'staff_link', code: link[1]!.toUpperCase() };
  if (REMOVE_DATA.test(text)) return { kind: 'remove_data' };
  if (STOP_MARKETING.test(text)) return { kind: 'stop_marketing' };
  if (HANDOFF.test(text)) return { kind: 'handoff' };
  if (MY_BOOKING.test(text)) return { kind: 'my_booking' };
  if (BOOK.test(text)) return { kind: 'book' };
  if (LOCATION.test(text)) return { kind: 'location' };
  return { kind: 'unknown' };
}

/** Tester code (B6): a message that is only 8 letters or digits, optionally after "tester". */
const TESTER_CODE = /^\s*(?:tester\s+)?([A-Za-z0-9]{8})\s*$/i;

/**
 * The typed text as a tester-code candidate, or null. Not part of `detectIntent`: the bot only
 * checks it at an onboarding club, and text that is not the live code goes on to `detectIntent`.
 */
export function testerCodeIn(text: string): string | null {
  const m = text.match(TESTER_CODE);
  return m ? m[1]!.toUpperCase() : null;
}
