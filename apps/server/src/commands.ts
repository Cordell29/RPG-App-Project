import { randomInt } from 'node:crypto';
import {
  type Command,
  type CommandResult,
  type EventDraft,
  type GameEvent,
  type RandomInt,
  type RoomSettings,
  CommandSchema,
  HOST_COMMANDS,
  RoomSettingsSchema,
  DiceError,
  parseDice,
  rollDice,
} from '@tavern/shared';
import { and, eq, lt } from 'drizzle-orm';
import type { Db } from './db/connection.ts';
import type { EventStore } from './db/eventStore.ts';
import { commandLog, rooms } from './db/schema.ts';
import type { AuthedPlayer } from './rooms.ts';

export const COMMAND_LOG_TTL_MS = 24 * 60 * 60 * 1000;

class CommandRejected extends Error {}

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

    let appended: GameEvent[] = [];
    const result = this.db.$client.transaction((): CommandResult => {
      let res: CommandResult;
      try {
        if (cmd.type === 'set_room_mode') {
          newSettings = this.setMode(player.roomId, cmd.mode);
        } else {
          appended = this.store.append(player.roomId, this.toEvents(player, cmd));
        }
        res = { ok: true, seqs: appended.map((e) => e.seq) };
      } catch (err) {
        if (!(err instanceof CommandRejected || err instanceof DiceError)) throw err;
        res = { ok: false, error: err.message };
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
    return result;
  }

  private setMode(roomId: string, mode: RoomSettings['mode']): RoomSettings {
    const row = this.db.select().from(rooms).where(eq(rooms.id, roomId)).get();
    if (!row) throw new CommandRejected('Room not found.');
    const current = RoomSettingsSchema.parse(JSON.parse(row.settingsJson));
    const next = RoomSettingsSchema.parse({
      ...current,
      mode,
      turnWindowSeconds: mode === 'solo' ? 0 : current.turnWindowSeconds || 60,
    });
    this.db.update(rooms).set({ settingsJson: JSON.stringify(next) }).where(eq(rooms.id, roomId)).run();
    return next;
  }

  private toEvents(player: AuthedPlayer, cmd: Exclude<Command, { type: 'set_room_mode' }>): EventDraft[] {
    const base = { actorId: player.playerId, turnId: null };
    switch (cmd.type) {
      case 'send_chat':
        return [{ ...base, type: 'chat_message', payload: { playerId: player.playerId, text: cmd.text } }];
      case 'roll_dice': {
        const roll = rollDice(parseDice(cmd.notation), this.random);
        return [{ ...base, type: 'dice_rolled', payload: { ...roll, ...(cmd.reason ? { reason: cmd.reason } : {}) } }];
      }
    }
  }

  pruneLog(now = Date.now()): number {
    const cutoff = new Date(now - COMMAND_LOG_TTL_MS).toISOString();
    return this.db.delete(commandLog).where(lt(commandLog.createdAt, cutoff)).run().changes;
  }
}
