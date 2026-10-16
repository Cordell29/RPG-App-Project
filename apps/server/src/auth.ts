import { createHash, randomBytes, randomInt } from 'node:crypto';
import { INVITE_ALPHABET } from '@tavern/shared';
import { nanoid } from 'nanoid';

/** 32 random bytes, URL-safe. Shown to the user once; only the hash is stored. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newRoomId(): string {
  return nanoid(21);
}

export function newId(): string {
  return nanoid(16);
}

export function newInviteCode(): string {
  const pick = () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  const part = () => Array.from({ length: 4 }, pick).join('');
  return `${part()}-${part()}`;
}
