#!/usr/bin/env node
// B14: create the data source and the starter boards in a running Metabase from dashboards/*.json.
// Run by a founder over the SSH tunnel; not run by tests. Unverified against a real Metabase (see README).
//
//   MB_URL=http://127.0.0.1:3000 MB_USER=... MB_PASSWORD=... METABASE_DB_PASSWORD=... node infra/metabase/provision.mjs
//
// Each card is a native SQL question with a `dataset` text variable (live | demo, default live) and an
// optional `club` variable. A re-run creates new copies; delete the old collection first.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const env = (k, d) => process.env[k] ?? d ?? (() => { throw new Error(`set ${k}`); })();
const base = env('MB_URL', 'http://127.0.0.1:3000');
const dir = fileURLToPath(new URL('./dashboards/', import.meta.url));

async function api(method, path, body, session) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(session ? { 'x-metabase-session': session } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const { id: session } = await api('POST', '/session', { username: env('MB_USER'), password: env('MB_PASSWORD') });
const databases = (await api('GET', '/database', undefined, session)).data ?? [];
let database = databases.find((d) => d.name === 'Club analytics (read-only)');
if (!database) {
  database = await api('POST', '/database', {
    engine: 'postgres',
    name: 'Club analytics (read-only)',
    details: {
      host: env('MB_DATA_HOST', 'db'), port: 5432, dbname: env('POSTGRES_DB', 'club'),
      user: 'metabase_ro', password: env('METABASE_DB_PASSWORD'), 'schema-filters-type': 'inclusion',
      'schema-filters-patterns': 'analytics,analytics_demo',
    },
  }, session);
}
const collection = await api('POST', '/collection', { name: 'Data dashboard (internal)', color: '#509EE3' }, session);

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const board = JSON.parse(readFileSync(dir + file, 'utf8'));
  const tags = Object.fromEntries(board.parameters.map((p) => [p.slug, {
    id: p.slug, name: p.slug, 'display-name': p.name, type: 'text', required: p.slug === 'dataset', default: p.default,
  }]));
  const dash = await api('POST', '/dashboard', { name: board.name, description: board.description, collection_id: collection.id }, session);
  const dashcards = [];
  for (const [i, c] of board.cards.entries()) {
    const card = await api('POST', '/card', {
      name: c.name, display: c.display, collection_id: collection.id, visualization_settings: {},
      dataset_query: { type: 'native', database: database.id, native: { query: c.sql, 'template-tags': tags } },
    }, session);
    dashcards.push({ id: -(i + 1), card_id: card.id, row: i * 8, col: 0, size_x: 24, size_y: 8 });
  }
  await api('PUT', `/dashboard/${dash.id}`, { dashcards }, session);
  console.log(`board ${board.name}: ${board.cards.length} cards`);
}
