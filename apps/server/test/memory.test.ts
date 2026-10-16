import { type GameState, BUILT_IN_PRESETS, CharacterCreateSchema, buildCharacter, estimateTokens, getPreset, replay } from '@tavern/shared';
import { describe, expect, it } from 'vitest';
import { Log } from '../../../packages/shared/test/fixtures.ts';
import { BUDGETS, type CanonEntry, buildTurnPrompt, selectCanon, systemBibleTokens } from '../src/gm/prompt.ts';
import { deriveCanon } from '../src/memory/canon.ts';

function partyState(size = 2, opts: { heavy?: boolean } = {}): GameState {
  const preset = getPreset('fantasy')!;
  const log = new Log();
  log.push('room_created', { name: 'T', setting: preset });
  let n = 0;
  for (let i = 0; i < size; i++) {
    const role = preset.roles[i % preset.roles.length]!;
    log.push('player_joined', { player: { id: `p${i}`, displayName: `Player ${i}`, isHost: i === 0 } });
    const c = buildCharacter(
      CharacterCreateSchema.parse({
        name: `Hero ${i}`,
        ancestry: 'Human',
        className: role.name,
        roleName: role.name,
        statMethod: 'standard',
        stats: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
        skills: (role.skillChoices.length ? role.skillChoices : ['arcana', 'history', 'insight']).slice(0, role.skillCount),
        saves: ['str', 'dex'],
      }),
      { id: `c${i}`, playerId: `p${i}`, preset, newItemId: () => `i${++n}` },
    );
    if (opts.heavy) {
      c.abilities = Array.from({ length: 8 }, (_, k) => ({ id: `a${i}${k}`, name: `Power ${k}`, description: 'x'.repeat(590), recharge: 'long_rest' as const, uses: { current: 1, max: 1 } }));
      c.inventory.push(...Array.from({ length: 25 }, (_, k) => ({ instanceId: `j${i}${k}`, name: `Trinket ${k}`, qty: 1, equipped: false, tags: [], notes: 'n'.repeat(400) })));
    }
    log.push('character_created', { character: c });
  }
  for (let q = 0; q < 12; q++) log.push('delta_applied', { delta: { type: 'update_quest', key: `q${q}`, title: `Quest ${q}`, status: q < 6 ? 'done' : 'active', note: 'progress '.repeat(10) } });
  return replay(log.events);
}

const actions = [{ playerId: 'p0', characterId: 'c0', text: 'I ask Brother Hal about the debt.' }];
const turn = (i: number, len = 200) => ({ actions: [`Hero 0: action ${i} ${'a'.repeat(len)}`], gist: `Gist ${i} ${'g'.repeat(len)}` });

describe('prompt budgets', () => {
  it('system + bible fits 3,000 tokens for every built-in preset', () => {
    for (const p of BUILT_IN_PRESETS) {
      expect(systemBibleTokens({ ...partyState(1), setting: p })).toBeLessThanOrEqual(BUDGETS.systemBible);
    }
  });

  it('caps sum to the 12,000 total', () => {
    const { systemBible, chronicle, canon, state, recent } = BUDGETS;
    expect(systemBible + chronicle + canon + state + recent).toBeLessThanOrEqual(BUDGETS.total);
  });

  it('chronicle is the third cached system block: arcs first, then chapters, oldest first', () => {
    const p = buildTurnPrompt({ state: partyState(), recent: [], actions, chronicle: { arcs: ['ARC ONE'], chapters: ['CHAPTER A', 'CHAPTER B'] }, canon: [] });
    expect(p.system.map((b) => b.cache)).toEqual([true, true, true]);
    const text = p.system[2]!.text;
    expect(text.indexOf('ARC ONE')).toBeLessThan(text.indexOf('CHAPTER A'));
    expect(text.indexOf('CHAPTER A')).toBeLessThan(text.indexOf('CHAPTER B'));
  });

  it('drops the oldest arcs when the chronicle is over budget', () => {
    const arcs = Array.from({ length: 12 }, (_, i) => `ARC${i} ${'w '.repeat(500)}`);
    const p = buildTurnPrompt({ state: partyState(), recent: [], actions, chronicle: { arcs, chapters: ['LATEST CHAPTER'] }, canon: [] });
    expect(p.budget.chronicle).toBeLessThanOrEqual(BUDGETS.chronicle);
    expect(p.system[2]!.text).not.toMatch(/ARC0 /);
    expect(p.system[2]!.text).toMatch(/ARC11 /);
    expect(p.system[2]!.text).toMatch(/LATEST CHAPTER/);
    expect(p.budget.dropped).toContain('arcs');
  });

  it('a big party with heavy sheets is trimmed to the state budget, keeping ids, HP and active quests', () => {
    const state = partyState(6, { heavy: true });
    const p = buildTurnPrompt({ state, recent: [], actions, canon: [] });
    expect(p.budget.state).toBeLessThanOrEqual(BUDGETS.state);
    const json = JSON.parse(p.user.match(/<state>\n([\s\S]*?)\n<\/state>/)![1]!);
    expect(json.party).toHaveLength(6);
    expect(json.party[5]).toMatchObject({ id: 'c5', hp: expect.stringMatching(/\d+\/\d+/) });
    expect(json.quests.map((q: { title: string }) => q.title)).toEqual(['Quest 6', 'Quest 7', 'Quest 8', 'Quest 9', 'Quest 10', 'Quest 11']);
    expect(p.user).not.toMatch(/nnnnnnnnnn/); // item notes went first
    expect(json.party[0].abilities[0].name).toBe('Power 0'); // names survive
  });

  it('a small party keeps full detail', () => {
    const p = buildTurnPrompt({ state: partyState(2), recent: [], actions, canon: [] });
    expect(p.budget.dropped).toEqual([]);
    expect(p.user).toMatch(/Second Wind/);
    expect(p.user).toMatch(/regain 1d10/);
  });

  it('recent turns: drop oldest to fit, but keep at least 4', () => {
    const recent = Array.from({ length: 8 }, (_, i) => turn(i, 900));
    const p = buildTurnPrompt({ state: partyState(), recent, actions, canon: [] });
    expect(p.budget.recent).toBeLessThanOrEqual(BUDGETS.recent);
    expect(p.user).not.toMatch(/action 0 /);
    expect(p.user).toMatch(/action 7 /);
    const huge = Array.from({ length: 8 }, (_, i) => turn(i, 4000));
    const q = buildTurnPrompt({ state: partyState(), recent: huge, actions, canon: [] });
    for (const i of [4, 5, 6, 7]) expect(q.user).toMatch(new RegExp(`action ${i} `));
    expect(q.budget.recent).toBeLessThanOrEqual(BUDGETS.recent);
  });

  it('total stays under 12,000 even with everything maxed', () => {
    const canon: CanonEntry[] = Array.from({ length: 40 }, (_, i) => ({ kind: 'npc', key: `npc_${i}`, aliases: ['Hal'], facts: ['f'.repeat(280)], updatedSeq: i }));
    const p = buildTurnPrompt({
      state: partyState(6, { heavy: true }),
      recent: Array.from({ length: 8 }, (_, i) => turn(i, 3000)),
      actions: Array.from({ length: 6 }, (_, i) => ({ playerId: `p${i}`, characterId: `c${i}`, text: 'Hal? '.repeat(100) })),
      chronicle: { arcs: Array.from({ length: 10 }, () => 'w '.repeat(900)), chapters: Array.from({ length: 5 }, () => 'c '.repeat(900)) },
      canon,
    });
    expect(p.budget.total).toBeLessThanOrEqual(BUDGETS.total);
    expect(p.budget.canon).toBeLessThanOrEqual(BUDGETS.canon);
    const measured = estimateTokens(p.system.map((b) => b.text).join('') + p.user);
    expect(measured).toBeLessThanOrEqual(BUDGETS.total);
  });
});

describe('canon', () => {
  const entries: CanonEntry[] = [
    { kind: 'npc', key: 'brother_hal', aliases: ['Hal', 'the monk'], facts: ['Ayla owes him 20 gold'], updatedSeq: 10 },
    { kind: 'location', key: 'greywood', aliases: [], facts: ['Haunted forest north of town'], updatedSeq: 20 },
    { kind: 'faction', key: 'iron_hand', aliases: ['the Hand'], facts: ['Smugglers'], updatedSeq: 30 },
  ];

  it('selects entries whose key or alias appears in recent turns, actions or the location', () => {
    const picked = selectCanon(entries, { text: 'I ask the monk for help', locationKey: 'greywood', budget: 1500 });
    expect(picked.map((e) => e.key).sort()).toEqual(['brother_hal', 'greywood']);
    expect(selectCanon(entries, { text: 'Hello Iron Hand!', locationKey: 'x', budget: 1500 }).map((e) => e.key)).toEqual(['iron_hand']);
    expect(selectCanon(entries, { text: 'nothing relevant (shall we?)', locationKey: 'x', budget: 1500 })).toEqual([]);
  });

  it('keeps the most recently updated entries when over budget', () => {
    const many: CanonEntry[] = Array.from({ length: 30 }, (_, i) => ({ kind: 'npc', key: `n${i}`, aliases: ['Hal'], facts: ['x'.repeat(280)], updatedSeq: i }));
    const picked = selectCanon(many, { text: 'Hal', locationKey: '', budget: 1500 });
    expect(picked.length).toBeLessThan(30);
    expect(picked[0]!.key).toBe('n29');
    expect(estimateTokens(JSON.stringify(picked))).toBeLessThanOrEqual(1500);
  });

  it('is derived from upsert_canon events, merging facts and skipping rewound turns', () => {
    const log = new Log();
    log.push('room_created', { name: 'T', setting: getPreset('fantasy')! });
    log.push('delta_applied', { delta: { type: 'upsert_canon', kind: 'npc', key: 'brother_hal', aliases: ['Hal'], facts: ['A monk'] } });
    log.push('delta_applied', { delta: { type: 'upsert_canon', kind: 'npc', key: 'brother_hal', aliases: ['the monk'], facts: ['A monk', 'Owed 20 gold'] } }, { turnId: 't1' });
    log.push('delta_applied', { delta: { type: 'upsert_canon', kind: 'npc', key: 'liar', aliases: [], facts: ['x'] } }, { turnId: 't2' });
    log.push('turn_voided', { turnId: 't2' });
    const canon = deriveCanon(log.events);
    expect(canon).toEqual([{ kind: 'npc', key: 'brother_hal', aliases: ['Hal', 'the monk'], facts: ['A monk', 'Owed 20 gold'], updatedSeq: 3 }]);
  });
});
