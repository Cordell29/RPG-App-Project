import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EventDraft, ReducerError, replay } from '@tavern/shared';
import { describe, expect, it } from 'vitest';
import { randomEvents } from '../../../packages/shared/test/randomEvents.ts';
import { seededLog } from '../../../packages/shared/test/fixtures.ts';
import { EventStore } from '../src/db/eventStore.ts';
import { eq } from 'drizzle-orm';
import { snapshots } from '../src/db/schema.ts';
import { insertRoom, testDb, toDraft } from './helpers.ts';

function setup(file?: string) {
  const db = testDb(file);
  const roomId = insertRoom(db);
  const store = new EventStore(db, { now: () => '2026-10-16T00:00:00.000Z' });
  return { db, roomId, store };
}

const chat = (text: string): EventDraft => ({
  type: 'chat_message',
  actorId: 'p1',
  turnId: null,
  payload: { playerId: 'p1', text },
});

describe('EventStore', () => {
  it('assigns gapless seqs and round-trips events', () => {
    const { roomId, store } = setup();
    const seeded = seededLog().events;
    const written = store.append(roomId, seeded.map(toDraft));
    expect(written.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    store.append(roomId, [chat('hi')]);
    const loaded = store.loadEvents(roomId);
    expect(loaded.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(store.getState(roomId)).toEqual(replay(loaded));
    expect(store.loadEvents(roomId, 4).map((e) => e.seq)).toEqual([5, 6]);
  });

  it('writes nothing when any event in a batch is invalid', () => {
    const { roomId, store } = setup();
    store.append(roomId, seededLog().events.map(toDraft));
    const before = store.getState(roomId);
    const bad: EventDraft = {
      type: 'delta_applied',
      actorId: null,
      turnId: null,
      payload: { delta: { type: 'change_gold', characterId: 'c1', amount: -1000 } },
    };
    expect(() => store.append(roomId, [chat('ok'), bad])).toThrow(ReducerError);
    expect(store.loadEvents(roomId)).toHaveLength(5);
    expect(store.getState(roomId)).toEqual(before);
    expect(() => store.append(roomId, [chat('')])).toThrow();
    expect(store.loadEvents(roomId)).toHaveLength(5);
  });

  it('snapshots every 25 events and reloads from snapshot + tail', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tavern-')), 'store.db');
    const { db, roomId, store } = setup(file);
    const drafts = randomEvents(260, 7, { voids: false }).map(toDraft);
    for (let i = 0; i < drafts.length; i += 7) store.append(roomId, drafts.slice(i, i + 7));
    const seqs = db.select().from(snapshots).all().map((s) => s.seq);
    expect(seqs.length).toBeGreaterThanOrEqual(9);
    expect(seqs.filter((s) => s % 25 !== 0)).toEqual([]);

    const fresh = new EventStore(testDb(file));
    expect(fresh.getState(roomId)).toEqual(replay(store.loadEvents(roomId)));
    expect(fresh.latestSnapshot(roomId)!.seq).toBe(Math.max(...seqs));
  });

  it('voiding a turn rolls state back and invalidates later snapshots', () => {
    const { db, roomId, store } = setup();
    store.append(roomId, seededLog().events.map(toDraft));
    store.append(roomId, [
      { type: 'action_submitted', actorId: 'p1', turnId: null, payload: { playerId: 'p1', characterId: 'c1', text: 'steal' } },
      { type: 'turn_started', actorId: null, turnId: 't1', payload: { turnId: 't1', actionSeqs: [6] } },
      {
        type: 'delta_applied',
        actorId: null,
        turnId: 't1',
        payload: { delta: { type: 'change_gold', characterId: 'c1', amount: 90 } },
      },
      { type: 'narration', actorId: null, turnId: 't1', payload: { turnId: 't1', text: 'Rich!' } },
    ]);
    // Pad past a snapshot boundary so a snapshot contains the soon-to-be-voided turn.
    store.append(roomId, Array.from({ length: 20 }, (_, i) => chat(`pad ${i}`)));
    expect(db.select().from(snapshots).all().map((s) => s.seq)).toEqual([25]);
    expect(store.getState(roomId).party[0]!.gold).toBe(100);

    store.append(roomId, [{ type: 'turn_voided', actorId: 'p1', turnId: null, payload: { turnId: 't1' } }]);
    const state = store.getState(roomId);
    expect(state.party[0]!.gold).toBe(10);
    expect(state.turn.pending.map((a) => a.seq)).toEqual([6]);
    expect(db.select().from(snapshots).all().map((s) => s.seq)).toEqual([30]);

    const fresh = new EventStore(db);
    expect(fresh.getState(roomId)).toEqual(state);
  });

  it('rebuild replays from scratch and replaces snapshots', () => {
    const { db, roomId, store } = setup();
    const drafts = randomEvents(120, 3).map(toDraft);
    store.append(roomId, drafts);
    const expected = replay(store.loadEvents(roomId));
    const latest = store.latestSnapshot(roomId)!;
    db.update(snapshots)
      .set({ stateJson: JSON.stringify({ ...latest.state, roomName: 'CORRUPT' }) })
      .where(eq(snapshots.seq, latest.seq))
      .run();
    store.forget(roomId);
    expect(store.getState(roomId).roomName).toBe('CORRUPT');
    expect(store.rebuild(roomId)).toEqual(expected);
    expect(db.select().from(snapshots).all().map((s) => s.seq)).toEqual([expected.seq]);
    store.forget(roomId);
    expect(store.getState(roomId)).toEqual(expected);
  });

  it('1,000 random events through SQLite give the same state as an in-memory replay', () => {
    const { db, roomId, store } = setup();
    const events = randomEvents(1000, 20261016);
    const drafts = events.map(toDraft);
    for (let i = 0; i < drafts.length; i += 13) store.append(roomId, drafts.slice(i, i + 13));
    expect(store.getState(roomId)).toEqual(replay(events));
    expect(new EventStore(db).getState(roomId)).toEqual(replay(events));
  });
});
