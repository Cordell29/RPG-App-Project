import type { z } from 'zod';

/**
 * Every LLM call goes through this interface so the engine never depends on a vendor,
 * and tests run offline against MockLLMProvider.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type LLMPurpose = 'setting_draft' | 'character_draft' | 'ability_draft' | 'gm_adjudicate' | 'gm_narrate';
export type Tier = 'summary' | 'turn';

export interface StructuredRequest<T> {
  /** What the call is for (logging, cost attribution, and mock routing). */
  purpose: LLMPurpose;
  /** 'summary' = the cheap model (drafts, recaps); 'turn' = the GM model. */
  tier: Tier;
  system: string;
  prompt: string;
  /** Schema the model must fill. Keep it simple: no min/max, the caller re-validates. */
  schema: z.ZodType<T>;
  maxTokens?: number;
}

export interface SystemBlock {
  text: string;
  /** Mark a prompt-cache breakpoint after this block. */
  cache: boolean;
}

/** Content blocks pass through untouched (thinking, fallback, … blocks must be echoed back as-is). */
export type LlmBlock = { type: string; [key: string]: unknown };
export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | LlmBlock[];
}
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface ChatRequest {
  purpose: LLMPurpose;
  tier: Tier;
  system: SystemBlock[];
  messages: LlmMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  /** Lower effort for fast, simple calls (narration). */
  effort?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}

export interface ChatResponse {
  /** Raw assistant content, to append to the conversation unchanged. */
  content: LlmBlock[];
  text: string;
  toolUses: ToolUse[];
  stopReason: string;
  usage: Usage;
}

export interface LLMProvider {
  readonly name: string;
  structured<T>(req: StructuredRequest<T>): Promise<{ data: T; usage: Usage }>;
  /** One request/response, with tools (the adjudication loop calls this repeatedly). */
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Streams text deltas to onText; resolves with the full response. */
  streamText(req: ChatRequest, onText: (delta: string) => void): Promise<ChatResponse>;
}

export class LLMError extends Error {
  override name = 'LLMError';
}
