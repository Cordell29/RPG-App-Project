/**
 * Keeps track of the server's public address. With a Cloudflare Quick Tunnel the hostname
 * changes on every restart, so we ask cloudflared's metrics endpoint (`/quicktunnel` returns
 * `{"hostname": "…trycloudflare.com"}`) and tell the host's screen when it changes. A fixed
 * PUBLIC_URL (named tunnel, Tailscale Funnel, own domain) skips polling.
 */
export interface TunnelOptions {
  publicUrl?: string | null;
  metricsUrl?: string | null;
  /** Optional Discord-style webhook: receives `{ content }` when the link changes. */
  webhookUrl?: string | null;
  pollMs?: number;
  fetch?: typeof fetch;
  onChange?: (url: string | null) => void;
  log?: (msg: string, err?: unknown) => void;
}

export class TunnelWatcher {
  private url: string | null;
  private timer: NodeJS.Timeout | null = null;
  private readonly o: Required<Omit<TunnelOptions, 'publicUrl' | 'metricsUrl' | 'webhookUrl'>> & Pick<TunnelOptions, 'metricsUrl' | 'webhookUrl'>;

  constructor(opts: TunnelOptions = {}) {
    this.url = normalize(opts.publicUrl);
    this.o = {
      pollMs: 30_000,
      fetch: globalThis.fetch,
      onChange: () => {},
      log: () => {},
      ...opts,
    };
  }

  get current(): string | null {
    return this.url;
  }

  start() {
    if (this.url || !this.o.metricsUrl) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.o.pollMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One check of cloudflared's metrics endpoint. Returns the current URL. */
  async poll(): Promise<string | null> {
    if (!this.o.metricsUrl) return this.url;
    try {
      const res = await this.o.fetch(this.o.metricsUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return this.url;
      const body = (await res.json()) as { hostname?: unknown };
      const host = typeof body.hostname === 'string' ? body.hostname.trim() : '';
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return this.url;
      const next = `https://${host}`;
      if (next !== this.url) {
        this.url = next;
        this.o.log(`public link: ${next}`);
        this.o.onChange(next);
        await this.announce(next);
      }
    } catch {
      // cloudflared not up yet; try again next tick.
    }
    return this.url;
  }

  private async announce(url: string) {
    if (!this.o.webhookUrl) return;
    try {
      await this.o.fetch(this.o.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: `Tavern is online at ${url}` }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      this.o.log('share webhook failed', err);
    }
  }
}

function normalize(url: string | null | undefined): string | null {
  const u = url?.trim().replace(/\/+$/, '');
  return u && /^https?:\/\/[^\s/]+/.test(u) ? u : null;
}
