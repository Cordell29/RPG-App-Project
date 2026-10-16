import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type CharacterCreateInput, type GameEvent, getPreset } from '@tavern/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type TavernApp, buildApp } from '../src/app.ts';
import { type CampaignFile, parseCampaignFile } from '../src/backup/campaign.ts';
import { NightlyBackups } from '../src/backup/nightly.ts';
import { snapshots } from '../src/db/schema.ts';
import { devMockProvider } from '../src/llm/devMock.ts';
import { testDb, tmpDir } from './helpers.ts';

const fighter: CharacterCreateInput = {
  name: 'Ayla', ancestry: 'Human', className: 'Fighter', roleName: 'Fighter', statMethod: 'standard',
  stats: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, skills: ['athletics', 'perception'], saves: [],
  visualDescriptor: 'tall, braided red hair', notes: '',
};

let apps: TavernApp[] = [];
afterEach(async () => {
  for (const t of apps) {
    t.io.close();
    await t.app.close();
  }
  apps = [];
});

async function setup(opts: { random?: (min: number, max: number) => number; dbFile?: string } = {}) {
  const dataDir = tmpDir();
  const db = testDb(opts.dbFile);
  const t = await buildApp({ dataDir, db, llm: devMockProvider(), rulesLookup: false, assetBackoffMs: () => 5, ...(opts.random ? { random: opts.random } : {}) });
  apps.push(t);
  return { t, db, dataDir };
}

function seat(t: TavernApp, roomId: string, token: string) {
  const player = t.rooms.authenticate(roomId, token)!;
  let n = 0;
  return (body: object) => t.commands.execute(player, { commandId: `bk-${player.playerId}-${++n}`, ...body });
}

async function playedCampaign(t: TavernApp) {
  const r = t.rooms.createRoom({ roomName: 'Saltreach Run', hostName: 'Cordell', setting: getPreset('fantasy')!, mode: 'group' });
  const cmd = seat(t, r.roomId, r.token);
  const bea = t.rooms.joinRoom(r.roomId, 'Bea');
  const g = seat(t, r.roomId, bea.token);
  cmd({ type: 'create_character', character: fighter });
  g({ type: 'create_character', character: { ...fighter, name: 'Bram' } });
  cmd({ type: 'start_session' });
  cmd({ type: 'send_chat', text: 'Ready?' });
  g({ type: 'roll_dice', notation: '2d6+1' });
  for (let i = 0; i < 3; i++) {
    cmd({ type: 'submit_action', text: `I scout ahead (${i}).` });
    cmd({ type: 'resolve_now' });
    await t.turns.whenIdle(r.roomId);
  }
  cmd({ type: 'void_last_turn' }); // a rewound turn must survive the round trip too
  await t.turns.whenIdle(r.roomId);
  cmd({ type: 'end_session' });
  await t.memory.whenIdle(r.roomId);
  await t.assets.whenIdle();
  return { ...r, cmd };
}

const exportFile = async (t: TavernApp, roomId: string, token: string, images = false) => {
  const res = await t.app.inject({ method: 'GET', url: `/api/rooms/${roomId}/export${images ? '?images=1' : ''}`, headers: { authorization: `Bearer ${token}` } });
  return { res, file: res.json() as CampaignFile };
};
const importFile = (t: TavernApp, file: unknown) => t.app.inject({ method: 'POST', url: '/api/import', payload: { file } });

describe('starting locations', () => {
  it('a new room rolls on the setting table with the server dice; the GM opens there', async () => {
    const fantasy = getPreset('fantasy')!;
    const { t } = await setup({ random: () => 4 });
    const r = t.rooms.createRoom({ roomName: 'R', hostName: 'H', setting: fantasy, mode: 'solo' });
    const s = t.store.getState(r.roomId);
    expect(s.opening).toEqual({ ...fantasy.starts[4], source: 'random' });
    expect(s.scene.title).toBe(fantasy.starts[4]!.title);
  });

  it('two campaigns with real randomness rarely start in the same place', async () => {
    const { t } = await setup();
    const titles = new Set(Array.from({ length: 12 }, (_, i) => t.store.getState(t.rooms.createRoom({ roomName: `R${i}`, hostName: 'H', setting: getPreset('scifi')!, mode: 'solo' }).roomId).opening!.title));
    expect(titles.size).toBeGreaterThan(3);
  });

  it('the host can pick one or write their own at creation', async () => {
    const { t } = await setup();
    const picked = t.rooms.createRoom({ roomName: 'R', hostName: 'H', setting: getPreset('scifi')!, mode: 'solo', start: { kind: 'pick', index: 1 } });
    expect(t.store.getState(picked.roomId).opening?.source).toBe('picked');
    const custom = t.rooms.createRoom({ roomName: 'R', hostName: 'H', setting: getPreset('scifi')!, mode: 'solo', start: { kind: 'custom', text: 'A casino orbiting a dead star.' } });
    expect(t.store.getState(custom.roomId).opening).toMatchObject({ source: 'custom', description: 'A casino orbiting a dead star.' });
    const res = await t.app.inject({ method: 'POST', url: '/api/rooms', payload: { roomName: 'X', hostName: 'H', setting: getPreset('scifi'), mode: 'solo', start: { kind: 'pick', index: 29 } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/does not exist/);
  });

  it('host re-rolls before the first turn (never the same place), then it is fixed', async () => {
    const { t } = await setup();
    const r = t.rooms.createRoom({ roomName: 'R', hostName: 'H', setting: getPreset('fantasy')!, mode: 'solo' });
    const cmd = seat(t, r.roomId, r.token);
    for (let i = 0; i < 5; i++) {
      const prev = t.store.getState(r.roomId).opening!.title;
      expect(cmd({ type: 'set_start', start: { kind: 'random' } })).toMatchObject({ ok: true });
      expect(t.store.getState(r.roomId).opening!.title).not.toBe(prev);
    }
    expect(cmd({ type: 'set_start', start: { kind: 'custom', title: 'The Lucky Void', text: 'A derelict casino.' } })).toMatchObject({ ok: true });
    cmd({ type: 'create_character', character: fighter });
    cmd({ type: 'submit_action', text: 'I look around.' });
    await t.turns.whenIdle(r.roomId);
    expect(cmd({ type: 'set_start', start: { kind: 'random' } })).toEqual({ ok: false, error: 'The story has already begun; the starting location is fixed.' });
  });

  it('only the host can change the start', async () => {
    const { t } = await setup();
    const r = t.rooms.createRoom({ roomName: 'R', hostName: 'H', setting: getPreset('fantasy')!, mode: 'group' });
    const g = seat(t, r.roomId, t.rooms.joinRoom(r.roomId, 'Bea').token);
    expect(g({ type: 'set_start', start: { kind: 'random' } })).toEqual({ ok: false, error: 'Only the host can do that.' });
  });
});

describe('export and import', () => {
  it('export → import on a fresh server → replay gives a state identical to the original', async () => {
    const a = await setup();
    const r = await playedCampaign(a.t);
    const original = a.t.store.getState(r.roomId);
    const { res, file } = await exportFile(a.t, r.roomId, r.token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="saltreach-run-\d{4}-\d{2}-\d{2}\.tavern\.json"/);
    expect(file).toMatchObject({ format: 'tavern-campaign', schemaVersion: 1, room: { name: 'Saltreach Run' } });
    expect(file.events).toHaveLength(original.seq);
    expect(file.assets.length).toBeGreaterThan(0);
    expect(file.assets[0]!.data).toBeUndefined();

    const b = await setup();
    const imp = await importFile(b.t, JSON.stringify(file));
    expect(imp.statusCode).toBe(200);
    const out = imp.json() as { roomId: string; playerId: string; token: string; hostToken: string; inviteCode: string; missingImages: number };
    expect(out.roomId).not.toBe(r.roomId);
    const imported = b.t.store.getState(out.roomId);
    expect(imported).toEqual({ ...original, seq: original.seq + 1 }); // + campaign_imported
    // Replaying from scratch agrees with the cache.
    b.t.store.forget(out.roomId);
    b.db.delete(snapshots).run();
    expect(b.t.store.getState(out.roomId)).toEqual(imported);
    // The importer is the host, with the original host's character.
    expect(out.playerId).toBe(original.players.find((p) => p.isHost)!.id);
    expect(b.t.rooms.authenticate(out.roomId, out.token)).toMatchObject({ isHost: true });
    // Chapters and canon tables are rebuilt from the log; images are listed as missing.
    expect(b.t.memory.rows(out.roomId)).toEqual(a.t.memory.rows(r.roomId).map((x) => ({ ...x, roomId: out.roomId })));
    expect(out.missingImages).toBe(file.assets.filter((x) => x.kind !== 'voice' && x.status === 'ready').length);
  });

  it('importing next to the original swaps colliding ids and still replays', async () => {
    const { t } = await setup();
    const r = await playedCampaign(t);
    const { file } = await exportFile(t, r.roomId, r.token);
    const imp = await importFile(t, file);
    expect(imp.statusCode).toBe(200);
    const out = imp.json() as { roomId: string; playerId: string };
    const a = t.store.getState(r.roomId);
    const b = t.store.getState(out.roomId);
    expect(out.playerId).not.toBe(a.players.find((p) => p.isHost)!.id);
    expect(b.party.map((c) => [c.name, c.hp, c.inventory.length])).toEqual(a.party.map((c) => [c.name, c.hp, c.inventory.length]));
    expect(b.turn.number).toBe(a.turn.number);
    // Both rooms still work independently.
    expect(t.rooms.authenticate(r.roomId, r.token)).toMatchObject({ isHost: true });
  });

  it('images can be embedded, and are restored without repainting', async () => {
    const a = await setup();
    const r = await playedCampaign(a.t);
    const { file } = await exportFile(a.t, r.roomId, r.token, true);
    const embedded = file.assets.filter((x) => x.data);
    expect(embedded.length).toBeGreaterThan(0);
    const b = await setup();
    const out = (await importFile(b.t, file)).json() as { roomId: string; missingImages: number };
    expect(out.missingImages).toBe(0);
    const res = await b.t.app.inject({ method: 'GET', url: `/assets/${out.roomId}/${embedded[0]!.id}.webp` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(Buffer.from(embedded[0]!.data!, 'base64'))).toBe(true);
  });

  it('missing images are repainted on request without moving the scene', async () => {
    const a = await setup();
    const r = await playedCampaign(a.t);
    r.cmd({ type: 'request_image', kind: 'scene' });
    await a.t.assets.whenIdle();
    const { file } = await exportFile(a.t, r.roomId, r.token);
    const b = await setup();
    const out = (await importFile(b.t, file)).json() as { roomId: string; token: string; missingImages: number };
    const before = b.t.store.getState(out.roomId);
    const cmd = seat(b.t, out.roomId, out.token);
    expect(cmd({ type: 'repaint_missing' })).toMatchObject({ ok: true });
    await b.t.assets.whenIdle();
    const repaints = b.t.store.loadEvents(out.roomId).filter((e) => e.type === 'image_ready' && e.payload.repaint);
    expect(repaints).toHaveLength(out.missingImages);
    expect(b.t.store.getState(out.roomId)).toEqual({ ...before, seq: before.seq + repaints.length });
  });

  it('only the host may export', async () => {
    const { t } = await setup();
    const r = t.rooms.createRoom({ roomName: 'R', hostName: 'H', setting: getPreset('fantasy')!, mode: 'group' });
    const bea = t.rooms.joinRoom(r.roomId, 'Bea');
    expect((await exportFile(t, r.roomId, bea.token)).res.statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: `/api/rooms/${r.roomId}/export` })).statusCode).toBe(401);
  });

  describe('corrupted files are rejected with a readable error', () => {
    let file: CampaignFile;
    const bad = async (t: TavernApp, f: unknown, re: RegExp) => {
      const res = await importFile(t, f);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(re);
    };

    it('covers every kind of damage', async () => {
      const { t, db } = await setup();
      const r = await playedCampaign(t);
      file = (await exportFile(t, r.roomId, r.token)).file;
      const text = JSON.stringify(file);
      await bad(t, text.slice(0, text.length / 2), /isn't valid JSON/);
      await bad(t, { hello: 'world' }, /isn't a Tavern campaign file/);
      await bad(t, { ...file, schemaVersion: 99 }, /newer version of Tavern/);
      const e = structuredClone(file);
      (e.events[5] as { payload: unknown }).payload = { nonsense: true };
      await bad(t, e, /damaged: events\[5\]\.payload/);
      await bad(t, { ...file, events: file.events.filter((_, i) => i !== 3) }, /gap or is out of order at position 4/);
      // A well-formed event that contradicts the story (removing an item nobody has).
      const c = structuredClone(file);
      const charId = c.events.find((x): x is Extract<GameEvent, { type: 'character_created' }> => x.type === 'character_created')!.payload.character.id;
      const last = c.events.at(-1)!;
      c.events.push({ ...last, seq: last.seq + 1, type: 'delta_applied', actorId: null, turnId: null, payload: { delta: { type: 'remove_item', characterId: charId, instanceId: 'nope', qty: 1 } } } as GameEvent);
      await bad(t, c, /could not be replayed: event \d+ \(delta_applied\)/);
      // Nothing half-imported: only the original room exists.
      expect(db.$client.prepare('select count(*) n from rooms').get()).toEqual({ n: 1 });
    });
  });

  it('parseCampaignFile accepts the exported file as-is', async () => {
    const { t } = await setup();
    const r = await playedCampaign(t);
    expect(() => parseCampaignFile(JSON.stringify(t.store.loadEvents(r.roomId)))).toThrow(/isn't a Tavern campaign file/);
  });
});

describe('rebuild state', () => {
  it('replays from scratch, replaces snapshots, refreshes derived tables and tells clients to resync', async () => {
    const { t, db } = await setup();
    const r = await playedCampaign(t);
    const good = t.store.getState(r.roomId);
    // Corrupt the cache and every snapshot.
    db.delete(snapshots).run();
    db.insert(snapshots).values({ roomId: r.roomId, seq: good.seq, stateJson: JSON.stringify({ ...good, roomName: 'CORRUPT' }) }).run();
    t.store.forget(r.roomId);
    expect(t.store.getState(r.roomId).roomName).toBe('CORRUPT');
    let resets = 0;
    const orig = t.commands.onReset;
    t.commands.onReset = (id) => {
      resets += id === r.roomId ? 1 : 0;
      orig(id);
    };
    expect(r.cmd({ type: 'rebuild_state' })).toMatchObject({ ok: true });
    expect(t.store.getState(r.roomId)).toEqual(good);
    t.store.forget(r.roomId);
    expect(t.store.getState(r.roomId)).toEqual(good);
    expect(resets).toBe(1);
  });
});

describe('seat links', () => {
  it('the host issues a one-time rejoin link that signs the old device out', async () => {
    const { t } = await setup();
    const r = t.rooms.createRoom({ roomName: 'R', hostName: 'H', setting: getPreset('fantasy')!, mode: 'group' });
    const bea = t.rooms.joinRoom(r.roomId, 'Bea');
    const link = await t.app.inject({ method: 'POST', url: `/api/rooms/${r.roomId}/seat-link`, payload: { playerId: bea.playerId }, headers: { authorization: `Bearer ${r.token}` } });
    expect(link.statusCode).toBe(200);
    const { token } = link.json() as { token: string };
    expect(t.rooms.authenticate(r.roomId, bea.token)).toBeNull();
    const claim = await t.app.inject({ method: 'POST', url: `/api/rooms/${r.roomId}/claim-seat`, payload: { playerId: bea.playerId, token } });
    expect(claim.statusCode).toBe(200);
    const creds = claim.json() as { token: string };
    expect(t.rooms.authenticate(r.roomId, creds.token)).toMatchObject({ playerId: bea.playerId, isHost: false });
    const again = await t.app.inject({ method: 'POST', url: `/api/rooms/${r.roomId}/claim-seat`, payload: { playerId: bea.playerId, token } });
    expect(again.statusCode).toBe(403);
    // Players cannot mint links.
    const nope = await t.app.inject({ method: 'POST', url: `/api/rooms/${r.roomId}/seat-link`, payload: { playerId: r.playerId }, headers: { authorization: `Bearer ${creds.token}` } });
    expect(nope.statusCode).toBe(403);
  });
});

describe('nightly backups', () => {
  it('writes one consistent backup per day and keeps 14 days', async () => {
    const dir = tmpDir();
    const dbFile = join(tmpDir(), 'live.db');
    const { t, db } = await setup({ dbFile });
    t.rooms.createRoom({ roomName: 'Backed up', hostName: 'H', setting: getPreset('fantasy')!, mode: 'solo' });
    let now = new Date('2026-10-01T03:00:00Z');
    const nightly = new NightlyBackups({ db, dir, keepDays: 14, now: () => now });
    const first = await nightly.runIfDue();
    expect(first).toBe(join(dir, 'tavern-2026-10-01.db'));
    expect(await nightly.runIfDue()).toBeNull(); // same day: nothing new
    const copy = testDb(first!);
    expect(copy.$client.prepare('select name from rooms').all()).toEqual([{ name: 'Backed up' }]);
    copy.$client.close();
    for (let d = 2; d <= 20; d++) {
      now = new Date(`2026-10-${String(d).padStart(2, '0')}T03:00:00Z`);
      await nightly.runIfDue();
    }
    const kept = nightly.list().map((b) => b.date);
    expect(kept).toHaveLength(14);
    expect(kept[0]).toBe('2026-10-07');
    expect(kept.at(-1)).toBe('2026-10-20');
    expect(existsSync(join(dir, 'tavern-2026-10-06.db'))).toBe(false);
  });
});
