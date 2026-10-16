import { describe, expect, it } from 'vitest';
import {
  type Character,
  type Item,
  effectiveAc,
  effectiveStats,
  itemPower,
  proficiencyBonus,
  saveModifier,
  skillLabel,
  skillModifier,
  weaponAttack,
  getPreset,
} from '../src/index.ts';
import { makeCharacter } from './fixtures.ts';

const item = (over: Partial<Item>): Item => ({ instanceId: 'x', name: 'Thing', qty: 1, equipped: true, tags: [], ...over });
const base = (over: Partial<Character> = {}) =>
  makeCharacter({ id: 'c1', playerId: 'p1', ac: 10, stats: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 }, ...over });

describe('proficiency', () => {
  it.each([
    [1, 2],
    [4, 2],
    [5, 3],
    [9, 4],
    [13, 5],
    [17, 6],
    [20, 6],
  ])('level %i → +%i', (level, pb) => expect(proficiencyBonus(level)).toBe(pb));
});

describe('effective AC', () => {
  it('unarmoured: base AC + Dex', () => expect(effectiveAc(base())).toBe(12));
  it('armour replaces base and caps Dex', () => {
    const c = base({ inventory: [item({ slot: 'armor', effects: { acBase: 13, dexCap: 2 } })], stats: { str: 10, dex: 18, con: 10, int: 10, wis: 10, cha: 10 } });
    expect(effectiveAc(c)).toBe(15);
  });
  it('heavy armour ignores Dex; shields and magic bonuses add', () => {
    const c = base({
      inventory: [
        item({ instanceId: 'a', slot: 'armor', effects: { acBase: 16, dexCap: 0 } }),
        item({ instanceId: 's', slot: 'shield', effects: { acBonus: 2 } }),
        item({ instanceId: 'r', slot: 'other', effects: { acBonus: 1 } }),
      ],
    });
    expect(effectiveAc(c)).toBe(19);
  });
  it('unequipped items do nothing', () => {
    const c = base({ inventory: [item({ equipped: false, slot: 'armor', effects: { acBase: 18, dexCap: 0 } })] });
    expect(effectiveAc(c)).toBe(12);
  });
});

describe('modifiers', () => {
  const c = base({
    proficiencies: { skills: ['stealth', 'athletics'], saves: ['str', 'con'] },
    inventory: [item({ slot: 'other', effects: { statBonus: { dex: 2 }, skillBonus: { perception: 1 }, saveBonus: 1 } })],
  });
  it('item stat bonuses raise effective stats', () => expect(effectiveStats(c).dex).toBe(16));
  it('skills: stat mod + proficiency + item bonus', () => {
    expect(skillModifier(c, 'stealth')).toBe(3 + 2); // dex 16 → +3, proficient
    expect(skillModifier(c, 'perception')).toBe(1 + 1); // wis 12 → +1, item +1
    expect(skillModifier(c, 'deception')).toBe(-1);
  });
  it('saves: stat mod + proficiency + save bonus', () => {
    expect(saveModifier(c, 'con')).toBe(2 + 2 + 1);
    expect(saveModifier(c, 'int')).toBe(0 + 1);
  });
});

describe('weapon attacks', () => {
  it('uses the weapon stat, proficiency and magic bonus', () => {
    const sword = item({ slot: 'weapon', name: '+1 Longsword', effects: { damage: '1d8', damageStat: 'str', damageType: 'slashing', attackBonus: 1 } });
    expect(weaponAttack(base(), sword)).toEqual({ attackBonus: 3 + 2 + 1, damage: '1d8+4', damageType: 'slashing' });
  });
  it('no weapon effects means an improvised 1d4 strike', () => {
    expect(weaponAttack(base(), item({ name: 'Chair' }))).toEqual({ attackBonus: 5, damage: '1d4+3', damageType: 'bludgeoning' });
  });
});

describe('item power tiers', () => {
  it.each([
    [{}, 0],
    [{ slot: 'shield' as const, effects: { acBonus: 2 } }, 0],
    [{ slot: 'shield' as const, effects: { acBonus: 3 } }, 1],
    [{ slot: 'armor' as const, effects: { acBase: 18, dexCap: 0 } }, 0],
    [{ slot: 'armor' as const, effects: { acBase: 20, dexCap: 0 } }, 2],
    [{ slot: 'weapon' as const, effects: { damage: '1d8', damageStat: 'str' as const, attackBonus: 2 } }, 2],
    [{ effects: { statBonus: { str: 3 } } }, 3],
    [{ effects: { skillBonus: { stealth: 1 }, saveBonus: 1 } }, 1],
  ])('%j → %i', (over, power) => expect(itemPower(item(over))).toBe(power));
});

describe('labels', () => {
  it('sci-fi renames stats and skills; fantasy uses 5e names', () => {
    const scifi = getPreset('scifi')!;
    expect(scifi.statLabels).toEqual({ str: 'Iron', dex: 'Edge', con: 'Grit', int: 'Wits', wis: 'Shadow', cha: 'Heart' });
    expect(skillLabel(scifi, 'arcana')).toBe('Precursor Lore');
    expect(skillLabel(scifi, 'stealth')).toBe('Stealth');
    expect(skillLabel(getPreset('fantasy')!, 'arcana')).toBe('Arcana');
  });
});
