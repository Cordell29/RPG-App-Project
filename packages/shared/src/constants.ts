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
  'shaken',
  'stunned',
  'unconscious',
  'unprepared',
] as const;
export type Condition = (typeof CONDITIONS)[number];

/** The 18 5e skills and their governing stat. Presets rename them; keys never change. */
export const SKILLS = {
  acrobatics: 'dex',
  animal_handling: 'wis',
  arcana: 'int',
  athletics: 'str',
  deception: 'cha',
  history: 'int',
  insight: 'wis',
  intimidation: 'cha',
  investigation: 'int',
  medicine: 'wis',
  nature: 'int',
  perception: 'wis',
  performance: 'cha',
  persuasion: 'cha',
  religion: 'int',
  sleight_of_hand: 'dex',
  stealth: 'dex',
  survival: 'wis',
} as const satisfies Record<string, StatKey>;
export type SkillKey = keyof typeof SKILLS;
export const SKILL_KEYS = Object.keys(SKILLS) as [SkillKey, ...SkillKey[]];

export const DEFAULT_SKILL_LABELS: Record<SkillKey, string> = {
  acrobatics: 'Acrobatics',
  animal_handling: 'Animal Handling',
  arcana: 'Arcana',
  athletics: 'Athletics',
  deception: 'Deception',
  history: 'History',
  insight: 'Insight',
  intimidation: 'Intimidation',
  investigation: 'Investigation',
  medicine: 'Medicine',
  nature: 'Nature',
  perception: 'Perception',
  performance: 'Performance',
  persuasion: 'Persuasion',
  religion: 'Religion',
  sleight_of_hand: 'Sleight of Hand',
  stealth: 'Stealth',
  survival: 'Survival',
};

/** Starforged-style meters (sci-fi). 0–5; at 0 the paired condition applies. */
export const METERS = ['spirit', 'supply'] as const;
export type MeterKey = (typeof METERS)[number];
export const METER_MAX = 5;
export const METER_ZERO_CONDITION: Record<MeterKey, 'shaken' | 'unprepared'> = { spirit: 'shaken', supply: 'unprepared' };

export const ITEM_SLOTS = ['armor', 'shield', 'weapon', 'other'] as const;
export const RARITIES = ['mundane', 'uncommon', 'rare', 'very_rare'] as const;
export type Rarity = (typeof RARITIES)[number];
/** Highest bonus the GM may grant without host approval (uncommon). */
export const GM_MAX_ITEM_POWER = 1;
export const RECHARGES = ['at_will', 'short_rest', 'long_rest'] as const;
export const MAX_SPELL_LEVEL = 9;

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
