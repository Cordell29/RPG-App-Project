import { readdirSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

export const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

export class MigrationError extends Error {
  override name = 'MigrationError';
}

interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function loadMigrations(dir: URL = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number(f.slice(0, 4)), name: f, sql: readFileSync(new URL(f, dir), 'utf8') }));
}

/**
 * Applies pending migrations, each in its own transaction. Throws MigrationError on any
 * failure (the server refuses to start) or if the database is newer than this code.
 */
export function migrate(sqlite: Database.Database, migrations = loadMigrations()): number[] {
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    (sqlite.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  const known = new Set(migrations.map((m) => m.version));
  const unknown = [...applied].filter((v) => !known.has(v));
  if (unknown.length) {
    throw new MigrationError(`database has migrations this build does not know: ${unknown.join(', ')}`);
  }

  const ran: number[] = [];
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    try {
      sqlite.transaction(() => {
        sqlite.exec(m.sql);
        sqlite
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(m.version, m.name, new Date().toISOString());
      })();
    } catch (err) {
      throw new MigrationError(`migration ${m.name} failed: ${(err as Error).message}`);
    }
    ran.push(m.version);
  }
  return ran;
}
