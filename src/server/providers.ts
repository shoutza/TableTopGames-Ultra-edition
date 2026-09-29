import { DEFAULT_CONTROLLER_CONFIG, type ControllerConfig } from '../contestants/controller.ts';
import { MockProvider, mockOk } from '../llm/mock.ts';
import { OpenAiProvider } from '../llm/openai.ts';
import type { LlmProvider } from '../llm/port.ts';
import { priceFor, type Price } from '../llm/prices.ts';
import type { ServerConfig } from './config.ts';

/** Builds the contestant provider from configuration. No API key → offline controller. */
export function contestantProvider(config: ServerConfig): LlmProvider | null {
  if (!config.openaiApiKey) return null;
  return new OpenAiProvider({ apiKey: config.openaiApiKey });
}

export function controllerConfig(config: ServerConfig): ControllerConfig {
  return { ...DEFAULT_CONTROLLER_CONFIG, model: config.contestantModel, reasoningEffort: config.contestantReasoningEffort };
}

export function contestantPrice(config: ServerConfig): Price | null {
  return priceFor(config.contestantModel, process.env);
}

/**
 * Offline stand-in for a model: reads the option ids from the packet and picks one
 * deterministically, occasionally answering badly to exercise validation and repair.
 */
export function scriptedProvider(): MockProvider {
  return new MockProvider((req, i) => {
    if (req.purpose === 'strategy') {
      const archetype = /- (\w+): /.exec(req.input)?.[1] ?? 'opportunist';
      return mockOk({ archetype, summary: `Scripted ${archetype} strategy.`, priorities: ['win'], avoid: [], plan: 'Follow the strategy.', reason: 'scripted' });
    }
    const decisionId = /DECISION (d\d+)/.exec(req.input)?.[1] ?? '';
    const ids = [...req.input.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1] as string);
    if (i % 17 === 5 && !req.input.includes('previous answer was rejected')) return mockOk({ decisionId, optionId: 'not-an-option', say: null, plan: null, strategyUpdate: null, reason: 'bad' });
    let h = 0;
    for (const ch of decisionId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const optionId = ids[h % Math.max(1, ids.length)] ?? 'pass';
    return mockOk({ decisionId, optionId, say: i % 5 === 0 ? 'Watch this.' : null, plan: 'Keep going.', strategyUpdate: null, reason: 'scripted choice' });
  });
}
