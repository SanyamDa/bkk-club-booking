import type { messagingApi } from '@line/bot-sdk';
import { PAX_RANGES, type BookingView, type TableOption } from '../bookings/service.js';
import type { Club } from '../db/schema.js';
import type { Message } from '../line/gateway.js';
import { addDays, currentNightDate, formatClock, formatNight } from '../lib/time.js';
import { formatBaht } from '../lib/util.js';
import { t, type Lang } from './i18n.js';
import type { Links } from './links.js';

/** B4: what a message needs to send the club's map and drinks links through the counted `/r/` redirect. */
export type TrackedLinks = Pick<Links, 'tracked'>;

type FlexComponent = messagingApi.FlexComponent;
type QuickReplyItem = messagingApi.QuickReplyItem;

// Dark, quiet card styling. The club's accent colour carries the brand.
const C = { bg: '#121113', text: '#F3EFE6', muted: '#A8A39A', line: '#2A2826' };

/** Postback payloads are short query strings: a=<action>&... */
export const pb = (params: Record<string, string>) => new URLSearchParams(params).toString();

// LINE label limits: 40 characters on Flex buttons, 20 on quick-reply chips.
const postback = (label: string, data: Record<string, string>, displayText?: string): messagingApi.PostbackAction => ({
  type: 'postback',
  label: label.slice(0, 40),
  data: pb(data),
  displayText: displayText ?? label,
});

const qr = (action: messagingApi.Action): QuickReplyItem => ({
  type: 'action',
  action: 'label' in action && action.label ? { ...action, label: action.label.slice(0, 20) } : action,
});

function text(textValue: string, quick?: QuickReplyItem[]): Message {
  return { type: 'text', text: textValue, ...(quick?.length ? { quickReply: { items: quick.slice(0, 13) } } : {}) };
}

function row(label: string, value: string, bold = false): FlexComponent {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: label, size: 'sm', color: C.muted, flex: 5 },
      { type: 'text', text: value, size: 'sm', color: C.text, align: 'end', flex: 6, weight: bold ? 'bold' : 'regular', wrap: true },
    ],
  };
}

function bubble(body: FlexComponent[], footer?: FlexComponent[], header?: { title: string; accent: string }): messagingApi.FlexBubble {
  return {
    type: 'bubble',
    styles: { body: { backgroundColor: C.bg }, footer: { backgroundColor: C.bg }, header: { backgroundColor: C.bg } },
    ...(header
      ? {
          header: {
            type: 'box',
            layout: 'vertical',
            paddingBottom: 'none',
            contents: [{ type: 'text', text: header.title.toUpperCase(), size: 'xs', color: header.accent, weight: 'bold' }],
          },
        }
      : {}),
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: body },
    ...(footer ? { footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer } } : {}),
  };
}

function primaryButton(action: messagingApi.Action, accent: string): FlexComponent {
  return { type: 'button', style: 'primary', color: accent, height: 'md', action };
}

function secondaryButton(action: messagingApi.Action): FlexComponent {
  return { type: 'button', style: 'secondary', height: 'sm', action };
}

// ---------- Menus ----------

/**
 * B4: postbacks that start or route a booking carry an entry tag `s=<where>_<action>` (spec §14.2
 * "Entry points are tagged"): `qr_*` on the menu quick replies, `greet_*` on the greeting.
 * In-flow buttons ("Another night", "Change") carry `s=other_night` / `s=change` and keep the attempt.
 */
export function menuQuickReplies(club: Club, lang: Lang, links: TrackedLinks, where: 'qr' | 'greet' = 'qr'): QuickReplyItem[] {
  return [
    qr(postback(t(lang, 'bookTable'), { a: 'book', s: `${where}_book` })),
    qr(postback(t(lang, 'myBooking'), { a: 'my', s: `${where}_my` })),
    // B4: LINE opens these without telling us, so they go through the counted `/r/` redirect.
    ...(club.settings.drinksMenuUrl ? [qr({ type: 'uri', label: t(lang, 'drinksMenu'), uri: links.tracked(club, 'drinks', `${where}_drinks`) })] : []),
    qr({ type: 'uri', label: t(lang, 'location'), uri: links.tracked(club, 'map', `${where}_location`) }),
    qr(postback(t(lang, 'talkToHost'), { a: 'host', s: `${where}_host` })),
    qr(postback(t(lang, 'myData'), { a: 'privacy' })), // B10b
  ];
}

export const menu = (club: Club, lang: Lang, links: TrackedLinks): Message => text(t(lang, 'menuPrompt'), menuQuickReplies(club, lang, links));

/** B10b: the "My data" menu item: stop promotions or ask for removal (spec §5.5, §14.9). */
export const myData = (lang: Lang): Message =>
  text(t(lang, 'myDataPrompt'), [
    qr(postback(t(lang, 'stopPromotions'), { a: 'stop' })),
    qr(postback(t(lang, 'removeMyData'), { a: 'remove' })),
  ]);

/** B10b: the one confirm tap before a removal request is written. */
export const removeConfirm = (lang: Lang): Message =>
  text(t(lang, 'removeConfirmPrompt'), [qr(postback(t(lang, 'removeConfirm'), { a: 'remove_confirm' }))]);

/** B4: the one-line data notice with its link (spec §5.5); the club's name is inserted. */
export const dataNotice = (club: Club, lang: Lang, url: string): Message => text(t(lang, 'dataNotice', { club: club.name, url }));

export function greeting(club: Club, lang: Lang, links: TrackedLinks): Message[] {
  const rules = club.settings.rules[lang].map((r) => `• ${r}`).join('\n');
  return [text(`${club.settings.greeting[lang]}\n\n${rules}`, menuQuickReplies(club, lang, links, 'greet'))];
}

// ---------- Booking steps ----------

/** A night in the guest date list: a plain date, or B8b's `bookableNights` entry with its event name. */
export type AskNightOption = string | { date: string; eventName?: string | null };

export function askNight(club: Club, lang: Lang, options: AskNightOption[], now: Date): Message {
  const list = options.map((o) => (typeof o === 'string' ? { date: o, eventName: null } : { date: o.date, eventName: o.eventName ?? null }));
  const nights = list.map((n) => n.date);
  if (nights.length === 0) return text(t(lang, 'noNights'), [qr(postback(t(lang, 'talkToHost'), { a: 'host' }))]);
  const tonight = currentNightDate(now, club.settings.nightEndHour);
  const shown = list.slice(0, 4);
  const items = shown.map(({ date: d, eventName }) => {
    const day = d === tonight ? t(lang, 'tonight') : formatNight(d, lang);
    const shownText = eventName ? `${formatNight(d, lang)} · ${eventName}` : formatNight(d, lang);
    return qr(postback(eventName ? `${day} · ${eventName}` : day, { a: 'night', d }, shownText));
  });
  // Event names are cut short on the 20-character chip, so the message lists them in full.
  const events = shown.filter((n) => n.eventName).map((n) => `• ${formatNight(n.date, lang)}: ${n.eventName}`);
  items.push(
    qr({
      type: 'datetimepicker',
      label: t(lang, 'pickDate'),
      data: pb({ a: 'night_pick' }),
      mode: 'date',
      initial: nights[0],
      min: tonight,
      max: addDays(tonight, club.settings.bookingWindowDays),
    }),
  );
  return text(events.length ? `${t(lang, 'askNight')}\n\n${events.join('\n')}` : t(lang, 'askNight'), items);
}

export function askPax(lang: Lang, nightDate: string): Message {
  return text(
    t(lang, 'askPax', { night: formatNight(nightDate, lang) }),
    PAX_RANGES.map((r) => qr(postback(r.key === '13+' ? '13+' : `${r.min}–${r.max}`, { a: 'pax', r: r.key }))),
  );
}

export function tablesCarousel(club: Club, lang: Lang, options: TableOption[], nightDate: string, paxLabel: string): Message[] {
  const accent = club.settings.accentColor;
  const bubbles = options.slice(0, 10).map((o) =>
    bubble(
      [
        { type: 'text', text: o.table.code, size: '3xl', weight: 'bold', color: C.text },
        { type: 'text', text: lang === 'th' ? o.zone.nameTh : o.zone.name, size: 'sm', color: C.muted },
        { type: 'separator', color: C.line, margin: 'md' },
        row(t(lang, 'guests'), t(lang, 'guestsRange', { min: o.table.minPax, max: o.table.maxPax })),
        row(t(lang, 'minSpend'), formatBaht(o.minSpendSatang), true),
        row(t(lang, 'deposit'), o.depositSatang ? formatBaht(o.depositSatang) : t(lang, 'noDeposit')),
      ],
      [primaryButton(postback(t(lang, 'chooseTable', { code: o.table.code }), { a: 'table', t: o.table.id, d: nightDate }), accent)],
      { title: formatNight(nightDate, lang), accent },
    ),
  );
  return [
    text(t(lang, 'tablesIntro', { night: formatNight(nightDate, lang), pax: paxLabel })),
    {
      type: 'flex',
      altText: t(lang, 'tablesIntro', { night: formatNight(nightDate, lang), pax: paxLabel }),
      contents: { type: 'carousel', contents: bubbles },
      quickReply: {
        items: [qr(postback(t(lang, 'otherNight'), { a: 'book', s: 'other_night' })), qr(postback(t(lang, 'talkToHost'), { a: 'host' }))],
      },
    },
  ];
}

/** No table fits. With `rangeKey` (B22), the first chip is [Join waitlist] for that night and range. */
export function noTables(lang: Lang, nightDate: string, paxLabel: string, rangeKey?: string): Message {
  return text(t(lang, 'noTables', { night: formatNight(nightDate, lang), pax: paxLabel }), [
    ...(rangeKey ? [qr(postback(t(lang, 'joinWaitlist'), { a: 'waitlist', d: nightDate, r: rangeKey }))] : []),
    qr(postback(t(lang, 'otherNight'), { a: 'book', s: 'other_night' })),
    qr(postback(t(lang, 'talkToHost'), { a: 'host' })),
  ]);
}

export function held(club: Club, lang: Lang, view: BookingView, detailsUrl: string): Message {
  const msg = t(lang, 'held', { code: view.table.code, time: formatClock(view.booking.holdExpiresAt!) });
  return {
    type: 'flex',
    altText: msg,
    contents: bubble(
      [{ type: 'text', text: msg, wrap: true, color: C.text, size: 'md' }],
      [primaryButton({ type: 'uri', label: t(lang, 'enterDetails'), uri: detailsUrl }, club.settings.accentColor)],
    ),
  };
}

function summaryRows(lang: Lang, view: BookingView): FlexComponent[] {
  const b = view.booking;
  return [
    row(t(lang, 'table'), `${view.table.code} · ${lang === 'th' ? view.zone.nameTh : view.zone.name}`, true),
    row(t(lang, 'night'), formatNight(b.nightDate, lang)),
    row(t(lang, 'guests'), String(b.pax)),
    row(t(lang, 'minSpend'), formatBaht(b.minSpendSatang), true),
    row(t(lang, 'deposit'), b.depositSatang ? formatBaht(b.depositSatang) : t(lang, 'noDeposit')),
  ];
}

export function review(club: Club, lang: Lang, view: BookingView): Message {
  const accent = club.settings.accentColor;
  const rules = club.settings.rules[lang].map(
    (r): FlexComponent => ({ type: 'text', text: `• ${r}`, size: 'xs', color: C.muted, wrap: true }),
  );
  const confirmLabel = view.booking.depositSatang ? t(lang, 'confirmPay') : t(lang, 'confirmNoDeposit');
  return {
    type: 'flex',
    altText: t(lang, 'reviewTitle'),
    contents: bubble(
      [
        ...summaryRows(lang, view),
        { type: 'separator', color: C.line, margin: 'md' },
        { type: 'text', text: t(lang, 'arriveBy', { time: club.settings.arrivalBy }), size: 'xs', color: C.text, wrap: true },
        ...rules,
        { type: 'text', text: `✓ ${t(lang, 'rulesAccepted')}`, size: 'xs', color: accent },
      ],
      [
        primaryButton(postback(confirmLabel, { a: 'confirm', b: view.booking.id }), accent),
        secondaryButton(postback(t(lang, 'change'), { a: 'book', s: 'change' })),
      ],
      { title: t(lang, 'reviewTitle'), accent },
    ),
  };
}

export function payment(club: Club, lang: Lang, view: BookingView, qrImageUrl: string | null): Message[] {
  const vars = {
    amount: formatBaht(view.booking.depositSatang),
    name: club.promptpayName ?? club.name,
    ref: view.booking.refCode,
    time: view.booking.holdExpiresAt ? formatClock(view.booking.holdExpiresAt) : club.settings.arrivalBy,
  };
  if (!qrImageUrl) return [text(t(lang, 'payDemo', vars))];
  return [
    { type: 'image', originalContentUrl: qrImageUrl, previewImageUrl: qrImageUrl },
    text(t(lang, 'payInstructions', vars), [qr(postback(t(lang, 'talkToHost'), { a: 'host' }))]),
  ];
}

/** A20b: the gateway payment link (hosted page), instead of the PromptPay QR and slip. */
export function paymentLink(club: Club, lang: Lang, view: BookingView, payUrl: string): Message {
  const vars = {
    amount: formatBaht(view.booking.depositSatang),
    ref: view.booking.refCode,
    time: view.booking.holdExpiresAt ? formatClock(view.booking.holdExpiresAt) : club.settings.arrivalBy,
  };
  const accent = club.settings.accentColor;
  return {
    type: 'flex',
    altText: `${t(lang, 'payTitle')} · ${vars.amount}`,
    contents: bubble(
      [{ type: 'text', text: t(lang, 'payLinkInstructions', vars), size: 'sm', color: C.text, wrap: true }],
      [primaryButton({ type: 'uri', label: t(lang, 'payNow'), uri: payUrl }, accent), secondaryButton(postback(t(lang, 'talkToHost'), { a: 'host' }))],
      { title: t(lang, 'payTitle'), accent },
    ),
  };
}

export function confirmation(club: Club, lang: Lang, view: BookingView, passImageUrl: string, links: TrackedLinks): Message {
  const b = view.booking;
  const paid = view.deposit?.status === 'verified' ? view.deposit.amountSatang : 0;
  return {
    type: 'flex',
    altText: `${t(lang, 'confirmedTitle')} · ${view.table.code} · ${formatNight(b.nightDate, lang)}`,
    contents: {
      ...bubble(
        [
          { type: 'text', text: club.name, size: 'xl', weight: 'bold', color: C.text },
          ...summaryRows(lang, view),
          ...(paid
            ? [row(t(lang, 'depositPaid'), formatBaht(paid)), row(t(lang, 'remaining'), formatBaht(Math.max(0, b.minSpendSatang - paid)))]
            : []),
          { type: 'separator', color: C.line, margin: 'md' },
          { type: 'text', text: t(lang, 'arriveBy', { time: club.settings.arrivalBy }), size: 'xs', color: C.muted, wrap: true },
          { type: 'text', text: `${t(lang, 'showAtDoor')} · ${b.refCode}`, size: 'xs', color: C.muted, wrap: true },
        ],
        [secondaryButton({ type: 'uri', label: t(lang, 'location'), uri: links.tracked(club, 'map', 'confirm_location') })],
        { title: t(lang, 'confirmedTitle'), accent: club.settings.accentColor },
      ),
      hero: { type: 'image', url: passImageUrl, size: 'full', aspectRatio: '1:1', aspectMode: 'fit', backgroundColor: '#FFFFFF' },
    },
  };
}

export function inProgress(lang: Lang, code: string, nightDate: string, bookingId: string): Message {
  return text(t(lang, 'inProgress', { code, night: formatNight(nightDate, lang) }), [
    qr(postback(t(lang, 'continueBooking'), { a: 'continue', b: bookingId })),
    qr(postback(t(lang, 'startOver'), { a: 'restart', s: 'restart' })),
  ]);
}

export function alreadyBooked(club: Club, lang: Lang, view: BookingView, links: TrackedLinks): Message {
  const status = t(lang, `status_${view.booking.status}` as 'status_confirmed');
  return text(
    t(lang, 'alreadyBooked', { code: view.table.code, night: formatNight(view.booking.nightDate, lang), status }),
    [qr(postback(t(lang, 'talkToHost'), { a: 'host' })), ...menuQuickReplies(club, lang, links).slice(2)],
  );
}

export const plain = text;
export const quickPostback = (label: string, data: Record<string, string>) => qr(postback(label, data));

// ---------- B22: waitlist and bottle pre-orders ----------

const rangeLabel = (key: string) => {
  const r = PAX_RANGES.find((x) => x.key === key);
  return r ? (r.key === '13+' ? '13+' : `${r.min}–${r.max}`) : key;
};

/** After a waitlist join (or a repeated one). */
export function waitlistJoined(lang: Lang, nightDate: string, rangeKey: string, entryId: string, already = false): Message {
  return text(t(lang, already ? 'waitlistAlready' : 'waitlistJoined', { night: formatNight(nightDate, lang), pax: rangeLabel(rangeKey) }), [
    qr(postback(t(lang, 'waitlistLeave'), { a: 'waitlist_leave', w: entryId })),
    qr(postback(t(lang, 'otherNight'), { a: 'book', s: 'other_night' })),
    qr(postback(t(lang, 'talkToHost'), { a: 'host' })),
  ]);
}

/** The push sent when a table frees up for a waiting guest. */
export function waitlistOffer(lang: Lang, nightDate: string, rangeKey: string, entryId: string, minutes: number): Message {
  return text(t(lang, 'waitlistOffer', { night: formatNight(nightDate, lang), pax: rangeLabel(rangeKey), minutes }), [
    qr(postback(t(lang, 'waitlistBook'), { a: 'waitlist_book', w: entryId })),
    qr(postback(t(lang, 'waitlistLeave'), { a: 'waitlist_leave', w: entryId })),
  ]);
}

/** Sent after a confirmation when the club has a bottle menu. */
export function preorderPrompt(lang: Lang, bookingId: string): Message {
  return text(t(lang, 'preorderPrompt'), [qr(postback(t(lang, 'preorderBottles'), { a: 'bottles', b: bookingId }))]);
}

export interface BottleCard {
  id: string;
  name: string;
  nameTh: string;
  priceSatang: number;
}

export function bottlesCarousel(club: Club, lang: Lang, items: BottleCard[], bookingId: string): Message {
  const accent = club.settings.accentColor;
  const bubbles = items.slice(0, 10).map((i) =>
    bubble(
      [
        { type: 'text', text: lang === 'th' ? i.nameTh : i.name, size: 'lg', weight: 'bold', color: C.text, wrap: true },
        { type: 'text', text: formatBaht(i.priceSatang), size: 'md', color: C.muted },
      ],
      [primaryButton(postback(t(lang, 'preorderAdd'), { a: 'bottle_add', b: bookingId, i: i.id }, `+1 ${i.name}`), accent)],
    ),
  );
  return {
    type: 'flex',
    altText: t(lang, 'preorderBottles'),
    contents: { type: 'carousel', contents: bubbles },
    quickReply: { items: [qr(postback(t(lang, 'preorderDone'), { a: 'bottle_done', b: bookingId }))] },
  };
}

export interface PreorderView {
  lines: { name: string; nameTh: string; qty: number; lineTotalSatang: number }[];
  totalSatang: number;
}

const preorderLines = (lang: Lang, p: PreorderView) =>
  p.lines.map((l) => `${l.qty}× ${lang === 'th' ? l.nameTh : l.name} · ${formatBaht(l.lineTotalSatang)}`).join('\n');

export function preorderSummary(lang: Lang, view: BookingView, p: PreorderView): Message {
  const b = view.booking;
  const body = p.lines.length
    ? t(lang, 'preorderSummary', { code: view.table.code, night: formatNight(b.nightDate, lang), lines: preorderLines(lang, p), total: formatBaht(p.totalSatang) })
    : t(lang, 'preorderEmpty');
  return text(body, [
    qr(postback(t(lang, 'preorderAddMore'), { a: 'bottles', b: b.id })),
    ...(p.lines.length ? [qr(postback(t(lang, 'preorderClear'), { a: 'bottle_clear', b: b.id }))] : []),
    qr(postback(t(lang, 'preorderDone'), { a: 'bottle_done', b: b.id })),
  ]);
}

export function staffPreorder(view: BookingView, p: PreorderView): Message {
  const b = view.booking;
  return text(
    [
      '🍾 Pre-order / สั่งขวดล่วงหน้า',
      `${view.table.code} · ${formatNight(b.nightDate, 'en')} · ${b.refCode}`,
      p.lines.length ? preorderLines('en', p) : 'Cleared / ยกเลิกรายการ',
      `Total ${formatBaht(p.totalSatang)} (not charged)`,
    ].join('\n'),
  );
}

// ---------- Staff alerts (always Thai + English in one message) ----------

export function staffNewBooking(view: BookingView, kind: 'confirmed' | 'review'): Message {
  const b = view.booking;
  const head = kind === 'confirmed' ? '✅ New booking / จองใหม่' : '🧾 Slip to check / ตรวจสลิป';
  const lines = [
    head,
    `${view.table.code} · ${formatNight(b.nightDate, 'en')} · ${b.pax} pax`,
    `${view.guest.name ?? view.guest.displayName ?? 'Guest'}${view.guest.nationality ? ` (${view.guest.nationality})` : ''}${view.guest.phone ? ` · ${view.guest.phone}` : ''}`,
    `Min ${formatBaht(b.minSpendSatang)} · Deposit ${formatBaht(b.depositSatang)} · ${b.refCode}`,
  ];
  if (b.specialRequest) lines.push(`Request: ${b.specialRequest}`);
  return text(lines.join('\n'));
}

export function staffHandoff(guestName: string, summary: string): Message {
  return text(`🙋 Guest wants a host / ลูกค้าต้องการคุยกับพนักงาน\n${guestName}\n${summary}\nReply in LINE OA Manager, then mark it resolved in the dashboard.`);
}
