import { z } from 'zod';
import { ITEM_SLOTS, METERS, RARITIES, RECHARGES, SKILL_KEYS, STAT_KEYS } from './constants.ts';
import { ItemEffectsSchema } from './schemaBits.ts';

const label = z.string().trim().min(1).max(30);

export const StatLabelsSchema = z.object({
  str: label,
  dex: label,
  con: label,
  int: label,
  wis: label,
  cha: label,
});

export const AbilityTemplateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(600),
  uses: z.number().int().min(1).max(99).optional(),
  recharge: z.enum(RECHARGES).default('at_will'),
});

export const RoleSchema = z.object({
  name: z.string().trim().min(1).max(40),
  summary: z.string().trim().min(1).max(300),
  startingKit: z.array(z.string().trim().min(1).max(80)).max(12),
  /** Skills the player picks from; empty = any skill. */
  skillChoices: z.array(z.enum(SKILL_KEYS)).default([]),
  skillCount: z.number().int().min(0).max(4).default(2),
  /** Two saving-throw proficiencies; empty = the player picks two. */
  saves: z.array(z.enum(STAT_KEYS)).max(2).default([]),
  abilities: z.array(AbilityTemplateSchema).max(8).default([]),
  /** Max slots per spell level at level 1, e.g. [2]. */
  spellSlots: z.array(z.number().int().min(0).max(9)).max(9).default([]),
});
export type Role = z.infer<typeof RoleSchema>;

/** Catalogue entry: resolves starting-kit names to real gear. */
export const ItemTemplateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slot: z.enum(ITEM_SLOTS).optional(),
  rarity: z.enum(RARITIES).optional(),
  effects: ItemEffectsSchema.optional(),
  notes: z.string().max(500).optional(),
});
export type ItemTemplate = z.infer<typeof ItemTemplateSchema>;

export const THEMES = ['parchment', 'neon', 'neutral'] as const;
export const ThemeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof ThemeSchema>;

/** A place the campaign can open in. Presets carry a table of these; one is rolled per campaign. */
export const StartSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(600),
  /** Up to three ways in, shown as quick options before the first turn. */
  hooks: z.array(z.string().trim().min(1).max(300)).max(3).default([]),
});
export type Start = z.infer<typeof StartSchema>;

/** Display-only flavour for a campaign. Internal field names (gold, str, …) never change. */
export const SettingPresetSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  name: z.string().trim().min(1).max(60),
  tone: z.string().trim().min(1).max(300),
  currencyName: z.string().trim().min(1).max(20),
  statLabels: StatLabelsSchema,
  roles: z.array(RoleSchema).min(4).max(8),
  openingHooks: z.array(z.string().trim().min(1).max(500)).length(3),
  /** Starting-location table; room creation rolls on it (or the host picks or writes one). */
  starts: z.array(StartSchema).max(30).default([]),
  artStyle: z.string().trim().min(1).max(1000),
  contentNotes: z.string().max(1000).optional(),
  /** Visual theme for the web app. CSS only; no effect on rules. */
  theme: ThemeSchema.default('neutral'),
  /** Display names for skills that differ from the 5e defaults. */
  skillLabels: z.partialRecord(z.enum(SKILL_KEYS), z.string().trim().min(1).max(30)).default({}),
  items: z.array(ItemTemplateSchema).max(60).default([]),
  meters: z.array(z.enum(METERS)).default([]),
  /** What spell slots are called in this setting ("Spell slots", "Tech charges"). */
  slotsLabel: z.string().trim().min(1).max(30).default('Spell slots'),
});

export type SettingPreset = z.infer<typeof SettingPresetSchema>;
