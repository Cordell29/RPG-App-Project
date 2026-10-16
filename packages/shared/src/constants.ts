export const SCHEMA_VERSION = 1 as const;

export const STAT_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type StatKey = (typeof STAT_KEYS)[number];

/** Fixed condition list. The GM may only toggle these. */
export const CONDITIONS = [
  'blinded',
  'charmed',
  'deafened',
  'exhausted',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
] as const;
export type Condition = (typeof CONDITIONS)[number];

export const CANON_KINDS = ['npc', 'location', 'faction', 'lore'] as const;
export type CanonKind = (typeof CANON_KINDS)[number];

export const QUEST_STATUSES = ['active', 'done', 'failed'] as const;
export type QuestStatus = (typeof QUEST_STATUSES)[number];

export const FLAG_KEY_RE = /^[a-z0-9_]{1,40}$/;

/** Cumulative XP needed to reach level index+1. Engine-computed; the GM never sets level. */
export const XP_THRESHOLDS = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000,
  165000, 195000, 225000, 265000, 305000, 355000,
] as const;
export const MAX_LEVEL = XP_THRESHOLDS.length;

export const LIMITS = {
  actionLength: 500,
  chatLength: 1000,
  sceneDescription: 600,
  name: 60,
  itemName: 80,
  visualDescriptor: 500,
  characterNotes: 2000,
  itemNotes: 500,
  maxTags: 10,
  idLength: 64,
  customSettingDescription: 2000,
} as const;
