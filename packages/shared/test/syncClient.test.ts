import { describe, expect, it } from 'vitest';
import { ClientLog, replay } from '../src/index.ts';
import { randomEvents } from './randomEvents.ts';

const log = randomEvents(300, 42);
const upTo = (n: number) => log.slice(0, n);
const range = (from: number, to: number) => log.slice(from - 1, to); // seqs from..to inclusive

describe('ClientLog', () => {
  it('applies a full catch-up from zero', () => {
    const c = new ClientLog();
    c.beginCatchUp();
    expect(c.applySync({ mode: 'events', events: upTo(300) })).toBeNull();
    expect(c.state).toEqual(replay(log));
    expect(c.events).toHaveLength(300);
  });

  it('buffers live events during catch-up and drops duplicates', () => {
    const c = new ClientLog();
    c.beginCatchUp();
    // Live events overlap the catch-up and arrive out of order.
    expect(c.receive(range(99, 102))).toBeNull();
    expect(c.receive(range(95, 100))).toBeNull();
    expect(c.lastSeq).toBe(0);
    expect(c.applySync({ mode: 'events', events: upTo(100) })).toBeNull();
    expect(c.lastSeq).toBe(102);
    expect(c.events.map((e) => e.seq)).toEqual(Array.from({ length: 102 }, (_, i) => i + 1));
    expect(c.state).toEqual(replay(upTo(102)));
  });

  it('reports a gap and stops applying until resynced', () => {
    const c = new ClientLog();
    c.beginCatchUp();
    c.applySync({ mode: 'events', events: upTo(50) });
    expect(c.receive(range(53, 55))).toBe(50);
    expect(c.lastSeq).toBe(50);
    c.beginCatchUp();
    expect(c.applySync({ mode: 'events', events: range(51, 55) })).toBeNull();
    expect(c.state).toEqual(replay(upTo(55)));
  });

  it('reconnect with lastSeq resumes without loss or duplication', () => {
    const c = new ClientLog();
    c.beginCatchUp();
    c.applySync({ mode: 'events', events: upTo(120) });
    c.receive(range(121, 130));
    // Disconnect; events 131–200 happen meanwhile. Server resends from lastSeq (130).
    c.beginCatchUp();
    c.receive(range(199, 205)); // live events racing the catch-up
    expect(c.applySync({ mode: 'events', events: range(131, 200) })).toBeNull();
    expect(c.events.map((e) => e.seq)).toEqual(Array.from({ length: 205 }, (_, i) => i + 1));
    expect(c.state).toEqual(replay(upTo(205)));
  });

  it('accepts a snapshot plus tail', () => {
    const plain = randomEvents(300, 42, { voids: false });
    const c = new ClientLog();
    c.beginCatchUp();
    c.applySync({ mode: 'events', events: plain.slice(0, 10) });
    c.beginCatchUp();
    const snapshot = replay(plain.slice(0, 250));
    expect(c.applySync({ mode: 'snapshot', snapshot, events: plain.slice(250) })).toBeNull();
    expect(c.state).toEqual(replay(plain));
    expect(c.events[0]!.seq).toBe(251);
  });

  it('asks for a full resync when a void targets a turn inside its snapshot', () => {
    const voidAt = log.findIndex((e) => e.type === 'turn_voided');
    const turnId = (log[voidAt] as { payload: { turnId: string } }).payload.turnId;
    const turnStart = log.findIndex((e) => e.turnId === turnId);
    const c = new ClientLog();
    c.beginCatchUp();
    const snapshot = replay(log.slice(0, turnStart + 1)); // snapshot contains the turn's start
    const result = c.applySync({ mode: 'snapshot', snapshot, events: log.slice(turnStart + 1, voidAt + 1) });
    expect(result).toBe(0);
    expect(c.lastSeq).toBe(0);
  });

  it('rebuilds on turn_voided', () => {
    const c = new ClientLog();
    c.beginCatchUp();
    c.applySync({ mode: 'events', events: [] });
    for (const e of log) c.receive([e]);
    expect(log.some((e) => e.type === 'turn_voided')).toBe(true);
    expect(c.state).toEqual(replay(log));
  });
});
