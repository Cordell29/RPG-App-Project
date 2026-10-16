import type { SettingPreset, Theme } from '@tavern/shared';

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export interface Credentials {
  roomId: string;
  playerId: string;
  token: string;
}

export interface RoomSummary {
  roomId: string;
  name: string;
  mode: 'solo' | 'group';
  settingName: string;
  theme: Theme;
  playerCount: number;
  maxPlayers: number;
}

export const api = {
  presets: () => request<SettingPreset[]>('GET', '/api/presets'),
  draftSetting: (description: string) => request<SettingPreset>('POST', '/api/setting-draft', { description }),
  createRoom: (body: { roomName: string; hostName: string; setting: SettingPreset; mode: 'solo' | 'group' }) =>
    request<Credentials & { hostToken: string; inviteCode: string }>('POST', '/api/rooms', body),
  invite: (code: string) => request<RoomSummary>('GET', `/api/invite/${encodeURIComponent(code)}`),
  room: (roomId: string) => request<RoomSummary>('GET', `/api/rooms/${encodeURIComponent(roomId)}`),
  join: (roomId: string, displayName: string) =>
    request<Credentials>('POST', `/api/rooms/${encodeURIComponent(roomId)}/join`, { displayName }),
  claimHost: (roomId: string, hostToken: string) =>
    request<Credentials>('POST', `/api/rooms/${encodeURIComponent(roomId)}/claim-host`, { hostToken }),
};
