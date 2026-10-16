import type { Credentials } from './api.ts';

/**
 * Per-room player tokens live in this browser only. Storage can be unavailable
 * (private windows, blocked site data), so every access is guarded.
 */
const key = (roomId: string) => `tavern:creds:${roomId}`;

export function loadCreds(roomId: string): Credentials | null {
  try {
    const raw = localStorage.getItem(key(roomId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Credentials;
    return parsed.roomId === roomId && parsed.token ? parsed : null;
  } catch {
    return null;
  }
}

export function saveCreds(creds: Credentials) {
  try {
    localStorage.setItem(key(creds.roomId), JSON.stringify(creds));
  } catch {
    // Without storage the player stays signed in for this tab only.
  }
}

export function clearCreds(roomId: string) {
  try {
    localStorage.removeItem(key(roomId));
  } catch {
    /* ignore */
  }
}

export function loadPref<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`tavern:pref:${name}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function savePref(name: string, value: unknown) {
  try {
    localStorage.setItem(`tavern:pref:${name}`, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
