import { z } from 'zod';

/** Operational room settings (rooms.settings_json). Not part of the event log. */
export const RoomSettingsSchema = z.object({
  mode: z.enum(['solo', 'group']).default('group'),
  turnMode: z.enum(['round', 'spotlight']).default('round'),
  /** Seconds after the first action before a round auto-resolves; 0 = off. */
  turnWindowSeconds: z.number().int().min(0).max(600).default(60),
  goldCapPerTurn: z.number().int().min(0).max(100000).default(100),
  sceneImageEveryTurns: z.number().int().min(1).default(3),
  imagesPerDay: z.number().int().min(0).default(20),
  aiVoice: z.boolean().default(false),
});
export type RoomSettings = z.infer<typeof RoomSettingsSchema>;

export function defaultRoomSettings(mode: RoomSettings['mode'] = 'group'): RoomSettings {
  return RoomSettingsSchema.parse({ mode, turnWindowSeconds: mode === 'solo' ? 0 : 60 });
}

/** Unambiguous alphabet (no 0/O, 1/I/L, U). Codes look like K7QM-P3XA. */
export const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const INVITE_CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;

/** Accepts user-typed codes: lowercase, spaces, missing dash. */
export function normalizeInviteCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}
