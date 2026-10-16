import { describe, expect, it } from 'vitest';
import { BUILT_IN_PRESETS, SettingPresetSchema, resolveStart, startTable, titleFrom } from '../src/index.ts';

const fantasy = BUILT_IN_PRESETS.find((p) => p.key === 'fantasy')!;
const scifi = BUILT_IN_PRESETS.find((p) => p.key === 'scifi')!;

describe('starting locations', () => {
  it('built-in presets carry a varied table of at least 12 distinct starts', () => {
    for (const p of [fantasy, scifi]) {
      expect(p.starts.length).toBeGreaterThanOrEqual(12);
      expect(new Set(p.starts.map((s) => s.title)).size).toBe(p.starts.length);
      for (const s of p.starts) expect(s.hooks.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('random uses the supplied dice and covers the whole table', () => {
    const seen = new Set<string>();
    for (let i = 0; i < fantasy.starts.length; i++) {
      seen.add(resolveStart(fantasy, { kind: 'random' }, (min) => min + i).title);
    }
    expect(seen.size).toBe(fantasy.starts.length);
    expect(resolveStart(fantasy, { kind: 'random' }, () => 0).source).toBe('random');
  });

  it('a re-roll never lands on the current start', () => {
    const current = fantasy.starts[0]!.title;
    for (let i = 0; i < fantasy.starts.length - 1; i++) {
      expect(resolveStart(fantasy, { kind: 'random' }, () => i, current).title).not.toBe(current);
    }
  });

  it('pick and custom', () => {
    expect(resolveStart(scifi, { kind: 'pick', index: 2 }, () => 0)).toEqual({ ...scifi.starts[2], source: 'picked' });
    expect(() => resolveStart(scifi, { kind: 'pick', index: 29 }, () => 0)).toThrow(/does not exist/);
    const custom = resolveStart(scifi, { kind: 'custom', text: 'A derelict casino orbiting a dead star, lights still on.' }, () => 0);
    expect(custom).toEqual({ title: 'A derelict casino orbiting a dead star', description: 'A derelict casino orbiting a dead star, lights still on.', hooks: [], source: 'custom' });
    expect(resolveStart(scifi, { kind: 'custom', title: 'The Lucky Void', text: 'x' }, () => 0).title).toBe('The Lucky Void');
  });

  it('settings without a table fall back to their opening hooks', () => {
    const old = SettingPresetSchema.parse({ ...fantasy, starts: undefined });
    expect(old.starts).toEqual([]);
    expect(startTable(old)).toHaveLength(3);
    expect(startTable(old)[0]!.hooks).toEqual([old.openingHooks[0]]);
    expect(titleFrom('A dying courier stumbles into the tavern, bleeding.')).toBe('A dying courier stumbles into the tavern');
  });
});
