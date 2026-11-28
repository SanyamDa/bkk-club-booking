import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { promoterBookingText } from '../bot/flow.js';
import { parseTrackedLinkCode } from '../bot/links.js';
import { channels, clubs, promoters, type Club } from '../db/schema.js';
import { emit } from '../data/events.js';
import type { AppContext } from './context.js';

/**
 * Counted redirects (plan B4, spec §14.2 "Entry points are tagged"). Links LINE opens without telling
 * us go through here, so the tap is an event (`link.opened`) before the 302.
 * - `GET /r/:code`: a signed `<kind>.<slug>.<entry>.<sig>` code (`Links.tracked`); the target is the
 *   club's own setting for that kind, never a URL from the link.
 * - `GET /r/p/:slug/:code`: a promoter's booking link (A20a `promoterLink`). It opens the club's LINE
 *   chat with a pre-filled "Book a table · promo <code>" text; the bot starts an attempt tagged
 *   `link_promoter` and attributes the hold with `attributeBooking(..., 'link', ...)`.
 * Unknown codes, clubs or promoters answer 404, and nothing is recorded.
 */
export function redirectRoutes(app: AppContext) {
  const r = new Hono();
  const { db } = app.deps;

  const opened = (club: Club, kind: string, entry: string) =>
    emit(db, {
      clubId: club.id,
      type: 'link.opened',
      occurredAt: app.deps.now(),
      actorType: 'guest',
      channel: 'line',
      dataOrigin: 'first_party',
      source: entry,
      props: { kind },
      isTest: club.status === 'demo',
    });

  // A18: the club's LINE account, from the OA basic id the LINE setup stored (null before setup).
  const lineAddUrl = async (club: Club): Promise<string | null> => {
    const [line] = await db
      .select({ basicId: channels.externalId })
      .from(channels)
      .where(and(eq(channels.clubId, club.id), eq(channels.kind, 'line')))
      .limit(1);
    return line?.basicId ? `https://line.me/R/ti/p/${encodeURIComponent(line.basicId)}` : null;
  };

  r.get('/p/:slug/:code', async (c) => {
    const club = await db.query.clubs.findFirst({ where: eq(clubs.slug, c.req.param('slug')) });
    if (!club) return c.text('Not found', 404);
    const code = c.req.param('code').trim().toLowerCase();
    const promoter = await db.query.promoters.findFirst({
      where: and(eq(promoters.clubId, club.id), eq(promoters.code, code), isNull(promoters.disabledAt)),
    });
    if (!promoter) return c.text('Not found', 404);
    // `channels.external_id` holds the OA's basic id once the LINE setup ran (A5 wizard).
    const [line] = await db
      .select({ basicId: channels.externalId })
      .from(channels)
      .where(and(eq(channels.clubId, club.id), eq(channels.kind, 'line')))
      .limit(1);
    if (!line?.basicId) return c.text('Not found', 404);
    await opened(club, 'promoter', 'link_promoter');
    return c.redirect(`https://line.me/R/oaMessage/${encodeURIComponent(line.basicId)}/?${encodeURIComponent(promoterBookingText(code))}`, 302);
  });

  r.get('/:code', async (c) => {
    const parsed = parseTrackedLinkCode(app.config.APP_SECRET, c.req.param('code'));
    if (!parsed) return c.text('Not found', 404);
    const club = await db.query.clubs.findFirst({ where: eq(clubs.slug, parsed.slug) });
    if (!club) return c.text('Not found', 404);
    const target = parsed.kind === 'line' ? await lineAddUrl(club) : parsed.kind === 'map' ? club.settings.mapUrl : club.settings.drinksMenuUrl;
    if (!target) return c.text('Not found', 404);
    await opened(club, parsed.kind, parsed.entry);
    return c.redirect(target, 302);
  });

  return r;
}

/**
 * The page the data notice links to (spec §5.5, `Links.privacy()`): the same notice in full, EN and
 * TH. Plain HTML so it opens in LINE's browser without the web app.
 */
export function privacyRoutes() {
  const r = new Hono();
  r.get('/', (c) =>
    c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your data</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:0 auto;padding:24px 16px;background:#121113;color:#F3EFE6}h1{font-size:22px}p{color:#D8D3CA}</style></head>
<body><h1>Your data</h1>
<p>Chats and bookings with the club are stored and used to run the service, improve answers, and for analytics and marketing by the club and by us, the booking platform. We are the data controller.</p>
<p>You can stop promotional messages at any time by typing <b>stop</b>, or ask for your data to be removed from the "My data" menu in the chat.</p>
<h1 lang="th">ข้อมูลของคุณ</h1>
<p lang="th">แชทและการจองกับคลับจะถูกจัดเก็บและใช้เพื่อให้บริการ ปรับปรุงคำตอบ และเพื่อการวิเคราะห์และการตลาดโดยคลับและโดยเรา ซึ่งเป็นแพลตฟอร์มการจองและผู้ควบคุมข้อมูล</p>
<p lang="th">คุณสามารถหยุดรับข้อความโปรโมชันได้ทุกเมื่อโดยพิมพ์ <b>stop</b> หรือขอให้ลบข้อมูลได้จากเมนู "ข้อมูลของฉัน" ในแชท</p>
</body></html>`),
  );
  return r;
}
