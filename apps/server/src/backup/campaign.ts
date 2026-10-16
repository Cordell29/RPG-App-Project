import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type GameEvent,
  type GameState,
  GameEventSchema,
  ReducerError,
  RoomSettingsSchema,
  replay,
} from '@tavern/shared';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { hashToken, newId, newRoomId, newToken } from '../auth.ts';
import type { Db } from '../db/connection.ts';
import type { EventStore } from '../db/eventStore.ts';
import { assets, players, rooms } from '../db/schema.ts';
import type { Chronicler } from '../memory/chronicle.ts';
import type { RoomService } from '../rooms.ts';
import { RoomError } from '../rooms.ts';

export const CAMPAIGN_FORMAT = 'tavern-campaign';
export const CAMPAIGN_SCHEMA_VERSION = 1;
/** Imports may embed images as base64; keep the request size sane. */
export const IMPORT_BODY_LIMIT = 64 * 1024 * 1024;

const AssetEntrySchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
  kind: z.enum(['portrait', 'scene', 'npc', 'voice']),
  prompt: z.string().max(20_000),
  status: z.enum(['pending', 'ready', 'failed']).optional(),
  /** Base64 WebP/WAV, only in exports made with "include images". */
  data: z.string().optional(),
});

export const CampaignFileSchema = z.object({
  format: z.literal(CAMPAIGN_FORMAT),
  schemaVersion: z.literal(CAMPAIGN_SCHEMA_VERSION),
  exportedAt: z.string(),
  room: z.object({ name: z.string().trim().min(1).max(60), settings: z.unknown() }),
  events: z.array(GameEventSchema).min(1),
  /** Derived from events; carried for people reading the file. Import rebuilds both from events. */
  chronicle: z.array(z.unknown()).default([]),
  canon: z.array(z.unknown()).default([]),
  assets: z.array(AssetEntrySchema).default([]),
});
export type CampaignFile = z.infer<typeof CampaignFileSchema>;

/**
 * Upgrades older export files one version at a time. Version 1 is the first, so there is
 * nothing to do yet; add `2: (f) => …` here when the format changes.
 */
const UPGRADES: Record<number, (file: Record<string, unknown>) => Record<string, unknown>> = {};

export class ImportError extends RoomError {
  override name = 'ImportError';
}

const fail = (msg: string): never => {
  throw new ImportError(msg, 400);
};

/** "events[12].payload.delta.amount: Invalid input" → readable, at most three issues. */
function describeZod(err: z.ZodError): string {
  const lines = err.issues.slice(0, 3).map((i) => {
    const path = i.path.reduce<string>((acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : acc ? `${acc}.${String(p)}` : String(p)), '');
    return path ? `${path}: ${i.message}` : i.message;
  });
  const more = err.issues.length > 3 ? ` (and ${err.issues.length - 3} more)` : '';
  return lines.join('; ') + more;
}

/** Parses, upgrades and fully validates an export file. Every failure is a readable ImportError. */
export function parseCampaignFile(raw: unknown): { file: CampaignFile; state: GameState } {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      fail("This file isn't valid JSON. It may be damaged or cut off; try exporting it again.");
    }
  }
  if (!data || typeof data !== 'object' || (data as { format?: unknown }).format !== CAMPAIGN_FORMAT) {
    fail("This isn't a Tavern campaign file.");
  }
  let obj = data as Record<string, unknown>;
  let version = obj.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) fail('The file has no valid schemaVersion.');
  if ((version as number) > CAMPAIGN_SCHEMA_VERSION) {
    fail(`This file comes from a newer version of Tavern (format ${version}); update the server to import it.`);
  }
  while ((version as number) < CAMPAIGN_SCHEMA_VERSION) {
    const up = UPGRADES[(version as number) + 1] ?? fail(`No upgrade path from format ${version}.`);
    obj = up(obj);
    version = (version as number) + 1;
    obj.schemaVersion = version;
  }
  const parsed = CampaignFileSchema.safeParse(obj);
  if (!parsed.success) fail(`The campaign file is damaged: ${describeZod(parsed.error)}`);
  const file = parsed.data!;

  file.events.forEach((e, i) => {
    if (e.seq !== i + 1) fail(`The event log has a gap or is out of order at position ${i + 1} (found seq ${e.seq}).`);
  });
  if (file.events[0]!.type !== 'room_created') fail('The event log does not start with the room being created.');

  let state: GameState;
  try {
    state = replay(file.events);
  } catch (err) {
    if (err instanceof ReducerError) {
      const at = err.event ? `event ${err.event.seq} (${err.event.type})` : 'an event';
      fail(`The story could not be replayed: ${at} is inconsistent with what came before (${err.message.replace(/^\[seq \d+ \w+\] /, '')}).`);
    }
    throw err;
  }
  if (!state!.players.some((p) => p.isHost)) fail('The campaign has no host player.');
  return { file, state: state! };
}

export interface CampaignDeps {
  db: Db;
  store: EventStore;
  rooms: RoomService;
  memory: Chronicler;
  assetDir: (roomId: string) => string;
}

/** Host export: the whole log plus derived chronicle/canon and the asset list. */
export function exportCampaign(d: CampaignDeps, roomId: string, opts: { images?: boolean } = {}): CampaignFile {
  const room = d.rooms.requireRoom(roomId);
  const rows = d.db.select().from(assets).where(eq(assets.roomId, roomId)).all();
  return {
    format: CAMPAIGN_FORMAT,
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    room: { name: room.name, settings: d.rooms.settings(room) },
    events: d.store.loadEvents(roomId),
    chronicle: d.memory.rows(roomId).map(({ level, chapterNo, fromSeq, toSeq, summary }) => ({ level, chapterNo, fromSeq, toSeq, summary })),
    canon: d.memory.canon(roomId),
    assets: rows.map((a) => {
      const entry: z.infer<typeof AssetEntrySchema> = { id: a.id, kind: a.kind, prompt: a.prompt, status: a.status };
      // Voice clips are large and easy to live without (read-aloud falls back to the browser voice).
      if (opts.images && a.kind !== 'voice' && a.status === 'ready' && a.path && existsSync(a.path)) {
        entry.data = readFileSync(a.path).toString('base64');
      }
      return entry;
    }),
  };
}

export interface ImportResult {
  roomId: string;
  playerId: string;
  token: string;
  hostToken: string;
  inviteCode: string;
  missingImages: number;
}

/**
 * Imports into a brand-new room (never overwrites). Player and asset ids that already exist
 * on this server (e.g. importing a copy of a room that is still here) are swapped for fresh
 * ones; otherwise the log is stored exactly as exported, so replay gives the identical state.
 */
export function importCampaign(d: CampaignDeps, raw: unknown): ImportResult {
  const parsed = parseCampaignFile(raw);
  let { file, state } = parsed;

  const playerIds = state.players.map((p) => p.id);
  const assetIds = file.assets.map((a) => a.id);
  const taken = new Set([
    ...(playerIds.length ? d.db.select({ id: players.id }).from(players).where(inArray(players.id, playerIds)).all() : []),
    ...(assetIds.length ? d.db.select({ id: assets.id }).from(assets).where(inArray(assets.id, assetIds)).all() : []),
  ].map((r) => r.id));
  if (taken.size) {
    // Ids are 16+ random characters, so a whole-string swap in the JSON is exact.
    let json = JSON.stringify({ events: file.events, assets: file.assets });
    for (const old of taken) json = json.split(JSON.stringify(old)).join(JSON.stringify(newId()));
    const swapped = JSON.parse(json) as Pick<CampaignFile, 'events' | 'assets'>;
    ({ file, state } = parseCampaignFile({ ...file, ...swapped }));
  }

  const settings = RoomSettingsSchema.safeParse(file.room.settings);
  const roomId = newRoomId();
  const hostToken = newToken();
  const inviteCode = d.rooms.newInviteCode();
  const host = state.players.find((p) => p.isHost)!;
  const tokens = new Map(state.players.map((p) => [p.id, newToken()]));
  const now = new Date().toISOString();
  let missingImages = 0;

  const imported = d.db.$client.transaction(() => {
    d.db
      .insert(rooms)
      .values({
        id: roomId,
        name: file.room.name,
        inviteCode,
        hostTokenHash: hashToken(hostToken),
        settingsJson: JSON.stringify(settings.success ? settings.data : RoomSettingsSchema.parse({})),
        createdAt: now,
      })
      .run();
    for (const p of state.players) {
      d.db
        .insert(players)
        .values({
          id: p.id,
          roomId,
          displayName: p.displayName,
          tokenHash: hashToken(tokens.get(p.id)!),
          isHost: p.isHost,
          characterId: state.party.find((c) => c.playerId === p.id)?.id ?? null,
        })
        .run();
    }
    d.store.importEvents(roomId, file.events);
    const dir = d.assetDir(roomId);
    for (const a of file.assets) {
      let path: string | null = null;
      if (a.data) {
        mkdirSync(dir, { recursive: true });
        path = join(dir, `${a.id}.${a.kind === 'voice' ? 'wav' : 'webp'}`);
        writeFileSync(path, Buffer.from(a.data, 'base64'));
      } else if (a.kind !== 'voice' && a.status === 'ready') {
        missingImages += 1;
      }
      d.db
        .insert(assets)
        .values({
          id: a.id,
          roomId,
          kind: a.kind,
          prompt: a.prompt,
          // Images without data stay "failed / missing" until the host repaints them.
          status: path ? 'ready' : 'failed',
          path,
          error: path ? null : 'missing after import',
          createdAt: file.exportedAt,
        })
        .run();
    }
    return d.store.append(roomId, [
      {
        type: 'campaign_imported',
        actorId: host.id,
        turnId: null,
        payload: { sourceRoomName: file.room.name, sourceExportedAt: file.exportedAt, importedEventCount: file.events.length },
      },
    ]);
  });

  try {
    imported();
  } catch (err) {
    d.store.forget(roomId);
    throw err;
  }
  d.memory.rebuildDerived(roomId);
  return { roomId, playerId: host.id, token: tokens.get(host.id)!, hostToken, inviteCode, missingImages };
}
