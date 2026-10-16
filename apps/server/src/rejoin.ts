import { randomBytes } from 'node:crypto';
import type { RejoinRequestInfo } from '@tavern/shared';
import { hashToken, newId } from './auth.ts';
import type { EventStore } from './db/eventStore.ts';
import { type Credentials, RoomError, type RoomService } from './rooms.ts';

const TTL_MS = 30 * 60 * 1000;
const MAX_PER_ROOM = 10;

interface Request extends RejoinRequestInfo {
  roomId: string;
  secretHash: string;
  status: 'pending' | 'approved' | 'denied';
  creds?: Credentials;
}

/**
 * Returning players after a link change (tunnel restart, new phone): they open the new link,
 * pick their character, and the host approves with one click; the server then issues a fresh
 * seat token, which the waiting browser collects once. Requests live in memory for 30 minutes.
 */
export class RejoinService {
  private readonly requests = new Map<string, Request>();
  private readonly rooms: RoomService;
  private readonly store: EventStore;
  /** Tell the room's host the list changed. */
  onChange: (roomId: string) => void = () => {};

  constructor(rooms: RoomService, store: EventStore) {
    this.rooms = rooms;
    this.store = store;
  }

  /** Characters a returning player can claim (names only, no secrets). */
  seats(roomId: string) {
    this.rooms.requireRoom(roomId);
    const state = this.store.getState(roomId);
    return state.party
      .map((c) => ({ characterId: c.id, characterName: c.name, playerName: state.players.find((p) => p.id === c.playerId)?.displayName ?? '' }))
      .filter((s) => s.playerName);
  }

  request(roomId: string, characterId: string): { requestId: string; secret: string } {
    this.prune();
    this.rooms.requireRoom(roomId);
    const state = this.store.getState(roomId);
    const c = state.party.find((x) => x.id === characterId) ?? fail('That character is not in this room.');
    const p = state.players.find((x) => x.id === c.playerId) ?? fail('That character has no seat.');
    if (p.isHost) fail('The host gets back in with the host link.');
    const mine = [...this.requests.values()].filter((r) => r.roomId === roomId && r.status === 'pending');
    if (mine.length >= MAX_PER_ROOM) fail('Too many people are waiting to rejoin. Ask the host.', 429);
    // One pending request per seat: a newer one replaces the older.
    for (const r of mine) if (r.playerId === p.id) this.requests.delete(r.id);
    const secret = randomBytes(24).toString('base64url');
    const id = newId();
    this.requests.set(id, { id, roomId, playerId: p.id, characterName: c.name, playerName: p.displayName, createdAt: Date.now(), secretHash: hashToken(secret), status: 'pending' });
    this.onChange(roomId);
    return { requestId: id, secret };
  }

  pending(roomId: string): RejoinRequestInfo[] {
    this.prune();
    return [...this.requests.values()]
      .filter((r) => r.roomId === roomId && r.status === 'pending')
      .map(({ id, playerId, characterName, playerName, createdAt }) => ({ id, playerId, characterName, playerName, createdAt }));
  }

  /** Host decision. Approving rotates the seat's token (old devices are signed out). */
  resolve(roomId: string, requestId: string, approve: boolean) {
    const r = this.requests.get(requestId);
    if (!r || r.roomId !== roomId || r.status !== 'pending') fail('That request has expired or was already handled.');
    r!.status = approve ? 'approved' : 'denied';
    if (approve) r!.creds = { roomId, playerId: r!.playerId, token: this.rooms.issueSeatToken(roomId, r!.playerId) };
    this.onChange(roomId);
  }

  /** The waiting browser polls this; credentials are handed out exactly once. */
  status(roomId: string, requestId: string, secret: string): { status: 'pending' | 'approved' | 'denied'; creds?: Credentials } {
    const r = this.requests.get(requestId);
    if (!r || r.roomId !== roomId || r.secretHash !== hashToken(secret)) fail('That request has expired. Ask to rejoin again.', 404);
    if (r!.status === 'approved') {
      this.requests.delete(requestId);
      return { status: 'approved', creds: r!.creds! };
    }
    return { status: r!.status };
  }

  private prune() {
    const now = Date.now();
    for (const [id, r] of this.requests) if (now - r.createdAt > TTL_MS) this.requests.delete(id);
  }
}

function fail(msg: string, status = 400): never {
  throw new RoomError(msg, status);
}
