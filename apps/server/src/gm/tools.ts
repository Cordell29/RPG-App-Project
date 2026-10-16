import { CANON_KINDS, CONDITIONS, FLAG_KEY_RE, LIMITS, METERS, QUEST_STATUSES, SKILL_KEYS, STAT_KEYS } from '@tavern/shared';
import { z } from 'zod';

/**
 * Adjudication tools offered to the GM model. These are proposals only: every call is
 * re-validated by the Adjudicator, and dice are always rolled by the server.
 */

const id = z.string().min(1).max(64);
const mode = z.enum(['normal', 'advantage', 'disadvantage']).default('normal');
const reason = z.string().max(200).default('');
const notation = z.string().regex(/^\d{1,2}d(4|6|8|10|12|20)([+-]\d{1,2})?$/, 'Use NdM+K with M in 4/6/8/10/12/20.');

const ItemEffectsInput = z
  .object({
    acBase: z.number().int(),
    dexCap: z.number().int().nullable(),
    acBonus: z.number().int(),
    damage: z.string(),
    damageStat: z.enum(['str', 'dex']),
    damageType: z.string(),
    attackBonus: z.number().int(),
    statBonus: z.record(z.string(), z.number().int()),
    saveBonus: z.number().int(),
    skillBonus: z.record(z.string(), z.number().int()),
  })
  .partial();

const contestSide = z.object({
  characterId: id.optional(),
  npcName: z.string().min(1).max(60).optional(),
  stat: z.enum(STAT_KEYS),
  skill: z.enum(SKILL_KEYS).optional(),
  /** NPC sides only: their total modifier. */
  modifier: z.number().int().min(-5).max(15).optional(),
  mode,
});

export const TOOL_INPUTS = {
  request_check: z.object({
    characterId: id,
    stat: z.enum(STAT_KEYS),
    skill: z.enum(SKILL_KEYS).optional(),
    save: z.boolean().optional(),
    /** A bare d20 with no modifier (death saves, pure luck). */
    flat: z.boolean().optional(),
    dc: z.number().int().min(5).max(30),
    mode,
    reason,
  }),
  request_contest: z.object({ sideA: contestSide, sideB: contestSide, reason }),
  request_attack: z.object({
    characterId: id,
    weaponInstanceId: id.optional(),
    targetName: z.string().min(1).max(60),
    targetAc: z.number().int().min(5).max(30),
    mode,
  }),
  npc_attack: z.object({
    npcName: z.string().min(1).max(60),
    attackBonus: z.number().int().min(-5).max(15),
    damage: notation,
    targetCharacterId: id,
    mode,
    reason,
  }),
  modify_hp: z.object({ characterId: id, amount: z.number().int(), reason }),
  add_item: z.object({
    characterId: id,
    name: z.string().trim().min(1).max(LIMITS.itemName),
    qty: z.number().int().min(1).max(10).default(1),
    tags: z.array(z.string().min(1).max(30)).max(5).default([]),
    notes: z.string().max(LIMITS.itemNotes).optional(),
    slot: z.enum(['armor', 'shield', 'weapon', 'other']).optional(),
    effects: ItemEffectsInput.optional(),
    reason,
  }),
  remove_item: z.object({ characterId: id, instanceId: id, qty: z.number().int().min(1).default(1), reason }),
  change_gold: z.object({ characterId: id, amount: z.number().int(), reason }),
  transfer_item: z.object({ fromId: id, toId: id, instanceId: id, qty: z.number().int().min(1).default(1) }),
  grant_xp: z.object({ characterId: id, amount: z.number().int().min(1), reason }),
  set_condition: z.object({ characterId: id, condition: z.enum(CONDITIONS), on: z.boolean() }),
  adjust_meter: z.object({ characterId: id, meter: z.enum(METERS), amount: z.number().int(), reason }),
  use_ability: z.object({ characterId: id, abilityId: id }),
  spend_spell_slot: z.object({ characterId: id, level: z.number().int().min(1).max(9) }),
  rest: z.object({ kind: z.enum(['short', 'long']), characterIds: z.array(id).min(1).max(6) }),
  set_flag: z.object({ key: z.string().regex(FLAG_KEY_RE), value: z.union([z.boolean(), z.number(), z.string().max(200)]) }),
  update_quest: z.object({
    key: z.string().min(1).max(60),
    title: z.string().min(1).max(120).optional(),
    status: z.enum(QUEST_STATUSES).optional(),
    note: z.string().max(500).optional(),
  }),
  change_scene: z.object({
    locationKey: z.string().min(1).max(80),
    title: z.string().max(120),
    description: z.string().max(LIMITS.sceneDescription),
  }),
  upsert_canon: z.object({
    kind: z.enum(CANON_KINDS),
    key: z.string().min(1).max(80),
    aliases: z.array(z.string().min(1).max(80)).max(10).default([]),
    facts: z.array(z.string().min(1).max(300)).max(20),
  }),
  end_adjudication: z.object({ summary: z.string().max(300) }),
} as const;

export type ToolName = keyof typeof TOOL_INPUTS;
export const TOOL_NAMES = Object.keys(TOOL_INPUTS) as ToolName[];

const DESCRIPTIONS: Record<ToolName, string> = {
  request_check:
    'Ask for an ability check or saving throw whenever the outcome is uncertain. Give the skill if one applies (its stat is used), save:true for a saving throw, or flat:true for a bare d20 (death saves: DC 10, three successes or failures). The server rolls and returns the result.',
  request_contest:
    'Resolve two opposed efforts (5e contest), e.g. two players grabbing the same object, a shove vs a brace, sneaking vs noticing. Each side is a character (characterId) or an NPC (npcName + modifier). Higher total wins; a tie keeps the status quo. Use this whenever two player actions conflict.',
  request_attack:
    "A character attacks with a weapon they carry (weaponInstanceId; omit for unarmed). Give the target's AC. The server rolls to hit and damage; NPC hit points are yours to narrate.",
  npc_attack:
    "An NPC attacks a character. Give the NPC's attack bonus and damage dice. The server rolls against the character's armour class and applies the damage itself.",
  modify_hp: 'Heal (+) or harm (−) a character outside an attack (falls, poison, healing). At most 50 per call.',
  add_item:
    "Give a character an item. Add slot and effects for gear that matters (armour acBase/dexCap, weapon damage/damageStat/damageType, magic bonuses). Bonuses of +1 are allowed; +2/+3 items go to the host for approval; higher is refused. At most 3 new items per character per turn.",
  remove_item: 'Remove items a character used up, lost or gave away (by instanceId).',
  change_gold: 'Change a character’s money. Gains are capped per turn; money never goes below zero.',
  transfer_item: 'Move items between two characters.',
  grant_xp: 'Award experience (max 200 per character per turn). Levels are computed by the engine.',
  set_condition: 'Turn a condition on or off.',
  adjust_meter: 'Sci-fi only: raise or lower Spirit (morale) or Supply (ammo, fuel, food) by up to 3. At 0 the engine applies shaken / unprepared.',
  use_ability: 'Spend one use of a limited ability the character just used.',
  spend_spell_slot: 'Spend a spell slot (or tech charge) of the given level when a character casts or deploys something that needs one.',
  rest: 'The party takes a short or long rest. Long rests restore HP, slots and uses.',
  set_flag: 'Remember a world fact as a flag (lowercase key).',
  update_quest: 'Create or update a quest; add a note to record progress, debts and promises.',
  change_scene: 'Move the party to a new location (description up to 600 characters).',
  upsert_canon: 'Record or update a lasting fact about an NPC, location, faction or lore.',
  end_adjudication: 'Finish resolving this turn. Always call this last, with a one-line summary.',
};

/** Tool definitions in the Messages API shape. Stable order keeps prompt caching effective. */
export function toolSpecs() {
  return TOOL_NAMES.map((name) => {
    const schema = z.toJSONSchema(TOOL_INPUTS[name], { io: 'input' }) as Record<string, unknown>;
    delete schema.$schema;
    return { name, description: DESCRIPTIONS[name], input_schema: schema };
  });
}
