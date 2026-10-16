import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './db/connection.ts';
import { rooms, spend } from './db/schema.ts';
import {
  type ChatRequest,
  type ChatResponse,
  LLMError,
  type LLMProvider,
  type StructuredRequest,
  type Usage,
} from './llm/provider.ts';

const PriceSchema = z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() });
export const PricingSchema = z.object({
  models: z.record(z.string(), PriceSchema).refine((m) => 'default' in m, 'pricing needs a "default" model'),
  perUnit: z.object({ image: z.number(), voice: z.number(), webSearch: z.number().default(0.01) }),
});
export type Pricing = z.infer<typeof PricingSchema>;

export const PRICING_FILE = new URL('../../../config/pricing.json', import.meta.url);

export function loadPricing(file: URL | string = PRICING_FILE): Pricing {
  return PricingSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** Estimated USD for one LLM response, from its token usage and the model's list price. */
export function usageCost(pricing: Pricing, usage: Usage): number {
  const p = pricing.models[usage.model ?? ''] ?? pricing.models.default!;
  const perTok = (rate: number, n = 0) => (rate * n) / 1_000_000;
  return (
    perTok(p.input, usage.inputTokens) +
    perTok(p.output, usage.outputTokens) +
    perTok(p.cacheRead, usage.cacheReadTokens) +
    perTok(p.cacheWrite, usage.cacheWriteTokens) +
    (usage.webSearches ?? 0) * pricing.perUnit.webSearch
  );
}

export interface SpendCaps {
  /** Default daily cap for new rooms (each room stores its own in rooms.spend_cap_cents). */
  roomUsd: number;
  globalUsd: number;
}

export type SpendCheck = { ok: true } | { ok: false; scope: 'room' | 'global'; message: string };

const today = (now: Date) => now.toISOString().slice(0, 10);
const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Daily spend ledger (UTC days) behind the room and global caps. Estimates only: token usage
 * times list price, plus fixed per-image and per-clip costs. Billing consoles stay the backstop.
 */
export class SpendMeter {
  private readonly db: Db;
  readonly pricing: Pricing;
  readonly caps: SpendCaps;
  private readonly now: () => Date;

  constructor(opts: { db: Db; pricing: Pricing; caps: SpendCaps; now?: () => Date }) {
    this.db = opts.db;
    this.pricing = opts.pricing;
    this.caps = opts.caps;
    this.now = opts.now ?? (() => new Date());
  }

  record(roomId: string | null, category: string, costUsd: number) {
    if (!(costUsd > 0)) return;
    const micro = Math.round(costUsd * 1_000_000);
    this.db
      .insert(spend)
      .values({ roomId: roomId ?? '', day: today(this.now()), category, microUsd: micro, calls: 1 })
      .onConflictDoUpdate({
        target: [spend.roomId, spend.day, spend.category],
        set: { microUsd: sql`${spend.microUsd} + ${micro}`, calls: sql`${spend.calls} + 1` },
      })
      .run();
  }

  recordUsage(roomId: string | null, category: string, usage: Usage) {
    this.record(roomId, category, usageCost(this.pricing, usage));
  }

  roomToday(roomId: string): number {
    const row = this.db
      .select({ m: sql<number>`coalesce(sum(${spend.microUsd}), 0)` })
      .from(spend)
      .where(and(eq(spend.roomId, roomId), eq(spend.day, today(this.now()))))
      .get();
    return (row?.m ?? 0) / 1_000_000;
  }

  globalToday(): number {
    const row = this.db
      .select({ m: sql<number>`coalesce(sum(${spend.microUsd}), 0)` })
      .from(spend)
      .where(eq(spend.day, today(this.now())))
      .get();
    return (row?.m ?? 0) / 1_000_000;
  }

  /** The room's daily cap: set at creation from SPEND_CAP_ROOM_USD, adjustable by the host. */
  roomCap(roomId: string): number {
    const row = this.db.select({ c: rooms.spendCapCents }).from(rooms).where(eq(rooms.id, roomId)).get();
    return row ? row.c / 100 : this.caps.roomUsd;
  }

  /** Whether more AI work may start now. */
  check(roomId: string | null): SpendCheck {
    if (this.globalToday() >= this.caps.globalUsd) {
      return { ok: false, scope: 'global', message: `The server's daily AI budget (${usd(this.caps.globalUsd)}) is used up. It resets at midnight UTC.` };
    }
    if (roomId) {
      const cap = this.roomCap(roomId);
      if (this.roomToday(roomId) >= cap) {
        return { ok: false, scope: 'room', message: `This room's daily AI budget (${usd(cap)}) is used up, so the GM is resting. It resets at midnight UTC; the host can raise it in Backup & seats.` };
      }
    }
    return { ok: true };
  }

  summary(roomId: string) {
    return { roomTodayUsd: this.roomToday(roomId), roomCapUsd: this.roomCap(roomId), globalTodayUsd: this.globalToday(), globalCapUsd: this.caps.globalUsd };
  }
}

/**
 * Wraps any LLMProvider: refuses new calls once a cap is reached and records each call's
 * estimated cost against its room (requests carry roomId) and the global total.
 */
export class MeteredLLM implements LLMProvider {
  private readonly inner: LLMProvider;
  private readonly meter: SpendMeter;

  constructor(inner: LLMProvider, meter: SpendMeter) {
    this.inner = inner;
    this.meter = meter;
  }

  get name() {
    return this.inner.name;
  }

  /** GM turn calls are gated once, before the turn starts (TurnRunner), so a turn never stops halfway. */
  private gate(roomId: string | undefined, purpose: string) {
    if (purpose === 'gm_adjudicate' || purpose === 'gm_narrate') return;
    const c = this.meter.check(roomId ?? null);
    if (!c.ok) throw new LLMError(c.message);
  }

  async structured<T>(req: StructuredRequest<T>) {
    this.gate(req.roomId, req.purpose);
    const res = await this.inner.structured(req);
    this.meter.recordUsage(req.roomId ?? null, req.purpose, res.usage);
    return res;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.gate(req.roomId, req.purpose);
    const res = await this.inner.chat(req);
    this.meter.recordUsage(req.roomId ?? null, req.purpose, res.usage);
    return res;
  }

  async streamText(req: ChatRequest, onText: (delta: string) => void): Promise<ChatResponse> {
    // Narration finishes a turn whose adjudication already ran: never cut it off mid-turn.
    const res = await this.inner.streamText(req, onText);
    this.meter.recordUsage(req.roomId ?? null, req.purpose, res.usage);
    return res;
  }
}
