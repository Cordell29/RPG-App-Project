import fantasy from '../presets/fantasy.json' with { type: 'json' };
import {
  type Character,
  type EventType,
  type GameEvent,
  type PayloadOf,
  type SettingPreset,
  GameEventSchema,
  SettingPresetSchema,
} from '../src/index.ts';

export const FANTASY: SettingPreset = SettingPresetSchema.parse(fantasy);

/** Builds a gapless, schema-valid event log. */
export class Log {
  readonly events: GameEvent[] = [];

  push<T extends EventType>(
    type: T,
    payload: PayloadOf<T>,
    opts: { actorId?: string | null; turnId?: string | null } = {},
  ): GameEvent {
    const event = GameEventSchema.parse({
      seq: this.events.length + 1,
      type,
      actorId: opts.actorId ?? null,
      turnId: opts.turnId ?? null,
      createdAt: '2026-01-01T00:00:00.000Z',
      payload,
    });
    this.events.push(event);
    return event;
  }

  get last(): GameEvent {
    return this.events[this.events.length - 1]!;
  }
}

export function makeCharacter(over: Partial<Character> & { id: string; playerId: string }): Character {
  return {
    name: 'Ayla',
    ancestry: 'Human',
    class: 'Fighter',
    level: 1,
    xp: 0,
    hp: { current: 12, max: 12 },
    ac: 15,
    stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 8 },
    gold: 10,
    inventory: [],
    conditions: [],
    visualDescriptor: 'tall woman, braided red hair, scarred leather armour',
    notes: '',
    proficiencies: { skills: [], saves: [] },
    abilities: [],
    spellSlots: [],
    meters: {},
    ...over,
  };
}

/** Room with a host (p1) and a second player (p2), each with a character (c1, c2). */
export function seededLog(): Log {
  const log = new Log();
  log.push('room_created', { name: 'Test Room', setting: FANTASY });
  log.push('player_joined', { player: { id: 'p1', displayName: 'Host', isHost: true } }, { actorId: 'p1' });
  log.push('player_joined', { player: { id: 'p2', displayName: 'Bea', isHost: false } }, { actorId: 'p2' });
  log.push('character_created', { character: makeCharacter({ id: 'c1', playerId: 'p1' }) }, { actorId: 'p1' });
  log.push(
    'character_created',
    { character: makeCharacter({ id: 'c2', playerId: 'p2', name: 'Bram', gold: 0 }) },
    { actorId: 'p2' },
  );
  return log;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
