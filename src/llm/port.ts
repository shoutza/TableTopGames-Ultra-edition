/**
 * Provider port: the only contract the contestant layer knows about. Adapters (OpenAI, mock)
 * live behind it, so providers and models can be swapped without touching game code.
 */

export interface LlmUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface LlmRequest {
  purpose: 'decision' | 'strategy';
  model: string;
  /** Stable system-level instructions (kept first so providers can cache them). */
  instructions: string;
  /** The per-call packet. */
  input: string;
  schemaName: string;
  /** JSON Schema for the structured response. Output is still validated by the caller. */
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  timeoutMs: number;
  reasoningEffort?: string | null | undefined;
  /** Abort handle (e.g. an AbortSignal) for decisions invalidated while in flight. */
  signal?: { readonly aborted: boolean } | undefined;
}

export type LlmErrorKind = 'timeout' | 'refusal' | 'rate_limit' | 'server' | 'network' | 'bad_request' | 'auth' | 'incomplete' | 'aborted' | 'unknown';

export type LlmResult =
  | { ok: true; text: string; usage: LlmUsage; latencyMs: number; model: string }
  | { ok: false; error: LlmErrorKind; message: string; usage: LlmUsage | null; latencyMs: number };

export interface LlmProvider {
  readonly name: string;
  complete(request: LlmRequest): Promise<LlmResult>;
}

export const ZERO_USAGE: LlmUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
