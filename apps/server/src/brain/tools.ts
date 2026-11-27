import type Anthropic from '@anthropic-ai/sdk';
import { normalizeDetails, type BookingDetails, type ExtractContext } from './extract.js';

/**
 * The fixed tool set of the live AI call (spec §8.5, plan B16). Tools are terminal: the server
 * runs one action per guest message and the model is not called again in the turn. No tool input
 * names a club or a guest: the server takes both from its own session, and any such key the model
 * writes is never read. No tool can set a price, waive a deposit or confirm a booking.
 *
 * `reply` carries the fixed result of §8.5 (answer, language, notes used, topic, needs_handoff),
 * so every model turn ends in exactly one tool call.
 */
const detailProps = {
  date: { type: 'string', description: 'Night date YYYY-MM-DD in Bangkok time, resolved from words like "this Saturday" or "เสาร์นี้".' },
  pax: { type: 'integer', description: 'Number of guests.' },
  table_code: { type: 'string', description: 'A table code the guest named, exactly as written in the club brain layout note.' },
  zone_pref: { type: 'string', description: 'A zone name the guest asked for.' },
} as const;

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'reply',
    description:
      'Answer the guest from the club brain only, or report that you cannot. Use this for every question that is not a booking request.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['answer', 'lang', 'notes_used', 'topic', 'needs_handoff', 'unclear', 'summary'],
      properties: {
        answer: { type: 'string', description: "The answer in the guest's language. Empty when needs_handoff or unclear." },
        lang: { type: 'string', enum: ['th', 'en'] },
        notes_used: { type: 'array', items: { type: 'string' }, description: 'The `note:` slugs the answer came from.' },
        topic: { type: 'string', description: 'Short snake_case topic code, e.g. dress_code, parking, birthday_cake.' },
        needs_handoff: { type: 'boolean', description: 'True when the brain has no answer to a clear question.' },
        unclear: { type: 'boolean', description: 'True when you cannot tell what the guest wants.' },
        summary: { type: 'string', description: 'When needs_handoff: two short lines for the host. Otherwise empty.' },
      },
    },
  },
  {
    name: 'check_availability',
    description: 'The guest asks which tables are free on a night. The booking system shows the real options.',
    input_schema: { type: 'object', additionalProperties: false, properties: { date: detailProps.date, pax: detailProps.pax } },
  },
  {
    name: 'start_booking',
    description: 'The guest wants to book a table. Pass every detail they gave; the booking system takes it from there.',
    input_schema: { type: 'object', additionalProperties: false, properties: { ...detailProps } },
  },
  {
    name: 'get_booking',
    description: 'The guest asks about their own booking (status, time, running late).',
    input_schema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'request_handoff',
    description: 'The guest asks for a person, complains, or needs something only staff can do.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['topic', 'summary'],
      properties: {
        topic: { type: 'string', description: 'Short snake_case topic code.' },
        summary: { type: 'string', description: 'Two short lines for the host: what the guest wants and any detail given.' },
      },
    },
  },
];

export type ToolAction =
  | {
      kind: 'reply';
      answer: string;
      lang: 'th' | 'en' | null;
      noteSlugs: string[];
      topic: string;
      needsHandoff: boolean;
      unclear: boolean;
      summary: string;
    }
  | { kind: 'booking'; details: BookingDetails }
  | { kind: 'get_booking' }
  | { kind: 'request_handoff'; topic: string; summary: string };

/** A props-safe topic code (`events.props` holds codes only). */
export function topicCode(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '') : '';
  return s.slice(0, 40) || 'other';
}

/** At most two lines of at most 160 characters each (spec §8.1 "a 2-line summary"). */
export function twoLines(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((l) => l.slice(0, 160))
    .join('\n');
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Reads one tool call. Returns null for an unknown tool name. Only declared fields are read. */
export function parseToolCall(call: { name: string; input: unknown }, ctx: ExtractContext): ToolAction | null {
  const input = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>;
  switch (call.name) {
    case 'reply':
      return {
        kind: 'reply',
        answer: str(input.answer).trim(),
        lang: input.lang === 'th' || input.lang === 'en' ? input.lang : null,
        noteSlugs: Array.isArray(input.notes_used) ? input.notes_used.filter((s): s is string => typeof s === 'string') : [],
        topic: topicCode(input.topic),
        needsHandoff: input.needs_handoff === true,
        unclear: input.unclear === true,
        summary: twoLines(input.summary),
      };
    case 'check_availability':
    case 'start_booking':
      return { kind: 'booking', details: normalizeDetails(input, ctx) };
    case 'get_booking':
      return { kind: 'get_booking' };
    case 'request_handoff':
      return { kind: 'request_handoff', topic: topicCode(input.topic), summary: twoLines(input.summary) };
    default:
      return null;
  }
}
