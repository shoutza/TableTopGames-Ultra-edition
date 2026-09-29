import type { LlmProvider, LlmRequest, LlmResult } from './port.ts';

/** Scripted provider for tests: each call is answered by the handler. */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly calls: LlmRequest[] = [];
  private readonly handler: (req: LlmRequest, callIndex: number) => LlmResult | Promise<LlmResult>;

  constructor(handler: (req: LlmRequest, callIndex: number) => LlmResult | Promise<LlmResult>) {
    this.handler = handler;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    this.calls.push(req);
    return this.handler(req, this.calls.length - 1);
  }
}

export function mockOk(value: unknown, usage = { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 60, reasoningTokens: 0 }): LlmResult {
  return { ok: true, text: typeof value === 'string' ? value : JSON.stringify(value), usage, latencyMs: 5, model: 'mock' };
}
