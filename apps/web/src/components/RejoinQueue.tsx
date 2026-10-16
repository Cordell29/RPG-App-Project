import { useState } from 'react';
import { useRoom } from '../lib/store.ts';

/** Host-only: returning players (new link, new phone) asking to take back their character. */
export function RejoinQueue() {
  const { rejoinRequests, send } = useRoom();
  const [error, setError] = useState<string | null>(null);
  if (rejoinRequests.length === 0) return null;
  const decide = async (requestId: string, approve: boolean) => {
    setError(null);
    const res = await send({ type: 'resolve_rejoin', requestId, approve });
    if (!res.ok) setError(res.error);
  };
  return (
    <div className="space-y-2 rounded-[var(--t-radius)] border-2 border-accent p-3" data-testid="rejoin-queue">
      <h3 className="label mb-0">Returning players</h3>
      {rejoinRequests.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
          <p className="min-w-0 flex-1">
            Someone wants to play <strong>{r.characterName}</strong> ({r.playerName}'s seat) again.
          </p>
          <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" onClick={() => decide(r.id, true)}>
            Let them in
          </button>
          <button type="button" className="btn px-2 py-0.5 text-xs" onClick={() => decide(r.id, false)}>
            Not them
          </button>
        </div>
      ))}
      <p className="text-xs text-muted">Only approve if you know it's really them: their old device is signed out.</p>
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}
