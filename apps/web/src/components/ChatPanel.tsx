import { LIMITS } from '@tavern/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { playerName, useRoom } from '../lib/store.ts';

/** Basic out-of-character chat. In-character speech goes in action prompts (Phase 4). */
export function ChatPanel() {
  const events = useRoom((s) => s.events);
  const state = useRoom((s) => s.state);
  const me = useRoom((s) => s.creds?.playerId);
  const send = useRoom((s) => s.send);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const lines = useMemo(
    () => events.filter((e) => e.type === 'chat_message' || e.type === 'player_joined' || e.type === 'player_left').slice(-200),
    [events],
  );

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText('');
    setError(null);
    const res = await send({ type: 'send_chat', text: trimmed });
    if (!res.ok) {
      setError(res.error);
      setText(trimmed);
    }
  }

  return (
    <section className="panel flex min-h-0 flex-col p-4" aria-labelledby="chat-heading">
      <h2 id="chat-heading" className="heading text-lg">
        Table chat
      </h2>
      <p className="text-xs text-muted">Out of character. What your character says or does goes in actions.</p>
      <ol ref={listRef} className="mt-2 max-h-[50vh] min-h-32 flex-1 space-y-1.5 overflow-y-auto pr-1 text-[0.95em]" aria-live="polite" data-testid="chat-log">
        {lines.length === 0 && <li className="text-sm text-muted">No messages yet.</li>}
        {lines.map((e) => {
          if (e.type === 'chat_message') {
            const mine = e.payload.playerId === me;
            return (
              <li key={e.seq} data-testid="chat-line">
                <span className={`font-semibold ${mine ? 'text-accent' : ''}`}>{playerName(state, e.payload.playerId)}:</span>{' '}
                <span className="break-words">{e.payload.text}</span>
              </li>
            );
          }
          const name = e.type === 'player_joined' ? e.payload.player.displayName : playerName(state, e.payload.playerId);
          return (
            <li key={e.seq} className="text-sm italic text-muted">
              {name} {e.type === 'player_joined' ? 'joined the table' : 'left the table'}
            </li>
          );
        })}
      </ol>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="chat-input" className="sr-only">
          Message
        </label>
        <input
          id="chat-input"
          className="field"
          placeholder="Say something to the table…"
          value={text}
          maxLength={LIMITS.chatLength}
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
        />
        <button type="submit" className="btn btn-primary" disabled={!text.trim()}>
          Send
        </button>
      </form>
      {error && (
        <p className="mt-1 text-sm text-bad" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
