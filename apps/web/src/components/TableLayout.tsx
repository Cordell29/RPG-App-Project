import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { loadPref, savePref } from '../lib/storage.ts';
import { useRoom } from '../lib/store.ts';
import { useMediaQuery } from '../lib/useMediaQuery.ts';
import { CharacterCreator } from './CharacterCreator.tsx';
import { CharacterSheet } from './CharacterSheet.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { DicePanel } from './DicePanel.tsx';
import { PartyPanel } from './PartyPanel.tsx';

type Tab = 'story' | 'sheet' | 'dice' | 'party' | 'chat';
type SideTab = Extract<Tab, 'sheet' | 'party' | 'chat'>;

const ICONS: Record<Tab, ReactNode> = {
  story: <path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2V5Zm0 16a2 2 0 0 1 2-2h12v2H6" />,
  sheet: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0" />,
  dice: <path d="M12 2 21 7v10l-9 5-9-5V7l9-5Zm0 6-4 7h8l-4-7Z" />,
  party: <path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7-1a3 3 0 1 0 0-6M3 20a6 6 0 0 1 12 0m1-6a5 5 0 0 1 5 5" />,
  chat: <path d="M4 5h16v11H9l-5 4V5Z" />,
};
const LABELS: Record<Tab, string> = { story: 'Story', sheet: 'Sheet', dice: 'Dice', party: 'Party', chat: 'Chat' };
const SIDE_LABELS: Record<SideTab, string> = { sheet: 'Character', party: 'Party', chat: 'Chat' };

function Icon({ tab }: { tab: Tab }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[tab]}
    </svg>
  );
}

function StoryPanel() {
  const setting = useRoom((s) => s.state.setting);
  return (
    <section className="panel p-5" aria-labelledby="story-h">
      <h2 id="story-h" className="heading text-xl">
        The story
      </h2>
      <p className="mt-1 text-muted">{setting?.tone}</p>
      <p className="mt-3 text-sm text-muted">
        The AI Game Master arrives in the next build. For now, create your characters, chat and test the dice. Possible openings:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{setting?.openingHooks.map((h) => <li key={h}>{h}</li>)}</ul>
    </section>
  );
}

/** Your own sheet, or the creator if you have no character yet. */
function MySheet() {
  const state = useRoom((s) => s.state);
  const me = useRoom((s) => s.creds?.playerId);
  const mine = state.party.find((c) => c.playerId === me);
  return mine ? <CharacterSheet character={mine} setting={state.setting} canEdit /> : <CharacterCreator setting={state.setting} />;
}

function useUnreadChat(chatVisible: boolean) {
  const events = useRoom((s) => s.events);
  const me = useRoom((s) => s.creds?.playerId);
  const lastChat = useMemo(() => [...events].reverse().find((e) => e.type === 'chat_message')?.seq ?? 0, [events]);
  const [seen, setSeen] = useState(lastChat);
  useEffect(() => {
    if (chatVisible) setSeen(lastChat);
  }, [chatVisible, lastChat]);
  return useMemo(
    () => events.filter((e) => e.type === 'chat_message' && e.seq > seen && e.actorId !== me).length,
    [events, seen, me],
  );
}

function Badge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="absolute -top-1 right-1 min-w-5 rounded-full bg-accent px-1 text-center text-[0.7rem] font-bold leading-5 text-accent-ink" data-testid="unread">
      {count > 9 ? '9+' : count}
    </span>
  );
}

/**
 * Desktop: story and dice in the main column, a sticky right sidebar with Character / Party / Chat tabs.
 * Mobile: one panel at a time with a fixed bottom tab bar. Same components either way.
 */
export function TableLayout() {
  const desktop = useMediaQuery('(min-width: 1024px)');
  const hasCharacter = useRoom((s) => s.state.party.some((c) => c.playerId === s.creds?.playerId));
  const [side, setSide] = useState<SideTab>(() => loadPref<SideTab>('sideTab', 'sheet'));
  const [mobile, setMobile] = useState<Tab>(() => (hasCharacter ? 'story' : 'sheet'));
  const unread = useUnreadChat(desktop ? side === 'chat' : mobile === 'chat');

  const panel = (tab: Tab) => {
    switch (tab) {
      case 'story':
        return <StoryPanel />;
      case 'dice':
        return <DicePanel />;
      case 'chat':
        return <ChatPanel />;
      case 'sheet':
        return (
          <section className="panel p-4" aria-label="Your character">
            <MySheet />
          </section>
        );
      case 'party':
        return (
          <section className="panel p-4" aria-labelledby="party-h">
            <h2 id="party-h" className="heading mb-3 text-lg">
              The party
            </h2>
            <PartyPanel />
          </section>
        );
    }
  };

  if (desktop) {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,26rem)] gap-4">
        <div className="flex min-w-0 flex-col gap-4">
          {panel('story')}
          {panel('dice')}
        </div>
        <aside className="sticky top-4 flex max-h-[calc(100vh-2rem)] min-w-0 flex-col gap-2 self-start" aria-label="Sidebar">
          <div className="panel flex p-1" role="tablist" aria-label="Sidebar">
            {(Object.keys(SIDE_LABELS) as SideTab[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={side === t}
                onClick={() => {
                  setSide(t);
                  savePref('sideTab', t);
                }}
                className={`relative flex flex-1 items-center justify-center gap-1.5 rounded-[var(--t-radius)] px-2 py-1.5 text-sm font-semibold ${side === t ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink'}`}
              >
                <Icon tab={t} />
                {SIDE_LABELS[t]}
                {t === 'chat' && <Badge count={unread} />}
              </button>
            ))}
          </div>
          <div className="min-h-0 overflow-y-auto" role="tabpanel">
            {panel(side)}
          </div>
        </aside>
      </div>
    );
  }

  return (
    <>
      <div role="tabpanel">{panel(mobile)}</div>
      <nav
        className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
        style={{ boxShadow: '0 -4px 12px rgb(0 0 0 / 0.12)' }}
        aria-label="Table sections"
      >
        <div className="mx-auto flex max-w-xl" role="tablist">
          {(Object.keys(LABELS) as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={mobile === t}
              onClick={() => {
                setMobile(t);
                window.scrollTo({ top: 0 });
              }}
              className={`relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-semibold ${mobile === t ? 'text-accent' : 'text-muted'}`}
            >
              <Icon tab={t} />
              {LABELS[t]}
              {t === 'chat' && <Badge count={unread} />}
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}
