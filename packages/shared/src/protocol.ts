import { z } from 'zod';
import { LIMITS } from './constants.ts';
import { CharacterCreateSchema } from './character.ts';
import { RECHARGES } from './constants.ts';
import { type GameEvent, HostOverrideSchema } from './events.ts';
import { AbilitySchema, ItemSchema } from './state.ts';
import { StartChoiceSchema } from './start.ts';
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
  z.object({ commandId, type: z.literal('submit_action'), text: z.string().trim().min(1).max(LIMITS.actionLength) }),
  z.object({
    commandId,
    type: z.literal('edit_action'),
    actionSeq: z.number().int().positive(),
    text: z.string().trim().min(1).max(LIMITS.actionLength),
  }),
  z.object({ commandId, type: z.literal('withdraw_action'), actionSeq: z.number().int().positive() }),
  z.object({ commandId, type: z.literal('resolve_now') }),
  z.object({ commandId, type: z.literal('retry_turn') }),
  z.object({ commandId, type: z.literal('void_last_turn') }),
  z.object({
    commandId,
    type: z.literal('set_turn_mode'),
    turnMode: z.enum(['round', 'spotlight']),
    turnWindowSeconds: z.number().int().min(0).max(600).optional(),
  }),
  z.object({ commandId, type: z.literal('start_session') }),
  z.object({ commandId, type: z.literal('end_session') }),
  z.object({ commandId, type: z.literal('write_recap') }),
  z.object({
    commandId,
    type: z.literal('request_image'),
    kind: z.enum(['scene', 'portrait']),
    characterId: z.string().min(1).max(64).optional(),
  }),
  z.object({ commandId, type: z.literal('set_ai_voice'), on: z.boolean() }),
  z.object({
    commandId,
    type: z.literal('resolve_approval'),
    approvalId: z.string().min(1).max(64),
    approved: z.boolean(),
    item: ItemSchema.optional(),
    ability: AbilitySchema.optional(),
  }),
  z.object({
    commandId,
    type: z.literal('propose_ability'),
    characterId: z.string().min(1).max(64),
    ability: z.object({
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().min(1).max(600),
      uses: z.number().int().min(1).max(20).optional(),
      recharge: z.enum(RECHARGES).default('at_will'),
    }),
    /** The 5e/Starforged feature or spell it is comparable to (shown to the host). */
    basis: z.string().trim().max(300).optional(),
  }),
  /** Host, before the first turn: re-roll, pick or write the starting location. */
  z.object({ commandId, type: z.literal('set_start'), start: StartChoiceSchema }),
  /** Host: replay every event from scratch and replace the cached snapshot (desync recovery). */
  z.object({ commandId, type: z.literal('rebuild_state') }),
  /** Host: repaint images whose files are missing (e.g. after importing without images). */
  z.object({ commandId, type: z.literal('repaint_missing') }),
  /** Host: this room's daily AI budget in US dollars (estimates; the server-wide cap still applies). */
  z.object({ commandId, type: z.literal('set_spend_cap'), usd: z.number().min(0).max(100) }),
  /** Host: let a returning player take back their seat (or turn them away). */
  z.object({ commandId, type: z.literal('resolve_rejoin'), requestId: z.string().min(1).max(64), approve: z.boolean() }),
  z.object({
    commandId,
    type: z.literal('host_override'),
    override: HostOverrideSchema,
    reason: z.string().trim().max(300).optional(),
  }),
]);
export type Command = z.infer<typeof CommandSchema>;

/** Commands only the host may send. */
export const HOST_COMMANDS: readonly CommandType[] = [
  'set_room_mode',
  'host_override',
  'resolve_now',
  'retry_turn',
  'void_last_turn',
  'set_turn_mode',
  'start_session',
  'end_session',
  'write_recap',
  'set_ai_voice',
  'resolve_approval',
  'set_start',
  'rebuild_state',
  'repaint_missing',
  'set_spend_cap',
  'resolve_rejoin',
];

/** Ephemeral GM status, broadcast to the room (not stored). */
export interface TurnStatus {
  /** 'paused': the GM is not taking turns (spend cap or turn-rate limit); `error` says why. */
  status: 'idle' | 'collecting' | 'adjudicating' | 'narrating' | 'failed' | 'paused';
  turnId?: string;
  /** Round mode: epoch ms when the window closes. */
  deadline?: number;
  error?: string;
  /** Which step failed, so Retry knows what to redo. */
  stage?: 'adjudicate' | 'narrate';
}
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
  turnStatus: TurnStatus;
  /** Public address of the server (Cloudflare tunnel / PUBLIC_URL), when known. */
  publicUrl?: string | null;
  /** Host only: returning players asking to take back their character. */
  rejoinRequests?: RejoinRequestInfo[];
  /** What this server has switched on (pictures can be off, e.g. on a free Gemini key). */
  features?: { images: boolean };
}

export interface RejoinRequestInfo {
  id: string;
  playerId: string;
  characterName: string;
  playerName: string;
  createdAt: number;
}

export interface ServerToClientEvents {
  sync: (msg: SyncMessage) => void;
  events: (events: GameEvent[]) => void;
  presence: (msg: { online: string[] }) => void;
  /** Operational settings changed (not part of the event log). */
  settings: (settings: RoomSettings) => void;
  turn_status: (status: TurnStatus) => void;
  /** Streamed narration text (delta) for the turn being narrated. */
  narration_chunk: (msg: { turnId: string; delta: string }) => void;
  /** The server's public address changed (tunnel restart). */
  public_url: (msg: { url: string | null }) => void;
  /** Host only: the current list of pending rejoin requests. */
  rejoin_requests: (list: RejoinRequestInfo[]) => void;
  /** State was rebuilt on the server: drop the local log and resync from seq 0. */
  reset: () => void;
}

export interface ClientToServerEvents {
  command: (cmd: Command, ack: (result: CommandResult) => void) => void;
  resync: (msg: { fromSeq: number }) => void;
}
