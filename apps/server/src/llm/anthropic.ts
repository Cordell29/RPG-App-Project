import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { LLMError, type LLMProvider, type StructuredRequest, type Usage } from './provider.ts';

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
}
