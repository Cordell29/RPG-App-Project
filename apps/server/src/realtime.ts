import type { Server as HttpServer } from 'node:http';
import {
  type ClientToServerEvents,
  type GameEvent,
  type ServerToClientEvents,
  type SyncMessage,
  type TurnStatus,
  CATCH_UP_SNAPSHOT_THRESHOLD,
  SocketAuthSchema,
  initialState,
} from '@tavern/shared';
import { Server, type Socket } from 'socket.io';
import type { CommandBus } from './commands.ts';
import type { EventStore } from './db/eventStore.ts';
import { RateLimiter } from './limits.ts';
import type { AuthedPlayer, RoomService } from './rooms.ts';

type SocketData = { player: AuthedPlayer };
type TavernSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
export type TavernIo = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/**
 * Socket.io layer: authenticates, joins the room, sends catch-up, relays commands and
 * broadcasts committed events. Clients never change state directly.
 */
export function attachRealtime(
  httpServer: HttpServer,
  deps: {
    rooms: RoomService;
    store: EventStore;
    commands: CommandBus;
    turnStatus: (roomId: string) => TurnStatus;
    /** Extra work for every committed batch (e.g. queueing media jobs). */
    afterPublish?: (roomId: string, events: GameEvent[]) => void;
    /** Extra fields for the sync message (public link; rejoin requests for the host). */
    extraSync?: (player: AuthedPlayer) => Partial<SyncMessage>;
    /** Commands per player per minute (default 30). */
    commandsPerMinute?: number;
  },
): TavernIo {
  const { rooms, store, commands } = deps;
  const io: TavernIo = new Server(httpServer, { serveClient: false, cors: { origin: false } });
  const online = new Map<string, Map<string, number>>(); // roomId → playerId → socket count
  const commandLimit = new RateLimiter(deps.commandsPerMinute ?? 30, 60_000);

  const broadcast = (roomId: string, events: GameEvent[]) => {
    if (!events.length) return;
    io.to(roomId).emit('events', events);
    deps.afterPublish?.(roomId, events);
  };
  rooms.onEvents = broadcast;
  commands.onEvents = broadcast;
  commands.onSettings = (roomId, settings) => io.to(roomId).emit('settings', settings);
  commands.onReset = (roomId) => io.to(roomId).emit('reset');

  const onlineIds = (roomId: string) => [...(online.get(roomId)?.keys() ?? [])];

  function sendSync(socket: TavernSocket, fromSeq: number) {
    const { player } = socket.data;
    const room = rooms.requireRoom(player.roomId);
    const state = store.getState(player.roomId);
    const base = {
      settings: rooms.settings(room),
      inviteCode: room.inviteCode ?? '',
      you: { playerId: player.playerId, isHost: player.isHost },
      online: onlineIds(player.roomId),
      turnStatus: deps.turnStatus(player.roomId),
      ...deps.extraSync?.(player),
    };
    let msg: SyncMessage;
    if (fromSeq > state.seq) {
      // Client is ahead of the server (e.g. database restored): start over.
      msg = { ...base, mode: 'snapshot', snapshot: initialState(), events: store.loadEvents(player.roomId, 0) };
    } else if (state.seq - fromSeq > CATCH_UP_SNAPSHOT_THRESHOLD) {
      const snap = store.latestSnapshot(player.roomId);
      msg =
        snap && snap.seq > fromSeq
          ? { ...base, mode: 'snapshot', snapshot: snap.state, events: store.loadEvents(player.roomId, snap.seq) }
          : { ...base, mode: 'events', events: store.loadEvents(player.roomId, fromSeq) };
    } else {
      msg = { ...base, mode: 'events', events: store.loadEvents(player.roomId, fromSeq) };
    }
    socket.emit('sync', msg);
  }

  io.use((socket, next) => {
    const auth = SocketAuthSchema.safeParse(socket.handshake.auth);
    if (!auth.success) return next(new Error('unauthorized'));
    const player = rooms.authenticate(auth.data.roomId, auth.data.token);
    if (!player) return next(new Error('unauthorized'));
    socket.data.player = player;
    next();
  });

  io.on('connection', (socket: TavernSocket) => {
    const { player } = socket.data;
    const lastSeq = SocketAuthSchema.parse(socket.handshake.auth).lastSeq;

    // Join first, then catch up: anything committed in between arrives twice and the
    // client drops the duplicate, so nothing can fall through the gap.
    void socket.join(player.roomId);
    sendSync(socket, lastSeq);

    const roomOnline = online.get(player.roomId) ?? new Map<string, number>();
    online.set(player.roomId, roomOnline);
    roomOnline.set(player.playerId, (roomOnline.get(player.playerId) ?? 0) + 1);
    io.to(player.roomId).emit('presence', { online: onlineIds(player.roomId) });

    socket.on('resync', (msg) => {
      const fromSeq = Number.isInteger(msg?.fromSeq) && msg.fromSeq >= 0 ? msg.fromSeq : 0;
      sendSync(socket, fromSeq);
    });

    socket.on('command', (cmd, ack) => {
      if (typeof ack !== 'function') return;
      const wait = commandLimit.hit(player.playerId);
      if (wait) return ack({ ok: false, error: `Slow down a little: try again in ${Math.ceil(wait / 1000)} s.` });
      try {
        ack(commands.execute(player, cmd));
      } catch (err) {
        console.error('[command]', err);
        ack({ ok: false, error: 'The server could not apply that. Try again.' });
      }
    });

    socket.on('disconnect', () => {
      const count = (roomOnline.get(player.playerId) ?? 1) - 1;
      if (count <= 0) roomOnline.delete(player.playerId);
      else roomOnline.set(player.playerId, count);
      io.to(player.roomId).emit('presence', { online: onlineIds(player.roomId) });
    });
  });

  return io;
}
