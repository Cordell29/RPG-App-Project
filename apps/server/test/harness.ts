import type { AddressInfo } from 'node:net';
import {
  type ClientToServerEvents,
  type Command,
  type CommandResult,
  type GameEvent,
  type ServerToClientEvents,
  type SyncMessage,
  type TurnStatus,
  ClientLog,
  getPreset,
} from '@tavern/shared';
import { type Socket, io as connect } from 'socket.io-client';
import { type TavernApp, buildApp } from '../src/app.ts';
import { devMockProvider } from '../src/llm/devMock.ts';
import type { MockLLMProvider } from '../src/llm/mock.ts';
import { testDb } from './helpers.ts';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type CommandBody = Command extends infer C ? (C extends Command ? Omit<C, 'commandId'> : never) : never;
export type Creds = { roomId: string; playerId: string; token: string; hostToken?: string; inviteCode?: string };

let n = 0;
export const cid = () => `cmd-${Date.now()}-${++n}`;

/** In-process server plus helpers for socket-level tests. */
export async function startServer(opts: { gmTimeoutMs?: number } = {}) {
  const llm: MockLLMProvider = devMockProvider();
  const t: TavernApp = await buildApp({ db: testDb(), llm, ...opts });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  const sockets: ClientSocket[] = [];

  async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await t.app.inject({ method: 'POST', url: path, payload: body as object, headers });
    return { status: res.statusCode, body: res.json() as T };
  }

  async function createRoom(mode: 'solo' | 'group' = 'group', preset = 'fantasy') {
    const res = await post<Creds>('/api/rooms', { roomName: 'Test', hostName: 'Host', setting: getPreset(preset), mode });
    return res.body;
  }

  async function join(roomId: string, displayName: string) {
    return (await post<Creds>(`/api/rooms/${roomId}/join`, { displayName })).body;
  }

  class Client {
    readonly log = new ClientLog();
    readonly socket: ClientSocket;
    readonly creds: Creds;
    syncs: SyncMessage[] = [];
    arrivals: { event: GameEvent; at: number }[] = [];
    statuses: TurnStatus[] = [];
    chunks: { turnId: string; delta: string }[] = [];

    constructor(creds: Creds) {
      this.creds = creds;
      this.socket = connect(url, {
        auth: (cb) => cb({ roomId: creds.roomId, token: creds.token, lastSeq: this.log.lastSeq }),
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      sockets.push(this.socket);
      this.socket.on('connect', () => this.log.beginCatchUp());
      this.socket.on('turn_status', (st) => this.statuses.push(st));
      this.socket.on('narration_chunk', (c) => this.chunks.push(c));
      this.socket.on('sync', (msg) => {
        this.syncs.push(msg);
        this.log.applySync(msg);
      });
      this.socket.on('events', (events) => {
        const at = performance.now();
        for (const event of events) this.arrivals.push({ event, at });
        this.log.receive(events);
      });
    }

    get state() {
      return this.log.state;
    }

    async until(pred: () => boolean, timeoutMs = 3000) {
      const start = Date.now();
      while (!pred()) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    async ready() {
      await this.until(() => this.syncs.length > 0);
      return this;
    }

    send(body: CommandBody): Promise<CommandResult> {
      return new Promise((resolve) => this.socket.emit('command', { ...body, commandId: cid() } as Command, resolve));
    }
  }

  return {
    t,
    url,
    llm,
    post,
    createRoom,
    join,
    client: (creds: Creds) => new Client(creds).ready(),
    async close() {
      for (const s of sockets) s.disconnect();
      t.io.close();
      await t.app.close();
    },
  };
}
