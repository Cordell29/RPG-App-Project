import { randomInt } from 'node:crypto';
import {
  type Command,
  type CommandResult,
  type EventDraft,
  type GameEvent,
  type RandomInt,
  type RoomSettings,
  CommandSchema,
  DiceError,
  HOST_COMMANDS,
  ReducerError,
  RoomSettingsSchema,
  STAT_ROLL_NOTATION,
  buildCharacter,
  checkProficiencies,
  checkStats,
  findRole,
  parseDice,
  rollDice,
  rollStatPool,
} from '@tavern/shared';
import { and, eq, lt } from 'drizzle-orm';
import { newId } from './auth.ts';
import type { Db } from './db/connection.ts';
import type { EventStore } from './db/eventStore.ts';
import { commandLog, players, rooms } from './db/schema.ts';
import type { AuthedPlayer } from './rooms.ts';

export const COMMAND_LOG_TTL_MS = 24 * 60 * 60 * 1000;

export interface TurnHooks {
  poke(roomId: string, opts?: { newAction?: boolean }): void;
  resolveNow(roomId: string): void;
  retry(roomId: string): void;
  lastNarratedTurn(roomId: string): string | null;
  hold(roomId: string): void;
  status(roomId: string): { status: string };
}

class CommandRejected extends Error {}
function reject(message: string): never {
  throw new CommandRejected(message);
}

/**
 * Executes client commands. Each commandId's result is stored for 24 h, so a retried
 * command (flaky connection, double click) returns the original result instead of
 * applying twice. Validation, the event append and the log write share one transaction.
 */
export class CommandBus {
  private readonly db: Db;
  private readonly store: EventStore;
  private readonly random: RandomInt;
  onEvents: (roomId: string, events: GameEvent[]) => void = () => {};
  onSettings: (roomId: string, settings: RoomSettings) => void = () => {};
  /** GM turn control, wired by the app once the TurnRunner exists. */
  turns: TurnHooks | null = null;

  constructor(db: Db, store: EventStore, random: RandomInt = randomInt) {
    this.db = db;
    this.store = store;
    this.random = random;
  }

  execute(player: AuthedPlayer, raw: unknown): CommandResult {
    const commandId =
      raw && typeof raw === 'object' && typeof (raw as { commandId?: unknown }).commandId === 'string'
        ? (raw as { commandId: string }).commandId
        : null;
    if (commandId) {
      const prior = this.db
        .select()
        .from(commandLog)
        .where(and(eq(commandLog.roomId, player.roomId), eq(commandLog.commandId, commandId)))
        .get();
      if (prior) return JSON.parse(prior.resultJson) as CommandResult;
    }
    const parsed = CommandSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid command.' };
    }
    const cmd = parsed.data;
    if (HOST_COMMANDS.includes(cmd.type) && !player.isHost) {
      return { ok: false, error: 'Only the host can do that.' };
    }
    let newSettings: RoomSettings | null = null;
    this.after = [];

    let appended: GameEvent[] = [];
    const result = this.db.$client.transaction((): CommandResult => {
      let res: CommandResult;
      try {
        if (cmd.type === 'set_room_mode') {
          newSettings = this.setMode(player.roomId, { mode: cmd.mode });
        } else if (cmd.type === 'set_turn_mode') {
          newSettings = this.setMode(player.roomId, {
            turnMode: cmd.turnMode,
            ...(cmd.turnWindowSeconds !== undefined ? { turnWindowSeconds: cmd.turnWindowSeconds } : {}),
          });
          const state = this.store.getState(player.roomId);
          const first = state.players.find((p) => p.active && p.characterId)?.id ?? null;
          const spotlight = cmd.turnMode === 'spotlight' ? (state.spotlight ?? first) : null;
          if (spotlight !== state.spotlight) {
            appended = this.store.append(player.roomId, [{ type: 'spotlight_set', actorId: player.playerId, turnId: null, payload: { playerId: spotlight } }]);
          }
          this.after.push(() => this.turns?.poke(player.roomId));
        } else {
          appended = this.store.append(player.roomId, this.toEvents(player, cmd));
        }
        res = { ok: true, seqs: appended.map((e) => e.seq) };
      } catch (err) {
        if (err instanceof ReducerError) {
          // The reducer refused (e.g. removing an item that is not there): report without the seq prefix.
          res = { ok: false, error: err.message.replace(/^\[seq \d+ \w+\] /, '') };
        } else if (err instanceof CommandRejected || err instanceof DiceError) {
          res = { ok: false, error: err.message };
        } else {
          throw err;
        }
      }
      this.db
        .insert(commandLog)
        .values({
          roomId: player.roomId,
          commandId: cmd.commandId,
          resultJson: JSON.stringify(res),
          createdAt: new Date().toISOString(),
        })
        .run();
      return res;
    })();
    if (appended.length) this.onEvents(player.roomId, appended);
    if (newSettings) this.onSettings(player.roomId, newSettings);
    if (result.ok) for (const fn of this.after) fn();
    return result;
  }

  private after: (() => void)[] = [];

  private setMode(roomId: string, patch: Partial<Pick<RoomSettings, 'mode' | 'turnMode' | 'turnWindowSeconds'>>): RoomSettings {
    const row = this.db.select().from(rooms).where(eq(rooms.id, roomId)).get();
    if (!row) throw new CommandRejected('Room not found.');
    const current = RoomSettingsSchema.parse(JSON.parse(row.settingsJson));
    const next = RoomSettingsSchema.parse({
      ...current,
      ...patch,
      ...(patch.mode ? { turnWindowSeconds: patch.mode === 'solo' ? 0 : current.turnWindowSeconds || 60 } : {}),
    });
    this.db.update(rooms).set({ settingsJson: JSON.stringify(next) }).where(eq(rooms.id, roomId)).run();
    return next;
  }

  private toEvents(player: AuthedPlayer, cmd: Exclude<Command, { type: 'set_room_mode' | 'set_turn_mode' }>): EventDraft[] {
    const base = { actorId: player.playerId, turnId: null };
    const state = this.store.getState(player.roomId);
    const me = state.players.find((p) => p.id === player.playerId);
    /** Players may touch only their own character; the host may touch any. */
    const ownCharacter = (characterId: string) => {
      const c = state.party.find((x) => x.id === characterId) ?? reject('That character does not exist.');
      if (c.playerId !== player.playerId && !player.isHost) reject('You can only change your own character.');
      return c;
    };

    switch (cmd.type) {
      case 'send_chat':
        return [{ ...base, type: 'chat_message', payload: { playerId: player.playerId, text: cmd.text } }];

      case 'roll_dice': {
        const roll = rollDice(parseDice(cmd.notation), this.random);
        return [{ ...base, type: 'dice_rolled', payload: { ...roll, ...(cmd.reason ? { reason: cmd.reason } : {}) } }];
      }

      case 'roll_stats': {
        if (me?.characterId) reject('You already have a character.');
        if (this.statPool(player)) reject('You have already rolled your ability scores. Use those six results.');
        return rollStatPool(this.random).map((roll, i) => ({
          ...base,
          type: 'dice_rolled' as const,
          payload: { ...roll, reason: `Ability score ${i + 1} of 6` },
        }));
      }

      case 'create_character': {
        if (me?.characterId) reject('You already have a character.');
        const input = cmd.character;
        const problem =
          checkStats(input.statMethod, input.stats, this.statPool(player) ?? undefined) ??
          checkProficiencies(findRole(state.setting, input.roleName), input.skills, input.saves);
        if (problem) reject(problem);
        const character = buildCharacter(input, {
          id: newId(),
          playerId: player.playerId,
          preset: state.setting,
          newItemId: newId,
        });
        this.db.update(players).set({ characterId: character.id }).where(eq(players.id, player.playerId)).run();
        return [{ ...base, type: 'character_created', payload: { character } }];
      }

      case 'edit_character': {
        ownCharacter(cmd.characterId);
        if (Object.keys(cmd.patch).length === 0) reject('Nothing to change.');
        return [{ ...base, type: 'character_edited', payload: { characterId: cmd.characterId, patch: cmd.patch } }];
      }

      case 'equip_item': {
        const c = ownCharacter(cmd.characterId);
        if (!c.inventory.some((i) => i.instanceId === cmd.instanceId)) reject('That item is not in this inventory.');
        return [
          {
            ...base,
            type: 'item_equipped',
            payload: { characterId: c.id, instanceId: cmd.instanceId, equipped: cmd.equipped },
          },
        ];
      }

      case 'submit_action': {
        const c = state.party.find((x) => x.playerId === player.playerId);
        if (!c) reject('Create a character first.');
        if (state.turn.pending.some((a) => a.playerId === player.playerId)) {
          reject('You already have an action waiting. Edit it instead.');
        }
        const settings = RoomSettingsSchema.parse(JSON.parse(this.room(player.roomId).settingsJson));
        if (settings.mode !== 'solo' && settings.turnMode === 'spotlight' && state.spotlight && state.spotlight !== player.playerId) {
          const who = state.players.find((p) => p.id === state.spotlight)?.displayName ?? 'another player';
          reject(`It's ${who}'s turn in the spotlight.`);
        }
        this.after.push(() => this.turns?.poke(player.roomId, { newAction: true }));
        return [{ ...base, type: 'action_submitted', payload: { playerId: player.playerId, characterId: c!.id, text: cmd.text } }];
      }

      case 'edit_action':
      case 'withdraw_action': {
        const a = state.turn.pending.find((x) => x.seq === cmd.actionSeq) ?? reject('That action has already been resolved.');
        if (a.playerId !== player.playerId && !player.isHost) reject('You can only change your own action.');
        this.after.push(() => this.turns?.poke(player.roomId, { newAction: cmd.type === 'edit_action' }));
        return cmd.type === 'edit_action'
          ? [{ ...base, type: 'action_edited', payload: { actionSeq: a.seq, text: cmd.text } }]
          : [{ ...base, type: 'action_withdrawn', payload: { actionSeq: a.seq } }];
      }

      case 'resolve_now':
        if (state.turn.phase === 'resolving') reject('The GM is already resolving a turn.');
        if (state.turn.pending.length === 0) reject('No actions to resolve yet.');
        this.after.push(() => this.turns?.resolveNow(player.roomId));
        return [];

      case 'retry_turn':
        if (this.turns?.status(player.roomId).status !== 'failed') reject('There is nothing to retry.');
        this.after.push(() => this.turns?.retry(player.roomId));
        return [];

      case 'void_last_turn': {
        if (state.turn.phase === 'resolving') reject('Wait for the current turn to finish (or retry it) first.');
        const turnId = this.turns?.lastNarratedTurn(player.roomId) ?? reject('There is no turn to rewind.');
        this.after.push(() => this.turns?.hold(player.roomId));
        return [{ ...base, type: 'turn_voided', payload: { turnId } }];
      }

      case 'start_session':
        if (state.session.active) reject('A session is already running.');
        return [{ ...base, type: 'session_started', payload: { number: state.session.number + 1 } }];

      case 'end_session':
        if (!state.session.active) reject('No session is running.');
        return [{ ...base, type: 'session_ended', payload: { number: state.session.number } }];

      case 'resolve_approval': {
        const ap = state.pendingApprovals.find((a) => a.id === cmd.approvalId) ?? reject('That request was already handled.');
        return [
          {
            ...base,
            type: 'approval_resolved',
            payload: {
              approvalId: ap.id,
              approved: cmd.approved,
              ...(cmd.approved && cmd.item && ap.kind === 'item' ? { item: { ...cmd.item, instanceId: ap.item!.instanceId } } : {}),
              ...(cmd.approved && cmd.ability && ap.kind === 'ability' ? { ability: { ...cmd.ability, id: ap.ability!.id } } : {}),
            },
          },
        ];
      }

      case 'propose_ability': {
        const c = ownCharacter(cmd.characterId);
        const ability = {
          id: newId(),
          name: cmd.ability.name,
          description: cmd.ability.description,
          recharge: cmd.ability.recharge,
          ...(cmd.ability.uses ? { uses: { current: cmd.ability.uses, max: cmd.ability.uses } } : {}),
        };
        if (player.isHost) {
          return [{ ...base, type: 'host_override', payload: { override: { kind: 'add_ability', characterId: c.id, ability } } }];
        }
        return [
          {
            ...base,
            type: 'approval_requested',
            payload: { approval: { id: newId(), kind: 'ability', characterId: c.id, ability, reason: cmd.basis || 'Workshopped by the player', requestedBy: 'player' } },
          },
        ];
      }

      case 'host_override':
        return [
          {
            ...base,
            type: 'host_override',
            payload: { override: cmd.override, ...(cmd.reason ? { reason: cmd.reason } : {}) },
          },
        ];
    }
  }

  private room(roomId: string) {
    return this.db.select().from(rooms).where(eq(rooms.id, roomId)).get() ?? reject('Room not found.');
  }

  /** The player's server-rolled ability scores, if they have rolled. */
  private statPool(player: AuthedPlayer): number[] | null {
    const rolls = this.store
      .loadEvents(player.roomId)
      .filter((e) => e.type === 'dice_rolled' && e.actorId === player.playerId && e.payload.notation === STAT_ROLL_NOTATION);
    if (rolls.length < 6) return null;
    return rolls.slice(0, 6).map((e) => (e.type === 'dice_rolled' ? e.payload.total : 0));
  }

  pruneLog(now = Date.now()): number {
    const cutoff = new Date(now - COMMAND_LOG_TTL_MS).toISOString();
    return this.db.delete(commandLog).where(lt(commandLog.createdAt, cutoff)).run().changes;
  }
}
