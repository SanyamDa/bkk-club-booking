import { boolean, date, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
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

/** B17: a club's own test set (spec §8.5). Baseline trick cases live in code (`BASELINE_TRICKS`). */
export const brainTestCases = pgTable(
  'brain_test_cases',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    question: text('question').notNull(),
    lang: text('lang').$type<'th' | 'en' | 'mixed' | 'romanised'>().notNull(),
    kind: text('kind').$type<'answer' | 'handoff' | 'booking' | 'menu' | 'trick'>().notNull(),
    /** Reference answer the judge compares against (`answer` cases). */
    reference: text('reference'),
    mustNotContain: jsonb('must_not_contain').$type<string[]>().notNull().default([]),
    source: text('source').$type<'manual' | 'learned' | 'baseline'>().notNull(),
    sourceNoteId: text('source_note_id'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('brain_test_cases_club_question').on(t.clubId, t.question)],
);

/** B17: one run of a club's test set (snapshot compile, model change) or a sampled quality review. */
export const brainTestRuns = pgTable(
  'brain_test_runs',
  {
    id: text('id').primaryKey(),
    clubId: text('club_id').notNull().references(() => clubs.id),
    trigger: text('trigger').$type<'snapshot' | 'model_change' | 'manual' | 'sample_review'>().notNull(),
    snapshotVersion: integer('snapshot_version'),
    model: text('model'),
    status: text('status').$type<'pending' | 'running' | 'passed' | 'failed'>().notNull().default('pending'),
    total: integer('total').notNull().default(0),
    passed: integer('passed').notNull().default(0),
    score: real('score'),
    results: jsonb('results').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('brain_test_runs_club_status').on(t.clubId, t.status)],
);

export type BrainNote = typeof brainNotes.$inferSelect;
export type BrainTestCase = typeof brainTestCases.$inferSelect;
export type BrainTestRun = typeof brainTestRuns.$inferSelect;
