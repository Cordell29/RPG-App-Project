import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { BUILT_IN_PRESETS, type GameEvent } from '@tavern/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import { CommandBus } from './commands.ts';
import type { Db } from './db/connection.ts';
import { EventStore } from './db/eventStore.ts';
import { LLMError, type LLMProvider } from './llm/provider.ts';
import { draftCharacter } from './llm/characterDraft.ts';
import { draftSetting } from './llm/settingDraft.ts';
import { TurnRunner } from './gm/turns.ts';
import { ASSET_FILE_RE, AssetService } from './media/assets.ts';
import { MockImageProvider, MockTtsProvider } from './media/mock.ts';
import type { ImageProvider, TtsProvider } from './media/provider.ts';
import { Chronicler } from './memory/chronicle.ts';
import { draftAbility } from './llm/abilityDraft.ts';
import { type TavernIo, attachRealtime } from './realtime.ts';
import { CreateRoomSchema, RoomError, RoomService } from './rooms.ts';

export interface AppDeps {
  db: Db;
  llm: LLMProvider;
  /** Dice source for GM rolls (tests pass a scripted one). */
  random?: (min: number, max: number) => number;
  gmTimeoutMs?: number;
  rulesLookup?: boolean;
  webDist?: string | null;
  logger?: boolean;
  images?: ImageProvider;
  tts?: TtsProvider;
  dataDir?: string;
  assetBackoffMs?: (attempt: number) => number;
}

export interface TavernApp {
  app: FastifyInstance;
  io: TavernIo;
  store: EventStore;
  rooms: RoomService;
  commands: CommandBus;
  turns: TurnRunner;
  memory: Chronicler;
  assets: AssetService;
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

  // Generated art and audio. Ids are unguessable; files never change, so cache forever.
  app.get('/assets/:roomId/:file', async (req, reply) => {
    const { roomId, file } = req.params as { roomId: string; file: string };
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(roomId) || !ASSET_FILE_RE.test(file)) return reply.status(404).send({ error: 'Not found.' });
    const path = join(assets.dir(roomId), file);
    if (!existsSync(path)) return reply.status(404).send({ error: 'Not found.' });
    return reply
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .type(file.endsWith('.wav') ? 'audio/wav' : 'image/webp')
      .send(createReadStream(path));
  });

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
    return draftAbility(deps.llm, state.setting, state.party.find((c) => c.id === characterId) ?? null, description, deps.rulesLookup ?? true);
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
  // Every committed batch goes to the room and to the media queue.
  const publish = (roomId: string, events: GameEvent[]) => {
    if (!events.length) return;
    io?.to(roomId).emit('events', events);
    assets.onCommitted(roomId, events);
  };
  const assets: AssetService = new AssetService({
    db: deps.db,
    store,
    dataDir: deps.dataDir ?? './data',
    images: deps.images ?? new MockImageProvider(),
    tts: deps.tts ?? new MockTtsProvider(),
    settings: (roomId) => rooms.settings(rooms.requireRoom(roomId)),
    onEvents: publish,
    ...(deps.assetBackoffMs ? { backoffMs: deps.assetBackoffMs } : {}),
  });
  const memory = new Chronicler({ db: deps.db, store, llm: deps.llm, onEvents: publish });
  const turns = new TurnRunner({
    memory,
    imageQuota: (roomId, state, events) => assets.quota(roomId, state, events),
    db: deps.db,
    store,
    rooms,
    llm: deps.llm,
    onEvents: publish,
    emit: (roomId, name, payload) => io?.to(roomId).emit(name, payload as never),
    ...(deps.random ? { random: deps.random } : {}),
    ...(deps.gmTimeoutMs ? { timeoutMs: deps.gmTimeoutMs } : {}),
    rulesLookup: deps.rulesLookup ?? true,
  });
  commands.turns = turns;
  commands.memory = memory;
  commands.media = assets;
  io = attachRealtime(app.server, {
    rooms,
    store,
    commands,
    turnStatus: (roomId) => turns.status(roomId),
    afterPublish: (roomId, events) => assets.onCommitted(roomId, events),
  });
  app.addHook('onClose', async () => assets.stop());
  assets.start();
  return { app, io, store, rooms, commands, turns, memory, assets };
}
