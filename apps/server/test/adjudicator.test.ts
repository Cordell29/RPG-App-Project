import {
  type GameState,
  CharacterCreateSchema,
  buildCharacter,
  defaultRoomSettings,
  getPreset,
  replay,
} from '@tavern/shared';
import { describe, expect, it } from 'vitest';
import { Log } from '../../../packages/shared/test/fixtures.ts';
import { Adjudicator } from '../src/gm/adjudicator.ts';

const fantasy = getPreset('fantasy')!;
const scifi = getPreset('scifi')!;

/** Deterministic stand-in for crypto.randomInt. */
function dice(...values: number[]) {
  let i = 0;
  return (min: number, max: number) => {
    const v = values[i++];
    if (v === undefined) throw new Error('ran out of scripted dice');
    if (v < min || v >= max) throw new Error(`scripted ${v} outside [${min}, ${max})`);
    return v;
  };
}

let n = 0;
const newId = () => `id${++n}`;

/** Room with Ayla (fantasy Fighter, p1) and Bram (Rogue, p2), built by the real rules. */
function table(preset = fantasy): GameState {
  const log = new Log();
  log.push('room_created', { name: 'T', setting: preset });
  log.push('player_joined', { player: { id: 'p1', displayName: 'Host', isHost: true } });
  log.push('player_joined', { player: { id: 'p2', displayName: 'Bea', isHost: false } });
  const mk = (id: string, playerId: string, roleName: string, skills: string[]) =>
    buildCharacter(
      CharacterCreateSchema.parse({
        name: id === 'c1' ? 'Ayla' : 'Bram',
        ancestry: '',
        className: roleName,
        roleName,
        statMethod: 'standard',
        stats: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
        skills,
      }),
      { id, playerId, preset, newItemId: newId },
    );
  const roles = preset === fantasy ? (['Fighter', 'Rogue'] as const) : (['Soldier', 'Scout'] as const);
  const skills = preset === fantasy ? [['athletics', 'perception'], ['stealth', 'deception', 'acrobatics', 'insight']] : [['athletics', 'perception'], ['stealth', 'survival', 'perception']];
  log.push('character_created', { character: mk('c1', 'p1', roles[0], skills[0]!) });
  log.push('character_created', { character: mk('c2', 'p2', roles[1], skills[1]!) });
  return replay(log.events);
}

function adj(state = table(), random = dice(), settings = defaultRoomSettings('group')) {
  return new Adjudicator({ state, settings, turnId: 't1', random, newId });
}

const applied = (a: Adjudicator) => a.drafts.filter((d) => d.type === 'delta_applied').map((d) => (d.type === 'delta_applied' ? d.payload.delta : null));
const rejected = (a: Adjudicator) => a.drafts.filter((d) => d.type === 'delta_rejected').map((d) => (d.type === 'delta_rejected' ? d.payload : null));
const rolls = (a: Adjudicator) => a.drafts.filter((d) => d.type === 'dice_rolled').map((d) => (d.type === 'dice_rolled' ? d.payload : null));
const char = (a: Adjudicator, id: string) => a.state.party.find((c) => c.id === id)!;

describe('Adjudicator: checks and contests (server rolls)', () => {
  it('request_check uses the skill modifier and reports success', () => {
    const a = adj(table(), dice(12));
    const out = a.handle('request_check', { characterId: 'c2', stat: 'dex', skill: 'stealth', dc: 14, reason: 'sneak past the guard' });
    expect(out.ok).toBe(true);
    // Bram: Dex 14 (+2) + proficiency 2 = +4 → 16 vs 14
    expect(rolls(a)[0]).toMatchObject({ notation: '1d20+4', total: 16, dc: 14, success: true, characterId: 'c2', stat: 'dex' });
    expect(out.result).toMatch(/Stealth.*16.*DC 14.*success/i);
    expect(a.drafts.every((d) => d.turnId === 't1')).toBe(true);
  });

  it('saving throws add proficiency only when proficient', () => {
    const a = adj(table(), dice(10, 10));
    a.handle('request_check', { characterId: 'c1', stat: 'con', save: true, dc: 15, reason: 'poison' }); // Fighter: con save prof
    a.handle('request_check', { characterId: 'c1', stat: 'wis', save: true, dc: 15, reason: 'fear' });
    expect(rolls(a).map((r) => r!.total)).toEqual([10 + 1 + 2, 10 + 1]);
  });

  it('flat checks (death saves) roll a bare d20', () => {
    const a = adj(table(), dice(9));
    a.handle('request_check', { characterId: 'c1', stat: 'con', flat: true, dc: 10, reason: 'death save' });
    expect(rolls(a)[0]).toMatchObject({ notation: '1d20', total: 9, success: false });
  });

  it('rejects checks for unknown characters and silly DCs', () => {
    const a = adj();
    expect(a.handle('request_check', { characterId: 'ghost', stat: 'dex', dc: 10 }).ok).toBe(false);
    expect(a.handle('request_check', { characterId: 'c1', stat: 'dex', dc: 99 }).ok).toBe(false);
    expect(rejected(a)).toHaveLength(2);
    expect(rolls(a)).toHaveLength(0);
  });

  it('request_contest: character vs character, higher wins; tie keeps the status quo', () => {
    const a = adj(table(), dice(10, 9, 7, 9));
    const win = a.handle('request_contest', {
      sideA: { characterId: 'c1', stat: 'str', skill: 'athletics' },
      sideB: { characterId: 'c2', stat: 'dex', skill: 'acrobatics' },
      reason: 'both grab the key',
    });
    // Ayla athletics +2+2 = 14; Bram acrobatics +2+2 = 13
    expect(win.result).toMatch(/Ayla wins/);
    const tie = a.handle('request_contest', {
      sideA: { characterId: 'c1', stat: 'str', skill: 'athletics' },
      sideB: { npcName: 'Guard', stat: 'str', modifier: 2 },
      reason: 'shove',
    });
    expect(tie.result).toMatch(/tie.*status quo/i);
    expect(rolls(a)).toHaveLength(4);
  });

  it('request_contest rejects sides that are neither or both a character and an NPC', () => {
    const a = adj();
    expect(a.handle('request_contest', { sideA: { stat: 'str' }, sideB: { characterId: 'c1', stat: 'str' } }).ok).toBe(false);
    expect(a.handle('request_contest', { sideA: { characterId: 'c1', npcName: 'X', stat: 'str' }, sideB: { characterId: 'c2', stat: 'str' } }).ok).toBe(false);
  });
});

describe('Adjudicator: combat', () => {
  it('request_attack uses the weapon, rolls damage on a hit', () => {
    const state = table();
    const sword = state.party[0]!.inventory.find((i) => i.name === 'Longsword')!;
    const a = adj(state, dice(13, 6));
    const out = a.handle('request_attack', { characterId: 'c1', weaponInstanceId: sword.instanceId, targetName: 'Bandit', targetAc: 15 });
    // Str 15 (+2) + prof 2 = +4 → 17 vs AC 15 hits; 1d8+2 → 8
    expect(rolls(a).map((r) => [r!.notation, r!.total])).toEqual([
      ['1d20+4', 17],
      ['1d8+2', 8],
    ]);
    expect(out.result).toMatch(/hits.*8 slashing/i);
  });

  it('a natural 20 crits (double dice); a natural 1 always misses', () => {
    const state = table();
    const sword = state.party[0]!.inventory.find((i) => i.name === 'Longsword')!;
    const a = adj(state, dice(20, 5, 3, 1));
    expect(a.handle('request_attack', { characterId: 'c1', weaponInstanceId: sword.instanceId, targetName: 'Ogre', targetAc: 30 }).result).toMatch(/critical/i);
    expect(rolls(a)[1]).toMatchObject({ notation: '2d8+2', total: 10 });
    expect(a.handle('request_attack', { characterId: 'c1', weaponInstanceId: sword.instanceId, targetName: 'Rat', targetAc: 5 }).result).toMatch(/miss/i);
  });

  it("rejects attacks with weapons the character doesn't carry", () => {
    const state = table();
    const theirs = state.party[1]!.inventory[0]!;
    expect(adj(state).handle('request_attack', { characterId: 'c1', weaponInstanceId: theirs.instanceId, targetName: 'X', targetAc: 10 }).ok).toBe(false);
  });

  it('npc_attack rolls against effective AC and applies the damage itself', () => {
    const a = adj(table(), dice(12, 5));
    // Ayla: chain shirt 13 + Dex 2 + shield 2 = 17. 12+5 = 17 hits.
    const out = a.handle('npc_attack', { npcName: 'Orc', attackBonus: 5, damage: '1d12+3', targetCharacterId: 'c1', reason: 'greataxe' });
    expect(out.result).toMatch(/hits Ayla for 8/);
    expect(applied(a)).toEqual([{ type: 'modify_hp', characterId: 'c1', amount: -8 }]);
    expect(char(a, 'c1').hp.current).toBe(3);
    const miss = adj(table(), dice(11));
    expect(miss.handle('npc_attack', { npcName: 'Orc', attackBonus: 5, damage: '1d12+3', targetCharacterId: 'c1' }).result).toMatch(/misses/);
    expect(applied(miss)).toEqual([]);
  });

  it('npc_attack refuses absurd damage dice', () => {
    expect(adj().handle('npc_attack', { npcName: 'God', attackBonus: 5, damage: '99d100', targetCharacterId: 'c1' }).ok).toBe(false);
  });
});

describe('Adjudicator: deltas, caps and approvals', () => {
  it('modify_hp: ±50 max, clamped by the engine', () => {
    const a = adj();
    expect(a.handle('modify_hp', { characterId: 'c1', amount: -5, reason: 'fall' }).ok).toBe(true);
    expect(a.handle('modify_hp', { characterId: 'c1', amount: -51 }).ok).toBe(false);
    expect(a.handle('modify_hp', { characterId: 'c1', amount: 0 }).ok).toBe(false);
    expect(char(a, 'c1').hp.current).toBe(6);
  });

  it('change_gold: a model proposing 10,000 gold is rejected', () => {
    const a = adj();
    const out = a.handle('change_gold', { characterId: 'c1', amount: 10000, reason: 'dragon hoard' });
    expect(out.ok).toBe(false);
    expect(out.result).toMatch(/rejected.*cap/i);
    expect(char(a, 'c1').gold).toBe(10);
    expect(rejected(a)[0]).toMatchObject({ tool: 'change_gold', input: { amount: 10000 } });
  });

  it('change_gold: gains are capped per character per turn, cumulatively; never below 0', () => {
    const a = adj();
    expect(a.handle('change_gold', { characterId: 'c1', amount: 60 }).ok).toBe(true);
    expect(a.handle('change_gold', { characterId: 'c1', amount: 50 }).ok).toBe(false);
    expect(a.handle('change_gold', { characterId: 'c2', amount: 100 }).ok).toBe(true);
    expect(a.handle('change_gold', { characterId: 'c1', amount: -500 }).ok).toBe(false);
    expect(a.handle('change_gold', { characterId: 'c1', amount: -70 }).ok).toBe(true);
    expect(char(a, 'c1').gold).toBe(0);
  });

  it('grant_xp: max 200 per character per turn; levels are computed', () => {
    const a = adj();
    expect(a.handle('grant_xp', { characterId: 'c1', amount: 150 }).ok).toBe(true);
    expect(a.handle('grant_xp', { characterId: 'c1', amount: 100 }).ok).toBe(false);
    expect(a.handle('grant_xp', { characterId: 'c1', amount: 50 }).ok).toBe(true);
    expect(char(a, 'c1')).toMatchObject({ xp: 200, level: 1 });
  });

  it('add_item: mundane and +1 items go straight in; max 3 per character per turn', () => {
    const a = adj();
    expect(a.handle('add_item', { characterId: 'c1', name: 'Torch', qty: 3 }).ok).toBe(true);
    const ring = a.handle('add_item', { characterId: 'c1', name: 'Ring of Protection', slot: 'other', effects: { acBonus: 1, saveBonus: 1 } });
    expect(ring.ok).toBe(true);
    expect(char(a, 'c1').inventory.at(-1)).toMatchObject({ name: 'Ring of Protection', rarity: 'uncommon', equipped: false });
    expect(a.handle('add_item', { characterId: 'c1', name: 'Rope' }).ok).toBe(true);
    expect(a.handle('add_item', { characterId: 'c1', name: 'Fourth thing' }).result).toMatch(/3 new items/);
  });

  it('add_item: +2/+3 items become host approval requests; above +3 is refused', () => {
    const a = adj();
    const rare = a.handle('add_item', {
      characterId: 'c1',
      name: 'Flametongue',
      slot: 'weapon',
      effects: { damage: '1d8', damageStat: 'str', damageType: 'fire', attackBonus: 2 },
      reason: 'dragon hoard',
    });
    expect(rare.ok).toBe(true);
    expect(rare.result).toMatch(/host.*approv/i);
    const req = a.drafts.find((d) => d.type === 'approval_requested');
    expect(req?.type === 'approval_requested' && req.payload.approval).toMatchObject({ kind: 'item', characterId: 'c1', requestedBy: 'gm', item: { rarity: 'rare' } });
    expect(char(a, 'c1').inventory.some((i) => i.name === 'Flametongue')).toBe(false);
    expect(a.handle('add_item', { characterId: 'c1', name: 'Belt of Giant Strength', effects: { statBonus: { str: 4 } } }).ok).toBe(false);
  });

  it('add_item rejects malformed effects', () => {
    const a = adj();
    expect(a.handle('add_item', { characterId: 'c1', name: 'Bad', slot: 'weapon', effects: { damage: 'lots' } }).ok).toBe(false);
  });

  it('remove_item and transfer_item need the item and enough of it', () => {
    const state = table();
    const kit = state.party[0]!.inventory[3]!; // rations
    const a = adj(state);
    expect(a.handle('remove_item', { characterId: 'c1', instanceId: kit.instanceId, qty: 2 }).ok).toBe(false);
    expect(a.handle('transfer_item', { fromId: 'c1', toId: 'c2', instanceId: kit.instanceId, qty: 1 }).ok).toBe(true);
    expect(a.handle('remove_item', { characterId: 'c1', instanceId: kit.instanceId }).ok).toBe(false);
    expect(char(a, 'c2').inventory.some((i) => i.name === kit.name)).toBe(true);
  });

  it('set_condition only from the fixed list', () => {
    const a = adj();
    expect(a.handle('set_condition', { characterId: 'c1', condition: 'poisoned', on: true }).ok).toBe(true);
    expect(a.handle('set_condition', { characterId: 'c1', condition: 'turned into a frog', on: true }).ok).toBe(false);
  });

  it('adjust_meter: sci-fi only, ±3 per call', () => {
    const sf = adj(table(scifi));
    expect(sf.handle('adjust_meter', { characterId: 'c1', meter: 'supply', amount: -2 }).ok).toBe(true);
    expect(sf.handle('adjust_meter', { characterId: 'c1', meter: 'spirit', amount: -4 }).ok).toBe(false);
    expect(char(sf, 'c1').meters.supply!.current).toBe(3);
    expect(adj().handle('adjust_meter', { characterId: 'c1', meter: 'spirit', amount: -1 }).ok).toBe(false);
  });

  it('use_ability and spend_spell_slot need uses and slots', () => {
    const state = table();
    const sw = state.party[0]!.abilities.find((x) => x.name === 'Second Wind')!;
    const a = adj(state);
    expect(a.handle('use_ability', { characterId: 'c1', abilityId: sw.id }).ok).toBe(true);
    expect(a.handle('use_ability', { characterId: 'c1', abilityId: sw.id }).result).toMatch(/no uses/);
    expect(a.handle('spend_spell_slot', { characterId: 'c1', level: 1 }).ok).toBe(false); // fighters have none
  });

  it('rest restores per recharge', () => {
    const state = table();
    const sw = state.party[0]!.abilities.find((x) => x.name === 'Second Wind')!;
    const a = adj(state);
    a.handle('use_ability', { characterId: 'c1', abilityId: sw.id });
    expect(a.handle('rest', { kind: 'short', characterIds: ['c1', 'c2'] }).ok).toBe(true);
    expect(char(a, 'c1').abilities.find((x) => x.id === sw.id)!.uses!.current).toBe(1);
  });

  it('set_flag, update_quest (max 10 active), change_scene, upsert_canon', () => {
    const a = adj();
    expect(a.handle('set_flag', { key: 'met_hal', value: true }).ok).toBe(true);
    expect(a.handle('set_flag', { key: 'Bad Key!', value: 1 }).ok).toBe(false);
    for (let i = 0; i < 10; i++) expect(a.handle('update_quest', { key: `q${i}`, title: `Quest ${i}` }).ok).toBe(true);
    expect(a.handle('update_quest', { key: 'q10', title: 'One too many' }).result).toMatch(/10 active/);
    expect(a.handle('update_quest', { key: 'q1', status: 'done' }).ok).toBe(true);
    expect(a.handle('update_quest', { key: 'q10', title: 'Now fits' }).ok).toBe(true);
    expect(a.handle('update_quest', { key: 'nope' }).result).toMatch(/title/);
    expect(a.handle('change_scene', { locationKey: 'crypt', title: 'Crypt', description: 'x'.repeat(601) }).ok).toBe(false);
    expect(a.handle('change_scene', { locationKey: 'crypt', title: 'Crypt', description: 'Cold.' }).ok).toBe(true);
    expect(a.handle('upsert_canon', { kind: 'npc', key: 'brother_hal', aliases: ['Hal'], facts: ['Owed 20 gold by Ayla'] }).ok).toBe(true);
    expect(a.handle('upsert_canon', { kind: 'deity', key: 'x', facts: ['y'] }).ok).toBe(false);
  });

  it('end_adjudication finishes; unknown tools are rejected', () => {
    const a = adj();
    expect(a.handle('give_everyone_a_castle', {}).ok).toBe(false);
    expect(a.done).toBe(false);
    expect(a.handle('end_adjudication', { summary: 'Done.' }).ok).toBe(true);
    expect(a.done).toBe(true);
    expect(a.summary).toBe('Done.');
  });

  it('the resolution log lists rolls, applied and rejected changes for the narrator', () => {
    const a = adj(table(), dice(15));
    a.handle('request_check', { characterId: 'c2', stat: 'dex', skill: 'stealth', dc: 10, reason: 'hide' });
    a.handle('change_gold', { characterId: 'c1', amount: 10000 });
    a.handle('change_gold', { characterId: 'c1', amount: 5, reason: 'tip' });
    const log = a.resolutionLog();
    expect(log.rolls).toHaveLength(1);
    expect(log.applied.join('\n')).toMatch(/Ayla gains 5 gold/);
    expect(log.applied.join('\n')).not.toMatch(/10000/);
    expect(log.rejected.join('\n')).toMatch(/10000/);
  });
});
