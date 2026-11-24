// Persistence (WP-02). node:sqlite — zero dependencies, WAL mode.
// Deviation DV-01: the spec names better-sqlite3; node:sqlite is the stdlib equivalent and
// needs no npm install. Same synchronous API shape.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');

let db = null;

export function openDb(dbPath) {
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate();
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not opened. Call openDb() during bootstrap.');
  return db;
}

function migrate() {
  const hasVersionTable = db
    .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_version'`)
    .get().n > 0;

  const applied = hasVersionTable
    ? new Set(db.prepare('SELECT version FROM schema_version').all().map((r) => r.version))
    : new Set();

  // Migrations are never edited after merge (repo-scaffold §5). Applied in filename order.
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!file.endsWith('.sql')) continue;
    const version = Number.parseInt(file.slice(0, 3), 10);
    if (applied.has(version)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    db.exec(sql);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────

/**
 * Opaque, type-prefixed, time-ordered IDs. Clients must not parse them (api-contract §1).
 * Time-ordered so `ORDER BY id` matches creation order without a second column.
 */
export function newId(prefix) {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = randomUUID().replace(/-/g, '').slice(0, 10);
  return `${prefix}_${t}${r}`;
}

/** UTC ISO-8601 with milliseconds — ONE format everywhere (api-contract §1). */
export function now() {
  return new Date().toISOString();
}

export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const result = fn(d);
    d.exec('COMMIT');
    return result;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

export function closeDb() {
  if (db) { db.close(); db = null; }
}
