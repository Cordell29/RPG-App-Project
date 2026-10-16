import { type CharacterCreateInput, STAT_ROLL_NOTATION } from '@tavern/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { players } from '../src/db/schema.ts';
import { startServer } from './harness.ts';

let s: Awaited<ReturnType<typeof startServer>>;
beforeEach(async () => {
  s = await startServer();
});
afterEach(async () => {
  await s.close();
});

const fighter = (over: Partial<CharacterCreateInput> = {}): CharacterCreateInput => ({
  name: 'Ayla',
  ancestry: 'Human',
  className: 'Fighter',
  roleName: 'Fighter',
  statMethod: 'standard',
  stats: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 },
  visualDescriptor: 'tall, red braid',
  notes: '',
  ...over,
});

async function tableWithCharacters() {
  const room = await s.createRoom();
  const bea = await s.join(room.roomId, 'Bea');
  const host = await s.client(room);
  const guest = await s.client(bea);
  expect(await host.send({ type: 'create_character', character: fighter({ name: 'Hostia' }) })).toMatchObject({ ok: true });
  expect(await guest.send({ type: 'create_character', character: fighter({ name: 'Bram', roleName: 'Rogue', className: 'Rogue' }) })).toMatchObject({ ok: true });
  await host.until(() => host.state.party.length === 2);
  await guest.until(() => guest.state.party.length === 2);
  const hostChar = host.state.party.find((c) => c.name === 'Hostia')!;
  const guestChar = host.state.party.find((c) => c.name === 'Bram')!;
  return { room, bea, host, guest, hostChar, guestChar };
}

describe('character creation', () => {
  it('builds a level-1 character from a preset role and links the player', async () => {
    const room = await s.createRoom();
    const host = await s.client(room);
    const res = await host.send({ type: 'create_character', character: fighter() });
    expect(res.ok).toBe(true);
    await host.until(() => host.state.party.length === 1);
    const c = host.state.party[0]!;
    expect(c).toMatchObject({ name: 'Ayla', class: 'Fighter', level: 1, hp: { current: 12, max: 12 }, ac: 11, gold: 10 });
    expect(c.inventory.map((i) => i.name)).toContain('Longsword');
    expect(host.state.players[0]!.characterId).toBe(c.id);
    const row = s.t.rooms['db'].select().from(players).all()[0]!;
    expect(row.characterId).toBe(c.id);
  });

  it('allows one character per player', async () => {
    const room = await s.createRoom();
    const host = await s.client(room);
    await host.send({ type: 'create_character', character: fighter() });
    expect(await host.send({ type: 'create_character', character: fighter({ name: 'Again' }) })).toEqual({
      ok: false,
      error: 'You already have a character.',
    });
  });

  it('rejects stats that break the chosen method', async () => {
    const room = await s.createRoom();
    const host = await s.client(room);
    const bad = await host.send({
      type: 'create_character',
      character: fighter({ stats: { str: 18, dex: 18, con: 18, int: 18, wis: 18, cha: 18 } }),
    });
    expect(bad).toEqual({ ok: false, error: 'Use each standard array score once: 15, 14, 13, 12, 10, 8.' });
    const pb = await host.send({
      type: 'create_character',
      character: fighter({ statMethod: 'pointbuy', stats: { str: 15, dex: 15, con: 15, int: 15, wis: 8, cha: 8 } }),
    });
    expect(pb).toMatchObject({ ok: false, error: expect.stringMatching(/36 points/) });
    expect(s.t.store.getState(room.roomId).party).toHaveLength(0);
  });

  it('rolled stats: six visible server rolls, once per player, used exactly', async () => {
    const room = await s.createRoom();
    const bea = await s.join(room.roomId, 'Bea');
    const host = await s.client(room);
    const guest = await s.client(bea);
    expect(await guest.send({ type: 'create_character', character: fighter({ statMethod: 'rolled' }) })).toEqual({
      ok: false,
      error: 'Roll your scores first.',
    });
    const rolled = await guest.send({ type: 'roll_stats' });
    expect(rolled).toMatchObject({ ok: true, seqs: expect.arrayContaining([expect.any(Number)]) });
    await host.until(() => host.log.events.filter((e) => e.type === 'dice_rolled').length === 6);
    const pool = host.log.events
      .filter((e) => e.type === 'dice_rolled' && e.payload.notation === STAT_ROLL_NOTATION)
      .map((e) => (e.type === 'dice_rolled' ? e.payload.total : 0));
    expect(pool).toHaveLength(6);
    expect(await guest.send({ type: 'roll_stats' })).toMatchObject({ ok: false, error: expect.stringMatching(/already rolled/) });

    // The host's own pool is separate: guest's rolls do not count for the host.
    expect(await host.send({ type: 'create_character', character: fighter({ statMethod: 'rolled' }) })).toMatchObject({ ok: false });

    const [a, b, c, d, e, f] = pool as [number, number, number, number, number, number];
    const wrong = await guest.send({
      type: 'create_character',
      character: fighter({ statMethod: 'rolled', stats: { str: 18, dex: b, con: c, int: d, wis: e, cha: f } }),
    });
    expect(wrong.ok).toBe(a === 18);
    if (!wrong.ok) {
      const right = await guest.send({
        type: 'create_character',
        character: fighter({ statMethod: 'rolled', stats: { str: f, dex: e, con: d, int: c, wis: b, cha: a } }),
      });
      expect(right).toMatchObject({ ok: true });
    }
  });

  it('describe-your-own drafts need a seat token and produce valid input', async () => {
    const room = await s.createRoom();
    const noAuth = await s.post('/api/rooms/' + room.roomId + '/character-draft', { description: 'A gruff dwarf smith' });
    expect(noAuth.status).toBe(401);
    const res = await s.post<CharacterCreateInput>(
      `/api/rooms/${room.roomId}/character-draft`,
      { description: 'Thorga, a gruff dwarf smith who left her forge to find her missing brother.' },
      { authorization: `Bearer ${room.token}` },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Thorga', statMethod: 'standard', roleName: 'Fighter' });
    expect(s.llm.calls.at(-1)).toMatchObject({ purpose: 'character_draft', tier: 'summary' });
    expect(s.llm.calls.at(-1)!.system).toContain('Strength'); // preset stat labels reach the prompt
    const host = await s.client(room);
    expect(await host.send({ type: 'create_character', character: res.body })).toMatchObject({ ok: true });
  });
});

describe('who can change what', () => {
  it('a player cannot change their own HP or gold', async () => {
    const { guest, guestChar } = await tableWithCharacters();
    const before = structuredClone(guest.state.party.find((c) => c.id === guestChar.id));
    const viaEdit = await guest.send({
      type: 'edit_character',
      characterId: guestChar.id,
      patch: { gold: 9999, hp: { current: 99, max: 99 } } as never,
    });
    expect(viaEdit.ok).toBe(false);
    const viaOverride = await guest.send({
      type: 'host_override',
      override: { kind: 'character', characterId: guestChar.id, patch: { gold: 9999, hp: { current: 99, max: 99 } } },
    });
    expect(viaOverride).toEqual({ ok: false, error: 'Only the host can do that.' });
    const viaRoll = await guest.send({ type: 'roll_stats' });
    expect(viaRoll).toEqual({ ok: false, error: 'You already have a character.' });
    expect(s.t.store.getState(guest.creds.roomId).party.find((c) => c.id === guestChar.id)).toEqual(before);
  });

  it('players edit their own name, notes and look; not someone else’s', async () => {
    const { guest, guestChar, hostChar } = await tableWithCharacters();
    expect(await guest.send({ type: 'edit_character', characterId: guestChar.id, patch: { notes: 'Afraid of geese.' } })).toMatchObject({ ok: true });
    expect(await guest.send({ type: 'edit_character', characterId: hostChar.id, patch: { name: 'Lol' } })).toEqual({
      ok: false,
      error: 'You can only change your own character.',
    });
    await guest.until(() => guest.state.party.find((c) => c.id === guestChar.id)!.notes === 'Afraid of geese.');
  });

  it('players equip their own items only', async () => {
    const { guest, guestChar, hostChar } = await tableWithCharacters();
    const item = guestChar.inventory[0]!;
    expect(await guest.send({ type: 'equip_item', characterId: guestChar.id, instanceId: item.instanceId, equipped: true })).toMatchObject({ ok: true });
    await guest.until(() => guest.state.party.find((c) => c.id === guestChar.id)!.inventory[0]!.equipped);
    const theirs = hostChar.inventory[0]!;
    expect((await guest.send({ type: 'equip_item', characterId: hostChar.id, instanceId: theirs.instanceId, equipped: true })).ok).toBe(false);
  });

  it('a host override appears on every client within 1 s', async () => {
    const { host, guest, guestChar } = await tableWithCharacters();
    const sentAt = performance.now();
    const res = await host.send({
      type: 'host_override',
      override: { kind: 'character', characterId: guestChar.id, patch: { gold: 250, hp: { current: 5 }, stats: { str: 17 } } },
      reason: 'Found a treasure chest',
    });
    expect(res.ok).toBe(true);
    for (const c of [host, guest]) {
      await c.until(() => c.state.party.find((x) => x.id === guestChar.id)!.gold === 250, 1000);
      const arrival = c.arrivals.find((a) => a.event.type === 'host_override')!;
      expect(arrival.at - sentAt).toBeLessThan(1000);
      expect(c.state.party.find((x) => x.id === guestChar.id)).toMatchObject({ gold: 250, hp: { current: 5, max: 12 }, stats: { str: 17 } });
    }
  });

  it('host item overrides add, update and remove; bad ones fail cleanly', async () => {
    const { host, guest, guestChar } = await tableWithCharacters();
    const add = await host.send({
      type: 'host_override',
      override: {
        kind: 'add_item',
        characterId: guestChar.id,
        item: { instanceId: 'gift-1', name: 'Potion of Healing', qty: 2, equipped: false, tags: ['consumable'] },
      },
    });
    expect(add.ok).toBe(true);
    await guest.until(() => guest.state.party.find((c) => c.id === guestChar.id)!.inventory.some((i) => i.instanceId === 'gift-1'));
    const bad = await host.send({
      type: 'host_override',
      override: { kind: 'remove_item', characterId: guestChar.id, instanceId: 'gift-1', qty: 5 },
    });
    expect(bad).toEqual({ ok: false, error: `only 2 of gift-1 on ${guestChar.id}` });
    const ghost = await host.send({
      type: 'host_override',
      override: { kind: 'character', characterId: 'nobody', patch: { gold: 1 } },
    });
    expect(ghost).toEqual({ ok: false, error: 'unknown character nobody' });
  });
});
