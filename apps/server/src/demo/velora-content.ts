/**
 * Velora (Demo): content for the fictional demo club (spec §12.4). Pure data, no database code.
 * `applyClubContent` (demo/apply-content.ts) writes it for a club; B7 seeds Velora from it.
 *
 * Rules this file follows (checked by test/velora-content.test.ts):
 * - Money is integer satang.
 * - FAQ answers and policies state no prices and no table codes. Prices and availability only
 *   ever come from the booking system (spec §8.2, §8.5).
 * - `gaps` are real guest questions deliberately left out of `faqs`, for the learning demo
 *   (§12.4 step 4–5). Their answers are what a host would reply; B7 does not insert them.
 * - Floor positions are on a 0–100 grid (x left to right, y front of stage to the bar).
 */

export type ZoneKind = 'vip' | 'booth' | 'high' | 'standing';
export type TableShape = 'round' | 'rect' | 'booth' | 'bar';

export interface VeloraZone {
  code: string;
  kind: ZoneKind;
  name_en: string;
  name_th: string;
  sort: number;
  /** Base price (Wednesday). Weekend and event-night prices are in `priceRules`. */
  minSpendSatang: number;
  depositSatang: number;
}

export interface VeloraTable {
  code: string;
  /** VeloraZone.code */
  zone: string;
  minPax: number;
  maxPax: number;
  floorX: number;
  floorY: number;
  shape: TableShape;
  sort: number;
  /** Table's own base price; null means the zone's. */
  minSpendSatang: number | null;
  depositSatang: number | null;
}

export interface VeloraPriceRule {
  scope: 'club' | 'zone' | 'table';
  /** Zone code or table code; null for scope 'club'. */
  target: string | null;
  /** 0 = Sunday … 6 = Saturday; null = every open night. */
  weekday: number | null;
  minSpendSatang: number;
  depositSatang: number;
  /** Higher wins when several rules match a night. */
  priority: number;
  label: string;
}

export interface VeloraProfile {
  capacityStanding: number;
  /** Sum of every table's maximum guests. */
  capacitySeated: number;
  lat: number;
  lng: number;
  district: string;
  venueType: 'nightclub';
  genres: string[];
  priceBand: 'budget' | 'mid' | 'premium' | 'luxury';
  openWeekdays: number[];
  openingHours: { open: string; close: string; lastEntry: string };
  arrivalCutoff: string;
  eventNight: { weekday: number; name_en: string; name_th: string };
  usualPeakHour: string;
  licenceType: 'entertainment_venue';
  crowdMix: 'mostly_local' | 'mixed' | 'mostly_tourist';
  guestlistOffered: boolean;
  posVendor: 'wongnai' | 'foodstory' | 'other' | 'none';
}

export interface VeloraFaq {
  slug: string;
  question_en: string;
  question_th: string;
  answer_en: string;
  answer_th: string;
}

export type VeloraGap = Omit<VeloraFaq, 'slug'>;

// Prices in satang (฿1 = 100 satang).
const baht = (n: number) => n * 100;

const zones: VeloraZone[] = [
  { code: 'VIP', kind: 'vip', name_en: 'VIP riser', name_th: 'วีไอพี (ยกพื้น)', sort: 1, minSpendSatang: baht(20_000), depositSatang: baht(8_000) },
  { code: 'BOOTH', kind: 'booth', name_en: 'DJ side booth', name_th: 'บูธข้างดีเจ', sort: 2, minSpendSatang: baht(12_000), depositSatang: baht(4_000) },
  { code: 'HIGH', kind: 'high', name_en: 'High tables', name_th: 'โต๊ะสูง', sort: 3, minSpendSatang: baht(5_000), depositSatang: baht(2_000) },
  { code: 'BAR', kind: 'standing', name_en: 'Bar and standing', name_th: 'บาร์และโซนยืน', sort: 4, minSpendSatang: baht(3_000), depositSatang: 0 },
];

const table = (code: string, zone: string, minPax: number, maxPax: number, floorX: number, floorY: number, shape: TableShape, sort: number): VeloraTable => ({
  code, zone, minPax, maxPax, floorX, floorY, shape, sort, minSpendSatang: null, depositSatang: null,
});

// The DJ booth is at the front centre (x 50, y 5); the bar runs along the back (y 95).
const tables: VeloraTable[] = [
  // VIP riser: raised platform facing the DJ.
  table('V1', 'VIP', 6, 12, 15, 15, 'booth', 1),
  table('V2', 'VIP', 6, 12, 35, 15, 'booth', 2),
  table('V3', 'VIP', 6, 12, 65, 15, 'booth', 3),
  table('V4', 'VIP', 6, 12, 85, 15, 'booth', 4),
  // DJ side booths: three each side of the dance floor.
  table('B1', 'BOOTH', 4, 8, 10, 30, 'booth', 5),
  table('B2', 'BOOTH', 4, 8, 10, 45, 'booth', 6),
  table('B3', 'BOOTH', 4, 8, 10, 60, 'booth', 7),
  table('B4', 'BOOTH', 4, 8, 90, 30, 'booth', 8),
  table('B5', 'BOOTH', 4, 8, 90, 45, 'booth', 9),
  table('B6', 'BOOTH', 4, 8, 90, 60, 'booth', 10),
  // High tables: two rows behind the dance floor.
  table('H1', 'HIGH', 2, 4, 25, 72, 'round', 11),
  table('H2', 'HIGH', 2, 4, 40, 72, 'round', 12),
  table('H3', 'HIGH', 2, 4, 60, 72, 'round', 13),
  table('H4', 'HIGH', 2, 4, 75, 72, 'round', 14),
  table('H5', 'HIGH', 2, 4, 25, 82, 'round', 15),
  table('H6', 'HIGH', 2, 4, 40, 82, 'round', 16),
  table('H7', 'HIGH', 2, 4, 60, 82, 'round', 17),
  table('H8', 'HIGH', 2, 4, 75, 82, 'round', 18),
  // Bar standing spots: reserved ledges along the bar.
  table('S1', 'BAR', 2, 4, 20, 95, 'bar', 19),
  table('S2', 'BAR', 2, 4, 35, 95, 'bar', 20),
  table('S3', 'BAR', 2, 4, 50, 95, 'bar', 21),
  table('S4', 'BAR', 2, 4, 65, 95, 'bar', 22),
];

const THURSDAY = 4;
const FRIDAY = 5;
const SATURDAY = 6;

/** Weekend (Fri, Sat) and event-night (Thu) prices per zone. Wednesday uses the zone base price. */
const nightPrices: Record<string, { weekend: [number, number]; event: [number, number] }> = {
  VIP: { weekend: [30_000, 10_000], event: [35_000, 12_000] },
  BOOTH: { weekend: [18_000, 6_000], event: [20_000, 6_000] },
  HIGH: { weekend: [8_000, 3_000], event: [8_000, 3_000] },
  BAR: { weekend: [4_000, 1_000], event: [5_000, 1_000] },
};

const priceRules: VeloraPriceRule[] = zones.flatMap((z) => {
  const p = nightPrices[z.code]!;
  return [
    ...[FRIDAY, SATURDAY].map((weekday) => ({
      scope: 'zone' as const,
      target: z.code,
      weekday,
      minSpendSatang: baht(p.weekend[0]),
      depositSatang: baht(p.weekend[1]),
      priority: 10,
      label: `${z.name_en}: weekend`,
    })),
    {
      scope: 'zone' as const,
      target: z.code,
      weekday: THURSDAY,
      minSpendSatang: baht(p.event[0]),
      depositSatang: baht(p.event[1]),
      priority: 20,
      label: `${z.name_en}: Velora Thursdays (guest DJ)`,
    },
  ];
});

const policies: { en: string; th: string }[] = [
  { en: 'Open Wednesday to Saturday, 22:00–04:00. Last entry 03:00.', th: 'เปิดวันพุธถึงวันเสาร์ 22:00–04:00 น. รับลูกค้าเข้าร้านถึง 03:00 น.' },
  {
    en: 'Table guests arrive by 23:30. A table not claimed by then may be released, unless you have told us you are running late.',
    th: 'ลูกค้าที่จองโต๊ะกรุณามาถึงก่อน 23:30 น. หากไม่มาตามเวลาและไม่ได้แจ้งว่าจะมาสาย โต๊ะอาจถูกปล่อยให้ลูกค้าท่านอื่น',
  },
  { en: 'A deposit confirms the booking and counts towards the table’s minimum spend.', th: 'มัดจำใช้ยืนยันการจองและนำไปหักจากยอดขั้นต่ำของโต๊ะ' },
  {
    en: 'Cancel before 18:00 on the night to move your deposit to another night within 30 days. Later cancellations and no-shows forfeit the deposit.',
    th: 'ยกเลิกก่อน 18:00 น. ของคืนที่จอง สามารถย้ายมัดจำไปใช้คืนอื่นได้ภายใน 30 วัน การยกเลิกหลังจากนั้นหรือไม่มาตามนัดจะถูกริบมัดจำ',
  },
  { en: '20+ only. An original passport or Thai ID card is required at the door.', th: 'อายุ 20 ปีขึ้นไปเท่านั้น ต้องแสดงพาสปอร์ตหรือบัตรประชาชนตัวจริงที่หน้าร้าน' },
  {
    en: 'Smart casual. No sportswear, flip-flops, shorts or sleeveless tops for men.',
    th: 'แต่งกายแบบสมาร์ทแคชชวล ผู้ชายงดชุดกีฬา รองเท้าแตะ กางเกงขาสั้น และเสื้อแขนกุด',
  },
  { en: 'Zero tolerance for drugs and weapons. Outside food and drinks are not allowed.', th: 'ห้ามยาเสพติดและอาวุธโดยเด็ดขาด ห้ามนำอาหารและเครื่องดื่มจากภายนอกเข้าร้าน' },
  { en: 'Prices include 7% VAT. A 10% service charge is added to the bill.', th: 'ราคารวม VAT 7% แล้ว และมีค่าบริการ 10% เพิ่มในบิล' },
  { en: 'The door team may refuse entry, and their decision is final.', th: 'ทีมหน้าร้านขอสงวนสิทธิ์ในการปฏิเสธการเข้าร้าน และการตัดสินถือเป็นที่สิ้นสุด' },
];

/** The onboarding template pack (spec §8.2), answered for Velora. */
const faqs: VeloraFaq[] = [
  {
    slug: 'dress-code',
    question_en: 'What’s the dress code?',
    question_th: 'การแต่งกายต้องเป็นแบบไหน?',
    answer_en: 'Smart casual. Men: no sportswear, flip-flops, shorts or sleeveless tops. The door team has the final say.',
    answer_th: 'แต่งกายสุภาพแบบสมาร์ทแคชชวลค่ะ ผู้ชายงดชุดกีฬา รองเท้าแตะ กางเกงขาสั้น และเสื้อแขนกุด การตัดสินของทีมหน้าร้านถือเป็นที่สิ้นสุด',
  },
  {
    slug: 'age-and-id',
    question_en: 'Is there an age limit, and what ID do I need?',
    question_th: 'มีจำกัดอายุไหม ต้องใช้บัตรอะไร?',
    answer_en: '20+ only. Bring your original passport or Thai ID card. Photos or copies of ID are not accepted.',
    answer_th: 'อายุ 20 ปีขึ้นไปเท่านั้นค่ะ กรุณานำพาสปอร์ตหรือบัตรประชาชนตัวจริงมาด้วย ไม่รับรูปถ่ายหรือสำเนาบัตร',
  },
  {
    slug: 'opening-hours',
    question_en: 'What are your opening hours?',
    question_th: 'ร้านเปิดกี่โมงถึงกี่โมง?',
    answer_en: 'Wednesday to Saturday, 22:00 to 04:00. We are closed Sunday to Tuesday.',
    answer_th: 'เปิดวันพุธถึงวันเสาร์ เวลา 22:00–04:00 น. ปิดวันอาทิตย์ถึงวันอังคารค่ะ',
  },
  {
    slug: 'last-entry',
    question_en: 'What time is last entry?',
    question_th: 'เข้าร้านได้ถึงกี่โมง?',
    answer_en: 'Last entry is 03:00.',
    answer_th: 'รับลูกค้าเข้าร้านถึง 03:00 น. ค่ะ',
  },
  {
    slug: 'entry-fee',
    question_en: 'Do I have to pay to get in?',
    question_th: 'เข้าร้านต้องเสียค่าเข้าไหม?',
    answer_en: 'Guests with a table booking get in free. Walk-in guests pay an entry fee at the door, which includes a welcome drink and changes by night.',
    answer_th: 'ลูกค้าที่จองโต๊ะเข้าฟรีค่ะ ลูกค้า walk-in ชำระค่าเข้าที่หน้าร้าน รวมเครื่องดื่มต้อนรับหนึ่งแก้ว ราคาขึ้นอยู่กับแต่ละคืน',
  },
  {
    slug: 'table-booking',
    question_en: 'How do I book a table?',
    question_th: 'จองโต๊ะยังไง?',
    answer_en: 'Tap Book a table in this chat, choose the night, your party size and a table, then pay the deposit by PromptPay. Your confirmation and door QR arrive here.',
    answer_th: 'กด “จองโต๊ะ” ในแชทนี้ เลือกคืน จำนวนคน และโต๊ะ แล้วชำระมัดจำผ่านพร้อมเพย์ คุณจะได้รับการยืนยันและ QR สำหรับเข้าร้านในแชทนี้ค่ะ',
  },
  {
    slug: 'minimum-spend',
    question_en: 'What is a minimum spend?',
    question_th: 'ยอดขั้นต่ำคืออะไร?',
    answer_en: 'Each table has a minimum spend for the night, set by zone and night. Drinks and food count towards it, and your deposit is part of it. You see the exact amount on the table card before you book.',
    answer_th: 'แต่ละโต๊ะมียอดใช้จ่ายขั้นต่ำต่อคืน ขึ้นอยู่กับโซนและคืนที่จอง ค่าเครื่องดื่มและอาหารนับรวมในยอดนี้ และมัดจำนำไปหักจากยอดขั้นต่ำ คุณจะเห็นยอดที่แน่นอนบนการ์ดโต๊ะก่อนจองค่ะ',
  },
  {
    slug: 'deposit',
    question_en: 'Do I need to pay a deposit?',
    question_th: 'ต้องจ่ายมัดจำไหม?',
    answer_en: 'Most tables need a deposit to confirm the booking, paid by PromptPay. It counts towards your minimum spend on the night.',
    answer_th: 'โต๊ะส่วนใหญ่ต้องชำระมัดจำเพื่อยืนยันการจองผ่านพร้อมเพย์ค่ะ มัดจำจะนำไปหักจากยอดขั้นต่ำในคืนนั้น',
  },
  {
    slug: 'cancellation',
    question_en: 'Can I cancel my booking?',
    question_th: 'ยกเลิกการจองได้ไหม?',
    answer_en: 'Cancel before 18:00 on the night and we move your deposit to another night within 30 days. Later cancellations and no-shows lose the deposit.',
    answer_th: 'หากยกเลิกก่อน 18:00 น. ของคืนที่จอง เราจะย้ายมัดจำไปใช้คืนอื่นได้ภายใน 30 วัน หากยกเลิกหลังจากนั้นหรือไม่มาตามนัด มัดจำจะไม่สามารถคืนได้ค่ะ',
  },
  {
    slug: 'running-late',
    question_en: 'What if we’re running late?',
    question_th: 'ถ้ามาสายจะเป็นอะไรไหม?',
    answer_en: 'Please arrive by 23:30. If you will be late, tell us in this chat and we will hold your table as long as we can. Without a message, the table may be released after 23:30.',
    answer_th: 'กรุณามาถึงก่อน 23:30 น. หากจะมาสาย แจ้งเราในแชทนี้ได้เลย เราจะเก็บโต๊ะไว้ให้นานที่สุดเท่าที่ทำได้ หากไม่ได้แจ้ง โต๊ะอาจถูกปล่อยหลัง 23:30 น. ค่ะ',
  },
  {
    slug: 'birthday-cake',
    question_en: 'Can I bring a birthday cake?',
    question_th: 'นำเค้กวันเกิดมาเองได้ไหม?',
    answer_en: 'Yes, with a table booking. Mention it in your booking’s special request and we will keep it in the fridge and bring it out with candles.',
    answer_th: 'ได้ค่ะ สำหรับลูกค้าที่จองโต๊ะ แจ้งไว้ในช่องคำขอพิเศษตอนจอง ทางร้านจะเก็บเค้กในตู้เย็นและนำออกมาพร้อมเทียนให้ค่ะ',
  },
  {
    slug: 'decorations',
    question_en: 'Can you arrange sparklers or a birthday sign?',
    question_th: 'ทางร้านจัดพลุเย็นหรือป้ายวันเกิดให้ได้ไหม?',
    answer_en: 'Yes. A host can arrange sparkler bottle service and a light-up birthday sign. Ask in this chat when you book.',
    answer_th: 'ได้ค่ะ พนักงานจัดเซอร์วิสขวดพร้อมพลุเย็นและป้ายไฟวันเกิดให้ได้ แจ้งในแชทนี้ตอนจองได้เลย',
  },
  {
    slug: 'bottle-keep',
    question_en: 'Can I keep an unfinished bottle?',
    question_th: 'ฝากขวดเหล้าที่ดื่มไม่หมดได้ไหม?',
    answer_en: 'Yes. Unfinished spirit bottles can be kept for 30 days under your name and phone number.',
    answer_th: 'ได้ค่ะ ขวดเหล้าที่ดื่มไม่หมดฝากไว้ได้ 30 วัน โดยใช้ชื่อและเบอร์โทรของคุณ',
  },
  {
    slug: 'payment-methods',
    question_en: 'How can I pay at the club?',
    question_th: 'ที่ร้านชำระเงินด้วยอะไรได้บ้าง?',
    answer_en: 'Cash, Thai QR, and Visa or Mastercard, at the bar and at tables. Booking deposits are paid by PromptPay in this chat.',
    answer_th: 'รับเงินสด Thai QR และบัตร Visa หรือ Mastercard ทั้งที่บาร์และที่โต๊ะค่ะ ส่วนมัดจำการจองชำระผ่านพร้อมเพย์ในแชทนี้',
  },
  {
    slug: 'vat-service-charge',
    question_en: 'Do prices include VAT and service charge?',
    question_th: 'ราคารวม VAT และค่าบริการหรือยัง?',
    answer_en: 'Menu prices include 7% VAT. A 10% service charge is added to the bill.',
    answer_th: 'ราคาในเมนูรวม VAT 7% แล้วค่ะ และมีค่าบริการ 10% เพิ่มในบิล',
  },
  {
    slug: 'parking',
    question_en: 'Is there parking?',
    question_th: 'มีที่จอดรถไหม?',
    answer_en: 'Valet parking is available at the entrance from 21:30. Spaces are limited on Fridays and Saturdays.',
    answer_th: 'มีบริการรับจอดรถที่หน้าร้านตั้งแต่ 21:30 น. ค่ะ วันศุกร์และวันเสาร์ที่จอดมีจำนวนจำกัด',
  },
  {
    slug: 'getting-here',
    question_en: 'How do I get there?',
    question_th: 'เดินทางไปยังไง?',
    answer_en: 'We are in Thonglor, a 10-minute walk or a short taxi ride from BTS Thong Lo. Tap Location in the menu for the map.',
    answer_th: 'ร้านอยู่ย่านทองหล่อ เดินจาก BTS ทองหล่อประมาณ 10 นาที หรือนั่งแท็กซี่ระยะสั้น กด “แผนที่” ในเมนูเพื่อดูแผนที่ได้เลยค่ะ',
  },
  {
    slug: 'lost-property',
    question_en: 'I lost something at the club. What should I do?',
    question_th: 'ลืมของไว้ที่ร้าน ต้องทำยังไง?',
    answer_en: 'Message us here with what you lost and the night you visited. Items are kept for 14 days and can be collected from 20:00 on open nights.',
    answer_th: 'แจ้งเราในแชทนี้ว่าลืมอะไรไว้และมาที่ร้านคืนไหน ทางร้านเก็บของไว้ 14 วัน รับคืนได้ตั้งแต่ 20:00 น. ในวันที่ร้านเปิดค่ะ',
  },
  {
    slug: 'smoking',
    question_en: 'Can I smoke inside?',
    question_th: 'สูบบุหรี่ในร้านได้ไหม?',
    answer_en: 'No. Smoking is only allowed in the outdoor smoking area by the entrance. E-cigarettes are illegal in Thailand and not allowed anywhere at the club.',
    answer_th: 'ไม่ได้ค่ะ สูบบุหรี่ได้เฉพาะในพื้นที่สูบบุหรี่ด้านนอกบริเวณทางเข้า บุหรี่ไฟฟ้าผิดกฎหมายในประเทศไทยและห้ามใช้ทุกพื้นที่ของร้าน',
  },
  {
    slug: 'food',
    question_en: 'Do you serve food?',
    question_th: 'มีอาหารไหม?',
    answer_en: 'Yes, bar snacks and sharing plates until 02:00. Food counts towards your table’s minimum spend.',
    answer_th: 'มีค่ะ มีอาหารทานเล่นและอาหารจานแชร์ถึง 02:00 น. ค่าอาหารนับรวมในยอดขั้นต่ำของโต๊ะ',
  },
  {
    slug: 'music',
    question_en: 'What music do you play?',
    question_th: 'ร้านเปิดเพลงแนวไหน?',
    answer_en: 'House and tech house most nights, with a guest DJ every Thursday.',
    answer_th: 'เพลงแนวเฮาส์และเทคเฮาส์เกือบทุกคืน และมีดีเจรับเชิญทุกวันพฤหัสบดีค่ะ',
  },
  {
    slug: 'event-night',
    question_en: 'What’s on Thursday?',
    question_th: 'คืนวันพฤหัสมีอะไร?',
    answer_en: 'Velora Thursdays: a guest DJ night every week. Tables go fast, so book early.',
    answer_th: 'Velora Thursdays คืนดีเจรับเชิญทุกสัปดาห์ค่ะ โต๊ะเต็มเร็ว แนะนำให้จองล่วงหน้า',
  },
  {
    slug: 'large-groups',
    question_en: 'Can you take a big group?',
    question_th: 'มากันเป็นกลุ่มใหญ่ได้ไหม?',
    answer_en: 'Yes. Groups of up to 12 can book a table here in the chat. For 13 or more, a host will arrange joined tables with you personally.',
    answer_th: 'ได้ค่ะ กลุ่มไม่เกิน 12 คนจองโต๊ะในแชทนี้ได้เลย กลุ่ม 13 คนขึ้นไป พนักงานจะช่วยจัดโต๊ะต่อกันให้โดยตรง',
  },
  {
    slug: 'photography',
    question_en: 'Can I take photos and videos?',
    question_th: 'ถ่ายรูปและวิดีโอในร้านได้ไหม?',
    answer_en: 'Phone photos and videos are fine. Professional cameras and filming for commercial use need the club’s permission first.',
    answer_th: 'ถ่ายรูปและวิดีโอด้วยมือถือได้ค่ะ กล้องมืออาชีพหรือการถ่ายทำเพื่อการค้าต้องได้รับอนุญาตจากทางร้านก่อน',
  },
  {
    slug: 'cloakroom',
    question_en: 'Is there a cloakroom or lockers?',
    question_th: 'มีที่ฝากของหรือล็อกเกอร์ไหม?',
    answer_en: 'Yes, a staffed cloakroom by the entrance for bags and jackets. Please keep valuables with you.',
    answer_th: 'มีจุดรับฝากกระเป๋าและเสื้อแจ็กเก็ตบริเวณทางเข้าค่ะ ของมีค่ากรุณาเก็บไว้กับตัว',
  },
];

/** Deliberately unanswered, for the learning demo (§12.4 steps 4–5). Not inserted into the brain. */
const gaps: VeloraGap[] = [
  {
    question_en: 'Can we hire a private room or book the whole club for an event?',
    question_th: 'เช่าห้องส่วนตัวหรือเหมาทั้งร้านจัดงานได้ไหม?',
    answer_en: 'Yes. The upstairs lounge takes up to 40 guests for private events, and the whole club can be booked Sunday to Tuesday, when we are closed. A host will send you the details.',
    answer_th: 'ได้ค่ะ เลานจ์ชั้นบนรองรับได้ถึง 40 ท่านสำหรับงานส่วนตัว และเหมาทั้งร้านได้ในวันอาทิตย์ถึงวันอังคารที่ร้านปิด พนักงานจะส่งรายละเอียดให้ค่ะ',
  },
  {
    question_en: 'Is the club wheelchair accessible?',
    question_th: 'ร้านรองรับรถเข็นไหม?',
    answer_en: 'Yes. The main floor and the accessible toilet are step-free from the entrance. The VIP riser has two steps, so let us know and we will seat you on the main floor.',
    answer_th: 'รองรับค่ะ ชั้นหลักและห้องน้ำสำหรับผู้ใช้รถเข็นไม่มีขั้นบันไดตั้งแต่ทางเข้า ส่วนโซนวีไอพียกพื้นมีบันได 2 ขั้น แจ้งเราได้เลย เราจะจัดที่นั่งชั้นหลักให้',
  },
  {
    question_en: 'Can I leave and come back in?',
    question_th: 'ออกไปข้างนอกแล้วกลับเข้ามาใหม่ได้ไหม?',
    answer_en: 'Yes, until 02:00, with the wristband you get at the door. After 02:00 re-entry is not possible.',
    answer_th: 'ได้ค่ะ จนถึง 02:00 น. โดยแสดงริสต์แบนด์ที่ได้รับที่หน้าร้าน หลัง 02:00 น. ไม่สามารถกลับเข้ามาใหม่ได้',
  },
];

const profile: VeloraProfile = {
  capacityStanding: 450,
  capacitySeated: tables.reduce((n, t) => n + t.maxPax, 0),
  lat: 13.7306,
  lng: 100.5822,
  district: 'Thonglor',
  venueType: 'nightclub',
  genres: ['house', 'tech_house'],
  priceBand: 'premium',
  openWeekdays: [3, 4, 5, 6],
  openingHours: { open: '22:00', close: '04:00', lastEntry: '03:00' },
  arrivalCutoff: '23:30',
  eventNight: { weekday: THURSDAY, name_en: 'Velora Thursdays (guest DJ)', name_th: 'Velora Thursdays (ดีเจรับเชิญ)' },
  usualPeakHour: '01:00',
  licenceType: 'entertainment_venue',
  crowdMix: 'mixed',
  guestlistOffered: false,
  posVendor: 'wongnai',
};

export const VELORA: {
  zones: VeloraZone[];
  tables: VeloraTable[];
  priceRules: VeloraPriceRule[];
  policies: { en: string; th: string }[];
  faqs: VeloraFaq[];
  gaps: VeloraGap[];
  profile: VeloraProfile;
} = { zones, tables, priceRules, policies, faqs, gaps, profile };
