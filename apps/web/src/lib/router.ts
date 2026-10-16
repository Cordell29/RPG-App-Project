import { useEffect, useState } from 'react';

/** Minimal client router: /, /new, /import, /join, /join/:code, /r/:roomId. */
export type Route =
  | { name: 'home' }
  | { name: 'new' }
  | { name: 'import' }
  | { name: 'join'; code: string | null; roomId: string | null }
  | { name: 'room'; roomId: string; hostToken: string | null; seat: string | null };

export function parseRoute(path: string, search: string): Route {
  const params = new URLSearchParams(search);
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'new') return { name: 'new' };
  if (parts[0] === 'import') return { name: 'import' };
  if (parts[0] === 'join') return { name: 'join', code: parts[1] ?? null, roomId: params.get('room') };
  if (parts[0] === 'r' && parts[1]) return { name: 'room', roomId: parts[1], hostToken: params.get('host'), seat: params.get('seat') };
  return { name: 'home' };
}

export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const read = () => parseRoute(location.pathname, location.search);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onPop = () => setRoute(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return route;
}

export function setTheme(theme: string) {
  document.documentElement.dataset.theme = theme;
}
