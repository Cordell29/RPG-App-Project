import fantasy from '../presets/fantasy.json' with { type: 'json' };
import scifi from '../presets/scifi.json' with { type: 'json' };
import { type SettingPreset, SettingPresetSchema } from './preset.ts';

/** Built-in presets. Adding a genre = adding one JSON file in packages/shared/presets and listing it here. */
export const BUILT_IN_PRESETS: readonly SettingPreset[] = [fantasy, scifi].map((p) => SettingPresetSchema.parse(p));

export function getPreset(key: string): SettingPreset | undefined {
  return BUILT_IN_PRESETS.find((p) => p.key === key);
}

export const IMAGE_PROMPT_PARTS = {
  portraitSuffix: 'Three-quarter view, waist up, single character, plain textured background.',
  sceneSuffix: 'Wide establishing shot, cinematic composition, environment in focus.',
  alwaysAppended: 'No text, no lettering, no watermark, no logos.',
} as const;
