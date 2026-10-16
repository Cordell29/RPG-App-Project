import type {
  ChatRequest,
  ChatResponse,
  LLMProvider,
  LlmBlock,
  StructuredRequest,
  ToolUse,
  Usage,
} from './provider.ts';

export type MockRequest = StructuredRequest<unknown> | ChatRequest;
/** A scripted reply: structured data, { tools, text } for chat, a string for streams, or an Error. */
export type MockReply = unknown;
type Responder = (req: MockRequest) => MockReply | Promise<MockReply>;

const USAGE: Usage = { inputTokens: 100, outputTokens: 50 };

/**
 * Offline provider. Queue replies with `respond()`; when the queue is empty the fallback
 * responder answers, otherwise the call fails. Records every request in `calls`.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';
  readonly calls: MockRequest[] = [];
  private queue: Responder[] = [];
  private readonly fallback?: Responder;
  /** Delay before each reply, to simulate latency in tests. */
  delayMs = 0;

  constructor(fallback?: Responder) {
    this.fallback = fallback;
  }

  respond(value: MockReply | Responder) {
    this.queue.push(typeof value === 'function' ? (value as Responder) : () => value);
    return this;
  }

  private async next(req: MockRequest): Promise<MockReply> {
    // Snapshot the conversation: callers keep appending to the same array.
    this.calls.push('messages' in req ? { ...req, messages: [...req.messages] } : req);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if ('signal' in req && req.signal?.aborted) throw new Error('aborted');
    const responder = this.queue.shift() ?? this.fallback;
    if (!responder) throw new Error(`MockLLMProvider: no scripted response for ${req.purpose}`);
    const reply = await responder(req);
    if (reply instanceof Error) throw reply;
    return reply;
  }

  async structured<T>(req: StructuredRequest<T>): Promise<{ data: T; usage: Usage }> {
    return { data: (await this.next(req as StructuredRequest<unknown>)) as T, usage: USAGE };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const reply = (await this.next(req)) as { tools?: { name: string; input: unknown }[]; text?: string; stopReason?: string };
    const toolUses: ToolUse[] = (reply.tools ?? []).map((t, i) => ({ id: `tu_${this.calls.length}_${i}`, name: t.name, input: t.input }));
    const content: LlmBlock[] = [
      ...(reply.text ? [{ type: 'text', text: reply.text }] : []),
      ...toolUses.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })),
    ];
    return { content, text: reply.text ?? '', toolUses, stopReason: reply.stopReason ?? (toolUses.length ? 'tool_use' : 'end_turn'), usage: USAGE };
  }

  async streamText(req: ChatRequest, onText: (delta: string) => void): Promise<ChatResponse> {
    const text = String(await this.next(req));
    for (const chunk of text.match(/[\s\S]{1,24}/g) ?? []) onText(chunk);
    return { content: [{ type: 'text', text }], text, toolUses: [], stopReason: 'end_turn', usage: USAGE };
  }
}
