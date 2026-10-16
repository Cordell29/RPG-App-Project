import { z } from 'zod';
import { CONDITIONS, LIMITS, MAX_LEVEL, QUEST_STATUSES, SCHEMA_VERSION } from './constants.ts';
import { SettingPresetSchema } from './preset.ts';

export const IdSchema = z.string().min(1).max(LIMITS.idLength);

const statScore = z.number().int().min(1).max(20);
export const StatsSchema = z.object({
  str: statScore,
  dex: statScore,
  con: statScore,
  int: statScore,
  wis: statScore,
  cha: statScore,
});
export type Stats = z.infer<typeof StatsSchema>;

export const ConditionSchema = z.enum(CONDITIONS);

export const ItemSchema = z.object({
  instanceId: IdSchema,
  name: z.string().trim().min(1).max(LIMITS.itemName),
  qty: z.number().int().min(1).max(999),
  equipped: z.boolean(),
  tags: z.array(z.string().trim().min(1).max(30)).max(LIMITS.maxTags),
  notes: z.string().max(LIMITS.itemNotes).optional(),
});
export type Item = z.infer<typeof ItemSchema>;

export const CharacterSchema = z.object({
  id: IdSchema,
  playerId: IdSchema,
  name: z.string().trim().min(1).max(LIMITS.name),
  ancestry: z.string().max(LIMITS.name),
  class: z.string().max(LIMITS.name),
  level: z.number().int().min(1).max(MAX_LEVEL),
  xp: z.number().int().min(0),
  hp: z.object({ current: z.number().int().min(0), max: z.number().int().min(1) }),
  ac: z.number().int().min(1).max(40),
  stats: StatsSchema,
  gold: z.number().int().min(0),
  inventory: z.array(ItemSchema),
  conditions: z.array(ConditionSchema),
  visualDescriptor: z.string().max(LIMITS.visualDescriptor),
  notes: z.string().max(LIMITS.characterNotes),
  portraitAssetId: IdSchema.optional(),
});
export type Character = z.infer<typeof CharacterSchema>;

export const SceneSchema = z.object({
  locationKey: z.string().min(1).max(80),
  title: z.string().max(120),
  description: z.string().max(LIMITS.sceneDescription),
  imageAssetId: IdSchema.optional(),
});
export type Scene = z.infer<typeof SceneSchema>;

export const QuestSchema = z.object({
  key: z.string().min(1).max(60),
  title: z.string().min(1).max(120),
  status: z.enum(QUEST_STATUSES),
  notes: z.array(z.string().max(500)),
});
export type Quest = z.infer<typeof QuestSchema>;

export const FlagValueSchema = z.union([z.boolean(), z.number(), z.string().max(200)]);

export const PlayerSchema = z.object({
  id: IdSchema,
  displayName: z.string().trim().min(1).max(40),
  isHost: z.boolean(),
  characterId: IdSchema.nullable(),
  active: z.boolean(),
});
export type Player = z.infer<typeof PlayerSchema>;

export const PendingActionSchema = z.object({
  seq: z.number().int().positive(),
  playerId: IdSchema,
  characterId: IdSchema.nullable(),
  text: z.string().max(LIMITS.actionLength),
});
export type PendingAction = z.infer<typeof PendingActionSchema>;

export const TurnStateSchema = z.object({
  number: z.number().int().min(0),
  phase: z.enum(['collecting', 'resolving', 'idle']),
  /** Turn currently being resolved, if any. */
  turnId: IdSchema.nullable(),
  /** Actions consumed by the turn being resolved. */
  resolving: z.array(PendingActionSchema),
  /** Actions waiting for the next turn (queued while one resolves). */
  pending: z.array(PendingActionSchema),
});

/**
 * The projection of a room's events. Spec fields plus a few the reducer needs
 * to stay a pure fold: roomName/setting (from room_created), players and voidedTurnIds.
 */
export const GameStateSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  seq: z.number().int().min(0),
  roomName: z.string(),
  setting: SettingPresetSchema.nullable(),
  scene: SceneSchema,
  party: z.array(CharacterSchema),
  players: z.array(PlayerSchema),
  quests: z.array(QuestSchema),
  flags: z.record(z.string(), FlagValueSchema),
  turn: TurnStateSchema,
  voidedTurnIds: z.array(IdSchema),
});
export type GameState = z.infer<typeof GameStateSchema>;

export function initialState(): GameState {
  return {
    schemaVersion: SCHEMA_VERSION,
    seq: 0,
    roomName: '',
    setting: null,
    scene: { locationKey: 'start', title: '', description: '' },
    party: [],
    players: [],
    quests: [],
    flags: {},
    turn: { number: 0, phase: 'idle', turnId: null, resolving: [], pending: [] },
    voidedTurnIds: [],
  };
}
