import { z } from 'zod';
import { SKILL_KEYS, STAT_KEYS } from './constants.ts';

/** Leaf schemas shared by state.ts and preset.ts (kept separate to avoid an import cycle). */

export const StatKeySchema = z.enum(STAT_KEYS);
export const SkillKeySchema = z.enum(SKILL_KEYS);

const bonus = z.number().int().min(-5).max(10);

/** Mechanical effects of an item. Only equipped items apply. Absent = flavour item. */
export const ItemEffectsSchema = z
  .object({
    /** Armour: base AC before Dex. */
    acBase: z.number().int().min(10).max(20),
    /** Armour: max Dex modifier added (null/absent = no cap). */
    dexCap: z.number().int().min(0).max(10).nullable(),
    /** Shields and other protective items. */
    acBonus: bonus,
    /** Weapons: damage dice, e.g. "1d8" or "2d6". */
    damage: z.string().regex(/^\d{1,2}d\d{1,3}$/),
    damageStat: z.enum(['str', 'dex']),
    damageType: z.string().max(20),
    attackBonus: bonus,
    statBonus: z.object({ str: bonus, dex: bonus, con: bonus, int: bonus, wis: bonus, cha: bonus }).partial(),
    saveBonus: bonus,
    skillBonus: z.record(z.string(), bonus),
  })
  .partial();
export type ItemEffects = z.infer<typeof ItemEffectsSchema>;
