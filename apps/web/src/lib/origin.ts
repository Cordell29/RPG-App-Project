import { useEffect, useState } from 'react';
import { useRoom } from './store.ts';

/**
 * Base URL for links people share. Behind a Cloudflare Quick Tunnel the host may be looking at
 * the app on localhost while friends need the trycloudflare.com address, so ask the server.
 */
let cached: Promise<string | null> | null = null;
function fetchPublicUrl() {
  cached ??= fetch('/api/server-info')
    .then((r) => (r.ok ? (r.json() as Promise<{ publicUrl: string | null }>) : { publicUrl: null }))
    .then((d) => d.publicUrl)
    .catch(() => null);
  return cached;
}

export function usePublicOrigin(): string {
  const live = useRoom((s) => s.publicUrl);
  const [fetched, setFetched] = useState<string | null>(null);
  useEffect(() => {
    void fetchPublicUrl().then(setFetched);
  }, []);
  return live ?? fetched ?? location.origin;
}
