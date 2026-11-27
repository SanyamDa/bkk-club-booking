import { date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { clubs } from './core.js';

export const brainNotes = pgTable(
  'brain_notes',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    type: text('type').$type<'faq' | 'policy' | 'layout' | 'event' | 'learned'>().notNull(),
    status: text('status').$type<'draft' | 'live' | 'retired'>().notNull().default('draft'),
    bodyMd: text('body_md').notNull(),
    frontmatter: jsonb('frontmatter').notNull().default({}),
    source: text('source').$type<'onboarding' | 'manual' | 'takeover' | 'import'>().notNull(),
    sourceEpisodeId: text('source_episode_id'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    validFrom: date('valid_from'),
    validUntil: date('valid_until'),
    reviewBy: date('review_by'),
    supersedesId: text('supersedes_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('brain_notes_club_status').on(t.clubId, t.status), index('brain_notes_club_slug').on(t.clubId, t.slug)],
);

export const brainNoteVersions = pgTable(
  'brain_note_versions',
  {
    id: text('id').primaryKey(),
    noteId: text('note_id').notNull().references(() => brainNotes.id),
    bodyMd: text('body_md').notNull(),
    editedBy: text('edited_by'),
    editedAt: timestamp('edited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('brain_note_versions_note').on(t.noteId)],
);

export const brainSnapshots = pgTable(
  'brain_snapshots',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    version: integer('version').notNull(),
    compiledText: text('compiled_text').notNull(),
    tokenCount: integer('token_count').notNull(),
    hash: text('hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('brain_snapshots_club_version').on(t.clubId, t.version)],
);

export type BrainNote = typeof brainNotes.$inferSelect;
