-- Addendum A6: short invite codes alongside the room link.
ALTER TABLE rooms ADD COLUMN invite_code TEXT;
CREATE UNIQUE INDEX rooms_invite_code_idx ON rooms(invite_code);
