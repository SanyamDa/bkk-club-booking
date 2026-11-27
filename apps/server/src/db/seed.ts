import { eq } from 'drizzle-orm';
import { compileSnapshot } from '../brain/compile.js';
import { assertLint } from '../brain/lint.js';
import { REVIEW_AFTER_DAYS } from '../brain/notes.js';
import { applyClubContent } from '../demo/apply-content.js';
import { seedHistory, seedTonight } from '../demo/seed-history.js';
import { VELORA } from '../demo/velora-content.js';
import { addDays, currentNightDate } from '../lib/time.js';
import type { Db } from './client.js';
import { brainNoteVersions, brainNotes, channels, clubProfile, clubs, type ClubSettings } from './schema.js';

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
  // Filled from VELORA.policies by applyClubContent.
  rules: { en: [], th: [] },
  greeting: {
    en: 'Welcome to Velora (Demo). Book a table in under a minute, right here in LINE.',
    th: 'ยินดีต้อนรับสู่ Velora (Demo) จองโต๊ะได้ในไม่ถึงหนึ่งนาที ผ่าน LINE นี้เลย',
  },
  address: 'Demo address, Thonglor, Bangkok',
  mapUrl: 'https://maps.google.com/?q=Thonglor+Bangkok',
};

/**
 * Velora (plan B7, spec §12.4): created once with its content, profile, live FAQ notes, six weeks
 * of history and tonight, all relative to `now`. On an existing database only the env-provided
 * LINE/PromptPay values are refreshed; `resetDemoClub` brings tonight back.
 */
export async function seedDemoClub(db: Db, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): Promise<void> {
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

  await db.transaction(async (tx) => {
    await tx.insert(clubs).values({
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
      status: 'demo',
    });
    await tx.insert(channels).values({ id: `chan_line_${DEMO_CLUB_ID}`, clubId: DEMO_CLUB_ID, kind: 'line' });
    // B7: zones, tables, prices and house rules come from the one content writer (B0).
    await applyClubContent(tx, DEMO_CLUB_ID, VELORA);
    await seedVeloraProfile(tx, DEMO_CLUB_ID);
    await seedVeloraBrain(tx, DEMO_CLUB_ID, now);
    const club = (await tx.query.clubs.findFirst({ where: eq(clubs.id, DEMO_CLUB_ID) }))!;
    await seedHistory(tx, club, now);
    await seedTonight(tx, club, now);
  });
}

/** Velora's `club_profile` row from the content (plan B7). */
async function seedVeloraProfile(tx: Db, clubId: string): Promise<void> {
  const p = VELORA.profile;
  await tx.insert(clubProfile).values({
    clubId,
    capacityStanding: p.capacityStanding,
    capacitySeated: p.capacitySeated,
    lat: p.lat,
    lng: p.lng,
    district: p.district,
    venueType: p.venueType,
    genres: p.genres,
    priceBand: p.priceBand,
    openingHours: { ...p.openingHours, openWeekdays: p.openWeekdays, arrivalCutoff: p.arrivalCutoff, eventNight: p.eventNight },
    usualPeakHour: Number(p.usualPeakHour.split(':')[0]),
    licenceType: p.licenceType,
    crowdMix: p.crowdMix,
    guestlistOffered: p.guestlistOffered,
    posVendor: p.posVendor,
  });
}

/**
 * The FAQ answers as live brain notes (`source = 'onboarding'`), linted like any saved note, then
 * one compiled snapshot. The three deliberate gaps are not inserted (spec §12.4 steps 4–5).
 */
async function seedVeloraBrain(tx: Db, clubId: string, now: Date): Promise<void> {
  const reviewBy = addDays(currentNightDate(now, demoSettings.nightEndHour), REVIEW_AFTER_DAYS);
  const rows = VELORA.faqs.map((f) => {
    const note = {
      id: `note_velora_${f.slug}`,
      clubId,
      slug: f.slug,
      title: f.question_en,
      type: 'faq' as const,
      status: 'live' as const,
      bodyMd: `**${f.question_en}** / **${f.question_th}**\n\n${f.answer_en}\n\n${f.answer_th}`,
      frontmatter: { question_th: f.question_th },
      source: 'onboarding' as const,
      approvedBy: 'platform',
      approvedAt: now,
      reviewBy,
      createdAt: now,
      updatedAt: now,
    };
    assertLint(note);
    return note;
  });
  await tx.insert(brainNotes).values(rows);
  await tx.insert(brainNoteVersions).values(rows.map((n) => ({ id: `${n.id}_v1`, noteId: n.id, bodyMd: n.bodyMd, editedBy: 'platform', editedAt: now })));
  await compileSnapshot(tx, clubId, now);
}
