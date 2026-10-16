import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_PRESETS, SettingPresetSchema, getPreset } from '../src/index.ts';

describe('presets', () => {
  const dir = new URL('../presets/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

  it('every preset file is valid and registered', () => {
    for (const f of files) {
      const preset = SettingPresetSchema.parse(JSON.parse(readFileSync(new URL(f, dir), 'utf8')));
      expect(getPreset(preset.key)).toEqual(preset);
    }
    expect(BUILT_IN_PRESETS).toHaveLength(files.length);
  });

  it('fantasy and sci-fi supply the spec labels', () => {
    expect(getPreset('fantasy')).toMatchObject({ currencyName: 'gold', statLabels: { str: 'Strength' } });
    expect(getPreset('scifi')).toMatchObject({ currencyName: 'credits', statLabels: { int: 'Wits', cha: 'Heart' }, meters: ['spirit', 'supply'] });
  });

  it('every starting-kit weapon and armour has a catalogue entry with effects', () => {
    for (const p of BUILT_IN_PRESETS) {
      for (const role of p.roles) {
        expect(role.saves).toHaveLength(2);
        expect(role.skillCount).toBeGreaterThanOrEqual(2);
        for (const choice of role.skillChoices) expect(typeof choice).toBe('string');
      }
      for (const item of p.items) if (item.slot === 'weapon') expect(item.effects?.damage).toMatch(/^\d+d\d+$/);
    }
  });

  it('art styles describe a look without naming a product', () => {
    for (const p of BUILT_IN_PRESETS) expect(p.artStyle).toMatch(/^Painterly/);
  });
});
