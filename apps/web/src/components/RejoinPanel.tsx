import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import { saveCreds } from '../lib/storage.ts';

type Seat = { characterId: string; characterName: string; playerName: string };

/**
 * "Played here before?" After the link changes (tunnel restart) or on a new device, a player
 * picks their character and waits for the host to let them back in.
 */
export function RejoinPanel({ roomId }: { roomId: string }) {
  const [open, setOpen] = useState(false);
  const [seats, setSeats] = useState<Seat[] | null>(null);
  const [waiting, setWaiting] = useState<{ requestId: string; secret: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || seats) return;
    api.seats(roomId).then(setSeats, (e: Error) => setError(e.message));
  }, [open, seats, roomId]);

  useEffect(() => {
    if (!waiting) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await api.rejoinStatus(roomId, waiting.requestId, waiting.secret);
        if (stop) return;
        if (res.status === 'approved' && res.creds) {
          saveCreds(res.creds);
          return navigate(`/r/${roomId}`, true);
        }
        if (res.status === 'denied') {
          setWaiting(null);
          return setError("The host didn't recognise that request.");
        }
        setTimeout(tick, 2000);
      } catch (e) {
        if (!stop) {
          setWaiting(null);
          setError((e as Error).message);
        }
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [waiting, roomId]);

  if (!open) {
    return (
      <button type="button" className="text-sm text-muted underline" onClick={() => setOpen(true)}>
        Played here before? Get your character back
      </button>
    );
  }
  return (
    <section className="panel space-y-3 p-5" aria-labelledby="rejoin-h" data-testid="rejoin-panel">
      <h2 id="rejoin-h" className="heading text-xl">
        Welcome back
      </h2>
      {waiting ? (
        <p className="text-sm" role="status" data-testid="rejoin-waiting">
          Waiting for the host to let <strong>{waiting.name}</strong> back in… Keep this page open.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted">Pick your character. The host gets a one-click request to let you back in.</p>
          {seats?.length === 0 && <p className="text-sm">There are no characters to reclaim in this room.</p>}
          <ul className="space-y-1.5">
            {seats?.map((s) => (
              <li key={s.characterId}>
                <button
                  type="button"
                  className="w-full rounded-[var(--t-radius)] border border-line p-2 text-left text-sm hover:border-accent"
                  onClick={async () => {
                    setError(null);
                    try {
                      const r = await api.requestRejoin(roomId, s.characterId);
                      setWaiting({ ...r, name: s.characterName });
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <strong>{s.characterName}</strong> <span className="text-muted">· {s.playerName}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && (
        <p className="text-sm text-bad" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
