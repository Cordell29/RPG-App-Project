import { z } from 'zod';
import { LIMITS, STAT_KEYS, type StatKey } from './constants.ts';
import { type DiceRoll, type RandomInt, type RollMode, rollDice } from './dice.ts';
import type { SettingPreset } from './preset.ts';
import { statModifier } from './rules.ts';
import { type Character, type Stats, StatsSchema } from './state.ts';

/** Character creation rules (spec Addendum A10). Pure; the server validates with these. */

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8] as const;
export const POINT_BUY_BUDGET = 27;
export const POINT_BUY_COST: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
/** Marks server-rolled ability scores. The player dice parser cannot produce this notation. */
export const STAT_ROLL_NOTATION = '4d6 drop lowest';
export const STAT_METHODS = ['standard', 'pointbuy', 'rolled'] as const;
export type StatMethod = (typeof STAT_METHODS)[number];
export const STARTING_GOLD = 10;
export const MAX_CUSTOM_KIT = 6;

const itemName = z.string().trim().min(1).max(LIMITS.itemName);

export const CharacterCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(LIMITS.name),
    ancestry: z.string().trim().max(LIMITS.name),
    className: z.string().trim().min(1).max(LIMITS.name),
    /** A preset role name. When it matches, the server uses that role's kit and ignores customKit. */
    roleName: z.string().trim().max(40).optional(),
    customKit: z.array(itemName).max(MAX_CUSTOM_KIT).optional(),
    statMethod: z.enum(STAT_METHODS),
    stats: StatsSchema,
    visualDescriptor: z.string().trim().max(LIMITS.visualDescriptor).default(''),
    notes: z.string().trim().max(LIMITS.characterNotes).default(''),
    personalItem: z
      .object({ name: itemName, notes: z.string().trim().max(LIMITS.itemNotes).default('') })
      .optional(),
  })
  .strict();
export type CharacterCreateInput = z.infer<typeof CharacterCreateSchema>;

const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => b - a);
const sameMultiset = (a: readonly number[], b: readonly number[]) => sorted(a).join(',') === sorted(b).join(',');
const values = (s: Stats) => STAT_KEYS.map((k) => s[k]);

export function pointBuyCost(stats: Stats): number {
  return values(stats).reduce((n, v) => n + (POINT_BUY_COST[v] ?? Infinity), 0);
}

/** Returns a readable reason when the scores break the chosen method's rules, else null. */
export function checkStats(method: StatMethod, stats: Stats, rolledPool?: readonly number[]): string | null {
  const v = values(stats);
  switch (method) {
    case 'standard':
      return sameMultiset(v, STANDARD_ARRAY) ? null : `Use each standard array score once: ${STANDARD_ARRAY.join(', ')}.`;
    case 'pointbuy': {
      if (v.some((x) => x < 8 || x > 15)) return 'Point-buy scores must be between 8 and 15.';
      const cost = pointBuyCost(stats);
      return cost <= POINT_BUY_BUDGET ? null : `That costs ${cost} points; the budget is ${POINT_BUY_BUDGET}.`;
    }
    case 'rolled':
      if (!rolledPool || rolledPool.length !== 6) return 'Roll your scores first.';
      return sameMultiset(v, rolledPool) ? null : `Use each of your rolled scores once: ${sorted(rolledPool).join(', ')}.`;
  }
}

/** Standard array in priority order (used by AI drafts, which pick an order, never numbers). */
export function assignByPriority(priority: readonly string[]): Stats {
  const order: StatKey[] = [];
  for (const k of [...priority, ...STAT_KEYS]) {
    if ((STAT_KEYS as readonly string[]).includes(k) && !order.includes(k as StatKey)) order.push(k as StatKey);
  }
  return Object.fromEntries(order.map((k, i) => [k, STANDARD_ARRAY[i]!])) as Stats;
}

/** Six rolls of 4d6, lowest die dropped. Server-only (pass crypto.randomInt). */
export function rollStatPool(randomInt: RandomInt): DiceRoll[] {
  return Array.from({ length: 6 }, () => {
    const raw = Array.from({ length: 4 }, () => randomInt(1, 7));
    const low = raw.indexOf(Math.min(...raw));
    const dice = raw.map((value, i) => ({ sides: 6, value, dropped: i === low }));
    const total = dice.filter((d) => !d.dropped).reduce((n, d) => n + d.value, 0);
    return { notation: STAT_ROLL_NOTATION, mode: 'normal' as const, dice, modifier: 0, total };
  });
}

export function findRole(preset: SettingPreset | null, roleName: string | undefined) {
  if (!preset || !roleName) return undefined;
  return preset.roles.find((r) => r.name.toLowerCase() === roleName.trim().toLowerCase());
}

/** Derives a full level-1 Character. Callers must have run checkStats first. */
export function buildCharacter(
  input: CharacterCreateInput,
  ctx: { id: string; playerId: string; preset: SettingPreset | null; newItemId: () => string },
): Character {
  const role = findRole(ctx.preset, input.roleName);
  const kit = role ? role.startingKit.map((name) => ({ name, tags: ['starting'] })) : (input.customKit ?? []).map((name) => ({ name, tags: ['custom'] }));
  const inventory: Character['inventory'] = kit.map((k) => ({
    instanceId: ctx.newItemId(),
    name: k.name,
    qty: 1,
    equipped: false,
    tags: k.tags,
  }));
  if (input.personalItem) {
    inventory.push({
      instanceId: ctx.newItemId(),
      name: input.personalItem.name,
      qty: 1,
      equipped: false,
      tags: ['personal'],
      ...(input.personalItem.notes ? { notes: input.personalItem.notes } : {}),
    });
  }
  const maxHp = Math.max(1, 10 + statModifier(input.stats.con));
  return {
    id: ctx.id,
    playerId: ctx.playerId,
    name: input.name,
    ancestry: input.ancestry,
    class: role?.name ?? input.className,
    level: 1,
    xp: 0,
    hp: { current: maxHp, max: maxHp },
    ac: Math.max(1, 10 + statModifier(input.stats.dex)),
    stats: { ...input.stats },
    gold: STARTING_GOLD,
    inventory,
    conditions: [],
    visualDescriptor: input.visualDescriptor,
    notes: input.notes,
  };
}

export interface ContestSide {
  modifier: number;
  mode: RollMode;
}

/** 5e contest: both sides roll d20 + modifier; higher wins; a tie keeps the status quo. */
export function rollContest(a: ContestSide, b: ContestSide, randomInt: RandomInt) {
  const roll = (s: ContestSide) => rollDice({ groups: [{ count: 1, sides: 20 }], modifier: s.modifier, mode: s.mode }, randomInt);
  const ra = roll(a);
  const rb = roll(b);
  const winner: 'a' | 'b' | 'tie' = ra.total > rb.total ? 'a' : rb.total > ra.total ? 'b' : 'tie';
  return { a: ra, b: rb, winner };
}
