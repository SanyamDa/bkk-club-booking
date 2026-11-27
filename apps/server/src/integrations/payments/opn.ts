import { createHmac } from 'node:crypto';
import type { Club } from '../../db/schema.js';
import { parseOpnEvent, safeEqualHex, type PaymentGateway, type PaymentGateways } from './gateway.js';

/**
 * Opn Payments (Omise API) adapter (plan A20b). One platform account: the secret key opens charges,
 * the webhook secret checks deliveries. Charges are PromptPay source charges in THB, amount in satang.
 */

export const OPN_API = 'https://api.omise.co';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function opnGateway(opts: { secretKey: string; webhookSecret: string; fetch?: FetchLike; apiBase?: string }): PaymentGateway {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const base = opts.apiBase ?? OPN_API;
  const key = Buffer.from(opts.webhookSecret, 'base64');

  return {
    provider: 'opn',

    async createCharge(club: Club, req) {
      const form = new URLSearchParams({
        amount: String(req.amountSatang),
        currency: 'thb',
        'source[type]': 'promptpay',
        return_uri: req.returnUrl,
        description: `Deposit ${req.bookingId}`,
        'metadata[club_id]': club.id,
        'metadata[booking_id]': req.bookingId,
        'metadata[deposit_id]': req.depositId,
      });
      const res = await doFetch(`${base}/charges`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${opts.secretKey}:`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
          // Opn returns the same charge for a repeated key, so a second tap reuses the charge.
          'idempotency-key': req.depositId,
        },
        body: form.toString(),
      });
      const body = (await res.json().catch(() => ({}))) as {
        object?: string;
        id?: string;
        code?: string;
        authorize_uri?: string | null;
        source?: { scannable_code?: { image?: { download_uri?: string } } };
      };
      // Only the error code goes into the message, never the request (it carries the key).
      if (!res.ok || body.object !== 'charge' || !body.id) throw new Error(`opn charge failed: ${res.status} ${body.code ?? ''}`.trim());
      const payUrl = body.authorize_uri ?? body.source?.scannable_code?.image?.download_uri;
      if (!payUrl) throw new Error('opn charge has no payment URL');
      return { chargeId: body.id, payUrl };
    },

    signatureOf(header) {
      const ts = header('omise-signature-timestamp');
      const sigs = header('omise-signature');
      if (!ts || !sigs) return undefined;
      return `t=${ts},${sigs
        .split(',')
        .map((s) => `v1=${s.trim()}`)
        .join(',')}`;
    },

    verifyWebhook(rawBody, signature) {
      if (!signature || key.length === 0) return null;
      const parts = signature.split(',');
      const ts = parts.find((p) => p.startsWith('t='))?.slice(2);
      const sigs = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
      if (!ts || sigs.length === 0) return null;
      const expected = createHmac('sha256', key).update(`${ts}.${rawBody}`).digest('hex');
      if (!sigs.some((s) => safeEqualHex(s, expected))) return null;
      return parseOpnEvent(rawBody);
    },
  };
}

/** The gateways the config enables: `opn` when both Opn keys are set. */
export function configuredPaymentGateways(config: { OPN_SECRET_KEY?: string; OPN_WEBHOOK_SECRET?: string }): PaymentGateways {
  const out: PaymentGateways = {};
  if (config.OPN_SECRET_KEY && config.OPN_WEBHOOK_SECRET) {
    out.opn = opnGateway({ secretKey: config.OPN_SECRET_KEY, webhookSecret: config.OPN_WEBHOOK_SECRET });
  }
  return out;
}
