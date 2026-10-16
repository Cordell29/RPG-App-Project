import { randomInt } from 'node:crypto';
import {
  type EventDraft,
  type GameEvent,
  type GameState,
  type PendingAction,
  type RandomInt,
  type TurnStatus,
} from '@tavern/shared';
import { eq } from 'drizzle-orm';
import { newId as defaultNewId } from '../auth.ts';
import type { Db } from '../db/connection.ts';
import type { EventStore } from '../db/eventStore.ts';
import { turns } from '../db/schema.ts';
import { type LLMProvider, type LlmMessage, RULES_DOMAINS, type Usage } from '../llm/provider.ts';
import type { RoomService } from '../rooms.ts';
import { Adjudicator } from './adjudicator.ts';
import type { Chronicler } from '../memory/chronicle.ts';
import {
  type BudgetReport,
  type RecentTurn,
  type ResolutionLog,
  type TurnAction,
  buildNarrationPrompt,
  buildTurnPrompt,
  parseNarration,
  visibleNarration,
} from './prompt.ts';
import { toolSpecs } from './tools.ts';

export const MAX_ADJUDICATION_ROUNDS = 6;
export const RECENT_TURNS = 8;

export interface TurnRunnerDeps {
  db: Db;
  store: EventStore;
  rooms: RoomService;
  llm: LLMProvider;
  /** Broadcast committed events. */
  onEvents: (roomId: string, events: GameEvent[]) => void;
  /** Broadcast an ephemeral message. */
  emit: (roomId: string, name: 'turn_status' | 'narration_chunk', payload: unknown) => void;
  random?: RandomInt;
  newId?: () => string;
  timeoutMs?: number;
  /** Let the GM consult rules sources with web search (on by default). */
  rulesLookup?: boolean;
  /** Long-term memory: chronicle, canon and recaps. */
  memory?: Chronicler;
  /** What illustrations the GM may request this turn. */
  imageQuota?: (roomId: string, state: GameState, events: GameEvent[]) => { remainingToday: number; sceneAllowed: boolean };
}

/**
 * Runs GM turns. One turn at a time per room: every run goes through a per-room promise
 * chain (the in-memory mutex), so simultaneous actions produce exactly one GM call.
 *
 * Pipeline: collect → lock → adjudicate (tool loop, server-rolled dice) → validate →
 * commit (one transaction) → narrate (streamed) → release. A provider error before the
 * commit leaves nothing behind; actions stay queued and the host can retry.
 */
export class TurnRunner {
  private readonly d: Required<Omit<TurnRunnerDeps, 'random' | 'newId' | 'timeoutMs' | 'rulesLookup' | 'memory' | 'imageQuota'>> & {
    memory: Chronicler | null;
    imageQuota: TurnRunnerDeps['imageQuota'] | null;
    random: RandomInt;
    newId: () => string;
    timeoutMs: number;
    rulesLookup: boolean;
  };
  private readonly chains = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly statuses = new Map<string, TurnStatus>();
  /** After a rewind, wait for a new action or the host before resolving again. */
  private readonly held = new Set<string>();
  /** Adjudication calls started per room (tests assert "exactly one GM call"). */
  readonly gmTurns = new Map<string, number>();
  /** Token budget report of the most recent GM prompt per room. */
  readonly lastBudget = new Map<string, BudgetReport>();

  constructor(deps: TurnRunnerDeps) {
    this.d = { random: randomInt, newId: defaultNewId, timeoutMs: 60_000, rulesLookup: true, memory: null, imageQuota: null, ...deps };
  }

  status(roomId: string): TurnStatus {
    return this.statuses.get(roomId) ?? { status: 'idle' };
  }

  /** Resolves when every queued job for the room has finished. */
  async whenIdle(roomId: string) {
    while (this.chains.get(roomId)) await this.chains.get(roomId);
  }

  /** Re-evaluate the action window after anything that changes the queue. */
  poke(roomId: string, opts: { newAction?: boolean } = {}) {
    if (opts.newAction) this.held.delete(roomId);
    if (this.held.has(roomId)) return;
    const state = this.d.store.getState(roomId);
    if (state.turn.phase === 'resolving') return;
    const pending = state.turn.pending;
    if (pending.length === 0) {
      this.clearTimer(roomId);
      if (this.status(roomId).status === 'collecting') this.setStatus(roomId, { status: 'idle' });
      return;
    }
    if (this.held.has(roomId)) return;
    const settings = this.d.rooms.settings(this.d.rooms.requireRoom(roomId));
    if (settings.mode === 'solo') return this.start(roomId);
    if (settings.turnMode === 'spotlight') {
      if (state.spotlight && pending.some((a) => a.playerId === state.spotlight)) this.start(roomId);
      return;
    }
    const actors = state.players.filter((p) => p.active && p.characterId);
    if (actors.every((p) => pending.some((a) => a.playerId === p.id))) return this.start(roomId);
    if (settings.turnWindowSeconds > 0 && !this.timers.has(roomId)) {
      const deadline = Date.now() + settings.turnWindowSeconds * 1000;
      this.timers.set(
        roomId,
        setTimeout(() => {
          this.timers.delete(roomId);
          this.start(roomId);
        }, settings.turnWindowSeconds * 1000),
      );
      this.setStatus(roomId, { status: 'collecting', deadline });
    } else if (!this.timers.has(roomId)) {
      this.setStatus(roomId, { status: 'collecting' });
    }
  }

  /** Host: resolve whatever is queued, now. */
  resolveNow(roomId: string) {
    this.held.delete(roomId);
    this.start(roomId);
  }

  /** Host: retry a failed turn (re-narrate if it already committed, else re-adjudicate). */
  retry(roomId: string) {
    this.held.delete(roomId);
    const state = this.d.store.getState(roomId);
    if (state.turn.phase === 'resolving' && state.turn.turnId) {
      const turnId = state.turn.turnId;
      this.enqueue(roomId, () => this.narrate(roomId, turnId));
    } else {
      this.start(roomId);
    }
  }

  /** The last narrated, not-yet-voided turn (what "rewind" would undo). */
  lastNarratedTurn(roomId: string): string | null {
    const state = this.d.store.getState(roomId);
    const narrated = this.d.store
      .loadEvents(roomId)
      .filter((e) => e.type === 'narration' && e.turnId && !state.voidedTurnIds.includes(e.turnId));
    return narrated.at(-1)?.turnId ?? null;
  }

  /** After a rewind: wait for a new action or the host before resolving again. */
  hold(roomId: string) {
    this.held.add(roomId);
    this.clearTimer(roomId);
    this.setStatus(roomId, { status: 'idle' });
  }

  private start(roomId: string) {
    this.clearTimer(roomId);
    this.enqueue(roomId, () => this.runTurn(roomId));
  }

  private enqueue(roomId: string, job: () => Promise<void>) {
    const prev = this.chains.get(roomId) ?? Promise.resolve();
    const next = prev
      .then(job)
      .catch((err) => console.error('[turn]', err))
      .finally(() => {
        if (this.chains.get(roomId) === next) {
          this.chains.delete(roomId);
          // Actions submitted while we were busy may now be ready.
          try {
            this.poke(roomId);
          } catch (err) {
            console.error('[turn] poke', err);
          }
        }
      });
    this.chains.set(roomId, next);
  }

  private clearTimer(roomId: string) {
    const t = this.timers.get(roomId);
    if (t) clearTimeout(t);
    this.timers.delete(roomId);
  }

  private setStatus(roomId: string, status: TurnStatus) {
    this.statuses.set(roomId, status);
    this.d.emit(roomId, 'turn_status', status);
  }

  private withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctrl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new Error(`The AI took longer than ${Math.round(this.d.timeoutMs / 1000)} s to answer.`));
      }, this.d.timeoutMs);
    });
    return Promise.race([fn(ctrl.signal), timeout]).finally(() => clearTimeout(timer));
  }

  // ── the turn ─────────────────────────────────────────────────────────────

  private async runTurn(roomId: string) {
    const state = this.d.store.getState(roomId);
    if (state.turn.phase === 'resolving') return;
    const settings = this.d.rooms.settings(this.d.rooms.requireRoom(roomId));
    const pending =
      settings.turnMode === 'spotlight' && settings.mode !== 'solo' && state.spotlight
        ? state.turn.pending.filter((a) => a.playerId === state.spotlight)
        : state.turn.pending;
    if (pending.length === 0) return;

    const turnId = this.d.newId();
    const actions: TurnAction[] = pending.map((a) => ({ playerId: a.playerId, characterId: a.characterId, text: a.text }));
    this.d.db
      .insert(turns)
      .values({ id: turnId, roomId, status: 'adjudicating', actionsJson: JSON.stringify(pending), createdAt: new Date().toISOString() })
      .run();
    this.gmTurns.set(roomId, (this.gmTurns.get(roomId) ?? 0) + 1);
    this.setStatus(roomId, { status: 'adjudicating', turnId });

    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let adj: Adjudicator;
    try {
      const imageQuota = this.d.imageQuota?.(roomId, state, this.d.store.loadEvents(roomId));
      adj = new Adjudicator({ state, settings, turnId, random: this.d.random, newId: this.d.newId, ...(imageQuota ? { imageQuota } : {}) });
      const prompt = buildTurnPrompt({
        state,
        recent: this.recentTurns(roomId, state),
        actions,
        ...(this.d.memory ? { chronicle: this.d.memory.chronicle(roomId), canon: this.d.memory.canon(roomId) } : {}),
      });
      this.lastBudget.set(roomId, prompt.budget);
      const tools = toolSpecs();
      const messages: LlmMessage[] = [{ role: 'user', content: prompt.user }];
      for (let round = 0; round < MAX_ADJUDICATION_ROUNDS && !adj.done; round++) {
        const resp = await this.withTimeout((signal) =>
          this.d.llm.chat({
            purpose: 'gm_adjudicate',
            tier: 'turn',
            system: prompt.system,
            messages,
            tools,
            signal,
            ...(this.d.rulesLookup ? { webSearch: { allowedDomains: RULES_DOMAINS, maxUses: 2 } } : {}),
          }),
        );
        addUsage(usage, resp.usage);
        messages.push({ role: 'assistant', content: resp.content });
        if (resp.toolUses.length === 0) {
          // A long server-side search can pause; re-sending the conversation resumes it.
          if (resp.stopReason === 'pause_turn') continue;
          break;
        }
        const results = resp.toolUses.map((t) => {
          const out = adj.handle(t.name, t.input);
          return { type: 'tool_result', tool_use_id: t.id, content: out.result, ...(out.ok ? {} : { is_error: true }) };
        });
        messages.push({ role: 'user', content: results });
      }
      // Commit: the turn and every accepted/rejected change, in one transaction.
      const drafts: EventDraft[] = [
        { type: 'turn_started', actorId: null, turnId, payload: { turnId, actionSeqs: pending.map((a: PendingAction) => a.seq) } },
        ...adj.drafts,
      ];
      const committed = this.d.store.append(roomId, drafts);
      this.d.onEvents(roomId, committed);
    } catch (err) {
      const message = (err as Error).message || 'The GM could not resolve this turn.';
      this.d.db.update(turns).set({ status: 'failed', error: message, usageJson: JSON.stringify(usage) }).where(eq(turns.id, turnId)).run();
      // Wait for the host (Retry) or a new action rather than hammering a failing provider.
      this.held.add(roomId);
      this.setStatus(roomId, { status: 'failed', error: message, stage: 'adjudicate' });
      return;
    }
    this.d.db.update(turns).set({ status: 'narrating', usageJson: JSON.stringify(usage) }).where(eq(turns.id, turnId)).run();
    await this.narrate(roomId, turnId, adj.resolutionLog(), actions, usage);
  }

  private async narrate(roomId: string, turnId: string, log?: ResolutionLog, actions?: TurnAction[], usage?: Usage) {
    const state = this.d.store.getState(roomId);
    if (state.turn.turnId !== turnId) return;
    const acts = actions ?? state.turn.resolving.map((a) => ({ playerId: a.playerId, characterId: a.characterId, text: a.text }));
    const resolution = log ?? logFromEvents(this.d.store.loadEvents(roomId).filter((e) => e.turnId === turnId));
    const total = usage ?? { inputTokens: 0, outputTokens: 0 };
    this.setStatus(roomId, { status: 'narrating', turnId });
    try {
      const prompt = buildNarrationPrompt({ state, actions: acts, log: resolution });
      let raw = '';
      let sent = 0;
      const resp = await this.withTimeout((signal) =>
        this.d.llm.streamText(
          { purpose: 'gm_narrate', tier: 'turn', system: [{ text: prompt.system, cache: true }], messages: [{ role: 'user', content: prompt.user }], effort: 'low', maxTokens: 2000, signal },
          (delta) => {
            raw += delta;
            const visible = visibleNarration(raw);
            if (visible.length > sent) {
              this.d.emit(roomId, 'narration_chunk', { turnId, delta: visible.slice(sent) });
              sent = visible.length;
            }
          },
        ),
      );
      addUsage(total, resp.usage);
      const parsed = parseNarration(resp.text || raw);
      const drafts: EventDraft[] = [
        {
          type: 'narration',
          actorId: null,
          turnId,
          payload: {
            turnId,
            text: parsed.text.slice(0, 20000) || '(The GM is silent.)',
            gist: parsed.gist,
            ...(parsed.suggestions.length ? { suggestions: parsed.suggestions } : {}),
          },
        },
      ];
      const settings = this.d.rooms.settings(this.d.rooms.requireRoom(roomId));
      if (settings.turnMode === 'spotlight' && settings.mode !== 'solo') {
        drafts.push({ type: 'spotlight_set', actorId: null, turnId: null, payload: { playerId: nextSpotlight(state) } });
      }
      const committed = this.d.store.append(roomId, drafts);
      this.d.onEvents(roomId, committed);
      this.d.db.update(turns).set({ status: 'done', usageJson: JSON.stringify(total) }).where(eq(turns.id, turnId)).run();
      this.setStatus(roomId, { status: 'idle' });
      if (this.d.memory) {
        if (resolution.applied.some((a) => a.startsWith('canon recorded'))) this.d.memory.syncCanon(roomId);
        this.d.memory.afterTurn(roomId);
      }
    } catch (err) {
      const message = (err as Error).message || 'Narration failed.';
      this.d.db.update(turns).set({ status: 'failed', error: message }).where(eq(turns.id, turnId)).run();
      this.setStatus(roomId, { status: 'failed', error: message, stage: 'narrate', turnId });
    }
  }

  /** Last N narrated turns: who tried what, and a short gist of what happened. */
  private recentTurns(roomId: string, state: GameState): RecentTurn[] {
    const events = this.d.store.loadEvents(roomId);
    const actionText = new Map<number, { playerId: string; characterId: string | null; text: string }>();
    for (const e of events) {
      if (e.type === 'action_submitted') actionText.set(e.seq, e.payload);
      if (e.type === 'action_edited') {
        const a = actionText.get(e.payload.actionSeq);
        if (a) actionText.set(e.payload.actionSeq, { ...a, text: e.payload.text });
      }
    }
    const started = new Map(events.filter((e) => e.type === 'turn_started').map((e) => [e.turnId, e]));
    const narrations = events.filter((e) => e.type === 'narration' && e.turnId && !state.voidedTurnIds.includes(e.turnId)).slice(-RECENT_TURNS);
    return narrations.map((n) => {
      const ts = started.get(n.turnId);
      const seqs = ts?.type === 'turn_started' ? ts.payload.actionSeqs : [];
      const name = (characterId: string | null, playerId: string) =>
        state.party.find((c) => c.id === characterId)?.name ?? state.players.find((p) => p.id === playerId)?.displayName ?? 'Someone';
      return {
        actions: seqs.map((s) => actionText.get(s)).filter((a) => !!a).map((a) => `${name(a!.characterId, a!.playerId)}: ${a!.text}`),
        gist: n.type === 'narration' ? (n.payload.gist ?? n.payload.text.slice(0, 300)) : '',
      };
    });
  }
}

function addUsage(total: Usage, u: Usage) {
  total.inputTokens += u.inputTokens;
  total.outputTokens += u.outputTokens;
  total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
  total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0);
}

/** Next player in seat order (active, with a character) after the current spotlight. */
export function nextSpotlight(state: GameState): string | null {
  const seats = state.players.filter((p) => p.active && p.characterId);
  if (!seats.length) return null;
  const i = seats.findIndex((p) => p.id === state.spotlight);
  return seats[(i + 1) % seats.length]!.id;
}

/** Rebuilds a narration log from a committed turn's events (used when retrying narration). */
export function logFromEvents(events: GameEvent[]): ResolutionLog {
  const log: ResolutionLog = { rolls: [], applied: [], rejected: [], summary: '' };
  for (const e of events) {
    if (e.type === 'dice_rolled') {
      const p = e.payload;
      log.rolls.push(`${p.reason ?? 'roll'}: ${p.notation} = ${p.total}${p.dc !== undefined ? ` vs ${p.dc} → ${p.success ? 'success' : 'failure'}` : ''}`);
    } else if (e.type === 'delta_applied') {
      log.applied.push(`${e.payload.delta.type} ${JSON.stringify(e.payload.delta)}`);
    } else if (e.type === 'delta_rejected') {
      log.rejected.push(`${e.payload.tool}: ${e.payload.reason}`);
    } else if (e.type === 'approval_requested') {
      log.applied.push(`An item awaits the host's approval: ${e.payload.approval.item?.name ?? e.payload.approval.ability?.name}`);
    }
  }
  return log;
}
