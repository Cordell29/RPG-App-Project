import type { AppliedDelta } from './deltas.ts';
import type { EventOf, GameEvent, HostOverride } from './events.ts';
import { METER_ZERO_CONDITION, type MeterKey } from './constants.ts';
import { hpPerLevel, levelForXp } from './rules.ts';
import { type Character, type GameState, initialState } from './state.ts';

export class ReducerError extends Error {
  readonly event?: { seq: number; type: string };

  constructor(message: string, event?: { seq: number; type: string }) {
    super(event ? `[seq ${event.seq} ${event.type}] ${message}` : message);
    this.name = 'ReducerError';
    this.event = event;
  }
}

export interface ApplyOptions {
  /** 'throw' (default; tests, imports) or 'skip' (production: log and advance seq). */
  unknown?: 'throw' | 'skip';
  onUnknown?: (event: { seq: number; type: string }) => void;
}

/**
 * Pure, deterministic fold step: no clock, no randomness, no I/O.
 * Throws ReducerError when an event breaks an invariant, so a bad log can never
 * produce a state silently (imports refuse, the store aborts the transaction).
 *
 * turn_voided only records the void; the state is rolled back by replay(), which
 * skips the voided turn's events. Callers check needsRebuild() after apply().
 */
export function apply(state: GameState, event: GameEvent, options: ApplyOptions = {}): GameState {
  if (event.seq !== state.seq + 1) {
    throw new ReducerError(`expected seq ${state.seq + 1}`, event);
  }
  if (state.seq === 0 && event.type !== 'room_created') {
    throw new ReducerError('first event must be room_created', event);
  }

  const s = structuredClone(state);
  s.seq = event.seq;

  if (event.turnId && event.type !== 'turn_voided' && s.voidedTurnIds.includes(event.turnId)) {
    return s;
  }

  const fail = (msg: string): never => {
    throw new ReducerError(msg, event);
  };
  const getChar = (id: string): Character =>
    s.party.find((c) => c.id === id) ?? fail(`unknown character ${id}`);

  switch (event.type) {
    case 'room_created':
      if (state.seq !== 0) fail('room_created must be the first event');
      s.roomName = event.payload.name;
      s.setting = event.payload.setting;
      break;

    case 'player_joined': {
      const { id, displayName, isHost } = event.payload.player;
      const existing = s.players.find((p) => p.id === id);
      if (existing) {
        existing.active = true;
        existing.displayName = displayName;
      } else {
        s.players.push({ id, displayName, isHost, characterId: null, active: true });
      }
      break;
    }

    case 'player_left': {
      const p = s.players.find((x) => x.id === event.payload.playerId) ?? fail('unknown player');
      p.active = false;
      break;
    }

    case 'character_created': {
      const c = event.payload.character;
      if (s.party.some((x) => x.id === c.id)) fail(`character ${c.id} already exists`);
      const p = s.players.find((x) => x.id === c.playerId) ?? fail(`unknown player ${c.playerId}`);
      s.party.push(structuredClone(c));
      p.characterId = c.id;
      break;
    }

    case 'character_edited':
      Object.assign(getChar(event.payload.characterId), event.payload.patch);
      break;

    case 'item_equipped': {
      const { characterId, instanceId, equipped } = event.payload;
      findItem(getChar(characterId), instanceId, fail).equipped = equipped;
      break;
    }

    case 'action_submitted': {
      const { playerId, characterId, text } = event.payload;
      if (!s.players.some((p) => p.id === playerId)) fail(`unknown player ${playerId}`);
      s.turn.pending.push({ seq: event.seq, playerId, characterId, text });
      if (s.turn.phase === 'idle') s.turn.phase = 'collecting';
      break;
    }

    case 'action_edited': {
      const a = s.turn.pending.find((x) => x.seq === event.payload.actionSeq) ?? fail(`action ${event.payload.actionSeq} is not pending`);
      a.text = event.payload.text;
      break;
    }

    case 'action_withdrawn': {
      const { actionSeq } = event.payload;
      if (!s.turn.pending.some((x) => x.seq === actionSeq)) fail(`action ${actionSeq} is not pending`);
      s.turn.pending = s.turn.pending.filter((x) => x.seq !== actionSeq);
      if (s.turn.phase === 'collecting' && s.turn.pending.length === 0) s.turn.phase = 'idle';
      break;
    }

    case 'spotlight_set': {
      const id = event.payload.playerId;
      if (id !== null && !s.players.some((p) => p.id === id)) fail(`unknown player ${id}`);
      s.spotlight = id;
      break;
    }

    case 'session_started':
      s.session = { number: event.payload.number, active: true };
      break;

    case 'session_ended':
      s.session = { number: event.payload.number, active: false };
      break;

    case 'approval_requested':
      s.pendingApprovals.push(structuredClone(event.payload.approval));
      break;

    case 'approval_resolved': {
      const { approvalId, approved, item, ability } = event.payload;
      const ap = s.pendingApprovals.find((a) => a.id === approvalId) ?? fail(`unknown approval ${approvalId}`);
      s.pendingApprovals = s.pendingApprovals.filter((a) => a !== ap);
      if (approved) {
        const c = getChar(ap.characterId);
        if (ap.kind === 'item') addItem(s, c, item ?? ap.item ?? fail('approval has no item'), fail);
        else c.abilities.push(structuredClone(ability ?? ap.ability ?? fail('approval has no ability')));
      }
      break;
    }

    case 'turn_started': {
      if (s.turn.phase === 'resolving') fail('a turn is already resolving');
      const wanted = new Set(event.payload.actionSeqs);
      for (const seq of wanted) {
        if (!s.turn.pending.some((a) => a.seq === seq)) fail(`action ${seq} is not pending`);
      }
      s.turn.resolving = s.turn.pending.filter((a) => wanted.has(a.seq));
      s.turn.pending = s.turn.pending.filter((a) => !wanted.has(a.seq));
      s.turn.number += 1;
      s.turn.phase = 'resolving';
      s.turn.turnId = event.payload.turnId;
      break;
    }

    case 'narration':
      if (s.turn.turnId === event.payload.turnId) {
        s.turn.turnId = null;
        s.turn.resolving = [];
        s.turn.phase = s.turn.pending.length ? 'collecting' : 'idle';
      }
      break;

    case 'delta_applied':
      applyDelta(s, event.payload.delta, getChar, fail);
      break;

    case 'scene_changed':
      s.scene = structuredClone(event.payload.scene);
      break;

    case 'image_ready': {
      const { kind, assetId, characterId } = event.payload;
      if (kind === 'portrait') getChar(characterId ?? fail('portrait needs characterId')).portraitAssetId = assetId;
      else if (kind === 'scene') s.scene.imageAssetId = assetId;
      break;
    }

    case 'host_override':
      applyOverride(s, event.payload.override, getChar, fail);
      break;

    case 'turn_voided':
      if (!s.voidedTurnIds.includes(event.payload.turnId)) s.voidedTurnIds.push(event.payload.turnId);
      break;

    // Log-only events: they matter to the transcript, chronicle and UI, not to state.
    case 'chat_message':
    case 'dice_rolled':
    case 'delta_rejected':
    case 'image_requested':
    case 'chapter_closed':
    case 'session_recap':
    case 'image_failed':
    case 'audio_ready':
    case 'campaign_imported':
      break;

    default: {
      const unknown = event as { seq: number; type: string };
      if (options.unknown === 'skip') {
        options.onUnknown?.(unknown);
        break;
      }
      throw new ReducerError(`unknown event type "${unknown.type}"`, unknown);
    }
  }
  return s;
}

type GetChar = (id: string) => Character;
type Fail = (msg: string) => never;

function findItem(c: Character, instanceId: string, fail: Fail) {
  return c.inventory.find((i) => i.instanceId === instanceId) ?? fail(`item ${instanceId} not found on ${c.id}`);
}

function addItem(s: GameState, c: Character, item: Character['inventory'][number], fail: Fail) {
  const taken = s.party.some((x) => x.inventory.some((i) => i.instanceId === item.instanceId));
  if (taken) fail(`item instance ${item.instanceId} already exists`);
  c.inventory.push(structuredClone(item));
}

function takeItem(c: Character, instanceId: string, qty: number, fail: Fail) {
  const item = findItem(c, instanceId, fail);
  if (item.qty < qty) fail(`only ${item.qty} of ${instanceId} on ${c.id}`);
  item.qty -= qty;
  if (item.qty === 0) c.inventory = c.inventory.filter((i) => i !== item);
  return item;
}

function applyDelta(s: GameState, d: AppliedDelta, getChar: GetChar, fail: Fail) {
  switch (d.type) {
    case 'modify_hp': {
      const c = getChar(d.characterId);
      c.hp.current = Math.max(0, Math.min(c.hp.max, c.hp.current + d.amount));
      break;
    }
    case 'add_item':
      addItem(s, getChar(d.characterId), d.item, fail);
      break;
    case 'remove_item':
      takeItem(getChar(d.characterId), d.instanceId, d.qty, fail);
      break;
    case 'change_gold': {
      const c = getChar(d.characterId);
      if (c.gold + d.amount < 0) fail(`gold would drop below 0 for ${c.id}`);
      c.gold += d.amount;
      break;
    }
    case 'transfer_item': {
      const from = getChar(d.fromId);
      const to = getChar(d.toId);
      if (from === to) fail('cannot transfer to the same character');
      const item = takeItem(from, d.instanceId, d.qty, fail);
      addItem(s, to, { ...item, instanceId: d.newInstanceId, qty: d.qty, equipped: false }, fail);
      break;
    }
    case 'grant_xp': {
      const c = getChar(d.characterId);
      c.xp += d.amount;
      const level = Math.max(c.level, levelForXp(c.xp));
      const gained = level - c.level;
      if (gained > 0) {
        const hp = gained * hpPerLevel(c.stats.con);
        c.level = level;
        c.hp.max += hp;
        c.hp.current += hp;
      }
      break;
    }
    case 'set_condition': {
      const c = getChar(d.characterId);
      const has = c.conditions.includes(d.condition);
      if (d.on && !has) c.conditions.push(d.condition);
      if (!d.on && has) c.conditions = c.conditions.filter((x) => x !== d.condition);
      break;
    }
    case 'set_flag':
      s.flags[d.key] = d.value;
      break;
    case 'update_quest': {
      let q = s.quests.find((x) => x.key === d.key);
      if (!q) {
        q = { key: d.key, title: d.title ?? d.key, status: 'active', notes: [] };
        s.quests.push(q);
      } else if (d.title) {
        q.title = d.title;
      }
      if (d.status) q.status = d.status;
      if (d.note) q.notes.push(d.note);
      break;
    }
    case 'change_scene':
      s.scene = { locationKey: d.locationKey, title: d.title, description: d.description };
      break;
    case 'adjust_meter':
      setMeter(getChar(d.characterId), d.meter, (cur) => cur + d.amount, fail);
      break;
    case 'use_ability': {
      const a = getChar(d.characterId).abilities.find((x) => x.id === d.abilityId) ?? fail(`unknown ability ${d.abilityId}`);
      if (a.uses) {
        if (a.uses.current <= 0) fail(`${a.name} has no uses left`);
        a.uses.current -= 1;
      }
      break;
    }
    case 'spend_spell_slot': {
      const slot = getChar(d.characterId).spellSlots[d.level - 1];
      if (!slot || slot.current <= 0) fail(`no level ${d.level} slot left`);
      slot!.current -= 1;
      break;
    }
    case 'rest':
      for (const id of d.characterIds) {
        const c = getChar(id);
        for (const a of c.abilities) {
          if (a.uses && (a.recharge === 'short_rest' || d.kind === 'long')) a.uses.current = a.uses.max;
        }
        if (d.kind === 'long') {
          c.hp.current = c.hp.max;
          for (const slot of c.spellSlots) slot.current = slot.max;
          if (c.meters.spirit) setMeter(c, 'spirit', (cur) => cur + 1, fail);
        }
      }
      break;
    case 'upsert_canon':
      // Canon is projected into its own table by the server; not part of GameState.
      break;
  }
}

/** Clamps a meter to 0…max and keeps its zero-condition (shaken / unprepared) in step. */
function setMeter(c: Character, meter: MeterKey, next: (current: number) => number, fail: Fail) {
  const m = c.meters[meter] ?? fail(`${c.name} has no ${meter} meter`);
  m.current = Math.max(0, Math.min(m.max, next(m.current)));
  const cond = METER_ZERO_CONDITION[meter];
  const has = c.conditions.includes(cond);
  if (m.current === 0 && !has) c.conditions.push(cond);
  if (m.current > 0 && has) c.conditions = c.conditions.filter((x) => x !== cond);
}

function applyOverride(s: GameState, o: HostOverride, getChar: GetChar, fail: Fail) {
  switch (o.kind) {
    case 'character': {
      const c = getChar(o.characterId);
      const { hp, stats, ...rest } = o.patch;
      Object.assign(c, rest);
      if (stats) Object.assign(c.stats, stats);
      if (hp) Object.assign(c.hp, hp);
      c.hp.current = Math.min(c.hp.current, c.hp.max);
      break;
    }
    case 'add_item':
      addItem(s, getChar(o.characterId), o.item, fail);
      break;
    case 'remove_item':
      takeItem(getChar(o.characterId), o.instanceId, o.qty, fail);
      break;
    case 'update_item':
      Object.assign(findItem(getChar(o.characterId), o.instanceId, fail), o.patch);
      break;
    case 'add_ability': {
      const c = getChar(o.characterId);
      if (c.abilities.some((a) => a.id === o.ability.id)) fail(`ability ${o.ability.id} already exists`);
      c.abilities.push(structuredClone(o.ability));
      break;
    }
    case 'update_ability': {
      const a = getChar(o.characterId).abilities.find((x) => x.id === o.abilityId) ?? fail(`unknown ability ${o.abilityId}`);
      Object.assign(a, structuredClone(o.patch));
      break;
    }
    case 'remove_ability': {
      const c = getChar(o.characterId);
      if (!c.abilities.some((a) => a.id === o.abilityId)) fail(`unknown ability ${o.abilityId}`);
      c.abilities = c.abilities.filter((a) => a.id !== o.abilityId);
      break;
    }
    case 'spell_slots':
      getChar(o.characterId).spellSlots = o.slots.map((x) => ({ max: x.max, current: Math.min(x.current, x.max) }));
      break;
    case 'meter': {
      const c = getChar(o.characterId);
      c.meters[o.meter] ??= { current: 5, max: 5 };
      setMeter(c, o.meter, () => o.current, fail);
      break;
    }
    case 'proficiencies':
      getChar(o.characterId).proficiencies = { skills: [...o.skills], saves: [...o.saves] };
      break;
    case 'setting':
      s.setting = structuredClone(o.setting);
      break;
    case 'scene':
      s.scene = structuredClone(o.scene);
      break;
    case 'flag':
      if (o.value === null) delete s.flags[o.key];
      else s.flags[o.key] = o.value;
      break;
  }
}

/** True when an incrementally-applied event requires a full replay to be correct. */
export function needsRebuild(event: GameEvent): event is EventOf<'turn_voided'> {
  return event.type === 'turn_voided';
}

/**
 * The canonical projection: state = events.reduce(apply, base), except that events
 * belonging to voided turns are skipped (their seqs still advance).
 * `base` lets the server start from a snapshot; the snapshot must not already contain
 * events of a turn that `events` voids (the store rebuilds from scratch in that case).
 */
export function replay(events: readonly GameEvent[], base: GameState = initialState(), options?: ApplyOptions) {
  const voided = new Set(base.voidedTurnIds);
  for (const e of events) if (e.type === 'turn_voided') voided.add(e.payload.turnId);
  // Seeded in log order, so the result matches incremental apply (which appends on each void).
  let state: GameState = { ...base, voidedTurnIds: [...voided] };
  for (const e of events) state = apply(state, e, options);
  return state;
}
