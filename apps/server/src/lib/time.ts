/**
 * Bangkok time helpers. Thailand is UTC+7 all year (no daylight saving), so a fixed offset is exact.
 */
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Wall-clock parts in Bangkok for an instant. */
export function bangkokParts(at: Date) {
  const d = new Date(at.getTime() + BKK_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

export function toDateString(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Adds days to a YYYY-MM-DD string. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return toDateString(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The club night an instant belongs to. Before `nightEndHour` (e.g. 02:00 Sunday) it still counts
 * as the previous date's night (Saturday).
 */
export function currentNightDate(at: Date, nightEndHour: number): string {
  const p = bangkokParts(at);
  const today = toDateString(p.year, p.month, p.day);
  return p.hour < nightEndHour ? addDays(today, -1) : today;
}

const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_TH = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** "Sat 29 Nov" / "ส. 29 พ.ย." */
export function formatNight(date: string, lang: 'en' | 'th'): string {
  const [, m, d] = date.split('-').map(Number) as [number, number, number];
  const wd = weekdayOf(date);
  return lang === 'th'
    ? `${WEEKDAYS_TH[wd]} ${d} ${MONTHS_TH[m - 1]}`
    : `${WEEKDAYS_EN[wd]} ${d} ${MONTHS_EN[m - 1]}`;
}

/** "22:41" in Bangkok time. */
export function formatClock(at: Date): string {
  const p = bangkokParts(at);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}
