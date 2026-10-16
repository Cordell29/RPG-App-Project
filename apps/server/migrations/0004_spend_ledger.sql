-- Phase 8: daily spend ledger for the room and global caps. Amounts in micro-dollars
-- (1/1,000,000 USD) so small token costs add up without rounding to zero.
-- room_id '' = spend not tied to a room (e.g. drafting a custom setting).
CREATE TABLE spend (
  room_id TEXT NOT NULL,
  day TEXT NOT NULL,
  category TEXT NOT NULL,
  micro_usd INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, day, category)
);
CREATE INDEX spend_day_idx ON spend(day);
