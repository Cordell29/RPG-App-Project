import type { GameEvent } from './events.ts';
import { apply, needsRebuild, replay } from './reducer.ts';
import { type GameState, initialState } from './state.ts';

export interface SyncPayload {
  mode: 'events' | 'snapshot';
  snapshot?: GameState;
  events: GameEvent[];
}

/**
 * Client-side mirror of a room's log. Never invents state: it only applies server events,
 * in seq order, with the shared reducer.
 *
 * Lifecycle per connection: beginCatchUp() on connect → live events are buffered →
 * applySync() with the server's catch-up → buffer flushed (duplicates dropped).
 * A seq gap at any point returns the seq to resync from.
 */
export class ClientLog {
  /** State the retained events start from (initial state, or a snapshot). */
  private base: GameState = initialState();
  /** Events after `base`, in order. Kept for chat/dice history and void rebuilds. */
  events: GameEvent[] = [];
  state: GameState = initialState();
  private catchingUp = false;
  private buffer: GameEvent[] = [];

  get lastSeq(): number {
    return this.state.seq;
  }

  beginCatchUp() {
    this.catchingUp = true;
    this.buffer = [];
  }

  /** Returns the seq to resync from if a gap was detected, else null. */
  applySync(sync: SyncPayload): number | null {
    if (sync.mode === 'snapshot' && sync.snapshot) {
      this.base = sync.snapshot;
      this.events = [];
      this.state = sync.snapshot;
    }
    const gap = this.ingest(sync.events);
    this.catchingUp = false;
    const buffered = this.buffer;
    this.buffer = [];
    return gap ?? this.ingest(buffered);
  }

  /** Live events from the server. Returns the seq to resync from if there was a gap. */
  receive(events: GameEvent[]): number | null {
    if (this.catchingUp) {
      this.buffer.push(...events);
      return null;
    }
    return this.ingest(events);
  }

  /** A turn's first event is always turn_started; if we hold it, we hold the whole turn. */
  private hasTurnStart(turnId: string) {
    return this.events.some((x) => x.type === 'turn_started' && x.payload.turnId === turnId);
  }

  private ingest(incoming: GameEvent[]): number | null {
    const sorted = [...incoming].sort((a, b) => a.seq - b.seq);
    for (const e of sorted) {
      if (e.seq <= this.lastSeq) continue; // duplicate
      if (e.seq !== this.lastSeq + 1) return this.lastSeq; // gap: ask for a resync
      if (needsRebuild(e) && this.base.seq > 0 && !this.hasTurnStart(e.payload.turnId)) {
        // The voided turn predates our snapshot, so we cannot rebuild locally: full resync.
        this.base = initialState();
        this.events = [];
        this.state = initialState();
        return 0;
      }
      this.events.push(e);
      this.state = needsRebuild(e) ? replay(this.events, this.base) : apply(this.state, e);
    }
    return null;
  }
}
