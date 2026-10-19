import { GoogleGenAI, type Interactions } from '@google/genai';
import { z } from 'zod';
import {
  type ChatRequest,
  type ChatResponse,
  LLMError,
  type LLMProvider,
  type LlmBlock,
  type LlmMessage,
  type StructuredRequest,
  type ToolSpec,
  type ToolUse,
  type Usage,
} from './provider.ts';
import { explainGoogleError } from './googleErrors.ts';

export interface GeminiTextConfig {
  apiKey: string;
  /** GM turns (default models/gemini-4-argon). */
  turnModel: string;
  /** Drafts, chapters, recaps. */
  summaryModel: string;
}

type Step = Interactions.Step;

/** Gemini steps ride inside our message history untouched, so thought signatures survive. */
const STEP = 'gemini_step';
const SUBMIT = 'submit_result';

const text = (t: string) => ({ type: 'text' as const, text: t });

/** JSON Schema from our tool specs, minus keys Gemini's function schema does not take. */
function cleanSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, ...rest } = schema;
  return rest;
}

/** Our provider-neutral history (Anthropic-shaped) → Interactions input steps. */
export function toSteps(messages: LlmMessage[]): Step[] {
  const steps: Step[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      steps.push(m.role === 'user' ? { type: 'user_input', content: [text(m.content)] } : { type: 'model_output', content: [text(m.content)] });
      continue;
    }
    for (const b of m.content) {
      if (b.type === STEP) steps.push(b.step as Step);
      else if (b.type === 'tool_result') {
        steps.push({
          type: 'function_result',
          call_id: String(b.tool_use_id),
          result: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
          ...(b.is_error ? { is_error: true } : {}),
        });
      } else if (b.type === 'text' && typeof b.text === 'string') {
        steps.push(m.role === 'user' ? { type: 'user_input', content: [text(b.text)] } : { type: 'model_output', content: [text(b.text)] });
      }
    }
  }
  return steps;
}

function stepText(steps: Step[]): string {
  return steps
    .filter((s): s is Extract<Step, { type: 'model_output' }> => s.type === 'model_output')
    .flatMap((s) => s.content ?? [])
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('');
}

function toUsage(u: Interactions.Usage | undefined, model: string, steps: Step[]): Usage {
  return {
    inputTokens: Math.max(0, (u?.total_input_tokens ?? 0) - (u?.total_cached_tokens ?? 0)) + (u?.total_tool_use_tokens ?? 0),
    // Thinking is billed as output.
    outputTokens: (u?.total_output_tokens ?? 0) + (u?.total_thought_tokens ?? 0),
    cacheReadTokens: u?.total_cached_tokens ?? 0,
    cacheWriteTokens: 0,
    model,
    webSearches: steps.filter((s) => s.type === 'google_search_call').length,
  };
}

/**
 * Gemini via the Interactions API, for running the GM on Google's models. Stateless
 * (store: false): the full history is sent each call, with Gemini's own steps echoed back
 * verbatim. Rules lookup uses Google Search (it cannot be limited to domains, so the
 * allowed sources are named in the system instruction instead).
 */
export class GeminiTextProvider implements LLMProvider {
  readonly name = 'gemini';
  private readonly ai: Pick<GoogleGenAI, 'interactions'>;
  private readonly config: GeminiTextConfig;

  /** `client` lets tests stand in for the Google SDK. */
  constructor(config: GeminiTextConfig, client?: Pick<GoogleGenAI, 'interactions'>) {
    this.config = config;
    this.ai = client ?? new GoogleGenAI({ apiKey: config.apiKey });
  }

  private model(tier: 'turn' | 'summary') {
    return tier === 'turn' ? this.config.turnModel : this.config.summaryModel;
  }

  private params(req: ChatRequest, extraTools: ToolSpec[] = [], toolChoice: 'auto' | 'any' = 'auto') {
    const fns = [...(req.tools ?? []), ...extraTools].map((t) => ({ type: 'function' as const, name: t.name, description: t.description, parameters: cleanSchema(t.input_schema) }));
    const tools: Interactions.Tool[] = [...fns, ...(req.webSearch ? [{ type: 'google_search' as const }] : [])];
    const sources = req.webSearch ? `\n\nWhen you look up rules, prefer these sources: ${req.webSearch.allowedDomains.join(', ')}. Search at most ${req.webSearch.maxUses} times.` : '';
    return {
      model: this.model(req.tier),
      input: toSteps(req.messages),
      system_instruction: req.system.map((b) => b.text).join('\n\n') + sources,
      store: false,
      ...(tools.length ? { tools } : {}),
      generation_config: {
        max_output_tokens: req.maxTokens ?? 16000,
        thinking_level: req.effort === 'low' ? 'low' : req.effort === 'high' ? 'high' : 'medium',
        ...(fns.length ? { tool_choice: toolChoice } : {}),
      },
    };
  }

  private toResponse(interaction: Interactions.Interaction, model: string): ChatResponse {
    if (interaction.status === 'failed' || interaction.status === 'cancelled') {
      throw new LLMError(`Gemini could not finish (${interaction.status}). The host can retry.`);
    }
    // Keep only what the model produced; our own inputs are already in the history.
    const steps = (interaction.steps ?? []).filter((s) => s.type !== 'user_input' && s.type !== 'function_result');
    const toolUses: ToolUse[] = steps
      .filter((s): s is Extract<Step, { type: 'function_call' }> => s.type === 'function_call')
      .map((s) => ({ id: s.id, name: s.name, input: s.arguments }));
    if (interaction.status === 'incomplete' && toolUses.length) throw new LLMError('The GM response was cut off. Retry the turn.');
    return {
      content: steps.map((step) => ({ type: STEP, step }) as LlmBlock),
      text: stepText(steps),
      toolUses,
      stopReason: toolUses.length ? 'tool_use' : interaction.status === 'incomplete' ? 'max_tokens' : 'end_turn',
      usage: toUsage(interaction.usage, model, steps),
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const params = this.params(req);
    try {
      const interaction = (await this.ai.interactions.create(params as Interactions.CreateModelInteractionParamsNonStreaming, req.signal ? ({ signal: req.signal } as never) : undefined)) as Interactions.Interaction;
      return this.toResponse(interaction, params.model);
    } catch (err) {
      throw wrap(err);
    }
  }

  async streamText(req: ChatRequest, onText: (delta: string) => void): Promise<ChatResponse> {
    const params = { ...this.params(req), stream: true as const };
    let full = '';
    let usage: Interactions.Usage | undefined;
    try {
      const stream = (await this.ai.interactions.create(params as Interactions.CreateModelInteractionParamsStreaming, req.signal ? ({ signal: req.signal } as never) : undefined)) as AsyncIterable<Interactions.InteractionSSEEvent>;
      for await (const ev of stream) {
        if (ev.event_type === 'step.delta' && ev.delta.type === 'text') {
          full += ev.delta.text;
          onText(ev.delta.text);
        } else if (ev.event_type === 'interaction.completed') {
          usage = ev.interaction.usage;
          if (!full) full = stepText(ev.interaction.steps ?? []);
        } else if (ev.event_type === 'error') {
          throw new LLMError(`Gemini error: ${ev.error?.message ?? 'unknown'}`);
        }
      }
    } catch (err) {
      throw wrap(err);
    }
    return { content: [{ type: 'text', text: full }], text: full, toolUses: [], stopReason: 'end_turn', usage: toUsage(usage, params.model, []) };
  }

  /** Structured output via one required function call whose parameters are the schema. */
  async structured<T>(req: StructuredRequest<T>): Promise<{ data: T; usage: Usage }> {
    const schema = z.toJSONSchema(req.schema as z.ZodType) as Record<string, unknown>;
    const chatReq: ChatRequest = {
      purpose: req.purpose,
      tier: req.tier,
      system: [{ text: `${req.system}\n\nAnswer by calling ${SUBMIT} exactly once.`, cache: false }],
      messages: [{ role: 'user', content: req.prompt }],
      maxTokens: req.maxTokens ?? 4000,
    };
    const params = this.params(chatReq, [{ name: SUBMIT, description: 'Submit the result.', input_schema: schema }], 'any');
    let res: ChatResponse;
    try {
      res = this.toResponse((await this.ai.interactions.create(params as Interactions.CreateModelInteractionParamsNonStreaming)) as Interactions.Interaction, params.model);
    } catch (err) {
      throw wrap(err);
    }
    const call = res.toolUses.find((t) => t.name === SUBMIT);
    let raw: unknown = call?.input;
    if (raw === undefined) {
      try {
        raw = JSON.parse(res.text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      } catch {
        throw new LLMError('The model returned output that did not match the schema.');
      }
    }
    const parsed = (req.schema as z.ZodType<T>).safeParse(raw);
    if (!parsed.success) throw new LLMError('The model returned output that did not match the schema.');
    return { data: parsed.data, usage: res.usage };
  }
}

function wrap(err: unknown): Error {
  if (err instanceof LLMError) return err;
  const e = err as { status?: number; message?: string };
  const plain = explainGoogleError(err);
  if (plain) return new LLMError(plain);
  if (typeof e?.status === 'number') return new LLMError(`AI service error ${e.status}: ${e.message ?? ''}`.trim());
  return err as Error;
}
