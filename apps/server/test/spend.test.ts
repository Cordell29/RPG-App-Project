import { type CharacterCreateInput, getPreset } from '@tavern/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type TavernApp, buildApp } from '../src/app.ts';
import { devMockProvider } from '../src/llm/devMock.ts';
import type { MockLLMProvider } from '../src/llm/mock.ts';
import { type Pricing, loadPricing, usageCost } from '../src/spend.ts';
import { testDb, tmpDir } from './helpers.ts';

const fighter: CharacterCreateInput = {
  name: 'Ayla', ancestry: 'Human', className: 'Fighter', roleName: 'Fighter', statMethod: 'standard',
  stats: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, skills: ['athletics', 'perception'], saves: [],
  visualDescriptor: '', notes: '',
};

// Mock usage is 100 in / 50 out per call on the "default" model: make that cost exactly 1 cent.
const pricing: Pricing = {
  models: { default: { input: 25, output: 150, cacheRead: 0, cacheWrite: 0 } },
  perUnit: { image: 0.04, voice: 0.01, webSearch: 0.01 },
};

let apps: TavernApp[] = [];
afterEach(async () => {
  for (const t of apps) {
    t.io.close();
    await t.app.close();
  }
  apps = [];
});

async function setup(opts: { roomUsd?: number; globalUsd?: number; turnsPerMinute?: number; now?: () => Date } = {}) {
  const llm: MockLLMProvider = devMockProvider();
  const t = await buildApp({
    dataDir: tmpDir(), db: testDb(), llm, rulesLookup: false, pricing, assetBackoffMs: () => 1,
    spendCaps: { roomUsd: opts.roomUsd ?? 5, globalUsd: opts.globalUsd ?? 20 },
    ...(opts.turnsPerMinute ? { turnsPerMinute: opts.turnsPerMinute } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  apps.push(t);
  return { t, llm };
}

function room(t: TavernApp, name = 'R') {
  const r = t.rooms.createRoom({ roomName: name, hostName: 'H', setting: getPreset('fantasy')!, mode: 'solo' });
  const player = t.rooms.authenticate(r.roomId, r.token)!;
  let n = 0;
  const cmd = (body: object) => t.commands.execute(player, { commandId: `spend-${r.roomId}-${++n}`, ...body });
  cmd({ type: 'create_character', character: fighter });
  return { ...r, cmd };
}

describe('cost estimates', () => {
  it('prices usage per model from config/pricing.json, unknown models at the pessimistic default', () => {
    const real = loadPricing();
    expect(usageCost(real, { inputTokens: 1_000_000, outputTokens: 1_000_000, model: 'claude-sonnet-5-5' })).toBeCloseTo(12);
    expect(usageCost(real, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000, model: 'claude-haiku-5-5' })).toBeCloseTo(0.11);
    expect(usageCost(real, { inputTokens: 1_000_000, outputTokens: 0, model: 'mystery-model' })).toBe(real.models.default!.input);
    expect(usageCost(real, { inputTokens: 0, outputTokens: 0, webSearches: 3 })).toBeCloseTo(0.03);
  });
});

describe('room spend cap', () => {
  it('hitting the cap pauses the GM cleanly; raising it resumes the queued action', async () => {
    const { t, llm } = await setup({ roomUsd: 0.03 });
    const r = room(t);
    // Each GM turn: adjudicate (1¢) + narrate (1¢) = 2¢. First turn fits, second crosses the cap.
    r.cmd({ type: 'submit_action', text: 'I look around.' });
    await t.turns.whenIdle(r.roomId);
    r.cmd({ type: 'submit_action', text: 'I open the door.' });
    await t.turns.whenIdle(r.roomId);
    expect(t.spend.roomToday(r.roomId)).toBeCloseTo(0.04);
    const calls = llm.calls.length;

    expect(r.cmd({ type: 'submit_action', text: 'I climb the stairs.' })).toMatchObject({ ok: true });
    await t.turns.whenIdle(r.roomId);
    expect(llm.calls.length).toBe(calls); // no AI call at all
    const status = t.turns.status(r.roomId);
    expect(status.status).toBe('paused');
    expect(status.error).toMatch(/daily AI budget \(\$0\.03\) is used up/);
    const state = t.store.getState(r.roomId);
    expect(state.turn.phase).not.toBe('resolving');
    expect(state.turn.pending.map((a) => a.text)).toEqual(['I climb the stairs.']); // nothing lost
    // Retry while capped stays paused.
    r.cmd({ type: 'resolve_now' });
    await t.turns.whenIdle(r.roomId);
    expect(llm.calls.length).toBe(calls);

    // Images are refused too.
    expect(r.cmd({ type: 'request_image', kind: 'scene' })).toMatchObject({ ok: false, error: expect.stringMatching(/daily AI budget/) });

    // The host raises the cap: the queued action resolves.
    expect(r.cmd({ type: 'set_spend_cap', usd: 1 })).toMatchObject({ ok: true });
    await t.turns.whenIdle(r.roomId);
    expect(t.store.getState(r.roomId).turn.pending).toEqual([]);
    expect(t.turns.status(r.roomId).status).toBe('idle');
  });

  it('a turn already running is allowed to finish even if it crosses the cap', async () => {
    const { t } = await setup({ roomUsd: 0.01 });
    const r = room(t);
    r.cmd({ type: 'submit_action', text: 'I look around.' });
    await t.turns.whenIdle(r.roomId);
    expect(t.store.loadEvents(r.roomId).filter((e) => e.type === 'narration')).toHaveLength(1);
    expect(t.spend.roomToday(r.roomId)).toBeGreaterThan(0.01);
  });

  it('only the host sets the cap; the spend summary is host-only', async () => {
    const { t } = await setup();
    const r = t.rooms.createRoom({ roomName: 'G', hostName: 'H', setting: getPreset('fantasy')!, mode: 'group' });
    const bea = t.rooms.joinRoom(r.roomId, 'Bea');
    const guest = t.rooms.authenticate(r.roomId, bea.token)!;
    expect(t.commands.execute(guest, { commandId: 'guest-cap-1', type: 'set_spend_cap', usd: 50 })).toEqual({ ok: false, error: 'Only the host can do that.' });
    const res = await t.app.inject({ method: 'GET', url: `/api/rooms/${r.roomId}/spend`, headers: { authorization: `Bearer ${r.token}` } });
    expect(res.json()).toEqual({ roomTodayUsd: 0, roomCapUsd: 5, globalTodayUsd: 0, globalCapUsd: 20 });
    expect((await t.app.inject({ method: 'GET', url: `/api/rooms/${r.roomId}/spend`, headers: { authorization: `Bearer ${bea.token}` } })).statusCode).toBe(403);
  });

  it('the cap resets at midnight UTC', async () => {
    let now = new Date('2026-10-16T23:50:00Z');
    const { t } = await setup({ roomUsd: 0.01, now: () => now });
    const r = room(t);
    r.cmd({ type: 'submit_action', text: 'one' });
    await t.turns.whenIdle(r.roomId);
    r.cmd({ type: 'submit_action', text: 'two' });
    await t.turns.whenIdle(r.roomId);
    expect(t.turns.status(r.roomId).status).toBe('paused');
    now = new Date('2026-10-17T00:01:00Z');
    r.cmd({ type: 'resolve_now' });
    await t.turns.whenIdle(r.roomId);
    expect(t.store.getState(r.roomId).turn.pending).toEqual([]);
  });
});

describe('global spend cap', () => {
  it('stops every room and every draft once the server total is reached', async () => {
    const { t, llm } = await setup({ globalUsd: 0.02 });
    const a = room(t, 'A');
    a.cmd({ type: 'submit_action', text: 'I look around.' });
    await t.turns.whenIdle(a.roomId);
    const b = room(t, 'B');
    const calls = llm.calls.length;
    b.cmd({ type: 'submit_action', text: 'Hello?' });
    await t.turns.whenIdle(b.roomId);
    expect(llm.calls.length).toBe(calls);
    expect(t.turns.status(b.roomId).error).toMatch(/server's daily AI budget/);
    const draft = await t.app.inject({ method: 'POST', url: '/api/setting-draft', payload: { description: 'A world of floating islands and sky whales.' } });
    expect(draft.statusCode).toBe(502);
    expect(draft.json().error).toMatch(/server's daily AI budget/);
  });
});

describe('turn-rate limit', () => {
  it('holds the 3rd turn in a minute and says when it resumes', async () => {
    const { t, llm } = await setup({ turnsPerMinute: 2 });
    const r = room(t);
    for (const text of ['one', 'two', 'three']) {
      r.cmd({ type: 'submit_action', text });
      await t.turns.whenIdle(r.roomId);
    }
    expect(llm.calls.filter((c) => c.purpose === 'gm_adjudicate')).toHaveLength(2);
    expect(t.turns.status(r.roomId)).toMatchObject({ status: 'paused', error: expect.stringMatching(/at most 2 turns a minute; resuming in \d+ s/) });
    expect(t.store.getState(r.roomId).turn.pending.map((a) => a.text)).toEqual(['three']);
  });
});
