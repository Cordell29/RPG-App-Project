import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type EventDraft,
  type GameEvent,
  type GameState,
  IMAGE_PROMPT_PARTS,
  type RoomSettings,
  deriveCanon,
} from '@tavern/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import PQueue from 'p-queue';
import sharp from 'sharp';
import type { Db } from '../db/connection.ts';
import type { EventStore } from '../db/eventStore.ts';
import { assets, rooms } from '../db/schema.ts';
import type { ImageProvider, TtsProvider } from './provider.ts';

export const COST_CENTS = { image: 4, voice: 1 } as const;
export const MAX_ATTEMPTS = 3;
export const ASSET_FILE_RE = /^[A-Za-z0-9_-]{6,64}\.(webp|wav)$/;
const FALLBACK_STYLE = 'Painterly digital illustration, realistic proportions, dramatic rim lighting, visible brushwork.';

type AssetRow = typeof assets.$inferSelect;
type ImageKind = 'portrait' | 'scene' | 'npc';

export interface AssetServiceDeps {
  db: Db;
  store: EventStore;
  dataDir: string;
  images: ImageProvider;
  tts: TtsProvider;
  settings: (roomId: string) => RoomSettings;
  onEvents: (roomId: string, events: GameEvent[]) => void;
  /** Delay before retry n (1-based). Tests pass () => 0. */
  backoffMs?: (attempt: number) => number;
  timeoutMs?: number;
}

/** Builds the image prompt: room art style + subject + suffix + the always-appended rules. */
export function imagePrompt(state: GameState, kind: ImageKind, opts: { characterId?: string; subject?: string }, events: GameEvent[] = []): string {
  const style = state.setting?.artStyle ?? FALLBACK_STYLE;
  const { portraitSuffix, sceneSuffix, alwaysAppended } = IMAGE_PROMPT_PARTS;
  if (kind === 'portrait') {
    const c = state.party.find((x) => x.id === opts.characterId);
    const who = c ? `${c.name}, ${[c.ancestry, c.class].filter(Boolean).join(' ')}. ${c.visualDescriptor}` : (opts.subject ?? 'an adventurer');
    return `${style} ${portraitSuffix} Subject: ${who.trim()} ${alwaysAppended}`;
  }
  if (kind === 'npc') {
    const subject = opts.subject ?? 'a stranger';
    const canon = deriveCanon(events).find((e) => e.kind === 'npc' && [e.key.replace(/_/g, ' '), ...e.aliases].some((n) => subject.toLowerCase().includes(n.toLowerCase())));
    return `${style} ${portraitSuffix} Subject: ${subject}.${canon ? ` ${canon.facts.slice(0, 3).join('. ')}.` : ''} ${alwaysAppended}`;
  }
  const scene = `${state.scene.title || state.scene.locationKey}. ${state.scene.description}`.trim();
  return `${style} ${sceneSuffix} Scene: ${scene}${opts.subject ? ` Focus: ${opts.subject}.` : ''} ${alwaysAppended}`;
}

/**
 * Persisted media jobs. Rows live in the assets table (pending → ready | failed); a p-queue
 * worker with concurrency 1 processes them, independently of GM turns. Pending rows are
 * re-queued on start, so a restart mid-generation still finishes the job.
 */
export class AssetService {
  private readonly d: Required<AssetServiceDeps>;
  private readonly queue = new PQueue({ concurrency: 1 });
  private readonly queued = new Set<string>();
  private stopped = false;
  private readonly controllers = new Set<AbortController>();

  constructor(deps: AssetServiceDeps) {
    this.d = { backoffMs: (n) => 1000 * 4 ** (n - 1), timeoutMs: 90_000, ...deps };
  }

  dir(roomId: string) {
    return join(this.d.dataDir, 'assets', roomId);
  }

  /** Re-queue anything left pending (e.g. by a crash or restart). */
  start() {
    for (const row of this.d.db.select().from(assets).where(eq(assets.status, 'pending')).all()) this.enqueue(row.id);
  }

  async whenIdle() {
    await this.queue.onIdle();
  }

  /** Stop accepting work and abort in-flight generation (shutdown, tests). Rows stay pending. */
  stop() {
    this.stopped = true;
    this.queue.clear();
    for (const c of this.controllers) c.abort();
  }

  // ── quotas ──────────────────────────────────────────────────────────────

  imagesToday(roomId: string): number {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const row = this.d.db
      .select({ n: sql<number>`count(*)` })
      .from(assets)
      .where(and(eq(assets.roomId, roomId), gte(assets.createdAt, since), sql`${assets.kind} != 'voice'`))
      .get();
    return row?.n ?? 0;
  }

  /** What the GM may request this turn. */
  quota(roomId: string, state: GameState, events: GameEvent[]) {
    const settings = this.d.settings(roomId);
    const remainingToday = Math.max(0, settings.imagesPerDay - this.imagesToday(roomId));
    let lastSceneTurn = -Infinity;
    let turnNo = 0;
    const voided = new Set(state.voidedTurnIds);
    for (const e of events) {
      if (e.turnId && voided.has(e.turnId)) continue;
      if (e.type === 'turn_started') turnNo += 1;
      if (e.type === 'image_requested' && e.payload.kind === 'scene') lastSceneTurn = turnNo;
    }
    const sceneAllowed = state.turn.number + 1 - lastSceneTurn >= settings.sceneImageEveryTurns;
    return { remainingToday, sceneAllowed };
  }

  /** Portrait regenerations this session for a character (the creation portrait doesn't count). */
  portraitsThisSession(events: GameEvent[], characterId: string): number {
    let since = 0;
    for (const e of events) if (e.type === 'session_started') since = e.seq;
    const all = events.filter((e) => e.type === 'image_requested' && e.payload.kind === 'portrait' && e.payload.characterId === characterId);
    const first = all[0]?.seq;
    return all.filter((e) => e.seq > since && e.seq !== first).length;
  }

  /** Images that were never painted here (imported without data, or failed): queue them again. */
  repaintMissing(roomId: string): number {
    const rows = this.d.db
      .select()
      .from(assets)
      .where(and(eq(assets.roomId, roomId), eq(assets.status, 'failed'), sql`${assets.kind} != 'voice'`))
      .all();
    for (const r of rows) {
      this.d.db.update(assets).set({ status: 'pending', attempts: 0, error: null }).where(eq(assets.id, r.id)).run();
      this.enqueue(r.id);
    }
    return rows.length;
  }

  // ── reacting to committed events ────────────────────────────────────────

  /** Called with every batch of committed events: creates and queues jobs. */
  onCommitted(roomId: string, events: GameEvent[]) {
    if (this.stopped) return;
    const requests = events.filter((e) => e.type === 'image_requested');
    const narrations = events.filter((e) => e.type === 'narration');
    if (!requests.length && !narrations.length) return;
    const state = this.d.store.getState(roomId);
    const all = requests.length ? this.d.store.loadEvents(roomId) : [];
    const now = new Date().toISOString();
    for (const e of requests) {
      if (e.type !== 'image_requested') continue;
      const { assetId, kind, subject, characterId } = e.payload;
      const prompt = imagePrompt(state, kind, { ...(characterId ? { characterId } : {}), ...(subject ? { subject } : {}) }, all);
      this.d.db.insert(assets).values({ id: assetId, roomId, kind, prompt, status: 'pending', createdAt: now }).onConflictDoNothing().run();
      this.enqueue(assetId);
    }
    if (narrations.length && this.d.settings(roomId).aiVoice) {
      for (const e of narrations) {
        if (e.type !== 'narration') continue;
        const id = `v${e.seq}x${roomId.slice(0, 8)}`;
        this.d.db.insert(assets).values({ id, roomId, kind: 'voice', prompt: JSON.stringify({ seq: e.seq, text: e.payload.text }), status: 'pending', createdAt: now }).onConflictDoNothing().run();
        this.enqueue(id);
      }
    }
  }

  private enqueue(id: string) {
    if (this.queued.has(id) || this.stopped) return;
    this.queued.add(id);
    void this.queue.add(() => this.process(id).finally(() => this.queued.delete(id)));
  }

  // ── the worker ──────────────────────────────────────────────────────────

  private async process(id: string) {
    let row = this.d.db.select().from(assets).where(eq(assets.id, id)).get();
    while (row && row.status === 'pending' && !this.stopped) {
      try {
        await this.generate(row);
        return;
      } catch (err) {
        if (this.stopped) return;
        const attempts = row.attempts + 1;
        const error = String((err as Error).message ?? err).slice(0, 300);
        if (attempts >= MAX_ATTEMPTS) {
          this.d.db.update(assets).set({ status: 'failed', attempts, error }).where(eq(assets.id, id)).run();
          if (row.kind !== 'voice') this.commit(row.roomId, [{ type: 'image_failed', actorId: null, turnId: null, payload: { assetId: id, reason: error } }]);
          return;
        }
        this.d.db.update(assets).set({ attempts, error }).where(eq(assets.id, id)).run();
        await new Promise((r) => setTimeout(r, this.d.backoffMs(attempts)));
        row = this.d.db.select().from(assets).where(eq(assets.id, id)).get();
      }
    }
  }

  private async generate(row: AssetRow) {
    const ctrl = new AbortController();
    this.controllers.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), this.d.timeoutMs);
    try {
      mkdirSync(this.dir(row.roomId), { recursive: true });
      if (row.kind === 'voice') {
        const { seq, text } = JSON.parse(row.prompt) as { seq: number; text: string };
        const wav = await this.d.tts.synthesize(text, ctrl.signal);
        if (this.stopped) return;
        const path = join(this.dir(row.roomId), `${row.id}.wav`);
        writeFileSync(path, wav);
        this.finish(row, path, COST_CENTS.voice);
        this.commit(row.roomId, [{ type: 'audio_ready', actorId: null, turnId: null, payload: { assetId: row.id, narrationSeq: seq } }]);
        return;
      }
      const raw = await this.d.images.generate(row.prompt, ctrl.signal);
      if (this.stopped) return;
      const webp = await sharp(raw).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      const path = join(this.dir(row.roomId), `${row.id}.webp`);
      writeFileSync(path, webp);
      this.finish(row, path, COST_CENTS.image);
      const log = this.d.store.loadEvents(row.roomId);
      const req = log.find((e) => e.type === 'image_requested' && e.payload.assetId === row.id);
      const repaint = log.some((e) => e.type === 'image_ready' && e.payload.assetId === row.id);
      const characterId = req?.type === 'image_requested' ? req.payload.characterId : undefined;
      const state = this.d.store.getState(row.roomId);
      const stillThere = !characterId || state.party.some((c) => c.id === characterId);
      if (stillThere || repaint) {
        this.commit(row.roomId, [
          {
            type: 'image_ready',
            actorId: null,
            turnId: null,
            payload: { assetId: row.id, kind: row.kind as ImageKind, ...(characterId ? { characterId } : {}), ...(repaint ? { repaint: true } : {}) },
          },
        ]);
      }
    } finally {
      clearTimeout(timer);
      this.controllers.delete(ctrl);
    }
  }

  private finish(row: AssetRow, path: string, cents: number) {
    this.d.db.$client.transaction(() => {
      this.d.db.update(assets).set({ status: 'ready', path, costCents: cents, error: null }).where(eq(assets.id, row.id)).run();
      this.d.db.update(rooms).set({ spendCents: sql`${rooms.spendCents} + ${cents}` }).where(eq(rooms.id, row.roomId)).run();
    })();
  }

  private commit(roomId: string, drafts: EventDraft[]) {
    const committed = this.d.store.append(roomId, drafts);
    this.d.onEvents(roomId, committed);
  }
}
