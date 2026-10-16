import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import { BUILT_IN_PRESETS } from '@tavern/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import { CommandBus } from './commands.ts';
import type { Db } from './db/connection.ts';
import { EventStore } from './db/eventStore.ts';
import { LLMError, type LLMProvider } from './llm/provider.ts';
import { draftCharacter } from './llm/characterDraft.ts';
import { draftSetting } from './llm/settingDraft.ts';
import { TurnRunner } from './gm/turns.ts';
import { draftAbility } from './llm/abilityDraft.ts';
import { type TavernIo, attachRealtime } from './realtime.ts';
import { CreateRoomSchema, RoomError, RoomService } from './rooms.ts';

export interface AppDeps {
  db: Db;
  llm: LLMProvider;
  /** Dice source for GM rolls (tests pass a scripted one). */
  random?: (min: number, max: number) => number;
  gmTimeoutMs?: number;
  webDist?: string | null;
  logger?: boolean;
}

export interface TavernApp {
  app: FastifyInstance;
  io: TavernIo;
  store: EventStore;
  rooms: RoomService;
  commands: CommandBus;
  turns: TurnRunner;
}

export async function buildApp(deps: AppDeps): Promise<TavernApp> {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true, bodyLimit: 64 * 1024 });
  const store = new EventStore(deps.db, { reducer: { unknown: 'skip', onUnknown: (e) => app.log.error(e, 'unknown event') } });
  const rooms = new RoomService(deps.db, store);
  const commands = new CommandBus(deps.db, store);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RoomError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: err.issues[0]?.message ?? 'Invalid input.' });
    if (err instanceof LLMError) return reply.status(502).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.status(500).send({ error: 'Something went wrong on the server.' });
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/api/presets', async () => BUILT_IN_PRESETS);

  app.post('/api/setting-draft', async (req) => {
    const { description } = z.object({ description: z.string() }).parse(req.body);
    return draftSetting(deps.llm, description);
  });

  app.post('/api/rooms', async (req) => rooms.createRoom(CreateRoomSchema.parse(req.body)));

  app.get('/api/invite/:code', async (req) => {
    const room = rooms.findByInvite((req.params as { code: string }).code);
    if (!room) throw new RoomError('No room has that invite code.', 404);
    return rooms.summary(room);
  });

  app.get('/api/rooms/:roomId', async (req) => rooms.summary(rooms.requireRoom((req.params as { roomId: string }).roomId)));

  app.post('/api/rooms/:roomId/join', async (req) => {
    const { displayName } = z.object({ displayName: z.string() }).parse(req.body);
    return rooms.joinRoom((req.params as { roomId: string }).roomId, displayName);
  });

  /** Describe-your-own character draft. Requires the player's seat token (Authorization: Bearer). */
  app.post('/api/rooms/:roomId/character-draft', async (req) => {
    const roomId = (req.params as { roomId: string }).roomId;
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token || !rooms.authenticate(roomId, token)) throw new RoomError('Sign in to this room first.', 401);
    const { description } = z.object({ description: z.string() }).parse(req.body);
    return draftCharacter(deps.llm, store.getState(roomId).setting, description);
  });

  /** Workshop an ability with the AI: returns a draft the player edits, then proposes. */
  app.post('/api/rooms/:roomId/ability-draft', async (req) => {
    const roomId = (req.params as { roomId: string }).roomId;
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token || !rooms.authenticate(roomId, token)) throw new RoomError('Sign in to this room first.', 401);
    const { description, characterId } = z.object({ description: z.string(), characterId: z.string() }).parse(req.body);
    const state = store.getState(roomId);
    return draftAbility(deps.llm, state.setting, state.party.find((c) => c.id === characterId) ?? null, description);
  });

  app.post('/api/rooms/:roomId/claim-host', async (req) => {
    const { hostToken } = z.object({ hostToken: z.string().min(16).max(128) }).parse(req.body);
    return rooms.claimHost((req.params as { roomId: string }).roomId, hostToken);
  });

  if (deps.webDist && existsSync(deps.webDist)) {
    await app.register(fastifyStatic, { root: deps.webDist, wildcard: false });
    // Client-side routes (/r/:id, /join/:code) all serve the SPA shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/socket.io/')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.status(404).send({ error: 'Not found.' });
    });
  }

  await app.ready();
  let io: TavernIo | null = null;
  const turns = new TurnRunner({
    db: deps.db,
    store,
    rooms,
    llm: deps.llm,
    onEvents: (roomId, events) => io?.to(roomId).emit('events', events),
    emit: (roomId, name, payload) => io?.to(roomId).emit(name, payload as never),
    ...(deps.random ? { random: deps.random } : {}),
    ...(deps.gmTimeoutMs ? { timeoutMs: deps.gmTimeoutMs } : {}),
  });
  commands.turns = turns;
  io = attachRealtime(app.server, { rooms, store, commands, turnStatus: (roomId) => turns.status(roomId) });
  return { app, io, store, rooms, commands, turns };
}
