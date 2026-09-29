/**
 * Price table (USD per million tokens) used for cost estimates in reports. Values are
 * configuration, not facts the engine depends on: verify them against the provider's current
 * pricing and override with TTG_PRICE_INPUT / TTG_PRICE_CACHED_INPUT / TTG_PRICE_OUTPUT.
 */
export interface Price {
  input: number;
  cachedInput: number;
  output: number;
}

export const DEFAULT_PRICES: Record<string, Price> = {
  // Public listings seen 2026-09 (unverified against OpenAI's pricing page from this environment).
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5 },
};

export function priceFor(model: string, env: Record<string, string | undefined>): Price | null {
  const input = Number(env['TTG_PRICE_INPUT']);
  const output = Number(env['TTG_PRICE_OUTPUT']);
  if (Number.isFinite(input) && Number.isFinite(output) && env['TTG_PRICE_INPUT'] && env['TTG_PRICE_OUTPUT']) {
    const cached = Number(env['TTG_PRICE_CACHED_INPUT']);
    return { input, output, cachedInput: Number.isFinite(cached) && env['TTG_PRICE_CACHED_INPUT'] ? cached : input };
  }
  return DEFAULT_PRICES[model] ?? null;
}

export function estimateCost(price: Price | null, usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): number | null {
  if (!price) return null;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (uncached * price.input + usage.cachedInputTokens * price.cachedInput + usage.outputTokens * price.output) / 1_000_000;
}
