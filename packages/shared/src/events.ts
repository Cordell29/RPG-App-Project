import { z } from 'zod';
import { CANON_KINDS, FLAG_KEY_RE, LIMITS, METER_MAX, METERS, RECHARGES } from './constants.ts';
import { AppliedDeltaSchema, StatKeySchema } from './deltas.ts';
import { SettingPresetSchema } from './preset.ts';
import {
  AbilitySchema,
  ApprovalSchema,
  CharacterSchema,
  ConditionSchema,
  FlagValueSchema,
  IdSchema,
  ItemSchema,
  PlayerSchema,
  OpeningSchema,
  SceneSchema,
  SkillKeySchema,
  StatKeySchema as StatKey,
  StatsSchema,
  UsesSchema,
} from './state.ts';

export const EVENT_TYPES = [
  'room_created',
  'player_joined',
  'player_left',
  'character_created',
  'character_edited',
  'item_equipped',
  'chat_message',
  'action_submitted',
  'action_edited',
  'action_withdrawn',
  'turn_started',
  'dice_rolled',
  'delta_applied',
  'delta_rejected',
  'narration',
  'scene_changed',
  'image_requested',
  'image_ready',
  'chapter_closed',
  'host_override',
  'turn_voided',
  'campaign_imported',
  'spotlight_set',
  'session_started',
  'session_ended',
  'approval_requested',
  'approval_resolved',
  'session_recap',
  'image_failed',
  'audio_ready',
  'start_set',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const RollModeSchema = z.enum(['normal', 'advantage', 'disadvantage']);

export const DieResultSchema = z.object({
  sides: z.number().int().min(2).max(1000),
  value: z.number().int().min(1),
  /** True for the lower/higher d20 discarded by advantage/disadvantage. */
  dropped: z.boolean(),
});

const CharacterPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(LIMITS.name),
    ancestry: z.string().max(LIMITS.name),
    class: z.string().max(LIMITS.name),
    hp: z
      .object({ current: z.number().int().min(0), max: z.number().int().min(1) })
      .partial(),
    ac: z.number().int().min(1).max(40),
    stats: StatsSchema.partial(),
    level: z.number().int().min(1).max(20),
    xp: z.number().int().min(0),
    gold: z.number().int().min(0),
    conditions: z.array(ConditionSchema),
  })
  .partial();

export const HostOverrideSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('character'), characterId: IdSchema, patch: CharacterPatchSchema }),
  z.object({ kind: z.literal('add_item'), characterId: IdSchema, item: ItemSchema }),
  z.object({
    kind: z.literal('remove_item'),
    characterId: IdSchema,
    instanceId: IdSchema,
    qty: z.number().int().min(1),
  }),
  z.object({
    kind: z.literal('update_item'),
    characterId: IdSchema,
    instanceId: IdSchema,
    patch: ItemSchema.omit({ instanceId: true }).partial(),
  }),
  z.object({ kind: z.literal('add_ability'), characterId: IdSchema, ability: AbilitySchema }),
  z.object({
    kind: z.literal('update_ability'),
    characterId: IdSchema,
    abilityId: IdSchema,
    // Explicit (not AbilitySchema.partial()) so recharge's default doesn't overwrite it.
    patch: z
      .object({
        name: AbilitySchema.shape.name,
        description: AbilitySchema.shape.description,
        uses: UsesSchema,
        recharge: z.enum(RECHARGES),
      })
      .partial(),
  }),
  z.object({ kind: z.literal('remove_ability'), characterId: IdSchema, abilityId: IdSchema }),
  z.object({
    kind: z.literal('spell_slots'),
    characterId: IdSchema,
    slots: z.array(UsesSchema.extend({ max: z.number().int().min(0).max(9) })).max(9),
  }),
  z.object({
    kind: z.literal('meter'),
    characterId: IdSchema,
    meter: z.enum(METERS),
    current: z.number().int().min(0).max(METER_MAX),
  }),
  z.object({
    kind: z.literal('proficiencies'),
    characterId: IdSchema,
    skills: z.array(SkillKeySchema).max(18),
    saves: z.array(StatKey).max(6),
  }),
  z.object({ kind: z.literal('setting'), setting: SettingPresetSchema }),
  z.object({ kind: z.literal('scene'), scene: SceneSchema }),
  z.object({
    kind: z.literal('flag'),
    key: z.string().regex(FLAG_KEY_RE),
    /** null deletes the flag. */
    value: FlagValueSchema.nullable(),
  }),
]);
export type HostOverride = z.infer<typeof HostOverrideSchema>;

export const PAYLOAD_SCHEMAS = {
  room_created: z.object({ name: z.string().trim().min(1).max(60), setting: SettingPresetSchema }),
  player_joined: z.object({ player: PlayerSchema.omit({ characterId: true, active: true }) }),
  player_left: z.object({ playerId: IdSchema }),
  character_created: z.object({ character: CharacterSchema }),
  character_edited: z.object({
    characterId: IdSchema,
    patch: z
      .object({
        name: z.string().trim().min(1).max(LIMITS.name),
        notes: z.string().max(LIMITS.characterNotes),
        visualDescriptor: z.string().max(LIMITS.visualDescriptor),
      })
      .partial(),
  }),
  item_equipped: z.object({ characterId: IdSchema, instanceId: IdSchema, equipped: z.boolean() }),
  chat_message: z.object({ playerId: IdSchema, text: z.string().min(1).max(LIMITS.chatLength) }),
  action_submitted: z.object({
    playerId: IdSchema,
    characterId: IdSchema.nullable(),
    text: z.string().min(1).max(LIMITS.actionLength),
  }),
  action_edited: z.object({ actionSeq: z.number().int().positive(), text: z.string().min(1).max(LIMITS.actionLength) }),
  action_withdrawn: z.object({ actionSeq: z.number().int().positive() }),
  turn_started: z.object({
    turnId: IdSchema,
    /** Seqs of the pending actions this turn consumes; later actions stay queued. */
    actionSeqs: z.array(z.number().int().positive()),
  }),
  dice_rolled: z.object({
    notation: z.string().min(1).max(40),
    mode: RollModeSchema,
    dice: z.array(DieResultSchema).min(1).max(100),
    modifier: z.number().int(),
    total: z.number().int(),
    dc: z.number().int().optional(),
    success: z.boolean().optional(),
    reason: z.string().max(200).optional(),
    characterId: IdSchema.optional(),
    stat: StatKeySchema.optional(),
  }),
  delta_applied: z.object({ delta: AppliedDeltaSchema, reason: z.string().max(300).optional() }),
  delta_rejected: z.object({
    tool: z.string().max(40),
    input: z.unknown(),
    reason: z.string().max(500),
  }),
  narration: z.object({
    turnId: IdSchema,
    text: z.string().max(20000),
    gist: z.string().max(400).optional(),
    suggestions: z.array(z.string().min(1).max(160)).max(3).optional(),
  }),
  scene_changed: z.object({ scene: SceneSchema }),
  image_requested: z.object({
    assetId: IdSchema,
    kind: z.enum(['portrait', 'scene', 'npc']),
    subject: z.string().max(600),
    characterId: IdSchema.optional(),
  }),
  image_ready: z.object({
    assetId: IdSchema,
    kind: z.enum(['portrait', 'scene', 'npc']),
    characterId: IdSchema.optional(),
    /** A missing file was repainted: clients reload the picture; state does not change. */
    repaint: z.boolean().optional(),
  }),
  chapter_closed: z.object({
    chapterNo: z.number().int().min(1),
    level: z.union([z.literal(0), z.literal(1)]),
    fromSeq: z.number().int().min(1),
    toSeq: z.number().int().min(1),
    summary: z.string().max(4000).optional(),
  }),
  host_override: z.object({ override: HostOverrideSchema, reason: z.string().max(300).optional() }),
  turn_voided: z.object({ turnId: IdSchema }),
  campaign_imported: z.object({
    sourceRoomName: z.string().max(60),
    sourceExportedAt: z.string(),
    importedEventCount: z.number().int().min(0),
  }),
  spotlight_set: z.object({ playerId: IdSchema.nullable() }),
  session_started: z.object({ number: z.number().int().min(1) }),
  session_ended: z.object({ number: z.number().int().min(1) }),
  image_failed: z.object({ assetId: IdSchema, reason: z.string().max(300) }),
  audio_ready: z.object({ assetId: IdSchema, narrationSeq: z.number().int().positive() }),
  start_set: z.object({ start: OpeningSchema }),
  session_recap: z.object({ number: z.number().int().min(1), text: z.string().min(1).max(4000) }),
  approval_requested: z.object({ approval: ApprovalSchema }),
  approval_resolved: z.object({
    approvalId: IdSchema,
    approved: z.boolean(),
    /** The host may tweak the item or ability before approving. */
    item: ApprovalSchema.shape.item,
    ability: ApprovalSchema.shape.ability,
  }),
} as const satisfies Record<EventType, z.ZodType>;

export const CanonKindSchema = z.enum(CANON_KINDS);

const envelope = {
  seq: z.number().int().positive(),
  /** Player id that caused the event; null for server/GM. */
  actorId: IdSchema.nullable(),
  /** GM turn this event belongs to; voiding the turn skips these events on replay. */
  turnId: IdSchema.nullable(),
  /** Informational only. The reducer never reads it. */
  createdAt: z.string(),
};

function eventSchema<T extends EventType>(type: T) {
  return z.object({ ...envelope, type: z.literal(type), payload: PAYLOAD_SCHEMAS[type] });
}

export const GameEventSchema = z.discriminatedUnion('type', [
  eventSchema('room_created'),
  eventSchema('player_joined'),
  eventSchema('player_left'),
  eventSchema('character_created'),
  eventSchema('character_edited'),
  eventSchema('item_equipped'),
  eventSchema('chat_message'),
  eventSchema('action_submitted'),
  eventSchema('action_edited'),
  eventSchema('action_withdrawn'),
  eventSchema('turn_started'),
  eventSchema('dice_rolled'),
  eventSchema('delta_applied'),
  eventSchema('delta_rejected'),
  eventSchema('narration'),
  eventSchema('scene_changed'),
  eventSchema('image_requested'),
  eventSchema('image_ready'),
  eventSchema('chapter_closed'),
  eventSchema('host_override'),
  eventSchema('turn_voided'),
  eventSchema('campaign_imported'),
  eventSchema('spotlight_set'),
  eventSchema('session_started'),
  eventSchema('session_ended'),
  eventSchema('approval_requested'),
  eventSchema('approval_resolved'),
  eventSchema('session_recap'),
  eventSchema('image_failed'),
  eventSchema('audio_ready'),
  eventSchema('start_set'),
]);
export type GameEvent = z.infer<typeof GameEventSchema>;
export type EventOf<T extends EventType> = Extract<GameEvent, { type: T }>;
export type PayloadOf<T extends EventType> = z.infer<(typeof PAYLOAD_SCHEMAS)[T]>;

/** An event before the store assigns seq and createdAt. */
export type EventDraft = {
  [T in EventType]: { type: T; actorId: string | null; turnId: string | null; payload: PayloadOf<T> };
}[EventType];
