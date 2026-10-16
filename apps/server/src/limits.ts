/**
 * Small in-memory sliding-window rate limiter (one process, a handful of players; no
 * dependency needed). `hit` records an attempt and says whether it is allowed.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Returns 0 if allowed, else milliseconds until the next attempt would be. */
  hit(key: string): number {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return this.windowMs - (now - recent[0]!);
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.sweep(now);
    return 0;
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
  }
}

/** Per-IP limits on the public HTTP endpoints (requests per 10 minutes). */
export const HTTP_LIMITS = {
  createRoom: 10,
  importCampaign: 5,
  join: 30,
  draft: 30,
  claim: 30,
  general: 600,
} as const;

/** Client IP: Cloudflare's header when behind the tunnel, else the socket address. */
export function clientIp(headers: Record<string, string | string[] | undefined>, fallback: string): string {
  const cf = headers['cf-connecting-ip'];
  return (Array.isArray(cf) ? cf[0] : cf)?.trim() || fallback;
}
