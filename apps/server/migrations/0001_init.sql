-- Initial schema. Never edit a migration once released; add a new numbered file.

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host_token_hash TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  spend_cents INTEGER NOT NULL DEFAULT 0,
  spend_cap_cents INTEGER NOT NULL DEFAULT 500,
  created_at TEXT NOT NULL
);

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  display_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  is_host INTEGER NOT NULL DEFAULT 0,
  character_id TEXT,
  last_seen TEXT
);
CREATE INDEX players_room_idx ON players(room_id);

CREATE TABLE events (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_id TEXT,
  turn_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, seq)
) WITHOUT ROWID;

-- The event log is append-only and gapless per room, enforced by the database itself.
CREATE TRIGGER events_gapless BEFORE INSERT ON events
WHEN NEW.seq != (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE room_id = NEW.room_id)
BEGIN SELECT RAISE(ABORT, 'events.seq must be gapless per room'); END;

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE snapshots (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  seq INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  PRIMARY KEY (room_id, seq)
) WITHOUT ROWID;

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  status TEXT NOT NULL CHECK (status IN ('collecting', 'adjudicating', 'narrating', 'done', 'failed')),
  actions_json TEXT NOT NULL DEFAULT '[]',
  usage_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX turns_room_idx ON turns(room_id);

CREATE TABLE chronicle_chapters (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  level INTEGER NOT NULL CHECK (level IN (0, 1)),
  chapter_no INTEGER NOT NULL,
  from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, level, chapter_no)
) WITHOUT ROWID;

CREATE TRIGGER chronicle_immutable BEFORE UPDATE ON chronicle_chapters
BEGIN SELECT RAISE(ABORT, 'chronicle chapters are immutable'); END;

CREATE TABLE canon (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL CHECK (kind IN ('npc', 'location', 'faction', 'lore')),
  key TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  data_json TEXT NOT NULL DEFAULT '{}',
  updated_seq INTEGER NOT NULL,
  PRIMARY KEY (room_id, kind, key)
) WITHOUT ROWID;

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL CHECK (kind IN ('portrait', 'scene', 'npc')),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  path TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX assets_status_idx ON assets(status);

CREATE TABLE command_log (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  command_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, command_id)
) WITHOUT ROWID;
CREATE INDEX command_log_created_idx ON command_log(created_at);
