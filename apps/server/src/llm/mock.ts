import type { LLMProvider, StructuredRequest, Usage } from './provider.ts';

type Responder = (req: StructuredRequest<unknown>) => unknown;

/**
 * Offline provider. Queue scripted responses with `respond()`; when the queue is empty the
 * fallback responder (if any) answers, otherwise the call fails. Records every request.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';
  readonly calls: StructuredRequest<unknown>[] = [];
  private queue: Responder[] = [];

  private readonly fallback?: Responder;

  constructor(fallback?: Responder) {
    this.fallback = fallback;
  }

  respond(value: unknown | Responder) {
    this.queue.push(typeof value === 'function' ? (value as Responder) : () => value);
    return this;
  }

  async structured<T>(req: StructuredRequest<T>): Promise<{ data: T; usage: Usage }> {
    this.calls.push(req as StructuredRequest<unknown>);
    const responder = this.queue.shift() ?? this.fallback;
    if (!responder) throw new Error('MockLLMProvider: no scripted response');
    const data = responder(req as StructuredRequest<unknown>);
    if (data instanceof Error) throw data;
    return { data: data as T, usage: { inputTokens: req.prompt.length, outputTokens: 100 } };
  }
}
