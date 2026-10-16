import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Typed mirror of migrations/*.sql for Drizzle queries.
// test/db.test.ts fails if the two drift apart.

export const rooms = sqliteTable(
  'rooms',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    inviteCode: text('invite_code'),
    hostTokenHash: text('host_token_hash').notNull(),
    settingsJson: text('settings_json').notNull().default('{}'),
    spendCents: integer('spend_cents').notNull().default(0),
    spendCapCents: integer('spend_cap_cents').notNull().default(500),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('rooms_invite_code_idx').on(t.inviteCode)],
);

export const players = sqliteTable(
  'players',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id),
    displayName: text('display_name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    isHost: integer('is_host', { mode: 'boolean' }).notNull().default(false),
    characterId: text('character_id'),
    lastSeen: text('last_seen'),
  },
  (t) => [index('players_room_idx').on(t.roomId)],
);

export const events = sqliteTable(
  'events',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    actorId: text('actor_id'),
    turnId: text('turn_id'),
    payloadJson: text('payload_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.seq] })],
);

export const snapshots = sqliteTable(
  'snapshots',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id),
    seq: integer('seq').notNull(),
    stateJson: text('state_json').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.seq] })],
);

export const turns = sqliteTable(
  'turns',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id),
    status: text('status', { enum: ['collecting', 'adjudicating', 'narrating', 'done', 'failed'] }).notNull(),
    actionsJson: text('actions_json').notNull().default('[]'),
    usageJson: text('usage_json'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('turns_room_idx').on(t.roomId)],
);

export const chronicleChapters = sqliteTable(
  'chronicle_chapters',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id),
    level: integer('level').notNull(),
    chapterNo: integer('chapter_no').notNull(),
    fromSeq: integer('from_seq').notNull(),
    toSeq: integer('to_seq').notNull(),
    summary: text('summary').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.level, t.chapterNo] })],
);

export const canon = sqliteTable(
  'canon',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id),
    kind: text('kind', { enum: ['npc', 'location', 'faction', 'lore'] }).notNull(),
    key: text('key').notNull(),
    aliasesJson: text('aliases_json').notNull().default('[]'),
    dataJson: text('data_json').notNull().default('{}'),
    updatedSeq: integer('updated_seq').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.kind, t.key] })],
);

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id),
    kind: text('kind', { enum: ['portrait', 'scene', 'npc', 'voice'] }).notNull(),
    prompt: text('prompt').notNull(),
    status: text('status', { enum: ['pending', 'ready', 'failed'] }).notNull(),
    path: text('path'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    costCents: integer('cost_cents').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('assets_status_idx').on(t.status), index('assets_room_idx').on(t.roomId, t.createdAt)],
);

export const commandLog = sqliteTable(
  'command_log',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id),
    commandId: text('command_id').notNull(),
    resultJson: text('result_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.commandId] }), index('command_log_created_idx').on(t.createdAt)],
);

export const allTables = {
  rooms,
  players,
  events,
  snapshots,
  turns,
  chronicleChapters,
  canon,
  assets,
  commandLog,
};
