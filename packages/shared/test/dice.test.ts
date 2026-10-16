import { describe, expect, it } from 'vitest';
import { DiceError, PAYLOAD_SCHEMAS, formatDice, parseDice, rollDice } from '../src/index.ts';

/** Deterministic stand-in for crypto.randomInt(min, maxExclusive): cycles through values. */
function scripted(values: number[]) {
  let i = 0;
  return (min: number, maxExclusive: number) => {
    const v = values[i++ % values.length]!;
    if (v < min || v >= maxExclusive) throw new Error(`scripted ${v} outside [${min}, ${maxExclusive})`);
    return v;
  };
}

describe('parseDice', () => {
  it.each([
    ['d20', { groups: [{ count: 1, sides: 20 }], modifier: 0, mode: 'normal' }],
    ['1d20+5', { groups: [{ count: 1, sides: 20 }], modifier: 5, mode: 'normal' }],
    ['2d6+3', { groups: [{ count: 2, sides: 6 }], modifier: 3, mode: 'normal' }],
    ['3d8-2', { groups: [{ count: 3, sides: 8 }], modifier: -2, mode: 'normal' }],
    [' 2D8 + 1d4 - 1 ', { groups: [{ count: 2, sides: 8 }, { count: 1, sides: 4 }], modifier: -1, mode: 'normal' }],
    ['1d20 adv', { groups: [{ count: 1, sides: 20 }], modifier: 0, mode: 'advantage' }],
    ['1d20+3 dis', { groups: [{ count: 1, sides: 20 }], modifier: 3, mode: 'disadvantage' }],
    ['d20 advantage', { groups: [{ count: 1, sides: 20 }], modifier: 0, mode: 'advantage' }],
    ['d100', { groups: [{ count: 1, sides: 100 }], modifier: 0, mode: 'normal' }],
    ['1d6+1+2', { groups: [{ count: 1, sides: 6 }], modifier: 3, mode: 'normal' }],
  ])('parses %s', (input, expected) => {
    expect(parseDice(input)).toEqual(expected);
  });

  it.each([
    ['', /empty/i],
    ['hello', /could not read/i],
    ['0d6', /at least 1/i],
    ['101d6', /at most 100/i],
    ['60d6+60d6', /at most 100/i],
    ['1d1', /sides/i],
    ['1d1001', /sides/i],
    ['2d6 adv', /single d20/i],
    ['1d20+1d4 adv', /single d20/i],
    ['5', /at least one die/i],
    ['1d6+99999', /modifier/i],
    ['1d6 + + 2', /could not read/i],
  ])('rejects %j', (input, message) => {
    expect(() => parseDice(input)).toThrow(DiceError);
    expect(() => parseDice(input)).toThrow(message);
  });

  it('formats back to canonical notation', () => {
    expect(formatDice(parseDice(' 2D8 + 1d4 - 1 '))).toBe('2d8+1d4-1');
    expect(formatDice(parseDice('d20+5 adv'))).toBe('1d20+5 adv');
    expect(formatDice(parseDice('1d20 dis'))).toBe('1d20 dis');
  });
});

describe('rollDice', () => {
  it('sums dice and modifier', () => {
    const r = rollDice(parseDice('2d6+3'), scripted([4, 6]));
    expect(r).toEqual({
      notation: '2d6+3',
      mode: 'normal',
      dice: [
        { sides: 6, value: 4, dropped: false },
        { sides: 6, value: 6, dropped: false },
      ],
      modifier: 3,
      total: 13,
    });
  });

  it('advantage keeps the higher d20, disadvantage the lower', () => {
    const adv = rollDice(parseDice('1d20+2 adv'), scripted([7, 15]));
    expect(adv.dice).toEqual([
      { sides: 20, value: 7, dropped: true },
      { sides: 20, value: 15, dropped: false },
    ]);
    expect(adv.total).toBe(17);
    const dis = rollDice(parseDice('1d20+2 dis'), scripted([7, 15]));
    expect(dis.total).toBe(9);
    expect(dis.dice.map((d) => d.dropped)).toEqual([false, true]);
  });

  it('ties drop the second die', () => {
    const r = rollDice(parseDice('1d20 adv'), scripted([11, 11]));
    expect(r.dice.map((d) => d.dropped)).toEqual([false, true]);
  });

  it('asks the RNG for 1…sides inclusive', () => {
    const calls: [number, number][] = [];
    rollDice(parseDice('1d20+1d6'), (min, max) => {
      calls.push([min, max]);
      return min;
    });
    expect(calls).toEqual([
      [1, 21],
      [1, 7],
    ]);
  });

  it('produces a valid dice_rolled payload', () => {
    const r = rollDice(parseDice('4d6-1'), scripted([1, 2, 3, 4]));
    expect(() => PAYLOAD_SCHEMAS.dice_rolled.parse(r)).not.toThrow();
  });

  it('stays within bounds for many rolls with a real RNG', () => {
    const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));
    for (let i = 0; i < 500; i++) {
      const r = rollDice(parseDice('3d6+2'), rand);
      expect(r.total).toBeGreaterThanOrEqual(5);
      expect(r.total).toBeLessThanOrEqual(20);
    }
  });
});
