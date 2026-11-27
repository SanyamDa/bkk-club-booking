import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import generatePayload from 'promptpay-qr';
import QRCode from 'qrcode';
import { bookings, clubs } from '../db/schema.js';
import { verifySignature } from '../lib/util.js';
import type { AppContext } from './context.js';

/** Public, signed images that LINE fetches: PromptPay QR codes and door passes. */
export function mediaRoutes(app: AppContext) {
  const r = new Hono();
  const secret = app.config.APP_SECRET;

  const png = (buf: Buffer) =>
    new Response(new Uint8Array(buf), {
      headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=600' },
    });

  r.get('/promptpay/:file', async (c) => {
    const id = c.req.param('file').replace(/\.png$/, '');
    if (!verifySignature(secret, 'promptpay', id, c.req.query('s'))) return c.text('Not found', 404);
    const booking = await app.deps.db.query.bookings.findFirst({ where: eq(bookings.id, id) });
    if (!booking) return c.text('Not found', 404);
    const club = await app.deps.db.query.clubs.findFirst({ where: eq(clubs.id, booking.clubId) });
    if (!club?.promptpayId) return c.text('Not found', 404);
    // Standard Thai PromptPay QR for the club's own account, exact amount. Money never touches us.
    const payload = generatePayload(club.promptpayId, { amount: booking.depositSatang / 100 });
    return png(await QRCode.toBuffer(payload, { width: 720, margin: 2, errorCorrectionLevel: 'M' }));
  });

  r.get('/pass/:file', async (c) => {
    const ref = c.req.param('file').replace(/\.png$/, '');
    if (!verifySignature(secret, 'pass', ref, c.req.query('s'))) return c.text('Not found', 404);
    const booking = await app.deps.db.query.bookings.findFirst({ where: eq(bookings.refCode, ref) });
    if (!booking) return c.text('Not found', 404);
    return png(await QRCode.toBuffer(ref, { width: 720, margin: 4, errorCorrectionLevel: 'H' }));
  });

  return r;
}
