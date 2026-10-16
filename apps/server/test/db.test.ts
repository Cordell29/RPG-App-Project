import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { MigrationError, loadMigrations, migrate } from '../src/db/migrate.ts';
import { allTables } from '../src/db/schema.ts';
import { insertRoom, testDb } from './helpers.ts';

describe('migrations', () => {
  it('create every table with columns matching the Drizzle schema', () => {
    const db = testDb();
    for (const table of Object.values(allTables)) {
      const config = getTableConfig(table);
      const cols = db.$client.prepare(`PRAGMA table_info(${config.name})`).all() as {
        name: string;
        notnull: number;
      }[];
      expect(cols.map((c) => c.name).sort(), config.name).toEqual(config.columns.map((c) => c.name).sort());
      for (const col of config.columns) {
        const dbCol = cols.find((c) => c.name === col.name)!;
        // SQLite reports PK columns of WITHOUT ROWID tables as NOT NULL too.
        expect(dbCol.notnull === 1 || col.primary, `${config.name}.${col.name} notnull`).toBe(col.notNull);
      }
    }
  });

  it('is idempotent', () => {
    const sqlite = new Database(':memory:');
    expect(migrate(sqlite)).toEqual([1]);
    expect(migrate(sqlite)).toEqual([]);
  });

  it('rolls back a failing migration and refuses to continue', () => {
    const sqlite = new Database(':memory:');
    const broken = [...loadMigrations(), { version: 2, name: '0002_broken.sql', sql: 'CREATE TABLE x (a); SELEKT;' }];
    expect(() => migrate(sqlite, broken)).toThrow(MigrationError);
    const versions = sqlite.prepare('SELECT version FROM schema_migrations').all();
    expect(versions).toEqual([{ version: 1 }]);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'x'").get()).toBeUndefined();
  });

  it('refuses a database newer than the code', () => {
    const sqlite = new Database(':memory:');
    migrate(sqlite);
    sqlite.prepare("INSERT INTO schema_migrations VALUES (99, '0099_future.sql', 'now')").run();
    expect(() => migrate(sqlite)).toThrow(/does not know/);
  });

  it('uses WAL mode and foreign keys on a file database', () => {
    const db = testDb(join(mkdtempSync(join(tmpdir(), 'tavern-')), 'test.db'));
    expect(db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('database guards', () => {
  const insert = (db: ReturnType<typeof testDb>, seq: number) =>
    db.$client
      .prepare("INSERT INTO events VALUES ('room1', ?, 'chat_message', NULL, NULL, '{}', 'now')")
      .run(seq);

  it('events are gapless per room', () => {
    const db = testDb();
    insertRoom(db);
    insert(db, 1);
    expect(() => insert(db, 3)).toThrow(/gapless/);
    expect(() => insert(db, 1)).toThrow();
    insert(db, 2);
  });

  it('events are append-only', () => {
    const db = testDb();
    insertRoom(db);
    insert(db, 1);
    expect(() => db.$client.prepare("UPDATE events SET type = 'x'").run()).toThrow(/append-only/);
    expect(() => db.$client.prepare('DELETE FROM events').run()).toThrow(/append-only/);
  });

  it('events need an existing room', () => {
    const db = testDb();
    expect(() => insert(db, 1)).toThrow(/FOREIGN KEY/);
  });

  it('chronicle chapters are immutable', () => {
    const db = testDb();
    insertRoom(db);
    db.$client.prepare("INSERT INTO chronicle_chapters VALUES ('room1', 0, 1, 1, 10, 'text', 'now')").run();
    expect(() => db.$client.prepare("UPDATE chronicle_chapters SET summary = 'rewritten'").run()).toThrow(
      /immutable/,
    );
  });
});
