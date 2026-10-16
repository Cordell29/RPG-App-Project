import { z } from 'zod';
import { LIMITS } from './constants.ts';
import { CharacterCreateSchema } from './character.ts';
import { type GameEvent, HostOverrideSchema } from './events.ts';
import type { RoomSettings } from './room.ts';
import type { GameState } from './state.ts';

/** Socket.io wire protocol shared by server and web client. */

/** Above this many missing events the server sends the latest snapshot plus the tail. */
export const CATCH_UP_SNAPSHOT_THRESHOLD = 500;

export const SocketAuthSchema = z.object({
  roomId: z.string().min(1).max(64),
  token: z.string().min(16).max(128),
  lastSeq: z.number().int().min(0).default(0),
});
export type SocketAuth = z.infer<typeof SocketAuthSchema>;

const commandId = z.string().min(8).max(64);

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ commandId, type: z.literal('send_chat'), text: z.string().trim().min(1).max(LIMITS.chatLength) }),
  z.object({
    commandId,
    type: z.literal('roll_dice'),
    notation: z.string().trim().min(1).max(40),
    reason: z.string().trim().max(200).optional(),
  }),
  z.object({ commandId, type: z.literal('set_room_mode'), mode: z.enum(['solo', 'group']) }),
  z.object({ commandId, type: z.literal('roll_stats') }),
  z.object({ commandId, type: z.literal('create_character'), character: CharacterCreateSchema }),
  z.object({
    commandId,
    type: z.literal('edit_character'),
    characterId: z.string().min(1).max(64),
    // Players may only change these. strict() rejects anything else (HP, gold, …).
    patch: z
      .object({
        name: z.string().trim().min(1).max(LIMITS.name),
        notes: z.string().max(LIMITS.characterNotes),
        visualDescriptor: z.string().max(LIMITS.visualDescriptor),
      })
      .partial()
      .strict(),
  }),
  z.object({
    commandId,
    type: z.literal('equip_item'),
    characterId: z.string().min(1).max(64),
    instanceId: z.string().min(1).max(64),
    equipped: z.boolean(),
  }),
  z.object({
    commandId,
    type: z.literal('host_override'),
    override: HostOverrideSchema,
    reason: z.string().trim().max(300).optional(),
  }),
]);
export type Command = z.infer<typeof CommandSchema>;

/** Commands only the host may send. */
export const HOST_COMMANDS: readonly CommandType[] = ['set_room_mode', 'host_override'];
export type CommandType = Command['type'];

export type CommandResult = { ok: true; seqs: number[] } | { ok: false; error: string };

export interface PlayerInfo {
  playerId: string;
  isHost: boolean;
}

export interface SyncMessage {
  /** 'events': apply `events` after lastSeq. 'snapshot': reset to `snapshot`, then apply `events`. */
  mode: 'events' | 'snapshot';
  snapshot?: GameState;
  events: GameEvent[];
  settings: RoomSettings;
  inviteCode: string;
  you: PlayerInfo;
  online: string[];
}

export interface ServerToClientEvents {
  sync: (msg: SyncMessage) => void;
  events: (events: GameEvent[]) => void;
  presence: (msg: { online: string[] }) => void;
  /** Operational settings changed (not part of the event log). */
  settings: (settings: RoomSettings) => void;
}

export interface ClientToServerEvents {
  command: (cmd: Command, ack: (result: CommandResult) => void) => void;
  resync: (msg: { fromSeq: number }) => void;
}
