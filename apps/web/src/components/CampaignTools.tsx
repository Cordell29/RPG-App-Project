import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { useMedia } from '../lib/media.ts';
import { downloadBlob } from '../lib/story.ts';
import { useRoom } from '../lib/store.ts';
import { CopyButton } from './CopyButton.tsx';

/** Rejoin links the host has minted this visit (a link works once). */
function SeatRow({ playerId, name, isHost, here }: { playerId: string; name: string; isHost: boolean; here: boolean }) {
  const creds = useRoom((s) => s.creds);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="space-y-1 rounded-[var(--t-radius)] border border-line p-2" data-testid="seat">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={`h-2 w-2 rounded-full ${here ? 'bg-good' : 'bg-muted opacity-50'}`} aria-hidden="true" />
        <strong className="flex-1">{name}</strong>
        {isHost ? (
          <span className="text-xs text-muted">you (use your host link)</span>
        ) : (
          <button
            type="button"
            className="btn px-2 py-0.5 text-xs"
            onClick={async () => {
              if (!creds) return;
              if (!link && !confirm(`Make a new rejoin link for ${name}? Their current device will be signed out until they use it.`)) return;
              setError(null);
              try {
                const { token } = await api.seatLink(creds, playerId);
                setLink(`${location.origin}/r/${creds.roomId}?seat=${playerId}.${token}`);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {link ? 'New link' : 'Rejoin link'}
          </button>
        )}
      </div>
      {link && (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-raised px-2 py-1 text-xs" data-testid="seat-link">
            {link}
          </code>
          <CopyButton text={link} label="Copy" />
        </div>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </li>
  );
}

/**
 * Host-only: download the campaign file, repaint images missing after an import, rebuild
 * state after a desync, and hand out rejoin links for seats.
 */
export function CampaignTools({ onClose }: { onClose: () => void }) {
  const { creds, state, online, send, events } = useRoom();
  const restored = useMemo(() => events.some((e) => e.type === 'campaign_imported'), [events]);
  const media = useMedia();
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const failed = useMemo(() => [...media.status.values()].filter((s) => s === 'failed').length, [media]);

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setNote(null);
    try {
      setNote({ ok: true, text: await fn() });
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const exportFile = (images: boolean) =>
    run(images ? 'export-images' : 'export', async () => {
      if (!creds) throw new Error('Not signed in.');
      const { blob, filename } = await api.exportCampaign(creds, images);
      downloadBlob(filename, blob);
      return `Saved ${filename} (${(blob.size / 1024).toFixed(0)} KB). Keep it somewhere safe; Restore a campaign on the home page brings it back.`;
    });

  const command = (label: string, body: Parameters<typeof send>[0], done: string) =>
    run(label, async () => {
      const res = await send(body);
      if (!res.ok) throw new Error(res.error);
      return done;
    });

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="panel m-auto max-h-[90vh] w-[min(36rem,calc(100vw-1rem))] max-w-none overflow-y-auto p-0 text-ink backdrop:bg-black/60"
      aria-labelledby="tools-h"
      data-testid="campaign-tools"
    >
      <header className="flex items-center gap-2 border-b border-line p-4">
        <h2 id="tools-h" className="heading flex-1 text-xl">
          Backup &amp; seats
        </h2>
        <button type="button" className="btn py-1 text-sm" onClick={() => ref.current?.close()}>
          Close
        </button>
      </header>
      <div className="space-y-6 p-4">
        <section className="space-y-2">
          <h3 className="heading text-base">Download the campaign</h3>
          <p className="text-sm text-muted">
            One file with the whole story, every character, chapters, world notes and settings. The server also keeps a backup every night
            for 14 days.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => exportFile(false)}>
              {busy === 'export' ? 'Preparing…' : 'Download campaign file'}
            </button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => exportFile(true)}>
              {busy === 'export-images' ? 'Preparing…' : 'Include images'}
            </button>
          </div>
          <p className="text-xs text-muted">Without images the file is small; pictures can be repainted after restoring.</p>
        </section>

        {(failed > 0 || restored) && (
          <section className="space-y-2">
            <h3 className="heading text-base">Missing images</h3>
            <p className="text-sm text-muted">
              {failed > 0 ? `${failed} picture${failed === 1 ? '' : 's'} failed to paint. ` : ''}Pictures restored from a file without images,
              or that failed, can be repainted from the same descriptions (this counts toward image costs).
            </p>
            <button type="button" className="btn" disabled={!!busy} onClick={() => command('repaint', { type: 'repaint_missing' }, 'Repainting; pictures appear as they finish.')}>
              Repaint missing images
            </button>
          </section>
        )}

        <section className="space-y-2">
          <h3 className="heading text-base">Seats</h3>
          <p className="text-sm text-muted">
            If someone lost their seat (new phone, cleared browser) or you restored this campaign from a file, send them a rejoin link. Each
            link works once.
          </p>
          <ul className="space-y-1.5">
            {state.players
              .filter((p) => p.active)
              .map((p) => (
                <SeatRow
                  key={p.id}
                  playerId={p.id}
                  name={`${state.party.find((c) => c.playerId === p.id)?.name ?? p.displayName} (${p.displayName})`}
                  isHost={p.isHost}
                  here={online.includes(p.id)}
                />
              ))}
          </ul>
        </section>

        <section className="space-y-2">
          <h3 className="heading text-base">Something looks wrong?</h3>
          <p className="text-sm text-muted">
            Rebuild replays every event from the start and refreshes everyone's screen. Nothing is lost. Use it if players see different
            things.
          </p>
          <button type="button" className="btn" disabled={!!busy} onClick={() => command('rebuild', { type: 'rebuild_state' }, 'State rebuilt from the full history. Everyone has been refreshed.')}>
            {busy === 'rebuild' ? 'Rebuilding…' : 'Rebuild state'}
          </button>
        </section>

        {note && (
          <p className={`text-sm ${note.ok ? 'text-good' : 'text-bad'}`} role={note.ok ? 'status' : 'alert'} data-testid="tools-note">
            {note.text}
          </p>
        )}
      </div>
    </dialog>
  );
}
