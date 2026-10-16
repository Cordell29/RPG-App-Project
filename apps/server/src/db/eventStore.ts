import {
  type ApplyOptions,
  type EventDraft,
  type GameEvent,
  type GameState,
  GameEventSchema,
  GameStateSchema,
  apply,
  needsRebuild,
  replay,
} from '@tavern/shared';
import { and, asc, desc, eq, gt, gte } from 'drizzle-orm';
import type { Db } from './connection.ts';
import { events, snapshots } from './schema.ts';

export const SNAPSHOT_EVERY = 25;

export interface EventStoreOptions {
  snapshotEvery?: number;
  now?: () => string;
  reducer?: ApplyOptions;
}

type EventRow = typeof events.$inferSelect;

function rowToEvent(row: EventRow): GameEvent {
  return GameEventSchema.parse({
    seq: row.seq,
    type: row.type,
    actorId: row.actorId,
    turnId: row.turnId,
    createdAt: row.createdAt,
    payload: JSON.parse(row.payloadJson),
  });
}

/**
 * The only writer of the events table. Every append is validated, applied to the
 * room's state (so reducer invariants guard the database) and committed in one
 * transaction. The cached state is updated only after the commit succeeds.
 */
export class EventStore {
  private readonly cache = new Map<string, GameState>();
  private readonly snapshotEvery: number;
  private readonly now: () => string;
  private readonly reducer: ApplyOptions;

  private readonly db: Db;

  constructor(db: Db, options: EventStoreOptions = {}) {
    this.db = db;
    this.snapshotEvery = options.snapshotEvery ?? SNAPSHOT_EVERY;
    this.now = options.now ?? (() => new Date().toISOString());
    this.reducer = options.reducer ?? {};
  }

  loadEvents(roomId: string, afterSeq = 0): GameEvent[] {
    return this.db
      .select()
      .from(events)
      .where(and(eq(events.roomId, roomId), gt(events.seq, afterSeq)))
      .orderBy(asc(events.seq))
      .all()
      .map(rowToEvent);
  }

  latestSnapshot(roomId: string): { seq: number; state: GameState } | null {
    const row = this.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.roomId, roomId))
      .orderBy(desc(snapshots.seq))
      .limit(1)
      .get();
    return row ? { seq: row.seq, state: GameStateSchema.parse(JSON.parse(row.stateJson)) } : null;
  }

  /** Current state: cache, else latest snapshot + tail, else full replay. */
  getState(roomId: string): GameState {
    const cached = this.cache.get(roomId);
    if (cached) return cached;
    const snap = this.latestSnapshot(roomId);
    const tail = this.loadEvents(roomId, snap?.seq ?? 0);
    const state =
      snap && !tail.some(needsRebuild)
        ? replay(tail, snap.state, this.reducer)
        : replay(this.loadEvents(roomId), undefined, this.reducer);
    this.cache.set(roomId, state);
    return state;
  }

  /** Appends drafts atomically. Throws (and writes nothing) if any event is invalid. */
  append(roomId: string, drafts: EventDraft[]): GameEvent[] {
    if (drafts.length === 0) return [];
    const client = this.db.$client;
    const result = client.transaction(() => {
      let state = this.getState(roomId);
      const appended: GameEvent[] = [];
      const due: GameState[] = [];
      let rebuilt = false;
      for (const draft of drafts) {
        const event = GameEventSchema.parse({ ...draft, seq: state.seq + 1, createdAt: this.now() });
        if (needsRebuild(event)) {
          state = replay([...this.loadEvents(roomId), ...appended, event], undefined, this.reducer);
          rebuilt = true;
        } else {
          state = apply(state, event, this.reducer);
        }
        appended.push(event);
        if (event.seq % this.snapshotEvery === 0) due.push(state);
      }
      this.db
        .insert(events)
        .values(
          appended.map((e) => ({
            roomId,
            seq: e.seq,
            type: e.type,
            actorId: e.actorId,
            turnId: e.turnId,
            payloadJson: JSON.stringify(e.payload),
            createdAt: e.createdAt,
          })),
        )
        .run();
      if (rebuilt) this.dropSnapshotsContainingVoids(roomId, appended);
      for (const snap of due) this.writeSnapshot(roomId, snap);
      if (rebuilt) this.writeSnapshot(roomId, state);
      return { appended, state };
    })();
    this.cache.set(roomId, result.state);
    return result.appended;
  }

  /**
   * Writes an imported log verbatim (original seqs and timestamps) into an empty room.
   * The caller has already validated and replayed it; this replays once more so the cache
   * and snapshot come from exactly what was stored. Runs inside the caller's transaction.
   */
  importEvents(roomId: string, log: GameEvent[]): GameState {
    const state = replay(log);
    for (let i = 0; i < log.length; i += 500) {
      this.db
        .insert(events)
        .values(
          log.slice(i, i + 500).map((e) => ({
            roomId,
            seq: e.seq,
            type: e.type,
            actorId: e.actorId,
            turnId: e.turnId,
            payloadJson: JSON.stringify(e.payload),
            createdAt: e.createdAt,
          })),
        )
        .run();
    }
    this.writeSnapshot(roomId, state);
    this.cache.set(roomId, state);
    return state;
  }

  /** Host "Rebuild state": replay everything from scratch and replace the cached snapshot. */
  rebuild(roomId: string): GameState {
    const state = replay(this.loadEvents(roomId), undefined, this.reducer);
    this.db.$client.transaction(() => {
      this.db.delete(snapshots).where(eq(snapshots.roomId, roomId)).run();
      if (state.seq > 0) this.writeSnapshot(roomId, state);
    })();
    this.cache.set(roomId, state);
    return state;
  }

  /** Drop the in-memory cache (tests, or after an external change). */
  forget(roomId: string) {
    this.cache.delete(roomId);
  }

  private writeSnapshot(roomId: string, state: GameState) {
    this.db
      .insert(snapshots)
      .values({ roomId, seq: state.seq, stateJson: JSON.stringify(state) })
      .onConflictDoUpdate({ target: [snapshots.roomId, snapshots.seq], set: { stateJson: JSON.stringify(state) } })
      .run();
  }

  /** Snapshots taken after a voided turn began still contain its effects; remove them. */
  private dropSnapshotsContainingVoids(roomId: string, appended: GameEvent[]) {
    for (const e of appended) {
      if (!needsRebuild(e)) continue;
      const first = this.db
        .select({ seq: events.seq })
        .from(events)
        .where(and(eq(events.roomId, roomId), eq(events.turnId, e.payload.turnId)))
        .orderBy(asc(events.seq))
        .limit(1)
        .get();
      if (first) {
        this.db
          .delete(snapshots)
          .where(and(eq(snapshots.roomId, roomId), gte(snapshots.seq, first.seq)))
          .run();
      }
    }
  }
}
