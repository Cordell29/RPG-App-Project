import { useEffect, useState } from 'react';
import { CampaignTools } from '../components/CampaignTools.tsx';
import { CopyButton } from '../components/CopyButton.tsx';
import { TableLayout } from '../components/TableLayout.tsx';
import { api } from '../lib/api.ts';
import { navigate, setTheme } from '../lib/router.ts';
import { clearCreds, loadCreds, saveCreds } from '../lib/storage.ts';
import { useRoom } from '../lib/store.ts';

// One claim per host token, even if effects run twice (React strict mode): each claim
// rotates the host's seat token, so a second claim would invalidate the first.
const claims = new Map<string, Promise<void>>();
function claimHostOnce(roomId: string, hostToken: string) {
  let p = claims.get(hostToken);
  if (!p) {
    p = api.claimHost(roomId, hostToken).then(saveCreds);
    claims.set(hostToken, p);
  }
  return p;
}

/** Rejoin links from the host: `?seat=<playerId>.<token>`, redeemed once for a fresh token. */
function claimSeatOnce(roomId: string, seat: string) {
  let p = claims.get(seat);
  if (!p) {
    const [playerId = '', token = ''] = seat.split('.');
    p = api.claimSeat(roomId, playerId, token).then(saveCreds);
    claims.set(seat, p);
  }
  return p;
}

const STATUS_TEXT = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  online: 'Connected',
  reconnecting: 'Reconnecting…',
  unauthorized: 'Seat not recognised',
} as const;

export function Room({ roomId, hostToken, seat }: { roomId: string; hostToken: string | null; seat?: string | null }) {
  const { status, state, settings, inviteCode, isHost, connect, disconnect, send } = useRoom();
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (hostToken) {
        try {
          await claimHostOnce(roomId, hostToken);
        } catch (e) {
          if (!cancelled) setError((e as Error).message);
        }
        navigate(`/r/${roomId}`, true); // drop the host token from the address bar
        return;
      }
      if (seat) {
        try {
          await claimSeatOnce(roomId, seat);
        } catch (e) {
          if (!cancelled) setError((e as Error).message);
        }
        navigate(`/r/${roomId}`, true);
        return;
      }
      const creds = loadCreds(roomId);
      if (!creds) return navigate(`/join?room=${encodeURIComponent(roomId)}`, true);
      connect(creds);
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId, hostToken, seat, connect]);

  useEffect(() => () => disconnect(), [disconnect]);

  useEffect(() => {
    if (state.setting) setTheme(state.setting.theme);
  }, [state.setting]);

  if (status === 'unauthorized') {
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <div className="panel space-y-3 p-6">
          <h1 className="heading text-2xl">Your seat wasn't recognised</h1>
          <p className="text-sm text-muted">This browser's saved seat for this room is no longer valid.</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              clearCreds(roomId);
              disconnect();
              navigate(`/join?room=${encodeURIComponent(roomId)}`, true);
            }}
          >
            Join again
          </button>
        </div>
      </main>
    );
  }

  const inviteLink = inviteCode ? `${location.origin}/join/${inviteCode}` : '';
  const statusColour = status === 'online' ? 'bg-good' : status === 'reconnecting' ? 'bg-accent-2' : 'bg-muted';

  return (
    <div className="mx-auto max-w-6xl px-4 pt-4 pb-24 lg:pb-4">
      <header className="panel mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
        <div className="min-w-[min(100%,16rem)] flex-1">
          <h1 className="heading truncate text-2xl font-bold" data-testid="room-name">
            {state.roomName || '…'}
          </h1>
          <p className="text-sm text-muted">
            {state.setting?.name}
            {settings && <> · {settings.mode === 'solo' ? 'Solo' : 'Group'}</>}
            {isHost && <> · You're the host</>}
          </p>
        </div>
        {settings?.mode === 'group' && inviteCode && (
          <div className="flex items-center gap-2">
            <span className="label mb-0">Invite</span>
            <span className="heading text-lg tracking-widest" data-testid="room-invite-code">
              {inviteCode}
            </span>
            <CopyButton text={inviteLink} label="Copy link" />
          </div>
        )}
        {settings?.mode === 'solo' && isHost && (
          <button
            type="button"
            className="btn text-sm"
            onClick={async () => {
              const res = await send({ type: 'set_room_mode', mode: 'group' });
              if (!res.ok) setError(res.error);
            }}
          >
            Invite friends
          </button>
        )}
        {isHost && (
          <button type="button" className="btn text-sm" onClick={() => setTools(true)}>
            Backup &amp; seats
          </button>
        )}
        <div className="flex items-center gap-2 text-sm" role="status" data-testid="connection-status" data-status={status}>
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${statusColour}`} aria-hidden="true" />
          {STATUS_TEXT[status]}
        </div>
      </header>

      {error && (
        <p className="mb-3 text-sm text-bad" role="alert">
          {error}
        </p>
      )}

      <TableLayout />
      {tools && <CampaignTools onClose={() => setTools(false)} />}
    </div>
  );
}
