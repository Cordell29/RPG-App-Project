import type { PayloadOf } from './events.ts';

/**
 * Dice notation parser and roller. The roller takes the random source as an argument:
 * the server passes crypto.randomInt; clients only ever parse (to validate input).
 */

export class DiceError extends Error {
  override name = 'DiceError';
}

export type RollMode = 'normal' | 'advantage' | 'disadvantage';

export interface DiceSpec {
  groups: { count: number; sides: number }[];
  modifier: number;
  mode: RollMode;
}

/** Same contract as crypto.randomInt(min, maxExclusive). */
export type RandomInt = (min: number, maxExclusive: number) => number;

export const DICE_LIMITS = { maxDice: 100, minSides: 2, maxSides: 1000, maxModifier: 1000, maxLength: 40 } as const;

const MODE_WORDS: Record<string, RollMode> = {
  adv: 'advantage',
  advantage: 'advantage',
  dis: 'disadvantage',
  disadvantage: 'disadvantage',
};

export function parseDice(input: string): DiceSpec {
  let text = input.trim().toLowerCase();
  if (!text) throw new DiceError('Dice notation is empty.');
  if (text.length > DICE_LIMITS.maxLength) throw new DiceError('Dice notation is too long.');

  let mode: RollMode = 'normal';
  const modeMatch = /\s+([a-z]+)$/.exec(text);
  if (modeMatch && MODE_WORDS[modeMatch[1]!]) {
    mode = MODE_WORDS[modeMatch[1]!]!;
    text = text.slice(0, modeMatch.index);
  }

  const compact = text.replace(/\s+/g, '');
  if (!/^[+-]?(\d*d\d+|\d+)([+-](\d*d\d+|\d+))*$/.test(compact)) {
    throw new DiceError(`Could not read "${input.trim()}". Try something like 2d6+3 or 1d20 adv.`);
  }

  const groups: DiceSpec['groups'] = [];
  let modifier = 0;
  for (const [, sign, term] of compact.matchAll(/([+-]?)(\d*d\d+|\d+)/g)) {
    const negative = sign === '-';
    if (term!.includes('d')) {
      if (negative) throw new DiceError('Dice cannot be subtracted.');
      const [countText, sidesText] = term!.split('d');
      const count = countText ? Number(countText) : 1;
      const sides = Number(sidesText);
      if (count < 1) throw new DiceError('Roll at least 1 die.');
      if (sides < DICE_LIMITS.minSides || sides > DICE_LIMITS.maxSides) {
        throw new DiceError(`Dice need between ${DICE_LIMITS.minSides} and ${DICE_LIMITS.maxSides} sides.`);
      }
      groups.push({ count, sides });
    } else {
      modifier += negative ? -Number(term) : Number(term);
    }
  }

  if (groups.length === 0) throw new DiceError('Roll at least one die, e.g. 1d20.');
  const total = groups.reduce((n, g) => n + g.count, 0);
  if (total > DICE_LIMITS.maxDice) throw new DiceError(`Roll at most ${DICE_LIMITS.maxDice} dice at once.`);
  if (Math.abs(modifier) > DICE_LIMITS.maxModifier) {
    throw new DiceError(`The modifier must be within ±${DICE_LIMITS.maxModifier}.`);
  }
  if (mode !== 'normal' && !(groups.length === 1 && groups[0]!.count === 1 && groups[0]!.sides === 20)) {
    throw new DiceError('Advantage and disadvantage apply to a single d20 only.');
  }
  return { groups, modifier, mode };
}

export function formatDice(spec: DiceSpec): string {
  const dice = spec.groups.map((g) => `${g.count}d${g.sides}`).join('+');
  const mod = spec.modifier > 0 ? `+${spec.modifier}` : spec.modifier < 0 ? `${spec.modifier}` : '';
  const mode = spec.mode === 'advantage' ? ' adv' : spec.mode === 'disadvantage' ? ' dis' : '';
  return `${dice}${mod}${mode}`;
}

export type DiceRoll = Pick<PayloadOf<'dice_rolled'>, 'notation' | 'mode' | 'dice' | 'modifier' | 'total'>;

export function rollDice(spec: DiceSpec, randomInt: RandomInt): DiceRoll {
  const dice: DiceRoll['dice'] = [];
  if (spec.mode !== 'normal') {
    const a = randomInt(1, 21);
    const b = randomInt(1, 21);
    const keepFirst = spec.mode === 'advantage' ? a >= b : a <= b;
    dice.push({ sides: 20, value: a, dropped: !keepFirst }, { sides: 20, value: b, dropped: keepFirst });
  } else {
    for (const g of spec.groups) {
      for (let i = 0; i < g.count; i++) dice.push({ sides: g.sides, value: randomInt(1, g.sides + 1), dropped: false });
    }
  }
  const kept = dice.filter((d) => !d.dropped).reduce((n, d) => n + d.value, 0);
  return { notation: formatDice(spec), mode: spec.mode, dice, modifier: spec.modifier, total: kept + spec.modifier };
}
