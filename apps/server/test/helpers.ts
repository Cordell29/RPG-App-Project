import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventDraft, GameEvent } from '@tavern/shared';
import { type Db, openDb } from '../src/db/connection.ts';
import { rooms } from '../src/db/schema.ts';

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'tavern-test-'));
}

export function testDb(file = ':memory:'): Db {
  return openDb(file);
}

export function insertRoom(db: Db, id = 'room1') {
  db.insert(rooms).values({ id, name: 'Test', hostTokenHash: 'x', createdAt: '2026-01-01T00:00:00Z' }).run();
  return id;
}

export function toDraft(e: GameEvent): EventDraft {
  const { seq: _seq, createdAt: _createdAt, ...draft } = e;
  return draft as EventDraft;
}
