import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  type ChatRequest,
  type ChatResponse,
  LLMError,
  type LLMProvider,
  type LlmBlock,
  type StructuredRequest,
  type ToolUse,
  type Usage,
} from './provider.ts';

export interface AnthropicConfig {
  apiKey: string;
  turnModel: string;
  summaryModel: string;
  timeoutMs?: number;
}

/** Real provider. Only constructed when ANTHROPIC_API_KEY is set; model IDs come from env. */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  private readonly config: AnthropicConfig;

  constructor(config: AnthropicConfig) {
    this.config = config;
    this.client = new Anthropic({ apiKey: config.apiKey, timeout: config.timeoutMs ?? 60_000, maxRetries: 2 });
  }

  async structured<T>(req: StructuredRequest<T>): Promise<{ data: T; usage: Usage }> {
    const model = req.tier === 'turn' ? this.config.turnModel : this.config.summaryModel;
    let response;
    try {
      response = await this.client.messages.parse({
        model,
        max_tokens: req.maxTokens ?? 4000,
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }],
        output_config: { format: zodOutputFormat(req.schema) },
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw new LLMError(`Anthropic API error ${err.status}: ${err.message}`);
      throw err;
    }
    if (response.stop_reason === 'refusal') throw new LLMError('The model declined this request.');
    if (response.stop_reason === 'max_tokens') throw new LLMError('The model ran out of room; try a shorter description.');
    if (response.parsed_output == null) throw new LLMError('The model returned output that did not match the schema.');
    return {
      data: response.parsed_output as T,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }

  private params(req: ChatRequest) {
    const model = req.tier === 'turn' ? this.config.turnModel : this.config.summaryModel;
    const custom = req.tools?.map((t, i, all) => ({
      ...t,
      // One breakpoint after the (stable) tool list caches tools + nothing volatile.
      ...(i === all.length - 1 && !req.webSearch ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));
    const search = req.webSearch
      ? [
          {
            type: 'web_search_20260209' as const,
            name: 'web_search' as const,
            max_uses: req.webSearch.maxUses,
            allowed_domains: req.webSearch.allowedDomains,
            cache_control: { type: 'ephemeral' as const },
          },
        ]
      : [];
    const tools = [...(custom ?? []), ...search];
    return {
      model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system.map((b) => ({ type: 'text' as const, text: b.text, ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {}) })),
      messages: req.messages as Anthropic.Beta.BetaMessageParam[],
      ...(tools?.length ? { tools: tools as Anthropic.Beta.BetaToolUnion[], tool_choice: { type: 'auto' as const } } : {}),
      ...(req.effort ? { output_config: { effort: req.effort } } : {}),
      // Server-side fallback: if a safety classifier declines, Anthropic re-runs the request
      // on its recommended fallback model instead of returning a refusal.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default' as const,
    };
  }

  private toResponse(msg: Anthropic.Beta.BetaMessage): ChatResponse {
    if (msg.stop_reason === 'refusal') throw new LLMError('The model declined to continue this scene. The host can retry or rewind.');
    const content = msg.content as unknown as LlmBlock[];
    const toolUses: ToolUse[] = msg.content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
    if (msg.stop_reason === 'max_tokens' && toolUses.length) throw new LLMError('The GM response was cut off. Retry the turn.');
    const text = msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      content,
      text,
      toolUses,
      stopReason: msg.stop_reason ?? 'end_turn',
      usage: {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    try {
      const msg = await this.client.beta.messages.create(this.params(req), { signal: req.signal });
      return this.toResponse(msg);
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async streamText(req: ChatRequest, onText: (delta: string) => void): Promise<ChatResponse> {
    try {
      const stream = this.client.beta.messages.stream(this.params(req), { signal: req.signal });
      stream.on('text', (delta) => onText(delta));
      return this.toResponse(await stream.finalMessage());
    } catch (err) {
      throw this.wrap(err);
    }
  }

  private wrap(err: unknown): Error {
    if (err instanceof LLMError) return err;
    if (err instanceof Anthropic.RateLimitError) return new LLMError('The AI service is rate-limiting us. Wait a moment, then retry.');
    if (err instanceof Anthropic.APIError) return new LLMError(`AI service error ${err.status ?? ''}: ${err.message}`.trim());
    return err as Error;
  }
}
