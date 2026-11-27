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
  | { kind: 'unknown' };

const DETAILS_SENT = /(?:Details sent|ส่งข้อมูลแล้ว)\s*·\s*([A-Z0-9]{2,4}-[A-Z0-9]{4})/;
const HANDOFF =
  /\b(talk|speak|chat)\s+(to|with)\s+(a\s+)?(person|human|staff|host|someone|real person|manager)\b|\b(human|agent|operator|admin|real person)\b|แอดมิน|พนักงาน|คุยกับคน|ขอคุย|ติดต่อเจ้าหน้าที่/i;
const MY_BOOKING = /\bmy\s+(booking|reservation|table)\b|การจองของฉัน|เช็คการจอง|ดูการจอง/i;
const BOOK = /\b(book|booking|reserve|reservation|table|tables)\b|จอง|โต๊ะ/i;
const LOCATION = /\b(location|address|where are you|map|directions)\b|แผนที่|ที่อยู่|อยู่ที่ไหน|ไปยังไง/i;
const STAFF_LINK = /^\s*link\s+([A-F0-9]{6})\s*$/i;

export function detectIntent(text: string): Intent {
  const details = text.match(DETAILS_SENT);
  if (details) return { kind: 'details_sent', ref: details[1]! };
  const link = text.match(STAFF_LINK);
  if (link) return { kind: 'staff_link', code: link[1]!.toUpperCase() };
  if (HANDOFF.test(text)) return { kind: 'handoff' };
  if (MY_BOOKING.test(text)) return { kind: 'my_booking' };
  if (BOOK.test(text)) return { kind: 'book' };
  if (LOCATION.test(text)) return { kind: 'location' };
  return { kind: 'unknown' };
}
