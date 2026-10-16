import { getPreset } from '@tavern/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type TavernApp, buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { RateLimiter } from '../src/limits.ts';
import { devMockProvider } from '../src/llm/devMock.ts';
import { TunnelWatcher } from '../src/tunnel.ts';
import { testDb, tmpDir } from './helpers.ts';

let apps: TavernApp[] = [];
afterEach(async () => {
  for (const t of apps) {
    t.io.close();
    await t.app.close();
  }
  apps = [];
});

async function setup(extra: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const t = await buildApp({ dataDir: tmpDir(), db: testDb(), llm: devMockProvider(), rulesLookup: false, ...extra });
  apps.push(t);
  return t;
}
const roomBody = (name = 'R') => ({ roomName: name, hostName: 'H', setting: getPreset('fantasy'), mode: 'group' });

describe('rate limits', () => {
  it('sliding window', () => {
    let now = 0;
    const rl = new RateLimiter(2, 1000, () => now);
    expect([rl.hit('a'), rl.hit('a'), rl.hit('b')]).toEqual([0, 0, 0]);
    expect(rl.hit('a')).toBe(1000);
    now = 600;
    expect(rl.hit('a')).toBe(400);
    now = 1001;
    expect(rl.hit('a')).toBe(0);
  });

  it('per-IP limits on room creation use CF-Connecting-IP behind the tunnel', async () => {
    const t = await setup({ httpLimits: { createRoom: 2 } });
    const post = (ip: string) => t.app.inject({ method: 'POST', url: '/api/rooms', payload: roomBody(), headers: { 'cf-connecting-ip': ip } });
    expect((await post('1.1.1.1')).statusCode).toBe(200);
    expect((await post('1.1.1.1')).statusCode).toBe(200);
    const third = await post('1.1.1.1');
    expect(third.statusCode).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();
    expect(third.json().error).toMatch(/Too many requests/);
    expect((await post('2.2.2.2')).statusCode).toBe(200); // a different friend is unaffected
  });
});

describe('security headers', () => {
  it('no referrer, no framing, no sniffing; API responses are not cached', async () => {
    const t = await setup();
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const api = await t.app.inject({ method: 'GET', url: '/api/presets' });
    expect(api.headers['cache-control']).toBe('no-store');
  });
});

describe('secrets', () => {
  it('keys are read from the environment only and never appear in any API response', async () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-test-SECRET', GEMINI_API_KEY: 'AIzaTESTSECRET' } as NodeJS.ProcessEnv);
    expect(config.anthropic?.apiKey).toBe('sk-ant-test-SECRET');
    const t = await setup();
    const r = (await t.app.inject({ method: 'POST', url: '/api/rooms', payload: roomBody() })).json() as { roomId: string; token: string };
    const bodies = await Promise.all(
      ['/api/presets', `/api/rooms/${r.roomId}`, `/api/rooms/${r.roomId}/seats`, `/api/rooms/${r.roomId}/spend`].map((url) =>
        t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${r.token}` } }).then((x) => x.body),
      ),
    );
    for (const b of bodies) expect(b).not.toMatch(/sk-ant|AIza/);
  });
});

describe('public link (Cloudflare Quick Tunnel)', () => {
  it('reads the hostname from cloudflared metrics, announces changes once, and posts the share webhook', async () => {
    let host = 'brave-otter.trycloudflare.com';
    const posts: string[] = [];
    const changes: (string | null)[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/quicktunnel')) return new Response(JSON.stringify({ hostname: host }));
      posts.push(String(init?.body));
      return new Response('ok');
    }) as typeof fetch;
    const w = new TunnelWatcher({ metricsUrl: 'http://cloudflared:2000/quicktunnel', webhookUrl: 'https://discord.example/hook', fetch: fakeFetch, onChange: (u) => changes.push(u) });
    expect(await w.poll()).toBe('https://brave-otter.trycloudflare.com');
    await w.poll();
    host = 'quiet-heron.trycloudflare.com'; // tunnel restarted
    expect(await w.poll()).toBe('https://quiet-heron.trycloudflare.com');
    expect(changes).toEqual(['https://brave-otter.trycloudflare.com', 'https://quiet-heron.trycloudflare.com']);
    expect(posts).toEqual([JSON.stringify({ content: 'Tavern is online at https://brave-otter.trycloudflare.com' }), JSON.stringify({ content: 'Tavern is online at https://quiet-heron.trycloudflare.com' })]);
  });

  it('ignores garbage and unreachable metrics; PUBLIC_URL wins without polling', async () => {
    const bad = new TunnelWatcher({ metricsUrl: 'http://x/quicktunnel', fetch: (async () => new Response(JSON.stringify({ hostname: 'not a host!' }))) as typeof fetch });
    expect(await bad.poll()).toBeNull();
    const down = new TunnelWatcher({ metricsUrl: 'http://x/quicktunnel', fetch: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch });
    expect(await down.poll()).toBeNull();
    expect(new TunnelWatcher({ publicUrl: 'https://tavern.example.com/' }).current).toBe('https://tavern.example.com');
  });
});

describe('rejoin after a link change', () => {
  it('a returning player picks their character, the host approves, and the player gets a fresh seat once', async () => {
    const t = await setup();
    const r = t.rooms.createRoom({ roomName: 'R', hostName: 'Cordell', setting: getPreset('fantasy')!, mode: 'group' });
    const bea = t.rooms.joinRoom(r.roomId, 'Bea');
    const guest = t.rooms.authenticate(r.roomId, bea.token)!;
    const fighter = { name: 'Bram', ancestry: 'Human', className: 'Fighter', roleName: 'Fighter', statMethod: 'standard', stats: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, skills: ['athletics', 'perception'], saves: [], visualDescriptor: '', notes: '' };
    t.commands.execute(guest, { commandId: 'bea-create-1', type: 'create_character', character: fighter });
    const bram = t.store.getState(r.roomId).party[0]!;

    const seats = (await t.app.inject({ method: 'GET', url: `/api/rooms/${r.roomId}/seats` })).json();
    expect(seats).toEqual([{ characterId: bram.id, characterName: 'Bram', playerName: 'Bea' }]);

    const req = (await t.app.inject({ method: 'POST', url: `/api/rooms/${r.roomId}/rejoin`, payload: { characterId: bram.id } })).json() as { requestId: string; secret: string };
    const poll = () => t.app.inject({ method: 'GET', url: `/api/rooms/${r.roomId}/rejoin/${req.requestId}?secret=${req.secret}` });
    expect((await poll()).json()).toEqual({ status: 'pending' });
    expect(t.rejoin.pending(r.roomId)).toEqual([expect.objectContaining({ characterName: 'Bram', playerName: 'Bea' })]);
    // A wrong secret learns nothing.
    expect((await t.app.inject({ method: 'GET', url: `/api/rooms/${r.roomId}/rejoin/${req.requestId}?secret=${'x'.repeat(32)}` })).statusCode).toBe(404);

    // Only the host decides.
    expect(t.commands.execute(guest, { commandId: 'bea-approve-1', type: 'resolve_rejoin', requestId: req.requestId, approve: true })).toEqual({ ok: false, error: 'Only the host can do that.' });
    const host = t.rooms.authenticate(r.roomId, r.token)!;
    expect(t.commands.execute(host, { commandId: 'host-approve-1', type: 'resolve_rejoin', requestId: req.requestId, approve: true })).toMatchObject({ ok: true });

    const done = (await poll()).json() as { status: string; creds: { playerId: string; token: string } };
    expect(done.status).toBe('approved');
    expect(t.rooms.authenticate(r.roomId, done.creds.token)).toMatchObject({ playerId: bea.playerId });
    expect(t.rooms.authenticate(r.roomId, bea.token)).toBeNull(); // the old device is signed out
    expect((await poll()).statusCode).toBe(404); // handed out once
  });

  it('host seats are not claimable this way; denied requests say so', async () => {
    const t = await setup();
    const r = t.rooms.createRoom({ roomName: 'R', hostName: 'Cordell', setting: getPreset('fantasy')!, mode: 'solo' });
    const host = t.rooms.authenticate(r.roomId, r.token)!;
    const fighter = { name: 'Ayla', ancestry: 'Human', className: 'Fighter', roleName: 'Fighter', statMethod: 'standard', stats: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, skills: ['athletics', 'perception'], saves: [], visualDescriptor: '', notes: '' };
    t.commands.execute(host, { commandId: 'host-create-1', type: 'create_character', character: fighter });
    const ayla = t.store.getState(r.roomId).party[0]!;
    const res = await t.app.inject({ method: 'POST', url: `/api/rooms/${r.roomId}/rejoin`, payload: { characterId: ayla.id } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/host link/);
  });
});
