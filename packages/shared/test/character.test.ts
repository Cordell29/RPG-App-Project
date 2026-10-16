import { describe, expect, it } from 'vitest';
import {
  CharacterCreateSchema,
  CharacterSchema,
  STANDARD_ARRAY,
  STAT_ROLL_NOTATION,
  assignByPriority,
  buildCharacter,
  checkStats,
  getPreset,
  pointBuyCost,
  rollContest,
  rollStatPool,
} from '../src/index.ts';

const fantasy = getPreset('fantasy')!;
const scripted = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

describe('stat methods', () => {
  it('standard array must be used exactly once each', () => {
    expect(checkStats('standard', { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 })).toBeNull();
    expect(checkStats('standard', { str: 8, dex: 10, con: 12, int: 13, wis: 14, cha: 15 })).toBeNull();
    expect(checkStats('standard', { str: 15, dex: 15, con: 13, int: 12, wis: 10, cha: 8 })).toMatch(/standard array/i);
  });

  it('point buy: 27 points, scores 8–15, 5e costs', () => {
    expect(pointBuyCost({ str: 15, dex: 15, con: 15, int: 8, wis: 8, cha: 8 })).toBe(27);
    expect(checkStats('pointbuy', { str: 15, dex: 15, con: 15, int: 8, wis: 8, cha: 8 })).toBeNull();
    expect(checkStats('pointbuy', { str: 13, dex: 13, con: 13, int: 12, wis: 12, cha: 12 })).toBeNull(); // 15+12 = 27
    expect(checkStats('pointbuy', { str: 15, dex: 15, con: 15, int: 9, wis: 8, cha: 8 })).toMatch(/28 points/);
    expect(checkStats('pointbuy', { str: 16, dex: 8, con: 8, int: 8, wis: 8, cha: 8 })).toMatch(/8 and 15/);
  });

  it('rolled scores must match the server-rolled pool exactly', () => {
    const pool = [16, 14, 12, 11, 9, 7];
    expect(checkStats('rolled', { str: 7, dex: 16, con: 14, int: 12, wis: 11, cha: 9 }, pool)).toBeNull();
    expect(checkStats('rolled', { str: 18, dex: 16, con: 14, int: 12, wis: 11, cha: 9 }, pool)).toMatch(/rolled/);
    expect(checkStats('rolled', { str: 7, dex: 16, con: 14, int: 12, wis: 11, cha: 9 })).toMatch(/Roll your scores/);
  });

  it('assigns the standard array by priority', () => {
    expect(assignByPriority(['dex', 'wis', 'con', 'int', 'cha', 'str'])).toEqual({
      dex: 15,
      wis: 14,
      con: 13,
      int: 12,
      cha: 10,
      str: 8,
    });
    // Missing or repeated keys are filled in a fixed order so the result is always valid.
    const partial = assignByPriority(['cha', 'cha', 'str']);
    expect(checkStats('standard', partial)).toBeNull();
    expect(partial.cha).toBe(15);
    expect(partial.str).toBe(14);
  });
});

describe('rollStatPool', () => {
  it('rolls 4d6 six times and drops the lowest die of each', () => {
    const rolls = rollStatPool(scripted([6, 5, 1, 3]));
    expect(rolls).toHaveLength(6);
    for (const r of rolls) {
      expect(r.notation).toBe(STAT_ROLL_NOTATION);
      expect(r.dice).toHaveLength(4);
      expect(r.dice.filter((d) => d.dropped)).toEqual([{ sides: 6, value: 1, dropped: true }]);
      expect(r.total).toBe(14);
    }
  });

  it('drops only one die when the lowest is tied', () => {
    const [r] = rollStatPool(scripted([2, 2, 2, 2]));
    expect(r!.dice.filter((d) => d.dropped)).toHaveLength(1);
    expect(r!.total).toBe(6);
  });
});

describe('buildCharacter', () => {
  let n = 0;
  const ids = { id: 'c1', playerId: 'p1', newItemId: () => `i${++n}` };

  it('derives a valid level-1 character from a preset role', () => {
    const input = CharacterCreateSchema.parse({
      name: 'Ayla',
      ancestry: 'Human',
      className: 'Fighter',
      roleName: 'Fighter',
      statMethod: 'standard',
      stats: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 },
      visualDescriptor: 'tall, braided red hair, scarred leather armour',
      notes: 'Owes the Thieves Guild a favour.',
      personalItem: { name: "Mother's locket", notes: 'Holds a faded portrait.' },
    });
    const c = buildCharacter(input, { ...ids, preset: fantasy });
    expect(CharacterSchema.parse(c)).toEqual(c);
    expect(c).toMatchObject({
      level: 1,
      xp: 0,
      hp: { current: 12, max: 12 }, // 10 + CON 14 (+2)
      ac: 11, // 10 + DEX 13 (+1)
      gold: 10,
      class: 'Fighter',
      conditions: [],
    });
    expect(c.inventory.map((i) => i.name)).toEqual(['Longsword', 'Shield', 'Chain shirt', 'Rations (3 days)', "Mother's locket"]);
    expect(c.inventory.at(-1)).toMatchObject({ tags: ['personal'], notes: 'Holds a faded portrait.' });
    expect(new Set(c.inventory.map((i) => i.instanceId)).size).toBe(c.inventory.length);
  });

  it('ignores a client-sent kit when a preset role is chosen', () => {
    const input = CharacterCreateSchema.parse({
      name: 'Sneaky',
      ancestry: '',
      className: 'Rogue',
      roleName: 'Rogue',
      customKit: ['Vorpal sword', 'Bag of holding'],
      statMethod: 'standard',
      stats: { str: 8, dex: 15, con: 14, int: 13, wis: 12, cha: 10 },
    });
    const c = buildCharacter(input, { ...ids, preset: fantasy });
    expect(c.inventory.map((i) => i.name)).not.toContain('Vorpal sword');
    expect(c.inventory.map((i) => i.name)).toContain("Thieves' tools");
  });

  it('a custom class uses a small custom kit, tagged as such', () => {
    const input = CharacterCreateSchema.parse({
      name: 'Pell',
      ancestry: 'Canal-born',
      className: 'Lamplighter',
      customKit: ['Hooked pole', 'Oil flask', 'Tinderbox'],
      statMethod: 'standard',
      stats: { str: 10, dex: 14, con: 13, int: 12, wis: 15, cha: 8 },
    });
    const c = buildCharacter(input, { ...ids, preset: fantasy });
    expect(c.class).toBe('Lamplighter');
    expect(c.inventory.map((i) => [i.name, i.tags])).toEqual([
      ['Hooked pole', ['custom']],
      ['Oil flask', ['custom']],
      ['Tinderbox', ['custom']],
    ]);
  });

  it('HP never drops below 1', () => {
    const input = CharacterCreateSchema.parse({
      name: 'Frail',
      ancestry: '',
      className: 'Wizard',
      roleName: 'Wizard',
      statMethod: 'rolled',
      stats: { str: 3, dex: 3, con: 1, int: 3, wis: 3, cha: 3 },
    });
    expect(buildCharacter(input, { ...ids, preset: fantasy }).hp).toEqual({ current: 5, max: 5 });
  });

  it('the create schema rejects mechanical fields and long kits', () => {
    const base = {
      name: 'X',
      ancestry: '',
      className: 'Fighter',
      statMethod: 'standard',
      stats: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
    };
    expect(CharacterCreateSchema.safeParse({ ...base, gold: 9999 }).success).toBe(false);
    expect(CharacterCreateSchema.safeParse({ ...base, hp: { current: 99, max: 99 } }).success).toBe(false);
    expect(CharacterCreateSchema.safeParse({ ...base, customKit: Array(7).fill('rock') }).success).toBe(false);
  });
});

describe('rollContest (5e contests)', () => {
  it('higher total wins', () => {
    const r = rollContest({ modifier: 2, mode: 'normal' }, { modifier: 0, mode: 'normal' }, scripted([10, 11]));
    expect(r.a.total).toBe(12);
    expect(r.b.total).toBe(11);
    expect(r.winner).toBe('a');
  });

  it('a tie keeps the status quo', () => {
    const r = rollContest({ modifier: 3, mode: 'normal' }, { modifier: 1, mode: 'normal' }, scripted([8, 10]));
    expect(r.winner).toBe('tie');
  });

  it('applies advantage and disadvantage per side', () => {
    const r = rollContest({ modifier: 0, mode: 'advantage' }, { modifier: 0, mode: 'disadvantage' }, scripted([4, 17, 18, 2]));
    expect(r.a.total).toBe(17);
    expect(r.b.total).toBe(2);
    expect(r.a.dice).toHaveLength(2);
    expect(r.winner).toBe('a');
  });
});
