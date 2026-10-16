import { DEFAULT_SKILL_LABELS, SKILLS, STAT_KEYS, type SkillKey, type StatKey } from './constants.ts';
import type { SettingPreset } from './preset.ts';
import { proficiencyBonus, statModifier } from './rules.ts';
import type { Character, Item, Stats } from './state.ts';

/** Derived numbers. Pure functions of a character; nothing here is stored. */

export const equipped = (c: Character) => c.inventory.filter((i) => i.equipped && i.effects);

export function effectiveStats(c: Character): Stats {
  const out = { ...c.stats };
  for (const i of equipped(c)) {
    for (const k of STAT_KEYS) out[k] = Math.max(1, Math.min(30, out[k] + (i.effects!.statBonus?.[k] ?? 0)));
  }
  return out;
}

export const effMod = (c: Character, stat: StatKey) => statModifier(effectiveStats(c)[stat]);

/** Armour (base + Dex up to its cap) or base AC + Dex, plus shield and other bonuses. */
export function effectiveAc(c: Character): number {
  const dex = effMod(c, 'dex');
  const armour = equipped(c)
    .filter((i) => i.slot === 'armor' && i.effects!.acBase)
    .sort((a, b) => b.effects!.acBase! - a.effects!.acBase!)[0];
  const body = armour ? armour.effects!.acBase! + Math.min(dex, armour.effects!.dexCap ?? Infinity) : c.ac + dex;
  return body + equipped(c).reduce((n, i) => n + (i.effects!.acBonus ?? 0), 0);
}

export function skillModifier(c: Character, skill: SkillKey): number {
  const prof = c.proficiencies.skills.includes(skill) ? proficiencyBonus(c.level) : 0;
  const items = equipped(c).reduce((n, i) => n + (i.effects!.skillBonus?.[skill] ?? 0), 0);
  return effMod(c, SKILLS[skill]) + prof + items;
}

export function saveModifier(c: Character, stat: StatKey): number {
  const prof = c.proficiencies.saves.includes(stat) ? proficiencyBonus(c.level) : 0;
  const items = equipped(c).reduce((n, i) => n + (i.effects!.saveBonus ?? 0), 0);
  return effMod(c, stat) + prof + items;
}

/** Modifier for a check: a skill (uses its stat), a save, or a raw stat. */
export function checkModifier(c: Character, check: { stat: StatKey; skill?: SkillKey | undefined; save?: boolean | undefined }): number {
  if (check.skill) return skillModifier(c, check.skill);
  if (check.save) return saveModifier(c, check.stat);
  return effMod(c, check.stat);
}

/** Attack bonus and damage notation for a weapon (or an improvised 1d4 strike). */
export function weaponAttack(c: Character, item: Item) {
  const e = item.effects ?? {};
  const stat = e.damageStat ?? 'str';
  const mod = effMod(c, stat) + (e.attackBonus ?? 0);
  const flat = mod === 0 ? '' : mod > 0 ? `+${mod}` : `${mod}`;
  return {
    attackBonus: effMod(c, stat) + proficiencyBonus(c.level) + (e.attackBonus ?? 0),
    damage: `${e.damage ?? '1d4'}${flat}`,
    damageType: e.damageType ?? 'bludgeoning',
  };
}

/**
 * Magic power of an item: 0 mundane, 1 uncommon, 2 rare, 3+ very rare. Mundane baselines
 * (a +2 shield, armour up to AC 18) do not count.
 */
export function itemPower(item: Pick<Item, 'slot' | 'effects'>): number {
  const e = item.effects;
  if (!e) return 0;
  const parts = [
    e.attackBonus ?? 0,
    e.saveBonus ?? 0,
    (e.acBonus ?? 0) - (item.slot === 'shield' ? 2 : 0),
    (e.acBase ?? 0) - 18,
    ...Object.values(e.statBonus ?? {}),
    ...Object.values(e.skillBonus ?? {}),
  ];
  return Math.max(0, ...parts);
}

export function skillLabel(preset: SettingPreset | null, skill: SkillKey): string {
  return preset?.skillLabels[skill] ?? DEFAULT_SKILL_LABELS[skill];
}

export function statLabel(preset: SettingPreset | null, stat: StatKey): string {
  return preset?.statLabels[stat] ?? stat.toUpperCase();
}
