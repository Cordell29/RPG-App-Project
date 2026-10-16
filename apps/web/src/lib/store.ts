import {
  type ClientToServerEvents,
  type Command,
  type CommandResult,
  type EventOf,
  type GameEvent,
  type GameState,
  type RejoinRequestInfo,
  type RoomSettings,
  type ServerToClientEvents,
  type TurnStatus,
  ClientLog,
  initialState,
} from '@tavern/shared';
import { type Socket, io } from 'socket.io-client';
import { create } from 'zustand';
import type { Credentials } from './api.ts';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type ConnectionStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'unauthorized';

/** Distributes Omit over the Command union so each variant keeps its own fields. */
type CommandBody = Command extends infer C ? (C extends Command ? Omit<C, 'commandId'> : never) : never;

interface RoomStore {
  status: ConnectionStatus;
  creds: Credentials | null;
  state: GameState;
  events: GameEvent[];
  settings: RoomSettings | null;
  inviteCode: string;
  isHost: boolean;
  online: string[];
  /** A dice roll that arrived live (not during catch-up) and should animate. */
  liveRoll: EventOf<'dice_rolled'> | null;
  turnStatus: TurnStatus;
  /** Narration streaming in for the current turn (cleared when the narration event lands). */
  streaming: { turnId: string; text: string } | null;
  /** Seq of the latest narration that arrived live (read-aloud speaks these). */
  liveNarrationSeq: number | null;
  /** The server's public address (tunnel), if known. */
  publicUrl: string | null;
  /** Host only: returning players waiting to be let back in. */
  rejoinRequests: RejoinRequestInfo[];
  connect: (creds: Credentials) => void;
  disconnect: () => void;
  send: (cmd: CommandBody) => Promise<CommandResult>;
}

let log = new ClientLog();
let socket: ClientSocket | null = null;

const MAX_ATTEMPTS = 4;
const ACK_TIMEOUT_MS = 8000;

export const useRoom = create<RoomStore>((set, get) => {
  const publish = () => set({ state: log.state, events: [...log.events] });

  const resync = (fromSeq: number) => {
    log.beginCatchUp();
    socket?.emit('resync', { fromSeq });
  };

  return {
    status: 'idle',
    creds: null,
    state: initialState(),
    events: [],
    settings: null,
    inviteCode: '',
    isHost: false,
    online: [],
    liveRoll: null,
    turnStatus: { status: 'idle' },
    streaming: null,
    liveNarrationSeq: null,
    publicUrl: null,
    rejoinRequests: [],

    connect(creds) {
      if (socket && get().creds?.token === creds.token) return;
      get().disconnect();
      set({ creds, status: 'connecting' });
      // auth is a callback so every reconnect sends the current lastSeq.
      socket = io({
        auth: (cb) => cb({ roomId: creds.roomId, token: creds.token, lastSeq: log.lastSeq }),
        transports: ['websocket', 'polling'],
      });
      socket.on('connect', () => {
        log.beginCatchUp();
        set({ status: 'online' });
      });
      socket.on('disconnect', () => set({ status: 'reconnecting' }));
      socket.on('connect_error', (err) => {
        if (err.message === 'unauthorized') {
          set({ status: 'unauthorized' });
          socket?.disconnect();
        } else {
          set({ status: 'reconnecting' });
        }
      });
      socket.on('sync', (msg) => {
        const gap = log.applySync(msg);
        set({
          settings: msg.settings,
          inviteCode: msg.inviteCode,
          isHost: msg.you.isHost,
          online: msg.online,
          turnStatus: msg.turnStatus,
          publicUrl: msg.publicUrl ?? null,
          rejoinRequests: msg.rejoinRequests ?? [],
        });
        publish();
        if (gap !== null) resync(gap);
      });
      socket.on('events', (events) => {
        const before = log.lastSeq;
        const gap = log.receive(events);
        publish();
        const roll = [...events]
          .reverse()
          .find((e): e is EventOf<'dice_rolled'> => e.type === 'dice_rolled' && e.seq > before && e.seq <= log.lastSeq);
        if (roll) set({ liveRoll: roll });
        const narration = events.find((e) => e.type === 'narration' && e.seq > before && e.seq <= log.lastSeq);
        if (narration) set({ streaming: null, liveNarrationSeq: narration.seq });
        if (gap !== null) resync(gap);
      });
      socket.on('presence', ({ online }) => set({ online }));
      socket.on('settings', (settings) => set({ settings }));
      socket.on('turn_status', (turnStatus) => set({ turnStatus }));
      socket.on('public_url', ({ url }) => set({ publicUrl: url }));
      socket.on('rejoin_requests', (rejoinRequests) => set({ rejoinRequests }));
      // The host rebuilt state on the server: start over from seq 0.
      socket.on('reset', () => {
        log = new ClientLog();
        publish();
        resync(0);
      });
      socket.on('narration_chunk', ({ turnId, delta }) => {
        const cur = get().streaming;
        set({ streaming: { turnId, text: (cur?.turnId === turnId ? cur.text : '') + delta } });
      });
      // Test hook: lets the Playwright suite drop and restore this tab's connection.
      (window as unknown as { __tavern?: unknown }).__tavern = {
        drop: () => socket?.disconnect(),
        restore: () => socket?.connect(),
      };
    },

    disconnect() {
      socket?.removeAllListeners();
      socket?.disconnect();
      socket = null;
      log = new ClientLog();
      set({
        status: 'idle',
        creds: null,
        state: initialState(),
        events: [],
        settings: null,
        online: [],
        liveRoll: null,
        turnStatus: { status: 'idle' },
        streaming: null,
        liveNarrationSeq: null,
        publicUrl: null,
        rejoinRequests: [],
      });
    },

    /**
     * Sends a command with a stable commandId, retrying on timeout. The server stores each
     * commandId's result, so a retry after a lost ack can never apply the command twice.
     */
    async send(body) {
      const cmd = { ...body, commandId: crypto.randomUUID() } as Command;
      for (let attempt = 1; ; attempt++) {
        const s = socket;
        if (!s) return { ok: false, error: 'Not connected.' };
        try {
          return await s.timeout(ACK_TIMEOUT_MS).emitWithAck('command', cmd);
        } catch {
          if (attempt >= MAX_ATTEMPTS) return { ok: false, error: 'No answer from the server. Check your connection.' };
        }
      }
    },
  };
});

export function playerName(state: GameState, playerId: string | null | undefined): string {
  if (!playerId) return 'Game Master';
  return state.players.find((p) => p.id === playerId)?.displayName ?? 'Someone';
}
