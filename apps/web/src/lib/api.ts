import type { CharacterCreateInput, SettingPreset, StartChoice, Theme } from '@tavern/shared';

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

export interface ImportResult extends Credentials {
  hostToken: string;
  inviteCode: string;
  missingImages: number;
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
  createRoom: (body: { roomName: string; hostName: string; setting: SettingPreset; mode: 'solo' | 'group'; start?: StartChoice }) =>
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
  draftAbility: (creds: Credentials, characterId: string, description: string) =>
    request<{ name: string; description: string; uses?: number; recharge: 'at_will' | 'short_rest' | 'long_rest'; basis: string }>(
      'POST',
      `/api/rooms/${encodeURIComponent(creds.roomId)}/ability-draft`,
      { description, characterId },
      creds.token,
    ),
  importCampaign: (file: string) => request<ImportResult>('POST', '/api/import', { file }),
  seatLink: (creds: Credentials, playerId: string) =>
    request<{ playerId: string; token: string }>('POST', `/api/rooms/${encodeURIComponent(creds.roomId)}/seat-link`, { playerId }, creds.token),
  claimSeat: (roomId: string, playerId: string, token: string) =>
    request<Credentials>('POST', `/api/rooms/${encodeURIComponent(roomId)}/claim-seat`, { playerId, token }),
  /** Host export: fetched with the seat token, saved as a file by the caller. */
  async exportCampaign(creds: Credentials, images: boolean): Promise<{ blob: Blob; filename: string }> {
    const res = await fetch(`/api/rooms/${encodeURIComponent(creds.roomId)}/export${images ? '?images=1' : ''}`, {
      headers: { authorization: `Bearer ${creds.token}` },
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(data.error ?? `Export failed (${res.status})`, res.status);
    }
    const filename = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'campaign.tavern.json';
    return { blob: await res.blob(), filename };
  },
  claimHost: (roomId: string, hostToken: string) =>
    request<Credentials>('POST', `/api/rooms/${encodeURIComponent(roomId)}/claim-host`, { hostToken }),
};
