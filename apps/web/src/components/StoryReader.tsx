import { useEffect, useRef } from 'react';
import { type StoryEntry, storyText } from '../lib/story.ts';
import { useRoom } from '../lib/store.ts';
import { CopyButton } from './CopyButton.tsx';
import { SpeakButton } from './StoryPanel.tsx';

/** "Story so far": every narrated turn in order, grouped by session. */
export function StoryReader({ entries, onClose }: { entries: StoryEntry[]; onClose: () => void }) {
  const roomName = useRoom((s) => s.state.roomName);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="panel m-auto h-[90vh] w-[min(48rem,calc(100vw-1rem))] max-w-none p-0 text-ink backdrop:bg-black/60"
      aria-labelledby="reader-h"
      data-testid="story-reader"
    >
      <div className="flex h-full flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-line p-4">
          <h2 id="reader-h" className="heading flex-1 text-xl">
            {roomName}: the story so far
          </h2>
          <CopyButton text={storyText(entries)} label="Copy text" />
          <button type="button" className="btn py-1 text-sm" onClick={() => ref.current?.close()}>
            Close
          </button>
        </header>
        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          {entries.map((en) =>
            en.kind === 'session' ? (
              <h3 key={`s${en.seq}`} className="heading border-b border-line pb-1 text-lg">
                Session {en.number} {en.started ? '' : '(end)'}
              </h3>
            ) : (
              <article key={en.turn.turnId} className="space-y-2">
                {en.turn.actions.map((a, i) => (
                  <p key={i} className="border-l-2 border-line pl-3 text-sm italic text-muted">
                    {a.who}: {a.text}
                  </p>
                ))}
                {en.turn.narration && (
                  <div className="flex items-start gap-2">
                    <p className="flex-1 whitespace-pre-wrap leading-relaxed">{en.turn.narration.text}</p>
                    <SpeakButton text={en.turn.narration.text} seq={en.turn.narration.seq} />
                  </div>
                )}
              </article>
            ),
          )}
        </div>
      </div>
    </dialog>
  );
}
