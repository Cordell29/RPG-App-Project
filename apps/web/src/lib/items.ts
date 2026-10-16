import type { Item, SettingPreset } from '@tavern/shared';

/** Short, readable summary of what an item does mechanically. */
export function effectText(item: Item, preset: SettingPreset | null): string {
  const e = item.effects;
  if (!e) return '';
  const label = (k: string) => preset?.statLabels[k as keyof SettingPreset['statLabels']] ?? k;
  const parts: string[] = [];
  if (e.acBase) parts.push(`AC ${e.acBase}${e.dexCap === 0 ? '' : e.dexCap ? ` + ${label('dex')} (max ${e.dexCap})` : ` + ${label('dex')}`}`);
  if (e.acBonus) parts.push(`${e.acBonus > 0 ? '+' : ''}${e.acBonus} AC`);
  if (e.damage) parts.push(`${e.damage} ${e.damageType ?? ''}`.trim() + ` (${label(e.damageStat ?? 'str')})`);
  if (e.attackBonus) parts.push(`+${e.attackBonus} attack & damage`);
  for (const [k, v] of Object.entries(e.statBonus ?? {})) parts.push(`${v > 0 ? '+' : ''}${v} ${label(k)}`);
  if (e.saveBonus) parts.push(`+${e.saveBonus} all saves`);
  for (const [k, v] of Object.entries(e.skillBonus ?? {})) parts.push(`+${v} ${k.replace(/_/g, ' ')}`);
  return parts.join(' · ');
}
