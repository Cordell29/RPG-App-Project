import type { z } from 'zod';

/**
 * Every LLM call goes through this interface so the engine never depends on a vendor,
 * and tests run offline against MockLLMProvider. GM turn methods are added in Phase 4.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface StructuredRequest<T> {
  /** 'summary' = the cheap model (drafts, recaps); 'turn' = the GM model. */
  tier: 'summary' | 'turn';
  system: string;
  prompt: string;
  /** Schema the model must fill. Keep it simple: no min/max, the caller re-validates. */
  schema: z.ZodType<T>;
  maxTokens?: number;
}

export interface LLMProvider {
  readonly name: string;
  structured<T>(req: StructuredRequest<T>): Promise<{ data: T; usage: Usage }>;
}

export class LLMError extends Error {
  override name = 'LLMError';
}
