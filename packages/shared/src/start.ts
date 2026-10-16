import { z } from 'zod';
import type { RandomInt } from './dice.ts';
import type { SettingPreset, Start } from './preset.ts';
import type { Opening } from './state.ts';

/** How the host chooses where the campaign opens. Default: roll on the setting's table. */
export const StartChoiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('random') }),
  z.object({ kind: z.literal('pick'), index: z.number().int().min(0).max(29) }),
  z.object({
    kind: z.literal('custom'),
    title: z.string().trim().max(120).optional(),
    text: z.string().trim().min(1).max(600),
  }),
]);
export type StartChoice = z.infer<typeof StartChoiceSchema>;

/** Short title from the first clause of a sentence ("A dying courier stumbles in, …" → "A dying courier stumbles in"). */
export function titleFrom(text: string): string {
  const first = text.split(/[.,;:!?—]/)[0]!.trim();
  return first.length <= 60 ? first : `${first.slice(0, 57).replace(/\s+\S*$/, '')}…`;
}

/** The setting's starting table; older or custom settings without one fall back to their opening hooks. */
export function startTable(setting: SettingPreset | null): Start[] {
  if (!setting) return [];
  if (setting.starts.length) return setting.starts;
  return setting.openingHooks.map((h) => ({ title: titleFrom(h), description: h, hooks: [h] }));
}

/**
 * Turns the host's choice into the opening. Random rolls happen here with the server's
 * RandomInt; `avoid` (the current title) keeps a re-roll from landing on the same place.
 */
export function resolveStart(setting: SettingPreset | null, choice: StartChoice, randomInt: RandomInt, avoid?: string): Opening {
  if (choice.kind === 'custom') {
    return { title: choice.title || titleFrom(choice.text) || 'Custom start', description: choice.text, hooks: [], source: 'custom' };
  }
  const table = startTable(setting);
  if (!table.length) throw new Error('This setting has no starting locations; describe your own.');
  if (choice.kind === 'pick') {
    const s = table[choice.index];
    if (!s) throw new Error('That starting location does not exist.');
    return { ...s, source: 'picked' };
  }
  const pool = table.length > 1 && avoid ? table.filter((s) => s.title !== avoid) : table;
  return { ...pool[randomInt(0, pool.length)]!, source: 'random' };
}
