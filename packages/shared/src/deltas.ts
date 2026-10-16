import { z } from 'zod';
import { CANON_KINDS, FLAG_KEY_RE, LIMITS, METERS, QUEST_STATUSES } from './constants.ts';
import { ConditionSchema, FlagValueSchema, IdSchema, ItemSchema } from './state.ts';
export { StatKeySchema } from './state.ts';

/**
 * Applied deltas: the resolved, server-validated form stored in delta_applied events.
 * They differ from raw tool inputs in that server-assigned values (instance ids) are filled in.
 * Per-turn caps (gold, xp, item count) are enforced by the validator, not here; the
 * reducer only enforces invariants that must hold for any replay.
 */
export const AppliedDeltaSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('modify_hp'),
    characterId: IdSchema,
    amount: z.number().int(),
  }),
  z.object({
    type: z.literal('add_item'),
    characterId: IdSchema,
    item: ItemSchema,
  }),
  z.object({
    type: z.literal('remove_item'),
    characterId: IdSchema,
    instanceId: IdSchema,
    qty: z.number().int().min(1),
  }),
  z.object({
    type: z.literal('change_gold'),
    characterId: IdSchema,
    amount: z.number().int(),
  }),
  z.object({
    type: z.literal('transfer_item'),
    fromId: IdSchema,
    toId: IdSchema,
    instanceId: IdSchema,
    qty: z.number().int().min(1),
    /** Server-assigned id for the recipient's stack. */
    newInstanceId: IdSchema,
  }),
  z.object({
    type: z.literal('grant_xp'),
    characterId: IdSchema,
    amount: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('set_condition'),
    characterId: IdSchema,
    condition: ConditionSchema,
    on: z.boolean(),
  }),
  z.object({
    type: z.literal('set_flag'),
    key: z.string().regex(FLAG_KEY_RE),
    value: FlagValueSchema,
  }),
  z.object({
    type: z.literal('update_quest'),
    key: z.string().min(1).max(60),
    title: z.string().min(1).max(120).optional(),
    status: z.enum(QUEST_STATUSES).optional(),
    note: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal('change_scene'),
    locationKey: z.string().min(1).max(80),
    title: z.string().max(120),
    description: z.string().max(LIMITS.sceneDescription),
  }),
  z.object({
    type: z.literal('adjust_meter'),
    characterId: IdSchema,
    meter: z.enum(METERS),
    amount: z.number().int(),
  }),
  z.object({
    type: z.literal('use_ability'),
    characterId: IdSchema,
    abilityId: IdSchema,
  }),
  z.object({
    type: z.literal('spend_spell_slot'),
    characterId: IdSchema,
    level: z.number().int().min(1).max(9),
  }),
  z.object({
    type: z.literal('rest'),
    kind: z.enum(['short', 'long']),
    characterIds: z.array(IdSchema).min(1).max(6),
  }),
  z.object({
    type: z.literal('upsert_canon'),
    kind: z.enum(CANON_KINDS),
    key: z.string().min(1).max(80),
    aliases: z.array(z.string().min(1).max(80)).max(10),
    facts: z.array(z.string().min(1).max(300)).max(20),
  }),
]);
export type AppliedDelta = z.infer<typeof AppliedDeltaSchema>;
export type AppliedDeltaType = AppliedDelta['type'];

