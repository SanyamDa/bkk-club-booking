import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config.js';
import type { ImportImage, OcrFn } from './import.js';

/**
 * Photo import OCR (spec §8.2 "Paste or photo import"): reads the text of a menu or house-rules
 * photo for `importPhoto`. Production uses Anthropic vision (`claude-haiku-5-5`) when
 * `ANTHROPIC_API_KEY` is set; tests inject a fake client or a fake `OcrFn`. Never called in tests.
 */

export const OCR_MODEL = 'claude-haiku-5-5';
/** Largest image accepted: the provider's per-image limit for base64 images. */
export const MAX_IMPORT_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMPORT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type ImportImageType = (typeof IMPORT_IMAGE_TYPES)[number];

export type OcrErrorCode = 'unsupported_type' | 'too_large' | 'ocr_failed' | 'no_text';

/** Photo import failed; no note was created. `message` is shown to the manager. */
export class OcrError extends Error {
  constructor(
    readonly code: OcrErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OcrError';
  }
}

/** The image type from its first bytes (the upload's own content type is not trusted). */
export function sniffImageType(bytes: Uint8Array): ImportImageType | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)
    return 'image/png';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return 'image/webp';
  return null;
}

/** Checks size and type; returns the image with its sniffed type, or throws `OcrError`. */
export function checkImportImage(image: ImportImage): ImportImage & { mimeType: ImportImageType } {
  if (image.bytes.length === 0) throw new OcrError('unsupported_type', 'The file is empty. Upload a JPEG, PNG, WebP or GIF photo.');
  if (image.bytes.length > MAX_IMPORT_IMAGE_BYTES) throw new OcrError('too_large', 'The photo is too large (5 MB at most).');
  const type = sniffImageType(image.bytes);
  if (!type) throw new OcrError('unsupported_type', 'Only JPEG, PNG, WebP or GIF photos can be imported.');
  return { bytes: image.bytes, mimeType: type };
}

/** The reply the model gives when the photo has no readable text. */
export const NO_TEXT = 'NO_TEXT';

const OCR_INSTRUCTIONS = [
  'You transcribe a photo a nightclub uploaded (a menu, a house-rules sign, a pinned notice) into notes for its booking assistant.',
  'Write the readable text as markdown: one "# Heading" per topic (for example "# Dress code", "# Age limit", "# Parking"), the text under it.',
  'Keep the original language (Thai, English or both). Do not translate, summarise or add anything that is not in the photo.',
  'Leave out every price, amount, minimum spend, currency figure, table code and any claim about availability or free tables: the booking system gives those, not notes.',
  `If the photo has no readable text, or only prices, reply with exactly ${NO_TEXT}.`,
  'Reply with the markdown only, no preamble.',
].join('\n');

/** The part of the Anthropic client the adapter uses, so tests can pass a fake. */
export interface OcrMessagesClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Pick<Anthropic.Message, 'content' | 'stop_reason'>> };
}

/** `OcrFn` over Anthropic vision. Throws `OcrError('ocr_failed')` on any provider error. */
export function anthropicOcr(client: OcrMessagesClient): OcrFn {
  return async (image) => {
    const { bytes, mimeType } = checkImportImage(image);
    let text: string;
    try {
      const msg = await client.messages.create({
        model: OCR_MODEL,
        max_tokens: 4096,
        system: OCR_INSTRUCTIONS,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType, data: Buffer.from(bytes).toString('base64') } },
              { type: 'text', text: 'Transcribe this photo as described.' },
            ],
          },
        ],
      });
      text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
    } catch (err) {
      throw new OcrError('ocr_failed', `The photo could not be read right now (${(err as Error).message}). Try again, or paste the text instead.`.slice(0, 300));
    }
    return text === NO_TEXT ? '' : text;
  };
}

/** The configured OCR provider: Anthropic vision when `ANTHROPIC_API_KEY` is set, else none. */
export function configuredOcr(config: Pick<Config, 'ANTHROPIC_API_KEY'>): OcrFn | null {
  return config.ANTHROPIC_API_KEY ? anthropicOcr(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 2 })) : null;
}
