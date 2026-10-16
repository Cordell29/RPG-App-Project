import type { CharacterCreateInput, SettingPreset, Theme } from '@tavern/shared';

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    method,
    headers,
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
  draftCharacter: (creds: Credentials, description: string) =>
    request<CharacterCreateInput>(
      'POST',
      `/api/rooms/${encodeURIComponent(creds.roomId)}/character-draft`,
      { description },
      creds.token,
    ),
  claimHost: (roomId: string, hostToken: string) =>
    request<Credentials>('POST', `/api/rooms/${encodeURIComponent(roomId)}/claim-host`, { hostToken }),
};
