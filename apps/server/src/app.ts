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
import { IMPORT_BODY_LIMIT, exportCampaign, importCampaign } from './backup/campaign.ts';
import { MockImageProvider, MockTtsProvider } from './media/mock.ts';
import type { ImageProvider, TtsProvider } from './media/provider.ts';
import { Chronicler } from './memory/chronicle.ts';
import { draftAbility } from './llm/abilityDraft.ts';
import { type TavernIo, attachRealtime } from './realtime.ts';
import { CreateRoomSchema, RoomError, RoomService } from './rooms.ts';
import { HTTP_LIMITS, RateLimiter, clientIp } from './limits.ts';
import { RejoinService } from './rejoin.ts';
import { type TunnelOptions, TunnelWatcher } from './tunnel.ts';
import { MeteredLLM, type Pricing, type SpendCaps, SpendMeter, loadPricing } from './spend.ts';

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
  /** Daily spend caps in USD (defaults: $5 per room, $20 across the server). */
  spendCaps?: SpendCaps;
  pricing?: Pricing;
  /** Clock for the spend ledger (tests). */
  now?: () => Date;
  /** GM turns per room per minute (default 6). */
  turnsPerMinute?: number;
  /** Per-IP limits on public HTTP endpoints (per 10 minutes); off unless given. */
  httpLimits?: Partial<Record<keyof typeof HTTP_LIMITS, number>>;
  /** Socket commands per player per minute (default 30). */
  commandsPerMinute?: number;
  /** Pictures on/off (IMAGES=off skips image generation entirely). Default on. */
  imagesEnabled?: boolean;
  /** Public link discovery (Cloudflare Quick Tunnel metrics, PUBLIC_URL, share webhook). */
  tunnel?: TunnelOptions;
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
  spend: SpendMeter;
  rejoin: RejoinService;
  tunnel: TunnelWatcher;
}

export async function buildApp(deps: AppDeps): Promise<TavernApp> {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true, bodyLimit: 64 * 1024 });
  const store = new EventStore(deps.db, { reducer: { unknown: 'skip', onUnknown: (e) => app.log.error(e, 'unknown event') } });
  const spend = new SpendMeter({
    db: deps.db,
    pricing: deps.pricing ?? loadPricing(),
    caps: deps.spendCaps ?? { roomUsd: 5, globalUsd: 20 },
    ...(deps.now ? { now: deps.now } : {}),
  });
  // Every LLM call is metered against its room and the global daily total.
  const llm = new MeteredLLM(deps.llm, spend);
  const rooms = new RoomService(deps.db, store, deps.random, Math.round(spend.caps.roomUsd * 100));
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

  // Security headers on every response. Tokens travel in URLs (?host=, ?seat=), so never
  // send a Referer; the app is never framed.
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html')) {
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
    }
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', reply.getHeader('cache-control') ?? 'no-store');
    return payload;
  });

  // Per-IP limits on the public endpoints (behind the tunnel the IP is CF-Connecting-IP).
  if (deps.httpLimits) {
    const limits = { ...HTTP_LIMITS, ...deps.httpLimits };
    const buckets = Object.fromEntries(Object.entries(limits).map(([k, n]) => [k, new RateLimiter(n, 10 * 60_000)])) as Record<keyof typeof HTTP_LIMITS, RateLimiter>;
    const bucketFor = (method: string, url: string): keyof typeof HTTP_LIMITS | null => {
      const path = url.split('?')[0]!;
      if (!path.startsWith('/api/')) return null;
      if (method === 'POST' && path === '/api/rooms') return 'createRoom';
      if (method === 'POST' && path === '/api/import') return 'importCampaign';
      if (method === 'POST' && /\/(join|rejoin)$/.test(path)) return 'join';
      if (method === 'POST' && /draft$/.test(path)) return 'draft';
      if (method === 'POST' && /\/claim-(host|seat)$/.test(path)) return 'claim';
      return 'general';
    };
    app.addHook('onRequest', async (req, reply) => {
      const bucket = bucketFor(req.method, req.url);
      if (!bucket) return;
      const ip = clientIp(req.headers, req.ip);
      const wait = buckets[bucket].hit(`${bucket}:${ip}`) || (bucket !== 'general' ? buckets.general.hit(`general:${ip}`) : 0);
      if (wait) {
        reply.header('Retry-After', String(Math.ceil(wait / 1000)));
        return reply.status(429).send({ error: `Too many requests. Try again in ${Math.ceil(wait / 60_000)} min.` });
      }
    });
  }

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

  /** The public address to put in shared links (changes when a Quick Tunnel restarts). */
  app.get('/api/server-info', async () => ({ publicUrl: tunnel.current }));

  app.post('/api/setting-draft', async (req) => {
    const { description } = z.object({ description: z.string() }).parse(req.body);
    return draftSetting(llm, description);
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
    return draftCharacter(llm, store.getState(roomId).setting, description, roomId);
  });

  /** Workshop an ability with the AI: returns a draft the player edits, then proposes. */
  app.post('/api/rooms/:roomId/ability-draft', async (req) => {
    const roomId = (req.params as { roomId: string }).roomId;
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token || !rooms.authenticate(roomId, token)) throw new RoomError('Sign in to this room first.', 401);
    const { description, characterId } = z.object({ description: z.string(), characterId: z.string() }).parse(req.body);
    const state = store.getState(roomId);
    return draftAbility(llm, state.setting, state.party.find((c) => c.id === characterId) ?? null, description, deps.rulesLookup ?? true, roomId);
  });

  const requireHost = (req: { params: unknown; headers: { authorization?: string } }) => {
    const roomId = (req.params as { roomId: string }).roomId;
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const who = token ? rooms.authenticate(roomId, token) : null;
    if (!who) throw new RoomError('Sign in to this room first.', 401);
    if (!who.isHost) throw new RoomError('Only the host can do that.', 403);
    return who;
  };
  const campaignDeps = () => ({ db: deps.db, store, rooms, memory, assetDir: (roomId: string) => assets.dir(roomId) });

  /** Host: the whole campaign as one JSON file (?images=1 embeds the pictures). */
  app.get('/api/rooms/:roomId/export', async (req, reply) => {
    const who = requireHost(req);
    const images = (req.query as { images?: string }).images === '1';
    const file = exportCampaign(campaignDeps(), who.roomId, { images });
    const slug = file.room.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'campaign';
    return reply
      .header('Content-Disposition', `attachment; filename="${slug}-${file.exportedAt.slice(0, 10)}.tavern.json"`)
      .header('Cache-Control', 'no-store')
      .send(file);
  });

  /** Import a campaign file into a brand-new room; the importer becomes its host. */
  app.post('/api/import', { bodyLimit: IMPORT_BODY_LIMIT }, async (req) => {
    const { file } = z.object({ file: z.unknown() }).parse(req.body);
    const res = importCampaign(campaignDeps(), file);
    return res;
  });

  /** Returning players: which characters can be reclaimed (names only). */
  app.get('/api/rooms/:roomId/seats', async (req) => rejoin.seats((req.params as { roomId: string }).roomId));

  app.post('/api/rooms/:roomId/rejoin', async (req) => {
    const { characterId } = z.object({ characterId: z.string().min(1).max(64) }).parse(req.body);
    return rejoin.request((req.params as { roomId: string }).roomId, characterId);
  });

  app.get('/api/rooms/:roomId/rejoin/:requestId', async (req) => {
    const { roomId, requestId } = req.params as { roomId: string; requestId: string };
    const { secret } = z.object({ secret: z.string().min(16).max(128) }).parse(req.query);
    return rejoin.status(roomId, requestId, secret);
  });

  /** Host: today's estimated AI spend for the room and the server. */
  app.get('/api/rooms/:roomId/spend', async (req) => spend.summary(requireHost(req).roomId));

  /** Host: a one-time rejoin link for a seat. */
  app.post('/api/rooms/:roomId/seat-link', async (req) => {
    const who = requireHost(req);
    const { playerId } = z.object({ playerId: z.string().min(1).max(64) }).parse(req.body);
    return { playerId, token: rooms.issueSeatToken(who.roomId, playerId) };
  });

  app.post('/api/rooms/:roomId/claim-seat', async (req) => {
    const { playerId, token } = z.object({ playerId: z.string().min(1).max(64), token: z.string().min(16).max(128) }).parse(req.body);
    return rooms.claimSeat((req.params as { roomId: string }).roomId, playerId, token);
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
    spend,
    imagesEnabled: deps.imagesEnabled ?? true,
    ...(deps.assetBackoffMs ? { backoffMs: deps.assetBackoffMs } : {}),
  });
  const memory = new Chronicler({ db: deps.db, store, llm, onEvents: publish });
  const turns = new TurnRunner({
    memory,
    imageQuota: (roomId, state, events) => assets.quota(roomId, state, events),
    db: deps.db,
    store,
    rooms,
    llm,
    gate: (roomId) => spend.check(roomId),
    imagesEnabled: deps.imagesEnabled ?? true,
    ...(deps.turnsPerMinute ? { turnsPerMinute: deps.turnsPerMinute } : {}),
    onEvents: publish,
    emit: (roomId, name, payload) => io?.to(roomId).emit(name, payload as never),
    ...(deps.random ? { random: deps.random } : {}),
    ...(deps.gmTimeoutMs ? { timeoutMs: deps.gmTimeoutMs } : {}),
    rulesLookup: deps.rulesLookup ?? true,
  });
  commands.turns = turns;
  commands.memory = memory;
  commands.media = assets;
  const rejoin = new RejoinService(rooms, store);
  commands.rejoin = rejoin;
  const tunnel = new TunnelWatcher({
    ...deps.tunnel,
    onChange: (url) => {
      io?.emit('public_url', { url });
      deps.tunnel?.onChange?.(url);
    },
  });
  io = attachRealtime(app.server, {
    rooms,
    store,
    commands,
    turnStatus: (roomId) => turns.status(roomId),
    afterPublish: (roomId, events) => assets.onCommitted(roomId, events),
    extraSync: (player) => ({ publicUrl: tunnel.current, features: { images: assets.imagesEnabled }, ...(player.isHost ? { rejoinRequests: rejoin.pending(player.roomId) } : {}) }),
    ...(deps.commandsPerMinute ? { commandsPerMinute: deps.commandsPerMinute } : {}),
  });
  rejoin.onChange = (roomId) => {
    const list = rejoin.pending(roomId);
    for (const s of io!.sockets.adapter.rooms.get(roomId) ?? []) {
      const sock = io!.sockets.sockets.get(s);
      if (sock?.data.player?.isHost) sock.emit('rejoin_requests', list);
    }
  };
  app.addHook('onClose', async () => {
    assets.stop();
    tunnel.stop();
  });
  assets.start();
  tunnel.start();
  return { app, io, store, rooms, commands, turns, memory, assets, spend, rejoin, tunnel };
}
