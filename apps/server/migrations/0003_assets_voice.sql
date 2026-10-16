-- Phase 6: assets gain the 'voice' kind (AI narration audio) and a cost column.
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt.
CREATE TABLE assets_new (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL CHECK (kind IN ('portrait', 'scene', 'npc', 'voice')),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  path TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
INSERT INTO assets_new (id, room_id, kind, prompt, status, path, attempts, error, created_at)
  SELECT id, room_id, kind, prompt, status, path, attempts, error, created_at FROM assets;
DROP TABLE assets;
ALTER TABLE assets_new RENAME TO assets;
CREATE INDEX assets_status_idx ON assets(status);
CREATE INDEX assets_room_idx ON assets(room_id, created_at);
