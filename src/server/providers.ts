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
    const all = [...req.input.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1] as string);
    const retry = req.input.includes('previous answer was rejected');
    // Plain options; trade proposals and counteroffers (which need terms) are scripted separately.
    const ids = all.filter((id) => id !== 'trade' && id !== 'tr:counter');
    const reconsider = /^RECONSIDER: (.*)$/m.exec(req.input)?.[1];
    const strategyUpdate = reconsider ? { archetype: 'opportunist', summary: 'Scripted revision: stay flexible and take the best value each turn.', priorities: ['best value each turn'], reason: reconsider.slice(0, 200) } : null;
    if (i % 17 === 5 && !retry) return mockOk({ decisionId, optionId: 'not-an-option', say: null, plan: null, strategyUpdate: null, reason: 'bad' });
    let h = 0;
    for (const ch of decisionId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const goods = (gold: number) => ({ resources: gold > 0 ? [{ resource: 'res.gold', amount: gold }] : [], items: [] });
    // Now and then: offer the first partner 1 Gold for a two-round truce.
    const partner = /Partners: [^\[]*\[(e\d+)\]/.exec(req.input)?.[1];
    if (!retry && all.includes('trade') && partner && h % 4 === 0) {
      const trade = { with: partner, give: goods(1), get: goods(0), promises: [{ by: 'them', kind: 'noAttack', rounds: 2, resource: null, amount: null }], message: 'A small gift for a little peace?' };
      return mockOk({ decisionId, optionId: 'trade', say: null, plan: 'Buy some peace.', strategyUpdate, trade, reason: 'scripted truce' });
    }
    // Sometimes answer an offer with a counteroffer asking for 1 Gold more.
    if (!retry && all.includes('tr:counter') && h % 3 === 0) {
      const trade = { with: null, give: goods(0), get: goods(2), promises: [{ by: 'me', kind: 'noAttack', rounds: 2, resource: null, amount: null }], message: 'Two, and you have a deal.' };
      return mockOk({ decisionId, optionId: 'tr:counter', say: 'Make it two.', plan: null, strategyUpdate, trade, reason: 'scripted counter' });
    }
    const optionId = ids[h % Math.max(1, ids.length)] ?? 'pass';
    return mockOk({ decisionId, optionId, say: i % 5 === 0 ? 'Watch this.' : null, plan: 'Keep going.', strategyUpdate, trade: null, reason: 'scripted choice' });
  });
}
