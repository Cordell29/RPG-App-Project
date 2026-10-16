import {
  type GameEvent,
  type GameState,
  CONDITIONS,
  apply,
  needsRebuild,
  replay,
} from '../src/index.ts';
import { FANTASY, Log, makeCharacter } from './fixtures.ts';

/** Small seeded PRNG (mulberry32). Test-only: production randomness lives on the server. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}

/**
 * Generates `count` random events, each valid against the state at that point.
 * Covers every event type, including turn cycles and voids.
 */
export function randomEvents(count: number, seed: number, opts: { voids?: boolean } = {}): GameEvent[] {
  const r = rng(seed);
  const log = new Log();
  let state: GameState = replay([]);
  let idCounter = 0;
  const id = (p: string) => `${p}${++idCounter}`;
  let lastDoneTurn: string | null = null;

  const push: Log['push'] = (type, payload, eventOpts) => {
    const event = log.push(type, payload, eventOpts);
    state = needsRebuild(event) ? replay(log.events) : apply(state, event);
    return event;
  };

  push('room_created', { name: 'Random', setting: FANTASY });
  push('start_set', { start: { title: 'Random Start', description: 'Somewhere.', hooks: ['Look around'], source: 'random' } });

  while (log.events.length < count) {
    const players = state.players;
    const active = players.filter((p) => p.active);
    const party = state.party;
    const turnId = state.turn.turnId;
    const resolving = state.turn.phase === 'resolving';
    const c = party.length ? r.pick(party) : undefined;
    const roll = r.int(0, 27);

    if (players.length < 2 || (players.length < 6 && roll === 0)) {
      const pid = id('p');
      push('player_joined', { player: { id: pid, displayName: `P ${pid}`, isHost: players.length === 0 } });
      continue;
    }
    const withoutChar = players.find((p) => !p.characterId);
    if (withoutChar) {
      push('character_created', {
        character: makeCharacter({ id: id('c'), playerId: withoutChar.id, name: `Hero ${idCounter}` }),
      });
      continue;
    }
    const pl = r.pick(players);
    const inTurn = { turnId: resolving ? turnId : null };

    switch (roll) {
      case 1:
        if (active.length > 2) push('player_left', { playerId: r.pick(active).id });
        else push('player_joined', { player: { id: pl.id, displayName: pl.displayName, isHost: pl.isHost } });
        break;
      case 2:
        push('character_edited', { characterId: c!.id, patch: { notes: `note ${idCounter++}` } });
        break;
      case 3: {
        const item = c!.inventory.length ? r.pick(c!.inventory) : undefined;
        if (item && r.chance(0.5)) push('item_equipped', { characterId: c!.id, instanceId: item.instanceId, equipped: r.chance(0.5) });
        else push('chat_message', { playerId: pl.id, text: 'hello' });
        break;
      }
      case 4:
        push('action_submitted', { playerId: pl.id, characterId: pl.characterId, text: 'I search the room' });
        break;
      case 5:
        if (!resolving) {
          const t = id('t');
          const seqs = state.turn.pending.filter(() => r.chance(0.8)).map((a) => a.seq);
          push('turn_started', { turnId: t, actionSeqs: seqs }, { turnId: t });
        } else {
          push('narration', { turnId: turnId!, text: 'Things happen.', gist: 'stuff' }, { turnId });
          lastDoneTurn = turnId;
        }
        break;
      case 6:
        push(
          'dice_rolled',
          {
            notation: '1d20+2',
            mode: 'normal',
            dice: [{ sides: 20, value: r.int(1, 20), dropped: false }],
            modifier: 2,
            total: 10,
          },
          inTurn,
        );
        break;
      case 7: {
        const amount = r.int(-15, 15);
        push('delta_applied', { delta: { type: 'modify_hp', characterId: c!.id, amount } }, inTurn);
        break;
      }
      case 8:
        push(
          'delta_applied',
          {
            delta: {
              type: 'add_item',
              characterId: c!.id,
              item: { instanceId: id('i'), name: 'Torch', qty: r.int(1, 10), equipped: false, tags: [] },
            },
          },
          inTurn,
        );
        break;
      case 9: {
        const item = c!.inventory.length ? r.pick(c!.inventory) : undefined;
        if (item)
          push(
            'delta_applied',
            { delta: { type: 'remove_item', characterId: c!.id, instanceId: item.instanceId, qty: r.int(1, item.qty) } },
            inTurn,
          );
        break;
      }
      case 10: {
        const amount = r.chance(0.5) ? r.int(0, 100) : 0 - r.int(0, c!.gold);
        push('delta_applied', { delta: { type: 'change_gold', characterId: c!.id, amount } }, inTurn);
        break;
      }
      case 11: {
        const to = r.pick(party);
        const item = c!.inventory.length ? r.pick(c!.inventory) : undefined;
        if (item && to.id !== c!.id)
          push(
            'delta_applied',
            {
              delta: {
                type: 'transfer_item',
                fromId: c!.id,
                toId: to.id,
                instanceId: item.instanceId,
                qty: r.int(1, item.qty),
                newInstanceId: id('i'),
              },
            },
            inTurn,
          );
        break;
      }
      case 12:
        push('delta_applied', { delta: { type: 'grant_xp', characterId: c!.id, amount: r.int(0, 200) } }, inTurn);
        break;
      case 13:
        push(
          'delta_applied',
          { delta: { type: 'set_condition', characterId: c!.id, condition: r.pick(CONDITIONS), on: r.chance(0.5) } },
          inTurn,
        );
        break;
      case 14:
        push('delta_applied', { delta: { type: 'set_flag', key: `flag_${r.int(0, 9)}`, value: r.int(0, 5) } }, inTurn);
        break;
      case 15:
        push(
          'delta_applied',
          {
            delta: {
              type: 'update_quest',
              key: `q${r.int(0, 4)}`,
              status: r.pick(['active', 'done', 'failed'] as const),
              note: 'progress',
            },
          },
          inTurn,
        );
        break;
      case 16:
        push(
          'delta_applied',
          { delta: { type: 'change_scene', locationKey: `loc${r.int(0, 5)}`, title: 'Somewhere', description: 'A place.' } },
          inTurn,
        );
        if (r.chance(0.3))
          push('delta_rejected', { tool: 'change_gold', input: { amount: 10000 }, reason: 'over cap' }, inTurn);
        break;
      case 17: {
        const assetId = id('a');
        const kind = r.pick(['portrait', 'scene', 'npc'] as const);
        const characterId = kind === 'portrait' ? c!.id : undefined;
        push('image_requested', { assetId, kind, subject: 'art', ...(characterId ? { characterId } : {}) }, inTurn);
        if (r.chance(0.2)) push('image_failed', { assetId, reason: 'mock failure' });
        else push('image_ready', { assetId, kind, ...(characterId ? { characterId } : {}) });
        if (r.chance(0.2)) push('audio_ready', { assetId: id('v'), narrationSeq: state.seq });
        break;
      }
      case 18:
        push('scene_changed', { scene: { locationKey: 'manual', title: 'Manual', description: '' } });
        push('chapter_closed', { chapterNo: idCounter, level: 0, fromSeq: 1, toSeq: state.seq, summary: 'A chapter.' });
        if (r.chance(0.5)) push('session_recap', { number: 1, text: 'Previously…' });
        break;
      case 19:
        push('host_override', {
          override: { kind: 'character', characterId: c!.id, patch: { gold: r.int(0, 50), hp: { max: r.int(5, 30) } } },
        });
        break;
      case 20:
        if (lastDoneTurn && !resolving && opts.voids !== false) {
          // Like the server: a void is only committed if the log still replays without it.
          try {
            push('turn_voided', { turnId: lastDoneTurn });
          } catch {
            log.events.pop();
          }
          lastDoneTurn = null;
        }
        break;
      case 21:
        push('campaign_imported', { sourceRoomName: 'x', sourceExportedAt: 'y', importedEventCount: 0 });
        break;
      case 22: {
        const p = state.turn.pending.length ? r.pick(state.turn.pending) : undefined;
        if (p && r.chance(0.5)) push('action_edited', { actionSeq: p.seq, text: 'I change my mind' });
        else if (p) push('action_withdrawn', { actionSeq: p.seq });
        break;
      }
      case 23:
        push('spotlight_set', { playerId: r.chance(0.7) ? r.pick(players).id : null });
        break;
      case 24:
        if (state.session.active) push('session_ended', { number: state.session.number });
        else push('session_started', { number: state.session.number + 1 });
        break;
      case 25: {
        const pending = state.pendingApprovals;
        if (pending.length && r.chance(0.6)) {
          push('approval_resolved', { approvalId: r.pick(pending).id, approved: r.chance(0.6) });
        } else {
          const ab = { id: id('ab'), name: 'Trick', description: 'Does a trick.', uses: { current: 2, max: 2 }, recharge: 'short_rest' as const };
          push('approval_requested', {
            approval: r.chance(0.5)
              ? { id: id('ap'), kind: 'ability', characterId: c!.id, ability: ab, reason: 'workshop', requestedBy: 'player' }
              : {
                  id: id('ap'),
                  kind: 'item',
                  characterId: c!.id,
                  item: { instanceId: id('i'), name: 'Magic ring', qty: 1, equipped: false, tags: [], slot: 'other', effects: { acBonus: 2 } },
                  reason: 'loot',
                  requestedBy: 'gm',
                },
          });
        }
        break;
      }
      case 26: {
        const withUses = c!.abilities.find((a) => a.uses && a.uses.current > 0);
        const slotLevel = c!.spellSlots.findIndex((x) => x.current > 0);
        if (withUses) push('delta_applied', { delta: { type: 'use_ability', characterId: c!.id, abilityId: withUses.id } }, inTurn);
        else if (slotLevel >= 0) push('delta_applied', { delta: { type: 'spend_spell_slot', characterId: c!.id, level: slotLevel + 1 } }, inTurn);
        else push('host_override', { override: { kind: 'spell_slots', characterId: c!.id, slots: [{ current: 2, max: 2 }] } });
        break;
      }
      case 27:
        if (c!.meters.spirit) {
          push('delta_applied', { delta: { type: 'adjust_meter', characterId: c!.id, meter: 'spirit', amount: r.int(-3, 3) } }, inTurn);
        } else if (r.chance(0.5)) {
          push('host_override', { override: { kind: 'meter', characterId: c!.id, meter: 'spirit', current: 3 } });
        } else {
          push('delta_applied', { delta: { type: 'rest', kind: r.chance(0.5) ? 'short' : 'long', characterIds: [c!.id] } }, inTurn);
        }
        break;
    }
  }
  return log.events.slice(0, count);
}
