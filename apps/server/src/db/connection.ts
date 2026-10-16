import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from './migrate.ts';
import { allTables } from './schema.ts';

export type Db = BetterSQLite3Database<typeof allTables> & { $client: Database.Database };

/** Opens (or creates) the database, sets pragmas and runs migrations. Use ':memory:' in tests. */
export function openDb(file: string): Db {
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  migrate(sqlite);
  return drizzle(sqlite, { schema: allTables });
}
