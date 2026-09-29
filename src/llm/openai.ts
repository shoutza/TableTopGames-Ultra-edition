import OpenAI from 'openai';
import type { LlmErrorKind, LlmProvider, LlmRequest, LlmResult, LlmUsage } from './port.ts';

/**
 * OpenAI Responses API adapter (structured output via text.format json_schema, strict).
 * Request/response shapes follow the installed `openai` SDK types. The default contestant model
 * is configured by TTG_CONTESTANT_MODEL (gpt-6-luna); model-specific parameters such as
 * reasoning effort are sent only when configured.
 */

type ResponsesClient = Pick<OpenAI, 'responses'>;

export interface OpenAiProviderOptions {
  apiKey: string;
  /** Injected for tests (e.g. a fake fetch). */
  fetch?: typeof fetch | undefined;
  baseURL?: string | undefined;
}

function usageOf(u: OpenAI.Responses.ResponseUsage | undefined | null): LlmUsage | null {
  if (!u) return null;
  return {
    inputTokens: u.input_tokens,
    cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: u.output_tokens,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

function classify(err: unknown): { kind: LlmErrorKind; message: string } {
  if (err instanceof OpenAI.APIUserAbortError) return { kind: 'aborted', message: 'request aborted' };
  if (err instanceof OpenAI.APIConnectionTimeoutError) return { kind: 'timeout', message: err.message };
  if (err instanceof OpenAI.APIConnectionError) return { kind: 'network', message: err.message };
  if (err instanceof OpenAI.RateLimitError) return { kind: 'rate_limit', message: err.message };
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) return { kind: 'auth', message: err.message };
  if (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.NotFoundError || err instanceof OpenAI.UnprocessableEntityError) {
    return { kind: 'bad_request', message: err.message };
  }
  if (err instanceof OpenAI.InternalServerError) return { kind: 'server', message: err.message };
  if (err instanceof OpenAI.APIError) return { kind: 'unknown', message: err.message };
  return { kind: 'unknown', message: err instanceof Error ? err.message : String(err) };
}

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly client: ResponsesClient;

  constructor(options: OpenAiProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      maxRetries: 1,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const started = Date.now();
    try {
      const response = await this.client.responses.create(
        {
          model: req.model,
          instructions: req.instructions,
          input: req.input,
          max_output_tokens: req.maxOutputTokens,
          store: false,
          text: { format: { type: 'json_schema', name: req.schemaName, schema: req.jsonSchema, strict: true } },
          ...(req.reasoningEffort ? { reasoning: { effort: req.reasoningEffort as OpenAI.ReasoningEffort } } : {}),
        },
        { timeout: req.timeoutMs, ...(req.signal ? { signal: req.signal as AbortSignal } : {}) },
      );
      const latencyMs = Date.now() - started;
      const usage = usageOf(response.usage);
      for (const item of response.output ?? []) {
        if (item.type !== 'message') continue;
        for (const part of item.content) {
          if (part.type === 'refusal') return { ok: false, error: 'refusal', message: part.refusal, usage, latencyMs };
        }
      }
      if (response.status === 'incomplete') {
        return { ok: false, error: 'incomplete', message: `incomplete: ${response.incomplete_details?.reason ?? 'unknown reason'}`, usage, latencyMs };
      }
      if (response.status !== undefined && response.status !== 'completed') {
        return { ok: false, error: 'server', message: `response status ${response.status}`, usage, latencyMs };
      }
      return { ok: true, text: response.output_text, usage: usage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }, latencyMs, model: response.model ?? req.model };
    } catch (err) {
      const { kind, message } = classify(err);
      return { ok: false, error: kind, message, usage: null, latencyMs: Date.now() - started };
    }
  }
}
