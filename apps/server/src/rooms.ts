import {
  type GameEvent,
  type RoomSettings,
  type SettingPreset,
  RoomSettingsSchema,
  SettingPresetSchema,
  defaultRoomSettings,
  normalizeInviteCode,
} from '@tavern/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { hashToken, newId, newInviteCode, newRoomId, newToken } from './auth.ts';
import type { Db } from './db/connection.ts';
import type { EventStore } from './db/eventStore.ts';
import { players, rooms } from './db/schema.ts';

export const MAX_PLAYERS = 6;

export class RoomError extends Error {
  override name = 'RoomError';
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const CreateRoomSchema = z.object({
  roomName: z.string().trim().min(1).max(60),
  hostName: z.string().trim().min(1).max(40),
  setting: SettingPresetSchema,
  mode: z.enum(['solo', 'group']),
});
export type CreateRoomInput = z.infer<typeof CreateRoomSchema>;

export const DisplayNameSchema = z.string().trim().min(1).max(40);

export interface Credentials {
  roomId: string;
  playerId: string;
  token: string;
}

export interface AuthedPlayer {
  roomId: string;
  playerId: string;
  displayName: string;
  isHost: boolean;
}

type RoomRow = typeof rooms.$inferSelect;

export class RoomService {
  private readonly db: Db;
  private readonly store: EventStore;
  /** Called after events are committed (wired to the socket broadcaster). */
  onEvents: (roomId: string, events: GameEvent[]) => void = () => {};

  constructor(db: Db, store: EventStore) {
    this.db = db;
    this.store = store;
  }

  createRoom(input: CreateRoomInput): Credentials & { hostToken: string; inviteCode: string } {
    const { roomName, hostName, setting, mode } = CreateRoomSchema.parse(input);
    const roomId = newRoomId();
    const hostToken = newToken();
    const playerId = newId();
    const token = newToken();
    const now = new Date().toISOString();
    const inviteCode = this.uniqueInviteCode();
    const events = this.db.$client.transaction(() => {
      this.db
        .insert(rooms)
        .values({
          id: roomId,
          name: roomName,
          inviteCode,
          hostTokenHash: hashToken(hostToken),
          settingsJson: JSON.stringify(defaultRoomSettings(mode)),
          createdAt: now,
        })
        .run();
      this.db
        .insert(players)
        .values({ id: playerId, roomId, displayName: hostName, tokenHash: hashToken(token), isHost: true, lastSeen: now })
        .run();
      return this.store.append(roomId, [
        { type: 'room_created', actorId: playerId, turnId: null, payload: { name: roomName, setting } },
        {
          type: 'player_joined',
          actorId: playerId,
          turnId: null,
          payload: { player: { id: playerId, displayName: hostName, isHost: true } },
        },
      ]);
    })();
    this.onEvents(roomId, events);
    return { roomId, playerId, token, hostToken, inviteCode };
  }

  joinRoom(roomId: string, displayName: string): Credentials {
    const name = DisplayNameSchema.parse(displayName);
    const room = this.requireRoom(roomId);
    if (this.settings(room).mode === 'solo') {
      throw new RoomError('This is a solo game. The host can switch it to group play to invite others.', 403);
    }
    const state = this.store.getState(roomId);
    if (state.players.filter((p) => p.active).length >= MAX_PLAYERS) {
      throw new RoomError(`This room is full (${MAX_PLAYERS} players).`, 403);
    }
    const playerId = newId();
    const token = newToken();
    const events = this.db.$client.transaction(() => {
      this.db
        .insert(players)
        .values({ id: playerId, roomId, displayName: name, tokenHash: hashToken(token), lastSeen: new Date().toISOString() })
        .run();
      return this.store.append(roomId, [
        {
          type: 'player_joined',
          actorId: playerId,
          turnId: null,
          payload: { player: { id: playerId, displayName: name, isHost: false } },
        },
      ]);
    })();
    this.onEvents(roomId, events);
    return { roomId, playerId, token };
  }

  /** Host link recovery: proves host-ness with the host token and issues a fresh player token. */
  claimHost(roomId: string, hostToken: string): Credentials {
    const room = this.requireRoom(roomId);
    if (hashToken(hostToken) !== room.hostTokenHash) throw new RoomError('That host link is not valid.', 403);
    const host = this.db
      .select()
      .from(players)
      .where(and(eq(players.roomId, roomId), eq(players.isHost, true)))
      .get();
    if (!host) throw new RoomError('Host player missing.', 500);
    const token = newToken();
    this.db.update(players).set({ tokenHash: hashToken(token) }).where(eq(players.id, host.id)).run();
    return { roomId, playerId: host.id, token };
  }

  authenticate(roomId: string, token: string): AuthedPlayer | null {
    const row = this.db
      .select()
      .from(players)
      .where(and(eq(players.tokenHash, hashToken(token)), eq(players.roomId, roomId)))
      .get();
    if (!row) return null;
    this.db.update(players).set({ lastSeen: new Date().toISOString() }).where(eq(players.id, row.id)).run();
    return { roomId, playerId: row.id, displayName: row.displayName, isHost: row.isHost };
  }

  findByInvite(code: string): RoomRow | null {
    return this.db.select().from(rooms).where(eq(rooms.inviteCode, normalizeInviteCode(code))).get() ?? null;
  }

  getRoom(roomId: string): RoomRow | null {
    return this.db.select().from(rooms).where(eq(rooms.id, roomId)).get() ?? null;
  }

  requireRoom(roomId: string): RoomRow {
    const room = this.getRoom(roomId);
    if (!room) throw new RoomError('Room not found.', 404);
    return room;
  }

  settings(room: RoomRow): RoomSettings {
    return RoomSettingsSchema.parse(JSON.parse(room.settingsJson));
  }

  /** Public summary for the join screen (no secrets, no game state). */
  summary(room: RoomRow) {
    const state = this.store.getState(room.id);
    const setting: SettingPreset | null = state.setting;
    return {
      roomId: room.id,
      name: room.name,
      mode: this.settings(room).mode,
      settingName: setting?.name ?? '',
      theme: setting?.theme ?? 'neutral',
      playerCount: state.players.filter((p) => p.active).length,
      maxPlayers: MAX_PLAYERS,
    };
  }

  private uniqueInviteCode(): string {
    for (let i = 0; i < 20; i++) {
      const code = newInviteCode();
      if (!this.findByInvite(code)) return code;
    }
    throw new RoomError('Could not allocate an invite code.', 500);
  }
}
