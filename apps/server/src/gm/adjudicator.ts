import {
  type AppliedDelta,
  type Character,
  type EventDraft,
  type GameEvent,
  type GameState,
  type Item,
  type RandomInt,
  type RollMode,
  type RoomSettings,
  GM_MAX_ITEM_POWER,
  ItemEffectsSchema,
  ReducerError,
  SKILLS,
  apply,
  checkModifier,
  effectiveAc,
  itemPower,
  parseDice,
  rollDice,
  skillLabel,
  statLabel,
  weaponAttack,
} from '@tavern/shared';
import type { z } from 'zod';
import { TOOL_INPUTS, type ToolName } from './tools.ts';

export const LIMITS_PER_TURN = { hp: 50, xp: 200, newItems: 3, activeQuests: 10, meter: 3 } as const;
const RARITY_BY_POWER = ['mundane', 'uncommon', 'rare', 'very_rare'] as const;

export interface ToolOutcome {
  ok: boolean;
  /** Returned to the model as the tool_result. */
  result: string;
}

type Input<T extends ToolName> = z.infer<(typeof TOOL_INPUTS)[T]>;

/**
 * Validates and applies one GM turn's proposed tool calls. Works on a scratch copy of
 * the state so later calls see earlier effects. Produces event drafts (rolls, applied and
 * rejected deltas, approval requests) that the turn runner commits in one transaction.
 * Dice come from `random` (crypto.randomInt in production).
 */
export class Adjudicator {
  state: GameState;
  readonly drafts: EventDraft[] = [];
  done = false;
  summary = '';
  private readonly settings: RoomSettings;
  private readonly turnId: string;
  private readonly random: RandomInt;
  private readonly newId: () => string;
  private readonly gold = new Map<string, number>();
  private readonly xp = new Map<string, number>();
  private readonly items = new Map<string, number>();
  private readonly log = { rolls: [] as string[], applied: [] as string[], rejected: [] as string[] };

  private readonly imageQuota: { remainingToday: number; sceneAllowed: boolean };

  constructor(opts: {
    state: GameState;
    settings: RoomSettings;
    turnId: string;
    random: RandomInt;
    newId: () => string;
    imageQuota?: { remainingToday: number; sceneAllowed: boolean };
  }) {
    this.imageQuota = { ...(opts.imageQuota ?? { remainingToday: 0, sceneAllowed: false }) };
    this.state = structuredClone(opts.state);
    this.settings = opts.settings;
    this.turnId = opts.turnId;
    this.random = opts.random;
    this.newId = opts.newId;
  }

  handle(name: string, raw: unknown): ToolOutcome {
    if (this.done) return { ok: false, result: 'Adjudication has already ended for this turn.' };
    if (!(name in TOOL_INPUTS)) return this.reject(name, raw, `"${name}" is not an available tool.`);
    const parsed = TOOL_INPUTS[name as ToolName].safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return this.reject(name, raw, `${issue.path.join('.') || 'input'}: ${issue.message}`);
    }
    try {
      return this.dispatch(name as ToolName, parsed.data, raw);
    } catch (err) {
      if (err instanceof Rejection) return this.reject(name, raw, err.message);
      throw err;
    }
  }

  resolutionLog() {
    return { rolls: [...this.log.rolls], applied: [...this.log.applied], rejected: [...this.log.rejected], summary: this.summary };
  }

  // ── dispatch ────────────────────────────────────────────────────────────

  private dispatch(name: ToolName, input: unknown, raw: unknown): ToolOutcome {
    switch (name) {
      case 'request_check':
        return this.check(input as Input<'request_check'>);
      case 'request_contest':
        return this.contest(input as Input<'request_contest'>);
      case 'request_attack':
        return this.attack(input as Input<'request_attack'>);
      case 'npc_attack':
        return this.npcAttack(input as Input<'npc_attack'>, raw);
      case 'modify_hp': {
        const i = input as Input<'modify_hp'>;
        if (i.amount === 0) throw new Rejection('amount must not be 0.');
        if (Math.abs(i.amount) > LIMITS_PER_TURN.hp) throw new Rejection(`HP changes are limited to ±${LIMITS_PER_TURN.hp} per call.`);
        const c = this.char(i.characterId);
        return this.applyDelta(name, raw, { type: 'modify_hp', characterId: c.id, amount: i.amount }, i.reason);
      }
      case 'add_item':
        return this.addItem(input as Input<'add_item'>, raw);
      case 'remove_item': {
        const i = input as Input<'remove_item'>;
        const c = this.char(i.characterId);
        const item = c.inventory.find((x) => x.instanceId === i.instanceId) ?? reject(`${c.name} has no item ${i.instanceId}.`);
        if (item.qty < i.qty) throw new Rejection(`${c.name} only has ${item.qty} ${item.name}.`);
        return this.applyDelta(name, raw, { type: 'remove_item', characterId: c.id, instanceId: i.instanceId, qty: i.qty }, i.reason);
      }
      case 'change_gold': {
        const i = input as Input<'change_gold'>;
        const c = this.char(i.characterId);
        if (i.amount === 0) throw new Rejection('amount must not be 0.');
        if (i.amount > 0) {
          const total = (this.gold.get(c.id) ?? 0) + i.amount;
          if (total > this.settings.goldCapPerTurn) {
            throw new Rejection(`gain exceeds the cap of ${this.settings.goldCapPerTurn} ${this.currency} per character per turn.`);
          }
          this.gold.set(c.id, total);
        } else if (c.gold + i.amount < 0) {
          throw new Rejection(`${c.name} only has ${c.gold} ${this.currency}.`);
        }
        return this.applyDelta(name, raw, { type: 'change_gold', characterId: c.id, amount: i.amount }, i.reason);
      }
      case 'transfer_item': {
        const i = input as Input<'transfer_item'>;
        const from = this.char(i.fromId);
        const to = this.char(i.toId);
        if (from.id === to.id) throw new Rejection('cannot transfer to the same character.');
        const item = from.inventory.find((x) => x.instanceId === i.instanceId) ?? reject(`${from.name} has no item ${i.instanceId}.`);
        if (item.qty < i.qty) throw new Rejection(`${from.name} only has ${item.qty} ${item.name}.`);
        return this.applyDelta(name, raw, { type: 'transfer_item', fromId: from.id, toId: to.id, instanceId: i.instanceId, qty: i.qty, newInstanceId: this.newId() });
      }
      case 'grant_xp': {
        const i = input as Input<'grant_xp'>;
        const c = this.char(i.characterId);
        const total = (this.xp.get(c.id) ?? 0) + i.amount;
        if (total > LIMITS_PER_TURN.xp) throw new Rejection(`XP is limited to ${LIMITS_PER_TURN.xp} per character per turn.`);
        this.xp.set(c.id, total);
        return this.applyDelta(name, raw, { type: 'grant_xp', characterId: c.id, amount: i.amount }, i.reason);
      }
      case 'set_condition': {
        const i = input as Input<'set_condition'>;
        const c = this.char(i.characterId);
        return this.applyDelta(name, raw, { type: 'set_condition', characterId: c.id, condition: i.condition, on: i.on });
      }
      case 'adjust_meter': {
        const i = input as Input<'adjust_meter'>;
        const c = this.char(i.characterId);
        if (!c.meters[i.meter]) throw new Rejection(`${c.name} has no ${i.meter} meter in this setting.`);
        if (i.amount === 0 || Math.abs(i.amount) > LIMITS_PER_TURN.meter) throw new Rejection(`meter changes must be between −3 and +3 (not 0).`);
        return this.applyDelta(name, raw, { type: 'adjust_meter', characterId: c.id, meter: i.meter, amount: i.amount }, i.reason);
      }
      case 'use_ability': {
        const i = input as Input<'use_ability'>;
        const c = this.char(i.characterId);
        const a = c.abilities.find((x) => x.id === i.abilityId) ?? reject(`${c.name} has no ability ${i.abilityId}.`);
        if (a.uses && a.uses.current <= 0) throw new Rejection(`${a.name} has no uses left until a rest.`);
        return this.applyDelta(name, raw, { type: 'use_ability', characterId: c.id, abilityId: a.id });
      }
      case 'spend_spell_slot': {
        const i = input as Input<'spend_spell_slot'>;
        const c = this.char(i.characterId);
        const slot = c.spellSlots[i.level - 1];
        if (!slot || slot.current <= 0) throw new Rejection(`${c.name} has no level ${i.level} ${this.slotsLabel.toLowerCase()} left.`);
        return this.applyDelta(name, raw, { type: 'spend_spell_slot', characterId: c.id, level: i.level });
      }
      case 'rest': {
        const i = input as Input<'rest'>;
        for (const id of i.characterIds) this.char(id);
        return this.applyDelta(name, raw, { type: 'rest', kind: i.kind, characterIds: [...new Set(i.characterIds)] });
      }
      case 'set_flag': {
        const i = input as Input<'set_flag'>;
        return this.applyDelta(name, raw, { type: 'set_flag', key: i.key, value: i.value });
      }
      case 'update_quest': {
        const i = input as Input<'update_quest'>;
        const existing = this.state.quests.find((q) => q.key === i.key);
        if (!existing && !i.title) throw new Rejection('a new quest needs a title.');
        const active = this.state.quests.filter((q) => q.status === 'active' && q.key !== i.key).length;
        const willBeActive = (i.status ?? existing?.status ?? 'active') === 'active';
        if (willBeActive && active >= LIMITS_PER_TURN.activeQuests) throw new Rejection('there are already 10 active quests; finish or fail one first.');
        return this.applyDelta(name, raw, { type: 'update_quest', ...i });
      }
      case 'change_scene': {
        const i = input as Input<'change_scene'>;
        return this.applyDelta(name, raw, { type: 'change_scene', ...i });
      }
      case 'upsert_canon': {
        const i = input as Input<'upsert_canon'>;
        return this.applyDelta(name, raw, { type: 'upsert_canon', ...i });
      }
      case 'request_image': {
        const i = input as Input<'request_image'>;
        if (this.imageQuota.remainingToday <= 0) throw new Rejection("today's image limit for this room is used up.");
        if (i.kind === 'scene' && !this.imageQuota.sceneAllowed) throw new Rejection('a scene image was made recently; wait a few turns.');
        if (i.kind === 'scene') this.imageQuota.sceneAllowed = false;
        this.imageQuota.remainingToday -= 1;
        this.drafts.push({ type: 'image_requested', actorId: null, turnId: this.turnId, payload: { assetId: this.newId(), kind: i.kind, subject: i.subject } });
        this.log.applied.push(`an illustration of ${i.subject} is being painted`);
        return { ok: true, result: 'Image requested; it will appear for the players shortly.' };
      }
      case 'end_adjudication': {
        this.done = true;
        this.summary = (input as Input<'end_adjudication'>).summary;
        return { ok: true, result: 'Turn resolved.' };
      }
    }
  }

  // ── rolls ───────────────────────────────────────────────────────────────

  private roll(sides: number, count: number, modifier: number, mode: RollMode) {
    const advOk = sides === 20 && count === 1;
    return rollDice({ groups: [{ count, sides }], modifier, mode: advOk ? mode : 'normal' }, this.random);
  }

  private pushRoll(payload: Extract<EventDraft, { type: 'dice_rolled' }>['payload'], text: string) {
    this.drafts.push({ type: 'dice_rolled', actorId: null, turnId: this.turnId, payload });
    this.log.rolls.push(text);
  }

  private check(i: Input<'request_check'>): ToolOutcome {
    const c = this.char(i.characterId);
    const stat = i.skill ? SKILLS[i.skill] : i.stat;
    const mod = i.flat ? 0 : checkModifier(c, { stat, skill: i.skill, save: i.save });
    const r = this.roll(20, 1, mod, i.mode);
    const success = r.total >= i.dc;
    const what = i.flat ? 'flat d20' : i.skill ? `${skillLabel(this.state.setting, i.skill)} (${statLabel(this.state.setting, stat)})` : `${statLabel(this.state.setting, stat)}${i.save ? ' save' : ''}`;
    const text = `${c.name} ${what} check${i.reason ? ` to ${i.reason}` : ''}: rolled ${this.kept(r)} ${fmt(mod)} = ${r.total} vs DC ${i.dc} → ${success ? 'success' : 'failure'}`;
    this.pushRoll({ ...r, dc: i.dc, success, characterId: c.id, stat, ...(i.reason ? { reason: clip(i.reason) } : {}) }, text);
    return { ok: true, result: text };
  }

  private contest(i: Input<'request_contest'>): ToolOutcome {
    const sides = [i.sideA, i.sideB].map((s) => {
      if (!!s.characterId === !!s.npcName) throw new Rejection('each side needs exactly one of characterId or npcName.');
      if (s.characterId) {
        const c = this.char(s.characterId);
        const stat = s.skill ? SKILLS[s.skill] : s.stat;
        return { name: c.name, mod: checkModifier(c, { stat, skill: s.skill }), stat, characterId: c.id, mode: s.mode };
      }
      return { name: s.npcName!, mod: s.modifier ?? 0, stat: s.stat, characterId: undefined, mode: s.mode };
    });
    const [a, b] = sides as [(typeof sides)[0], (typeof sides)[0]];
    const ra = this.roll(20, 1, a.mod, a.mode);
    const rb = this.roll(20, 1, b.mod, b.mode);
    const outcome = ra.total > rb.total ? `${a.name} wins` : rb.total > ra.total ? `${b.name} wins` : 'tie: the status quo holds';
    const label = `contest${i.reason ? `: ${i.reason}` : ''}`;
    for (const [side, r] of [
      [a, ra],
      [b, rb],
    ] as const) {
      this.pushRoll(
        { ...r, ...(side.characterId ? { characterId: side.characterId } : {}), stat: side.stat, reason: clip(`${side.name}, ${label}`) },
        `${side.name}: ${this.kept(r)} ${fmt(side.mod)} = ${r.total}`,
      );
    }
    const text = `Contest (${i.reason || 'opposed'}): ${a.name} ${ra.total} vs ${b.name} ${rb.total} → ${outcome}.`;
    this.log.rolls.push(text);
    return { ok: true, result: text };
  }

  private attack(i: Input<'request_attack'>): ToolOutcome {
    const c = this.char(i.characterId);
    let weapon: Item = { instanceId: 'unarmed', name: 'Unarmed strike', qty: 1, equipped: true, tags: [] };
    if (i.weaponInstanceId) {
      weapon = c.inventory.find((x) => x.instanceId === i.weaponInstanceId) ?? reject(`${c.name} does not carry item ${i.weaponInstanceId}.`);
    }
    const profile = weaponAttack(c, weapon);
    const toHit = this.roll(20, 1, profile.attackBonus, i.mode);
    const nat = this.kept(toHit);
    const crit = nat === 20;
    const hit = crit || (nat !== 1 && toHit.total >= i.targetAc);
    let text = `${c.name} attacks ${i.targetName} with ${weapon.name}: ${nat} ${fmt(profile.attackBonus)} = ${toHit.total} vs AC ${i.targetAc} → `;
    this.drafts.push({
      type: 'dice_rolled',
      actorId: null,
      turnId: this.turnId,
      payload: { ...toHit, dc: i.targetAc, success: hit, characterId: c.id, reason: clip(`${weapon.name} attack on ${i.targetName}`) },
    });
    if (!hit) {
      text += nat === 1 ? 'natural 1, a miss.' : 'miss.';
      this.log.rolls.push(text);
      return { ok: true, result: text };
    }
    const spec = parseDice(profile.damage);
    if (crit) spec.groups = spec.groups.map((g) => ({ ...g, count: g.count * 2 }));
    const dmg = rollDice(spec, this.random);
    this.drafts.push({ type: 'dice_rolled', actorId: null, turnId: this.turnId, payload: { ...dmg, characterId: c.id, reason: clip(`${weapon.name} damage`) } });
    text += `${crit ? 'critical hit! ' : 'hits '}for ${dmg.total} ${profile.damageType} damage.`;
    this.log.rolls.push(text);
    return { ok: true, result: `${text} (Track the target's wounds in the story.)` };
  }

  private npcAttack(i: Input<'npc_attack'>, raw: unknown): ToolOutcome {
    const c = this.char(i.targetCharacterId);
    const spec = parseDice(i.damage);
    const ac = effectiveAc(c);
    const toHit = this.roll(20, 1, i.attackBonus, i.mode);
    const nat = this.kept(toHit);
    const crit = nat === 20;
    const hit = crit || (nat !== 1 && toHit.total >= ac);
    this.drafts.push({
      type: 'dice_rolled',
      actorId: null,
      turnId: this.turnId,
      payload: { ...toHit, dc: ac, success: hit, reason: clip(`${i.npcName} attacks ${c.name}${i.reason ? ` (${i.reason})` : ''}`) },
    });
    if (!hit) {
      const text = `${i.npcName} attacks ${c.name}: ${nat} ${fmt(i.attackBonus)} = ${toHit.total} vs AC ${ac} → misses.`;
      this.log.rolls.push(text);
      return { ok: true, result: text };
    }
    if (crit) spec.groups = spec.groups.map((g) => ({ ...g, count: g.count * 2 }));
    const dmg = rollDice(spec, this.random);
    this.drafts.push({ type: 'dice_rolled', actorId: null, turnId: this.turnId, payload: { ...dmg, reason: clip(`${i.npcName} damage`) } });
    const amount = Math.min(LIMITS_PER_TURN.hp, Math.max(0, dmg.total));
    const text = `${i.npcName} attacks ${c.name}: ${nat} ${fmt(i.attackBonus)} = ${toHit.total} vs AC ${ac} → ${crit ? 'critical! ' : ''}hits ${c.name} for ${amount}.`;
    this.log.rolls.push(text);
    if (amount > 0) {
      const out = this.applyDelta('npc_attack', raw, { type: 'modify_hp', characterId: c.id, amount: -amount }, `${i.npcName}'s attack`);
      if (!out.ok) return out;
    }
    return { ok: true, result: `${text} ${c.name} now has ${this.char(c.id).hp.current}/${c.hp.max} HP.` };
  }

  // ── items ───────────────────────────────────────────────────────────────

  private addItem(i: Input<'add_item'>, raw: unknown): ToolOutcome {
    const c = this.char(i.characterId);
    const count = this.items.get(c.id) ?? 0;
    if (count >= LIMITS_PER_TURN.newItems) throw new Rejection(`a character can receive at most 3 new items per turn.`);
    let effects: Item['effects'];
    if (i.effects && Object.keys(i.effects).length) {
      const parsed = ItemEffectsSchema.safeParse(i.effects);
      if (!parsed.success) throw new Rejection(`invalid effects (${parsed.error.issues[0]!.path.join('.')}: ${parsed.error.issues[0]!.message}).`);
      effects = parsed.data;
    }
    const power = itemPower({ slot: i.slot, effects });
    if (power > 3) throw new Rejection('items stronger than +3 can only be created by the host.');
    const item: Item = {
      instanceId: this.newId(),
      name: i.name,
      qty: i.qty,
      equipped: false,
      tags: i.tags,
      ...(i.notes ? { notes: i.notes } : {}),
      ...(i.slot ? { slot: i.slot } : {}),
      ...(effects ? { effects, rarity: RARITY_BY_POWER[power]! } : {}),
    };
    this.items.set(c.id, count + 1);
    if (power > GM_MAX_ITEM_POWER) {
      this.drafts.push({
        type: 'approval_requested',
        actorId: null,
        turnId: this.turnId,
        payload: { approval: { id: this.newId(), kind: 'item', characterId: c.id, item, reason: clip(i.reason || 'found', 300), requestedBy: 'gm' } },
      });
      this.log.applied.push(`${i.name} (${RARITY_BY_POWER[power]!.replace('_', ' ')}) is offered to ${c.name}, awaiting the host's approval`);
      return { ok: true, result: `${i.name} is a ${RARITY_BY_POWER[power]!.replace('_', ' ')} item: it has been sent to the host for approval. Describe it as found but not yet claimed.` };
    }
    return this.applyDelta('add_item', raw, { type: 'add_item', characterId: c.id, item }, i.reason);
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private applyDelta(tool: string, raw: unknown, delta: AppliedDelta, reason?: string): ToolOutcome {
    const event = {
      seq: this.state.seq + 1,
      type: 'delta_applied',
      actorId: null,
      turnId: this.turnId,
      createdAt: '',
      payload: { delta, ...(reason ? { reason: clip(reason, 300) } : {}) },
    } as GameEvent;
    try {
      this.state = apply(this.state, event);
    } catch (err) {
      if (err instanceof ReducerError) return this.reject(tool, raw, err.message.replace(/^\[seq \d+ \w+\] /, ''));
      throw err;
    }
    this.drafts.push({ type: 'delta_applied', actorId: null, turnId: this.turnId, payload: event.payload } as EventDraft);
    const words = this.describe(delta);
    this.log.applied.push(words);
    return { ok: true, result: `Applied: ${words}.` };
  }

  private reject(tool: string, input: unknown, reason: string): ToolOutcome {
    this.drafts.push({ type: 'delta_rejected', actorId: null, turnId: this.turnId, payload: { tool: clip(tool, 40), input, reason: clip(reason, 500) } });
    this.log.rejected.push(`${tool} ${JSON.stringify(input)}: ${reason}`);
    return { ok: false, result: `Rejected: ${reason} Nothing changed; do not narrate it as happening.` };
  }

  private char(id: string): Character {
    return this.state.party.find((c) => c.id === id) ?? reject(`there is no character with id ${id}.`);
  }

  private kept(r: { dice: { value: number; dropped: boolean }[] }) {
    return r.dice.find((d) => !d.dropped)!.value;
  }

  private get currency() {
    return this.state.setting?.currencyName ?? 'gold';
  }

  private get slotsLabel() {
    return this.state.setting?.slotsLabel ?? 'Spell slots';
  }

  private describe(d: AppliedDelta): string {
    const name = (id: string) => this.state.party.find((c) => c.id === id)?.name ?? id;
    switch (d.type) {
      case 'modify_hp':
        return `${name(d.characterId)} ${d.amount < 0 ? `takes ${-d.amount} damage` : `heals ${d.amount}`} (now ${this.char(d.characterId).hp.current} HP)`;
      case 'add_item':
        return `${name(d.characterId)} receives ${d.item.qty > 1 ? `${d.item.qty}× ` : ''}${d.item.name}`;
      case 'remove_item':
        return `${name(d.characterId)} loses ${d.qty} of item ${d.instanceId}`;
      case 'change_gold':
        return `${name(d.characterId)} ${d.amount > 0 ? 'gains' : 'spends'} ${Math.abs(d.amount)} ${this.currency}`;
      case 'transfer_item':
        return `${name(d.fromId)} gives ${d.qty} item(s) to ${name(d.toId)}`;
      case 'grant_xp':
        return `${name(d.characterId)} earns ${d.amount} XP (level ${this.char(d.characterId).level})`;
      case 'set_condition':
        return `${name(d.characterId)} is ${d.on ? 'now' : 'no longer'} ${d.condition}`;
      case 'adjust_meter':
        return `${name(d.characterId)}'s ${d.meter} ${d.amount > 0 ? 'rises' : 'drops'} by ${Math.abs(d.amount)}`;
      case 'use_ability':
        return `${name(d.characterId)} uses ${this.char(d.characterId).abilities.find((a) => a.id === d.abilityId)?.name ?? 'an ability'}`;
      case 'spend_spell_slot':
        return `${name(d.characterId)} spends a level ${d.level} ${this.slotsLabel.toLowerCase().replace(/s$/, '')}`;
      case 'rest':
        return `${d.characterIds.map(name).join(', ')} take a ${d.kind} rest`;
      case 'set_flag':
        return `flag ${d.key} = ${String(d.value)}`;
      case 'update_quest':
        return `quest "${d.title ?? d.key}"${d.status ? ` is ${d.status}` : ''}${d.note ? `: ${d.note}` : ''}`;
      case 'change_scene':
        return `the scene moves to ${d.title || d.locationKey}`;
      case 'upsert_canon':
        return `canon recorded: ${d.kind} ${d.key}`;
    }
  }
}

class Rejection extends Error {}
function reject(message: string): never {
  throw new Rejection(message);
}
const fmt = (n: number) => (n >= 0 ? `+ ${n}` : `− ${-n}`);
const clip = (s: string, n = 200) => (s.length > n ? s.slice(0, n) : s);
