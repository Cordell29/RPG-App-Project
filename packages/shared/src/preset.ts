import { z } from 'zod';

const label = z.string().trim().min(1).max(30);

export const StatLabelsSchema = z.object({
  str: label,
  dex: label,
  con: label,
  int: label,
  wis: label,
  cha: label,
});

export const RoleSchema = z.object({
  name: z.string().trim().min(1).max(40),
  summary: z.string().trim().min(1).max(300),
  startingKit: z.array(z.string().trim().min(1).max(80)).max(12),
});

/** Display-only flavour for a campaign. Internal field names (gold, str, …) never change. */
export const SettingPresetSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  name: z.string().trim().min(1).max(60),
  tone: z.string().trim().min(1).max(300),
  currencyName: z.string().trim().min(1).max(20),
  statLabels: StatLabelsSchema,
  roles: z.array(RoleSchema).min(4).max(8),
  openingHooks: z.array(z.string().trim().min(1).max(500)).length(3),
  artStyle: z.string().trim().min(1).max(1000),
  contentNotes: z.string().max(1000).optional(),
});

export type SettingPreset = z.infer<typeof SettingPresetSchema>;
