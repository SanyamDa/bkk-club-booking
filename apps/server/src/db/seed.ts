import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { channels, clubs, tables, zones, type ClubSettings } from './schema.js';
import { newLinkCode } from '../lib/util.js';

/**
 * A fictional club used for development and sales demos. Do not rename it to a real venue
 * without that venue's permission.
 */
export const DEMO_CLUB_ID = 'club_demo';
export const DEMO_CLUB_SLUG = 'demo';

const demoSettings: ClubSettings = {
  openWeekdays: [3, 4, 5, 6], // Wed–Sat
  closedDates: [],
  bookingWindowDays: 30,
  holdMinutes: 10,
  nightStartHour: 18,
  nightEndHour: 6,
  arrivalBy: '23:30',
  handoffTimeoutMinutes: 30,
  refPrefix: 'VL',
  accentColor: '#C9A45C',
  rulesVersion: '2026-11-26',
  rules: {
    en: [
      'Deposit is non-refundable',
      'Deposit counts towards your minimum spend',
      '20+ only, ID checked at the door',
      'Smart dress code',
      'Zero tolerance for drugs',
    ],
    th: [
      'มัดจำไม่สามารถคืนได้',
      'มัดจำนำไปหักจากยอดขั้นต่ำ',
      'อายุ 20 ปีขึ้นไป ตรวจบัตรที่หน้าร้าน',
      'แต่งกายสุภาพ',
      'ห้ามยาเสพติดทุกชนิด',
    ],
  },
  greeting: {
    en: 'Welcome to Velora (Demo). Book a table in under a minute, right here in LINE.',
    th: 'ยินดีต้อนรับสู่ Velora (Demo) จองโต๊ะได้ในไม่ถึงหนึ่งนาที ผ่าน LINE นี้เลย',
  },
  address: 'Demo address, Thonglor, Bangkok',
  mapUrl: 'https://maps.google.com/?q=Thonglor+Bangkok',
};

export async function seedDemoClub(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const existing = await db.query.clubs.findFirst({ where: eq(clubs.id, DEMO_CLUB_ID) });
  if (existing) {
    // Keep env-provided LINE/PromptPay values in sync so editing .env just works.
    await db
      .update(clubs)
      .set({
        liffId: env.DEMO_LIFF_ID || null,
        promptpayId: env.DEMO_PROMPTPAY_ID || null,
        lineLoginChannelIdEnv: 'DEMO_LINE_LOGIN_CHANNEL_ID',
        lineLoginChannelSecretEnv: 'DEMO_LINE_LOGIN_CHANNEL_SECRET',
      })
      .where(eq(clubs.id, DEMO_CLUB_ID));
    return;
  }

  await db.insert(clubs).values({
    id: DEMO_CLUB_ID,
    slug: DEMO_CLUB_SLUG,
    name: 'Velora (Demo)',
    settings: demoSettings,
    lineChannelSecretEnv: 'DEMO_LINE_CHANNEL_SECRET',
    lineAccessTokenEnv: 'DEMO_LINE_ACCESS_TOKEN',
    lineLoginChannelIdEnv: 'DEMO_LINE_LOGIN_CHANNEL_ID',
    lineLoginChannelSecretEnv: 'DEMO_LINE_LOGIN_CHANNEL_SECRET',
    liffId: env.DEMO_LIFF_ID || null,
    promptpayId: env.DEMO_PROMPTPAY_ID || null,
    promptpayName: 'Velora Demo Co., Ltd.',
    staffLinkCode: newLinkCode(),
    status: 'demo',
  });
  await db.insert(channels).values({ id: `chan_line_${DEMO_CLUB_ID}`, clubId: DEMO_CLUB_ID, kind: 'line' });

  const z = {
    vip: { id: 'zone_demo_vip', name: 'VIP riser', nameTh: 'โซนวีไอพี', sort: 1, minSpendSatang: 2_500_000, depositSatang: 1_000_000 },
    dj: { id: 'zone_demo_dj', name: 'DJ side booth', nameTh: 'บูธข้างดีเจ', sort: 2, minSpendSatang: 1_500_000, depositSatang: 500_000 },
    std: { id: 'zone_demo_std', name: 'High table', nameTh: 'โต๊ะสูง', sort: 3, minSpendSatang: 800_000, depositSatang: 300_000 },
  };
  await db.insert(zones).values(Object.values(z).map((zone) => ({ ...zone, clubId: DEMO_CLUB_ID })));

  const t = (code: string, zoneId: string, minPax: number, maxPax: number, sort: number) => ({
    id: `table_demo_${code}`,
    clubId: DEMO_CLUB_ID,
    zoneId,
    code,
    minPax,
    maxPax,
    sort,
  });
  await db.insert(tables).values([
    t('V1', z.vip.id, 6, 12, 1),
    t('V2', z.vip.id, 6, 12, 2),
    t('B1', z.dj.id, 4, 8, 3),
    t('B2', z.dj.id, 4, 8, 4),
    t('B3', z.dj.id, 4, 8, 5),
    t('B4', z.dj.id, 4, 8, 6),
    t('T1', z.std.id, 2, 4, 7),
    t('T2', z.std.id, 2, 4, 8),
    t('T3', z.std.id, 2, 4, 9),
    t('T4', z.std.id, 2, 4, 10),
  ]);
}
