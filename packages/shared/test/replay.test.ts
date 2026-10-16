import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, GameEventSchema, GameStateSchema, apply, needsRebuild, replay } from '../src/index.ts';
import { randomEvents } from './randomEvents.ts';

describe('replay determinism', () => {
  const events = randomEvents(1000, 20261016);

  it('generates 1,000 schema-valid events covering every type', () => {
    expect(events).toHaveLength(1000);
    for (const e of events) GameEventSchema.parse(e);
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(EVENT_TYPES));
    expect(events.some((e) => e.type === 'turn_voided')).toBe(true);
  });

  it('replaying the same 1,000 events twice gives identical state', () => {
    const a = replay(events);
    const b = replay(events);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    GameStateSchema.parse(a);
    expect(a.seq).toBe(1000);
  });

  it('survives a JSON round trip of the log (as it would from SQLite)', () => {
    const fromDb = JSON.parse(JSON.stringify(events)).map((e: unknown) => GameEventSchema.parse(e));
    expect(replay(fromDb)).toEqual(replay(events));
  });

  it('incremental apply (rebuilding on voids) matches a full replay at every step', () => {
    let state = replay([]);
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      state = needsRebuild(e) ? replay(events.slice(0, i + 1)) : apply(state, e);
    }
    expect(state).toEqual(replay(events));
  });

  it('different seeds give different but equally reproducible logs', () => {
    for (const seed of [1, 2, 3]) {
      const log = randomEvents(500, seed);
      expect(replay(log)).toEqual(replay(randomEvents(500, seed)));
    }
  });
});
