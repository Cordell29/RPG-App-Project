import { describe, expect, it, vi } from 'vitest';
import {
  type EventType,
  type GameEvent,
  type GameState,
  EVENT_TYPES,
  GameStateSchema,
  ReducerError,
  apply,
  initialState,
  replay,
} from '../src/index.ts';
import { FANTASY, Log, deepFreeze, makeCharacter, seededLog } from './fixtures.ts';

const char = (s: GameState, id: string) => s.party.find((c) => c.id === id)!;

/** Replays the log, then applies one more event and returns before/after. */
function step(log: Log, add: (log: Log) => void) {
  const before = replay(log.events);
  add(log);
  const after = apply(deepFreeze(structuredClone(before)), log.last);
  GameStateSchema.parse(after);
  return { before, after };
}

function expectOnlySeqChanged(before: GameState, after: GameState) {
  expect(after).toEqual({ ...before, seq: before.seq + 1 });
}

function withSword(log: Log) {
  log.push('delta_applied', {
    delta: {
      type: 'add_item',
      characterId: 'c1',
      item: { instanceId: 'i1', name: 'Rope', qty: 3, equipped: false, tags: ['gear'] },
    },
  });
}

// Every event type must have a describe block below; this list is checked at the end.
const covered = new Set<EventType>();
function forType(type: EventType, fn: () => void) {
  covered.add(type);
  describe(type, fn);
}

describe('reducer basics', () => {
  it('starts from a valid initial state', () => {
    expect(GameStateSchema.parse(initialState())).toEqual(initialState());
  });

  it('does not mutate its input state', () => {
    const log = seededLog();
    const state = deepFreeze(replay(log.events));
    log.push('delta_applied', { delta: { type: 'change_gold', characterId: 'c1', amount: 5 } });
    expect(() => apply(state, log.last)).not.toThrow();
    expect(char(state, 'c1').gold).toBe(10);
  });

  it('rejects seq gaps and duplicates', () => {
    const log = seededLog();
    const state = replay(log.events);
    const next = { ...log.events[1]!, seq: state.seq + 2 } as GameEvent;
    expect(() => apply(state, next)).toThrow(ReducerError);
    expect(() => apply(state, { ...log.events[1]!, seq: state.seq } as GameEvent)).toThrow(/seq/);
  });

  it('throws on unknown event types by default', () => {
    const state = replay(seededLog().events);
    const bogus = { seq: state.seq + 1, type: 'bogus', actorId: null, turnId: null, createdAt: '', payload: {} };
    expect(() => apply(state, bogus as unknown as GameEvent)).toThrow(/unknown event type/i);
  });

  it('logs and skips unknown event types in skip mode', () => {
    const state = replay(seededLog().events);
    const bogus = { seq: state.seq + 1, type: 'bogus', actorId: null, turnId: null, createdAt: '', payload: {} };
    const onUnknown = vi.fn();
    const next = apply(state, bogus as unknown as GameEvent, { unknown: 'skip', onUnknown });
    expect(next).toEqual({ ...state, seq: state.seq + 1 });
    expect(onUnknown).toHaveBeenCalledOnce();
  });

  it('never reads createdAt', () => {
    const log = seededLog();
    const a = replay(log.events);
    const b = replay(log.events.map((e) => ({ ...e, createdAt: '1999-12-31T00:00:00Z' })));
    expect(a).toEqual(b);
  });
});

forType('room_created', () => {
  it('sets the room name and setting', () => {
    const log = new Log();
    log.push('room_created', { name: 'Dragons', setting: FANTASY });
    const s = replay(log.events);
    expect(s.roomName).toBe('Dragons');
    expect(s.setting?.currencyName).toBe('gold');
  });
  it('must be the first event', () => {
    const log = seededLog();
    log.push('room_created', { name: 'Again', setting: FANTASY });
    expect(() => replay(log.events)).toThrow(ReducerError);
  });
  it('no other event may precede it', () => {
    const log = new Log();
    log.push('chat_message', { playerId: 'p1', text: 'hi' });
    expect(() => replay(log.events)).toThrow(/room_created/);
  });
});

forType('player_joined', () => {
  it('adds an active player', () => {
    const s = replay(seededLog().events);
    expect(s.players.map((p) => [p.id, p.isHost, p.active])).toEqual([
      ['p1', true, true],
      ['p2', false, true],
    ]);
  });
  it('re-activates a returning player', () => {
    const log = seededLog();
    log.push('player_left', { playerId: 'p2' });
    log.push('player_joined', { player: { id: 'p2', displayName: 'Bea2', isHost: false } });
    const p2 = replay(log.events).players.find((p) => p.id === 'p2')!;
    expect(p2).toMatchObject({ active: true, displayName: 'Bea2', characterId: 'c2' });
  });
});

forType('player_left', () => {
  it('marks the player inactive', () => {
    const { after } = step(seededLog(), (l) => l.push('player_left', { playerId: 'p2' }));
    expect(after.players.find((p) => p.id === 'p2')!.active).toBe(false);
  });
  it('throws for an unknown player', () => {
    const log = seededLog();
    log.push('player_left', { playerId: 'nope' });
    expect(() => replay(log.events)).toThrow(ReducerError);
  });
});

forType('character_created', () => {
  it('adds the character and links the player', () => {
    const s = replay(seededLog().events);
    expect(s.party.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(s.players.find((p) => p.id === 'p1')!.characterId).toBe('c1');
  });
  it('throws for a duplicate id or unknown player', () => {
    const dup = seededLog();
    dup.push('character_created', { character: makeCharacter({ id: 'c1', playerId: 'p2' }) });
    expect(() => replay(dup.events)).toThrow(/exists/);
    const orphan = seededLog();
    orphan.push('character_created', { character: makeCharacter({ id: 'c9', playerId: 'ghost' }) });
    expect(() => replay(orphan.events)).toThrow(/player/);
  });
});

forType('character_edited', () => {
  it('patches name, notes and visual descriptor only', () => {
    const { after } = step(seededLog(), (l) =>
      l.push('character_edited', {
        characterId: 'c1',
        patch: { name: 'Ayla the Bold', notes: 'owes Brother Hal 20 gold', visualDescriptor: 'new look' },
      }),
    );
    expect(char(after, 'c1')).toMatchObject({
      name: 'Ayla the Bold',
      notes: 'owes Brother Hal 20 gold',
      visualDescriptor: 'new look',
      gold: 10,
      hp: { current: 12, max: 12 },
    });
  });
  it('throws for an unknown character', () => {
    const log = seededLog();
    log.push('character_edited', { characterId: 'zz', patch: { name: 'X' } });
    expect(() => replay(log.events)).toThrow(ReducerError);
  });
});

forType('item_equipped', () => {
  it('toggles equipped on an owned item; unknown items throw', () => {
    const log = seededLog();
    withSword(log);
    log.push('item_equipped', { characterId: 'c1', instanceId: 'i1', equipped: true });
    expect(char(replay(log.events), 'c1').inventory[0]!.equipped).toBe(true);
    log.push('item_equipped', { characterId: 'c1', instanceId: 'nope', equipped: true });
    expect(() => replay(log.events)).toThrow(ReducerError);
  });
});

forType('action_edited', () => {
  it('rewrites a pending action; unknown seqs throw', () => {
    const log = seededLog();
    log.push('action_submitted', { playerId: 'p1', characterId: 'c1', text: 'I climb' }); // 6
    log.push('action_edited', { actionSeq: 6, text: 'I climb carefully' }, { actorId: 'p1' });
    expect(replay(log.events).turn.pending[0]!.text).toBe('I climb carefully');
    log.push('action_edited', { actionSeq: 99, text: 'x' });
    expect(() => replay(log.events)).toThrow(/not pending/);
  });
});

forType('action_withdrawn', () => {
  it('removes a pending action and goes idle when none remain', () => {
    const log = seededLog();
    log.push('action_submitted', { playerId: 'p1', characterId: 'c1', text: 'I climb' }); // 6
    log.push('action_withdrawn', { actionSeq: 6 });
    expect(replay(log.events).turn).toMatchObject({ pending: [], phase: 'idle' });
  });
});

forType('spotlight_set', () => {
  it('sets and clears the spotlight', () => {
    const log = seededLog();
    log.push('spotlight_set', { playerId: 'p2' });
    expect(replay(log.events).spotlight).toBe('p2');
    log.push('spotlight_set', { playerId: null });
    expect(replay(log.events).spotlight).toBeNull();
    log.push('spotlight_set', { playerId: 'ghost' });
    expect(() => replay(log.events)).toThrow(ReducerError);
  });
});

forType('session_started', () => {
  it('opens a numbered session', () => {
    const log = seededLog();
    log.push('session_started', { number: 1 });
    expect(replay(log.events).session).toEqual({ number: 1, active: true });
  });
});

forType('session_ended', () => {
  it('closes the session', () => {
    const log = seededLog();
    log.push('session_started', { number: 1 });
    log.push('session_ended', { number: 1 });
    expect(replay(log.events).session).toEqual({ number: 1, active: false });
  });
});

const rareSword = { instanceId: 'rs', name: 'Flametongue', qty: 1, equipped: false, tags: [], slot: 'weapon' as const, rarity: 'rare' as const, effects: { damage: '1d8', damageStat: 'str' as const, attackBonus: 2 } };

forType('approval_requested', () => {
  it('queues the request for the host', () => {
    const log = seededLog();
    log.push('approval_requested', { approval: { id: 'ap1', kind: 'item', characterId: 'c1', item: rareSword, reason: 'dragon hoard', requestedBy: 'gm' } });
    expect(replay(log.events).pendingApprovals.map((a) => a.id)).toEqual(['ap1']);
  });
});

forType('approval_resolved', () => {
  it('approved items and abilities are granted (with host edits); denied ones vanish', () => {
    const log = seededLog();
    log.push('approval_requested', { approval: { id: 'ap1', kind: 'item', characterId: 'c1', item: rareSword, reason: '', requestedBy: 'gm' } });
    log.push('approval_requested', {
      approval: { id: 'ap2', kind: 'ability', characterId: 'c2', ability: { id: 'ab1', name: 'Shadow Step', description: 'Teleport 30 ft between shadows.', uses: { current: 1, max: 1 }, recharge: 'short_rest' }, reason: '', requestedBy: 'player' },
    });
    log.push('approval_requested', { approval: { id: 'ap3', kind: 'item', characterId: 'c1', item: { ...rareSword, instanceId: 'rs2' }, reason: '', requestedBy: 'gm' } });
    log.push('approval_resolved', { approvalId: 'ap1', approved: true, item: { ...rareSword, name: 'Flametongue (+2)' } });
    log.push('approval_resolved', { approvalId: 'ap2', approved: true });
    log.push('approval_resolved', { approvalId: 'ap3', approved: false });
    const s = replay(log.events);
    expect(s.pendingApprovals).toEqual([]);
    expect(char(s, 'c1').inventory.map((i) => i.name)).toEqual(['Flametongue (+2)']);
    expect(char(s, 'c2').abilities.map((a) => a.name)).toEqual(['Shadow Step']);
    log.push('approval_resolved', { approvalId: 'ap1', approved: true });
    expect(() => replay(log.events)).toThrow(/approval/);
  });
});

describe('Phase 4 deltas', () => {
  function withKit() {
    const log = seededLog();
    log.push('host_override', {
      override: { kind: 'spell_slots', characterId: 'c1', slots: [{ current: 2, max: 2 }, { current: 1, max: 1 }] },
    });
    log.push('host_override', {
      override: { kind: 'add_ability', characterId: 'c1', ability: { id: 'sw', name: 'Second Wind', description: 'Heal.', uses: { current: 1, max: 1 }, recharge: 'short_rest' } },
    });
    log.push('host_override', {
      override: { kind: 'add_ability', characterId: 'c1', ability: { id: 'ai', name: 'Arcane Recovery', description: 'Slots.', uses: { current: 1, max: 1 }, recharge: 'long_rest' } },
    });
    return log;
  }

  it('use_ability spends a use; none left throws', () => {
    const log = withKit();
    log.push('delta_applied', { delta: { type: 'use_ability', characterId: 'c1', abilityId: 'sw' } });
    expect(char(replay(log.events), 'c1').abilities[0]!.uses).toEqual({ current: 0, max: 1 });
    log.push('delta_applied', { delta: { type: 'use_ability', characterId: 'c1', abilityId: 'sw' } });
    expect(() => replay(log.events)).toThrow(/no uses/);
  });

  it('spend_spell_slot spends a slot of that level; empty throws', () => {
    const log = withKit();
    log.push('delta_applied', { delta: { type: 'spend_spell_slot', characterId: 'c1', level: 2 } });
    expect(char(replay(log.events), 'c1').spellSlots[1]).toEqual({ current: 0, max: 1 });
    log.push('delta_applied', { delta: { type: 'spend_spell_slot', characterId: 'c1', level: 2 } });
    expect(() => replay(log.events)).toThrow(/slot/);
    const none = withKit();
    none.push('delta_applied', { delta: { type: 'spend_spell_slot', characterId: 'c1', level: 5 } });
    expect(() => replay(none.events)).toThrow(/slot/);
  });

  it('short rest restores short-rest uses; long rest restores everything and HP', () => {
    const log = withKit();
    log.push('delta_applied', { delta: { type: 'use_ability', characterId: 'c1', abilityId: 'sw' } });
    log.push('delta_applied', { delta: { type: 'use_ability', characterId: 'c1', abilityId: 'ai' } });
    log.push('delta_applied', { delta: { type: 'spend_spell_slot', characterId: 'c1', level: 1 } });
    log.push('delta_applied', { delta: { type: 'modify_hp', characterId: 'c1', amount: -7 } });
    log.push('delta_applied', { delta: { type: 'rest', kind: 'short', characterIds: ['c1'] } });
    let c = char(replay(log.events), 'c1');
    expect(c.abilities.map((a) => a.uses!.current)).toEqual([1, 0]);
    expect(c.spellSlots[0]!.current).toBe(1);
    expect(c.hp.current).toBe(5);
    log.push('delta_applied', { delta: { type: 'rest', kind: 'long', characterIds: ['c1'] } });
    c = char(replay(log.events), 'c1');
    expect(c.abilities.map((a) => a.uses!.current)).toEqual([1, 1]);
    expect(c.spellSlots.map((x) => x.current)).toEqual([2, 1]);
    expect(c.hp.current).toBe(12);
  });

  it('adjust_meter clamps 0–max and toggles shaken / unprepared at zero', () => {
    const log = seededLog();
    log.push('host_override', { override: { kind: 'meter', characterId: 'c1', meter: 'spirit', current: 2 } });
    log.push('delta_applied', { delta: { type: 'adjust_meter', characterId: 'c1', meter: 'spirit', amount: -3 } });
    let c = char(replay(log.events), 'c1');
    expect(c.meters.spirit).toEqual({ current: 0, max: 5 });
    expect(c.conditions).toContain('shaken');
    log.push('delta_applied', { delta: { type: 'adjust_meter', characterId: 'c1', meter: 'spirit', amount: 9 } });
    c = char(replay(log.events), 'c1');
    expect(c.meters.spirit!.current).toBe(5);
    expect(c.conditions).not.toContain('shaken');
    log.push('delta_applied', { delta: { type: 'adjust_meter', characterId: 'c2', meter: 'supply', amount: -1 } });
    expect(() => replay(log.events)).toThrow(/supply/);
  });

  it('long rest raises Spirit by 1', () => {
    const log = seededLog();
    log.push('host_override', { override: { kind: 'meter', characterId: 'c1', meter: 'spirit', current: 1 } });
    log.push('delta_applied', { delta: { type: 'rest', kind: 'long', characterIds: ['c1'] } });
    expect(char(replay(log.events), 'c1').meters.spirit!.current).toBe(2);
  });

  it('host can update and remove abilities and set proficiencies', () => {
    const log = withKit();
    log.push('host_override', { override: { kind: 'update_ability', characterId: 'c1', abilityId: 'sw', patch: { description: 'Heal 1d10+level.' } } });
    log.push('host_override', { override: { kind: 'remove_ability', characterId: 'c1', abilityId: 'ai' } });
    log.push('host_override', { override: { kind: 'proficiencies', characterId: 'c1', skills: ['stealth'], saves: ['dex'] } });
    const c = char(replay(log.events), 'c1');
    expect(c.abilities).toEqual([{ id: 'sw', name: 'Second Wind', description: 'Heal 1d10+level.', uses: { current: 1, max: 1 }, recharge: 'short_rest' }]);
    expect(c.proficiencies).toEqual({ skills: ['stealth'], saves: ['dex'] });
  });
});

forType('chat_message', () => {
  it('changes nothing but seq', () => {
    const { before, after } = step(seededLog(), (l) =>
      l.push('chat_message', { playerId: 'p1', text: 'brb' }, { actorId: 'p1' }),
    );
    expectOnlySeqChanged(before, after);
  });
});

forType('action_submitted', () => {
  it('queues the action and opens collection', () => {
    const { after } = step(seededLog(), (l) =>
      l.push('action_submitted', { playerId: 'p1', characterId: 'c1', text: 'I open the door' }, { actorId: 'p1' }),
    );
    expect(after.turn.phase).toBe('collecting');
    expect(after.turn.pending).toEqual([{ seq: 6, playerId: 'p1', characterId: 'c1', text: 'I open the door' }]);
  });
  it('throws for an unknown player', () => {
    const log = seededLog();
    log.push('action_submitted', { playerId: 'ghost', characterId: null, text: 'boo' });
    expect(() => replay(log.events)).toThrow(ReducerError);
  });
});

forType('turn_started', () => {
  it('consumes only the listed actions and leaves later ones queued', () => {
    const log = seededLog();
    log.push('action_submitted', { playerId: 'p1', characterId: 'c1', text: 'a' }); // seq 6
    log.push('action_submitted', { playerId: 'p2', characterId: 'c2', text: 'b' }); // seq 7
    log.push('turn_started', { turnId: 't1', actionSeqs: [6] }, { turnId: 't1' });
    const s = replay(log.events);
    expect(s.turn).toMatchObject({ number: 1, phase: 'resolving', turnId: 't1' });
    expect(s.turn.resolving.map((a) => a.seq)).toEqual([6]);
    expect(s.turn.pending.map((a) => a.seq)).toEqual([7]);
  });
  it('throws if a turn is already resolving or an action is not pending', () => {
    const log = seededLog();
    log.push('action_submitted', { playerId: 'p1', characterId: 'c1', text: 'a' });
    log.push('turn_started', { turnId: 't1', actionSeqs: [6] }, { turnId: 't1' });
    log.push('turn_started', { turnId: 't2', actionSeqs: [] }, { turnId: 't2' });
    expect(() => replay(log.events)).toThrow(/already/);
    const bad = seededLog();
    bad.push('turn_started', { turnId: 't1', actionSeqs: [99] }, { turnId: 't1' });
    expect(() => replay(bad.events)).toThrow(/pending/);
  });
});

forType('dice_rolled', () => {
  it('changes nothing but seq', () => {
    const { before, after } = step(seededLog(), (l) =>
      l.push('dice_rolled', {
        notation: '1d20+3',
        mode: 'advantage',
        dice: [
          { sides: 20, value: 4, dropped: true },
          { sides: 20, value: 17, dropped: false },
        ],
        modifier: 3,
        total: 20,
        dc: 15,
        success: true,
        reason: 'climb the wall',
        characterId: 'c1',
        stat: 'str',
      }),
    );
    expectOnlySeqChanged(before, after);
  });
});

forType('delta_applied', () => {
  it('modify_hp clamps to 0…max', () => {
    const log = seededLog();
    log.push('delta_applied', { delta: { type: 'modify_hp', characterId: 'c1', amount: -50 } });
    expect(char(replay(log.events), 'c1').hp).toEqual({ current: 0, max: 12 });
    log.push('delta_applied', { delta: { type: 'modify_hp', characterId: 'c1', amount: 40 } });
    expect(char(replay(log.events), 'c1').hp).toEqual({ current: 12, max: 12 });
  });

  it('add_item adds a new stack; a duplicate instanceId throws', () => {
    const log = seededLog();
    withSword(log);
    expect(char(replay(log.events), 'c1').inventory).toEqual([
      { instanceId: 'i1', name: 'Rope', qty: 3, equipped: false, tags: ['gear'] },
    ]);
    withSword(log);
    expect(() => replay(log.events)).toThrow(/instance/);
  });

  it('remove_item reduces qty, removes empty stacks, throws when insufficient', () => {
    const log = seededLog();
    withSword(log);
    log.push('delta_applied', { delta: { type: 'remove_item', characterId: 'c1', instanceId: 'i1', qty: 2 } });
    expect(char(replay(log.events), 'c1').inventory[0]!.qty).toBe(1);
    log.push('delta_applied', { delta: { type: 'remove_item', characterId: 'c1', instanceId: 'i1', qty: 1 } });
    expect(char(replay(log.events), 'c1').inventory).toEqual([]);
    log.push('delta_applied', { delta: { type: 'remove_item', characterId: 'c1', instanceId: 'i1', qty: 1 } });
    expect(() => replay(log.events)).toThrow(ReducerError);
  });

  it('change_gold adds and subtracts; never below 0', () => {
    const log = seededLog();
    log.push('delta_applied', { delta: { type: 'change_gold', characterId: 'c1', amount: 25 } });
    log.push('delta_applied', { delta: { type: 'change_gold', characterId: 'c1', amount: -30 } });
    expect(char(replay(log.events), 'c1').gold).toBe(5);
    log.push('delta_applied', { delta: { type: 'change_gold', characterId: 'c1', amount: -6 } });
    expect(() => replay(log.events)).toThrow(/gold/);
  });

  it('transfer_item moves part or all of a stack', () => {
    const log = seededLog();
    withSword(log);
    log.push('delta_applied', {
      delta: { type: 'transfer_item', fromId: 'c1', toId: 'c2', instanceId: 'i1', qty: 2, newInstanceId: 'i2' },
    });
    let s = replay(log.events);
    expect(char(s, 'c1').inventory[0]!.qty).toBe(1);
    expect(char(s, 'c2').inventory).toEqual([
      { instanceId: 'i2', name: 'Rope', qty: 2, equipped: false, tags: ['gear'] },
    ]);
    log.push('delta_applied', {
      delta: { type: 'transfer_item', fromId: 'c1', toId: 'c2', instanceId: 'i1', qty: 1, newInstanceId: 'i3' },
    });
    s = replay(log.events);
    expect(char(s, 'c1').inventory).toEqual([]);
    expect(char(s, 'c2').inventory.map((i) => i.qty)).toEqual([2, 1]);
  });

  it('transfer_item throws for unknown characters or too few items', () => {
    const log = seededLog();
    withSword(log);
    log.push('delta_applied', {
      delta: { type: 'transfer_item', fromId: 'c1', toId: 'c2', instanceId: 'i1', qty: 4, newInstanceId: 'i2' },
    });
    expect(() => replay(log.events)).toThrow(ReducerError);
  });

  it('grant_xp levels up and raises max HP', () => {
    const log = seededLog();
    log.push('delta_applied', { delta: { type: 'grant_xp', characterId: 'c1', amount: 200 } });
    expect(char(replay(log.events), 'c1')).toMatchObject({ xp: 200, level: 1 });
    log.push('delta_applied', { delta: { type: 'grant_xp', characterId: 'c1', amount: 150 } });
    // con 14 → +2 modifier → 7 HP per level
    expect(char(replay(log.events), 'c1')).toMatchObject({ xp: 350, level: 2, hp: { current: 19, max: 19 } });
  });

  it('set_condition toggles idempotently', () => {
    const log = seededLog();
    log.push('delta_applied', { delta: { type: 'set_condition', characterId: 'c1', condition: 'poisoned', on: true } });
    log.push('delta_applied', { delta: { type: 'set_condition', characterId: 'c1', condition: 'poisoned', on: true } });
    expect(char(replay(log.events), 'c1').conditions).toEqual(['poisoned']);
    log.push('delta_applied', { delta: { type: 'set_condition', characterId: 'c1', condition: 'poisoned', on: false } });
    expect(char(replay(log.events), 'c1').conditions).toEqual([]);
  });

  it('set_flag stores the value', () => {
    const log = seededLog();
    log.push('delta_applied', { delta: { type: 'set_flag', key: 'met_hal', value: true } });
    expect(replay(log.events).flags).toEqual({ met_hal: true });
  });

  it('update_quest creates, updates and annotates', () => {
    const log = seededLog();
    log.push('delta_applied', { delta: { type: 'update_quest', key: 'debt', title: 'Repay Hal', note: 'owes 20' } });
    log.push('delta_applied', { delta: { type: 'update_quest', key: 'debt', status: 'done', note: 'paid' } });
    log.push('delta_applied', { delta: { type: 'update_quest', key: 'rats' } });
    expect(replay(log.events).quests).toEqual([
      { key: 'debt', title: 'Repay Hal', status: 'done', notes: ['owes 20', 'paid'] },
      { key: 'rats', title: 'rats', status: 'active', notes: [] },
    ]);
  });

  it('change_scene replaces the scene and clears its image', () => {
    const log = seededLog();
    log.push('image_ready', { assetId: 'a1', kind: 'scene' });
    log.push('delta_applied', {
      delta: { type: 'change_scene', locationKey: 'crypt', title: 'The Crypt', description: 'Cold stone.' },
    });
    expect(replay(log.events).scene).toEqual({ locationKey: 'crypt', title: 'The Crypt', description: 'Cold stone.' });
  });

  it('upsert_canon does not touch game state (canon lives in its own table)', () => {
    const { before, after } = step(seededLog(), (l) =>
      l.push('delta_applied', {
        delta: { type: 'upsert_canon', kind: 'npc', key: 'brother_hal', aliases: ['Hal'], facts: ['monk'] },
      }),
    );
    expectOnlySeqChanged(before, after);
  });

  it('throws when the character does not exist', () => {
    const log = seededLog();
    log.push('delta_applied', { delta: { type: 'change_gold', characterId: 'ghost', amount: 1 } });
    expect(() => replay(log.events)).toThrow(/character/);
  });
});

forType('delta_rejected', () => {
  it('changes nothing but seq', () => {
    const { before, after } = step(seededLog(), (l) =>
      l.push('delta_rejected', {
        tool: 'change_gold',
        input: { characterId: 'c1', amount: 10000 },
        reason: 'gain exceeds cap',
      }),
    );
    expectOnlySeqChanged(before, after);
  });
});

forType('narration', () => {
  it('ends the turn; queued actions keep collection open', () => {
    const log = seededLog();
    log.push('action_submitted', { playerId: 'p1', characterId: 'c1', text: 'a' });
    log.push('turn_started', { turnId: 't1', actionSeqs: [6] }, { turnId: 't1' });
    log.push('action_submitted', { playerId: 'p2', characterId: 'c2', text: 'late' });
    log.push('narration', { turnId: 't1', text: 'The door creaks.' }, { turnId: 't1' });
    expect(replay(log.events).turn).toEqual({
      number: 1,
      phase: 'collecting',
      turnId: null,
      resolving: [],
      pending: [{ seq: 8, playerId: 'p2', characterId: 'c2', text: 'late' }],
    });
  });
  it('goes idle when nothing is queued', () => {
    const log = seededLog();
    log.push('turn_started', { turnId: 't1', actionSeqs: [] }, { turnId: 't1' });
    log.push('narration', { turnId: 't1', text: 'Silence.' }, { turnId: 't1' });
    expect(replay(log.events).turn.phase).toBe('idle');
  });
});

forType('scene_changed', () => {
  it('replaces the scene', () => {
    const scene = { locationKey: 'inn', title: 'The Gilded Goose', description: 'Warm and loud.' };
    const { after } = step(seededLog(), (l) => l.push('scene_changed', { scene }));
    expect(after.scene).toEqual(scene);
  });
});

forType('image_requested', () => {
  it('changes nothing but seq', () => {
    const { before, after } = step(seededLog(), (l) =>
      l.push('image_requested', { assetId: 'a1', kind: 'portrait', subject: 'Ayla', characterId: 'c1' }),
    );
    expectOnlySeqChanged(before, after);
  });
});

forType('image_ready', () => {
  it('sets portrait or scene image; npc art changes nothing', () => {
    const log = seededLog();
    log.push('image_ready', { assetId: 'a1', kind: 'portrait', characterId: 'c1' });
    log.push('image_ready', { assetId: 'a2', kind: 'scene' });
    const s = replay(log.events);
    expect(char(s, 'c1').portraitAssetId).toBe('a1');
    expect(s.scene.imageAssetId).toBe('a2');
    const { before, after } = step(log, (l) => l.push('image_ready', { assetId: 'a3', kind: 'npc' }));
    expectOnlySeqChanged(before, after);
  });
});

forType('chapter_closed', () => {
  it('changes nothing but seq', () => {
    const { before, after } = step(seededLog(), (l) =>
      l.push('chapter_closed', { chapterNo: 1, level: 0, fromSeq: 1, toSeq: 5 }),
    );
    expectOnlySeqChanged(before, after);
  });
});

forType('host_override', () => {
  it('patches character mechanics, including stats and max HP', () => {
    const { after } = step(seededLog(), (l) =>
      l.push('host_override', {
        override: {
          kind: 'character',
          characterId: 'c1',
          patch: { hp: { max: 20 }, stats: { str: 18 }, gold: 99, level: 3, conditions: ['prone'] },
        },
        reason: 'fixing a mistake',
      }),
    );
    expect(char(after, 'c1')).toMatchObject({
      hp: { current: 12, max: 20 },
      stats: { str: 18, dex: 12 },
      gold: 99,
      level: 3,
      conditions: ['prone'],
    });
  });
  it('clamps current HP when max is lowered', () => {
    const { after } = step(seededLog(), (l) =>
      l.push('host_override', { override: { kind: 'character', characterId: 'c1', patch: { hp: { max: 5 } } } }),
    );
    expect(char(after, 'c1').hp).toEqual({ current: 5, max: 5 });
  });
  it('adds, updates and removes items', () => {
    const log = seededLog();
    log.push('host_override', {
      override: {
        kind: 'add_item',
        characterId: 'c2',
        item: { instanceId: 'h1', name: 'Shield', qty: 1, equipped: false, tags: [] },
      },
    });
    log.push('host_override', {
      override: { kind: 'update_item', characterId: 'c2', instanceId: 'h1', patch: { equipped: true, notes: '+1' } },
    });
    expect(char(replay(log.events), 'c2').inventory[0]).toMatchObject({ equipped: true, notes: '+1' });
    log.push('host_override', { override: { kind: 'remove_item', characterId: 'c2', instanceId: 'h1', qty: 1 } });
    expect(char(replay(log.events), 'c2').inventory).toEqual([]);
  });
  it('changes the setting, scene and flags', () => {
    const log = seededLog();
    const setting = { ...FANTASY, key: 'grim', name: 'Grim', currencyName: 'crowns' };
    log.push('host_override', { override: { kind: 'setting', setting } });
    log.push('host_override', { override: { kind: 'scene', scene: { locationKey: 'x', title: 'X', description: '' } } });
    log.push('host_override', { override: { kind: 'flag', key: 'a', value: 1 } });
    log.push('host_override', { override: { kind: 'flag', key: 'b', value: 2 } });
    log.push('host_override', { override: { kind: 'flag', key: 'a', value: null } });
    const s = replay(log.events);
    expect(s.setting?.currencyName).toBe('crowns');
    expect(s.scene.locationKey).toBe('x');
    expect(s.flags).toEqual({ b: 2 });
  });
});

forType('turn_voided', () => {
  function playedTurn() {
    const log = seededLog();
    log.push('action_submitted', { playerId: 'p1', characterId: 'c1', text: 'rob the bank' }); // 6
    log.push('turn_started', { turnId: 't1', actionSeqs: [6] }, { turnId: 't1' });
    log.push('delta_applied', { delta: { type: 'change_gold', characterId: 'c1', amount: 100 } }, { turnId: 't1' });
    log.push('narration', { turnId: 't1', text: 'You are rich.' }, { turnId: 't1' });
    log.push('chat_message', { playerId: 'p2', text: 'lol' });
    log.push('character_edited', { characterId: 'c2', patch: { notes: 'kept' } });
    return log;
  }

  it('replay skips the voided turn but keeps everything outside it', () => {
    const log = playedTurn();
    expect(char(replay(log.events), 'c1').gold).toBe(110);
    log.push('turn_voided', { turnId: 't1' });
    const s = replay(log.events);
    expect(char(s, 'c1').gold).toBe(10);
    expect(char(s, 'c2').notes).toBe('kept');
    expect(s.turn).toMatchObject({ number: 0, phase: 'collecting', turnId: null });
    expect(s.turn.pending.map((a) => a.seq)).toEqual([6]); // action returns to the queue for a retry
    expect(s.voidedTurnIds).toEqual(['t1']);
    expect(s.seq).toBe(log.events.length);
  });

  it('applied incrementally it records the void (callers then rebuild via replay)', () => {
    const log = playedTurn();
    const { after } = step(log, (l) => l.push('turn_voided', { turnId: 't1' }));
    expect(after.voidedTurnIds).toEqual(['t1']);
  });

  it('does not skip itself', () => {
    const log = playedTurn();
    log.push('turn_voided', { turnId: 't1' }, { turnId: 't1' });
    expect(() => replay(log.events)).not.toThrow();
  });
});

forType('session_recap', () => {
  it('changes nothing but seq', () => {
    const { before, after } = step(seededLog(), (l) => l.push('session_recap', { number: 1, text: 'Previously on…' }));
    expectOnlySeqChanged(before, after);
  });
});

describe('image_ready repaint', () => {
  it('changes nothing but seq', () => {
    const { before, after } = step(seededLog(), (l) => l.push('image_ready', { assetId: 'a1', kind: 'scene', repaint: true }));
    expectOnlySeqChanged(before, after);
  });
});

forType('image_failed', () => {
  it('changes nothing but seq', () => {
    const { before, after } = step(seededLog(), (l) => l.push('image_failed', { assetId: 'a1', reason: 'quota' }));
    expectOnlySeqChanged(before, after);
  });
});

forType('audio_ready', () => {
  it('changes nothing but seq', () => {
    const { before, after } = step(seededLog(), (l) => l.push('audio_ready', { assetId: 'v1', narrationSeq: 3 }));
    expectOnlySeqChanged(before, after);
  });
});

forType('start_set', () => {
  const start = {
    title: 'The Drowned Bell',
    description: 'A flooded chapel where a bell still rings beneath the water.',
    hooks: ['Dive for the bell', 'Question the ferryman'],
    source: 'random' as const,
  };
  it('records the opening and moves the scene there', () => {
    const { after } = step(seededLog(), (l) => l.push('start_set', { start }));
    expect(after.opening).toEqual(start);
    expect(after.scene).toEqual({ locationKey: 'the_drowned_bell', title: start.title, description: start.description });
  });
  it('can be changed again before the first turn', () => {
    const log = seededLog();
    log.push('start_set', { start });
    const { after } = step(log, (l) => l.push('start_set', { start: { ...start, title: 'Custom', source: 'custom', hooks: [] } }));
    expect(after.opening?.source).toBe('custom');
    expect(after.scene.locationKey).toBe('custom');
  });
  it('is refused once the story has begun', () => {
    const log = seededLog();
    log.push('turn_started', { turnId: 't1', actionSeqs: [] }, { turnId: 't1' });
    const state = replay(log.events);
    log.push('start_set', { start });
    expect(() => apply(state, log.last)).toThrow(/already begun/);
  });
});

forType('campaign_imported', () => {
  it('changes nothing but seq', () => {
    const { before, after } = step(seededLog(), (l) =>
      l.push('campaign_imported', {
        sourceRoomName: 'Old',
        sourceExportedAt: '2026-10-16T02:00:00Z',
        importedEventCount: 5,
      }),
    );
    expectOnlySeqChanged(before, after);
  });
});

describe('coverage', () => {
  it('has a test block for every event type', () => {
    expect([...covered].sort()).toEqual([...EVENT_TYPES].sort());
  });
});
