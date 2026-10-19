import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CharacterCreateInput, type GameEvent, getPreset } from '@tavern/shared';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { type TavernApp, buildApp } from '../src/app.ts';
import { devMockProvider } from '../src/llm/devMock.ts';
import type { MockLLMProvider } from '../src/llm/mock.ts';
import { imagePrompt } from '../src/media/assets.ts';
import { MockImageProvider, MockTtsProvider } from '../src/media/mock.ts';
import { testDb, tmpDir } from './helpers.ts';

const fighter: CharacterCreateInput = {
  name: 'Ayla', ancestry: 'Human', className: 'Fighter', roleName: 'Fighter', statMethod: 'standard',
  stats: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, skills: ['athletics', 'perception'], saves: [],
  visualDescriptor: 'tall, braided red hair, scarred leather armour', notes: '',
};

let apps: TavernApp[] = [];
afterEach(async () => {
  for (const t of apps) {
    t.io.close();
    await t.app.close();
  }
  apps = [];
});

async function setup(opts: { images?: MockImageProvider; tts?: MockTtsProvider; dataDir?: string; dbFile?: string; mode?: 'solo' | 'group'; llm?: MockLLMProvider } = {}) {
  const images = opts.images ?? new MockImageProvider();
  const tts = opts.tts ?? new MockTtsProvider();
  const llm = opts.llm ?? devMockProvider();
  const dataDir = opts.dataDir ?? tmpDir();
  const t = await buildApp({ dataDir, db: testDb(opts.dbFile), llm, images, tts, rulesLookup: false, assetBackoffMs: () => 5 });
  apps.push(t);
  return { t, images, tts, llm, dataDir };
}

function room(t: TavernApp, mode: 'solo' | 'group' = 'solo') {
  const r = t.rooms.createRoom({ roomName: 'Art', hostName: 'Host', setting: getPreset('fantasy')!, mode });
  const player = t.rooms.authenticate(r.roomId, r.token)!;
  let n = 0;
  const cmd = (body: object) => t.commands.execute(player, { commandId: `media-cmd-${++n}`, ...body });
  return { ...r, player, cmd };
}

const events = (t: TavernApp, roomId: string, type: GameEvent['type']) => t.store.loadEvents(roomId).filter((e) => e.type === type);

describe('images', () => {
  it('a new character gets a portrait: prompt has art style, look and the no-text rule; 1024 px WebP; served immutable', async () => {
    const { t, images, dataDir } = await setup();
    const r = room(t);
    expect(r.cmd({ type: 'create_character', character: fighter })).toMatchObject({ ok: true });
    await t.assets.whenIdle();
    const ready = events(t, r.roomId, 'image_ready')[0]!;
    expect(ready.type === 'image_ready' && ready.payload.kind).toBe('portrait');
    const c = t.store.getState(r.roomId).party[0]!;
    expect(c.portraitAssetId).toBe(ready.type === 'image_ready' ? ready.payload.assetId : '');
    expect(images.prompts[0]).toMatch(/^Painterly digital illustration/);
    expect(images.prompts[0]).toMatch(/Three-quarter view, waist up/);
    expect(images.prompts[0]).toMatch(/braided red hair/);
    expect(images.prompts[0]).toMatch(/No text, no lettering, no watermark, no logos\.$/);
    const file = join(dataDir, 'assets', r.roomId, `${c.portraitAssetId}.webp`);
    const meta = await sharp(readFileSync(file)).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1024);
    const res = await t.app.inject({ method: 'GET', url: `/assets/${r.roomId}/${c.portraitAssetId}.webp` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['content-type']).toBe('image/webp');
    expect((await t.app.inject({ method: 'GET', url: `/assets/${r.roomId}/../../secret.webp` })).statusCode).toBe(404);
    // Cost is logged against the room.
    expect(t.rooms.getRoom(r.roomId)!.spendCents).toBe(4);
  });

  it('the GM can request a scene image, at most one every 3 turns', async () => {
    const llm = devMockProvider();
    const { t, images } = await setup({ llm });
    const r = room(t);
    r.cmd({ type: 'create_character', character: fighter });
    await t.assets.whenIdle();
    const ask = () => llm.respond({ tools: [{ name: 'request_image', input: { kind: 'scene', subject: 'a ruined chapel at dusk' } }, { name: 'end_adjudication', input: { summary: 'x' } }] });
    for (let i = 0; i < 4; i++) {
      ask();
      llm.respond('Narration.');
      r.cmd({ type: 'submit_action', text: `I look around (${i}).` });
      await t.turns.whenIdle(r.roomId);
    }
    await t.assets.whenIdle();
    const scenes = events(t, r.roomId, 'image_requested').filter((e) => e.type === 'image_requested' && e.payload.kind === 'scene');
    expect(scenes).toHaveLength(2); // turns 1 and 4
    expect(events(t, r.roomId, 'delta_rejected').filter((e) => e.type === 'delta_rejected' && /scene image was made recently/.test(e.payload.reason))).toHaveLength(2);
    expect(images.prompts.at(-1)).toMatch(/Wide establishing shot/);
    expect(images.prompts.at(-1)).toMatch(/ruined chapel at dusk/);
    expect(t.store.getState(r.roomId).scene.imageAssetId).toBeTruthy();
  });

  it('20 images per room per day', async () => {
    const { t } = await setup();
    const r = room(t);
    r.cmd({ type: 'create_character', character: fighter });
    for (let i = 0; i < 19; i++) expect(r.cmd({ type: 'request_image', kind: 'scene' })).toMatchObject({ ok: true });
    expect(r.cmd({ type: 'request_image', kind: 'scene' })).toEqual({ ok: false, error: "Today's image limit for this room is used up." });
    await t.assets.whenIdle();
  });

  it('players get one new portrait per character per session; the host is exempt; scenes are host-only', async () => {
    const { t } = await setup();
    const host = room(t, 'group');
    host.cmd({ type: 'create_character', character: fighter });
    const bea = t.rooms.joinRoom(host.roomId, 'Bea');
    const guest = t.rooms.authenticate(host.roomId, bea.token)!;
    let n = 0;
    const g = (body: object) => t.commands.execute(guest, { commandId: `guest-cmd-${++n}`, ...body });
    g({ type: 'create_character', character: { ...fighter, name: 'Bram' } });
    host.cmd({ type: 'start_session' });
    expect(g({ type: 'request_image', kind: 'portrait' })).toMatchObject({ ok: true });
    expect(g({ type: 'request_image', kind: 'portrait' })).toEqual({ ok: false, error: 'One new portrait per character per session.' });
    expect(g({ type: 'request_image', kind: 'scene' })).toEqual({ ok: false, error: 'Only the host can do that.' });
    const bram = t.store.getState(host.roomId).party.find((c) => c.name === 'Bram')!;
    expect(host.cmd({ type: 'request_image', kind: 'portrait', characterId: bram.id })).toMatchObject({ ok: true });
    expect(host.cmd({ type: 'request_image', kind: 'portrait', characterId: bram.id })).toMatchObject({ ok: true });
    await t.assets.whenIdle();
  });

  it('retries twice, then marks the image failed with a log event', async () => {
    const images = new MockImageProvider();
    images.failNext = 3;
    const { t } = await setup({ images });
    const r = room(t);
    r.cmd({ type: 'create_character', character: fighter });
    await t.assets.whenIdle();
    expect(images.prompts).toHaveLength(3);
    const failed = events(t, r.roomId, 'image_failed');
    expect(failed).toHaveLength(1);
    expect(t.store.getState(r.roomId).party[0]!.portraitAssetId).toBeUndefined();
    images.failNext = 2;
    r.cmd({ type: 'start_session' });
    r.cmd({ type: 'request_image', kind: 'portrait' });
    await t.assets.whenIdle();
    expect(events(t, r.roomId, 'image_ready')).toHaveLength(1); // third attempt succeeded
  });

  it('an image failure (or a slow image) never delays a turn', async () => {
    const images = new MockImageProvider();
    images.hang = true;
    const llm = devMockProvider();
    const { t } = await setup({ images, llm });
    const r = room(t);
    r.cmd({ type: 'create_character', character: fighter }); // portrait job hangs forever
    llm.respond({ tools: [{ name: 'request_image', input: { kind: 'npc', subject: 'a hooded smuggler' } }, { name: 'end_adjudication', input: { summary: 'x' } }] });
    llm.respond('A hooded figure watches you.');
    const start = Date.now();
    r.cmd({ type: 'submit_action', text: 'I look for the smuggler.' });
    await t.turns.whenIdle(r.roomId);
    expect(Date.now() - start).toBeLessThan(1500);
    expect(events(t, r.roomId, 'narration')).toHaveLength(1);
    expect(events(t, r.roomId, 'image_ready')).toHaveLength(0);
  });

  it('restarting the server mid-generation finishes the job', async () => {
    const dataDir = tmpDir();
    const dbFile = join(dataDir, 'tavern.db');
    const stuck = new MockImageProvider();
    stuck.hang = true;
    const first = await setup({ images: stuck, dataDir, dbFile });
    const r = room(first.t);
    r.cmd({ type: 'create_character', character: fighter });
    await new Promise((res) => setTimeout(res, 50));
    expect(stuck.prompts).toHaveLength(1);
    // "Crash": shut down without the job finishing.
    first.t.io.close();
    await first.t.app.close();
    apps = apps.filter((a) => a !== first.t);
    first.t.store['db'].$client.close();

    const second = await setup({ dataDir, dbFile });
    await second.t.assets.whenIdle();
    const c = second.t.store.getState(r.roomId).party[0]!;
    expect(c.portraitAssetId).toBeTruthy();
    expect(existsSync(join(dataDir, 'assets', r.roomId, `${c.portraitAssetId}.webp`))).toBe(true);
  });

  it('image prompts: NPCs pull canon facts; scenes use the scene description', () => {
    const state = {
      setting: getPreset('scifi')!,
      party: [],
      scene: { locationKey: 'dock', title: 'Dock 9', description: 'Rust-streaked gantries over a black sea.' },
    } as unknown as Parameters<typeof imagePrompt>[0];
    expect(imagePrompt(state, 'scene', {})).toMatch(/^Painterly science-fiction concept illustration[\s\S]*Dock 9\. Rust-streaked gantries/);
    const evs = [
      { seq: 1, type: 'delta_applied', actorId: null, turnId: null, createdAt: '', payload: { delta: { type: 'upsert_canon', kind: 'npc', key: 'mara_voss', aliases: ['Mara'], facts: ['One-eyed smuggler captain'] } } },
    ] as unknown as GameEvent[];
    expect(imagePrompt(state, 'npc', { subject: 'Mara, scowling' }, evs)).toMatch(/One-eyed smuggler captain/);
  });
});

describe('AI voice', () => {
  it('off by default; when the host turns it on, narration is also synthesised and announced', async () => {
    const tts = new MockTtsProvider();
    const { t } = await setup({ tts });
    const r = room(t);
    r.cmd({ type: 'create_character', character: fighter });
    r.cmd({ type: 'submit_action', text: 'I wait.' });
    await t.turns.whenIdle(r.roomId);
    await t.assets.whenIdle();
    expect(tts.texts).toHaveLength(0);
    expect(r.cmd({ type: 'set_ai_voice', on: true })).toMatchObject({ ok: true });
    r.cmd({ type: 'submit_action', text: 'I wait again.' });
    await t.turns.whenIdle(r.roomId);
    await t.assets.whenIdle();
    expect(tts.texts).toHaveLength(1);
    const audio = events(t, r.roomId, 'audio_ready')[0]!;
    const narration = events(t, r.roomId, 'narration').at(-1)!;
    expect(audio.type === 'audio_ready' && audio.payload.narrationSeq).toBe(narration.seq);
    const res = await t.app.inject({ method: 'GET', url: `/assets/${r.roomId}/${audio.type === 'audio_ready' ? audio.payload.assetId : ''}.wav` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
  });

  it('only the host can switch it on', async () => {
    const { t } = await setup();
    const host = room(t, 'group');
    const bea = t.rooms.joinRoom(host.roomId, 'Bea');
    const guest = t.rooms.authenticate(host.roomId, bea.token)!;
    expect(t.commands.execute(guest, { commandId: 'guest-voice-1', type: 'set_ai_voice', on: true })).toEqual({ ok: false, error: 'Only the host can do that.' });
  });
});

describe('pictures switched off (IMAGES=off, e.g. a free Gemini key)', () => {
  it('no portrait is requested, scenes are refused with a clear reason, and the GM is not offered the tool', async () => {
    const llm = devMockProvider();
    const t = await buildApp({ dataDir: tmpDir(), db: testDb(), llm, rulesLookup: false, imagesEnabled: false });
    apps.push(t);
    const r = room(t);
    expect(r.cmd({ type: 'create_character', character: fighter })).toMatchObject({ ok: true });
    expect(events(t, r.roomId, 'image_requested')).toHaveLength(0);
    expect(r.cmd({ type: 'request_image', kind: 'scene' })).toEqual({ ok: false, error: 'Pictures are switched off on this server (IMAGES=off in .env).' });
    r.cmd({ type: 'submit_action', text: 'I look around.' });
    await t.turns.whenIdle(r.roomId);
    const gmCall = llm.calls.find((c) => c.purpose === 'gm_adjudicate') as { tools?: { name: string }[] } | undefined;
    expect(gmCall?.tools?.map((x) => x.name)).not.toContain('request_image');
    expect(gmCall?.tools?.length).toBeGreaterThan(3);
  });
});
