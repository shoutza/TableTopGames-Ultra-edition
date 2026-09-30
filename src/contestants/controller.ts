import type { TradeOfferInput } from '../schema/trade.ts';
import type { LlmErrorKind, LlmProvider, LlmUsage } from '../llm/port.ts';
import type { Persona, Strategy } from '../schema/persona.ts';
import type { PublicGameInfo } from '../visibility/public-info.ts';
import type { ContestantView } from '../visibility/view.ts';
import { chooseHeuristic } from './heuristic.ts';
import type { ContestantMind } from './mind.ts';
import { buildDecisionPacket, buildStrategyPacket } from './packet.ts';
import {
  DECISION_SCHEMA_NAME,
  DecisionJsonSchema,
  DecisionResponseSchema,
  STRATEGY_SCHEMA_NAME,
  StrategyJsonSchema,
  StrategyResponseSchema,
  parseStructured,
} from './responses.ts';
import { ARCHETYPE_INFO, defaultStrategy, reviseStrategy } from './strategy.ts';

/**
 * Decision controller: builds a packet from the contestant's view, asks the model, validates the
 * answer against the offered options, retries once, and falls back to the deterministic player.
 * The game never waits on a failing provider.
 */

export interface ControllerConfig {
  model: string;
  reasoningEffort: string | null;
  timeoutMs: number;
  maxOutputTokens: number;
}

export const DEFAULT_CONTROLLER_CONFIG: ControllerConfig = { model: 'gpt-6-luna', reasoningEffort: null, timeoutMs: 20_000, maxOutputTokens: 600 };

export interface AttemptRecord {
  ok: boolean;
  errorKind: LlmErrorKind | 'invalid' | null;
  error: string | null;
  usage: LlmUsage | null;
  latencyMs: number;
}

export type DecisionSource = 'llm' | 'repaired' | 'fallback' | 'forced' | 'heuristic' | 'aborted';

export interface DecisionResult {
  optionId: string;
  say: string | null;
  plan: string | null;
  strategyUpdate: Strategy | null;
  /** Terms when the option is "trade" or a counteroffer. */
  trade: TradeOfferInput | null;
  reason: string;
  source: DecisionSource;
  attempts: AttemptRecord[];
  packetTokens: number;
  /** The exact packet sent (for the GM inspector and the call log). */
  packet: { instructions: string; input: string } | null;
}

/** Shared by all contestants of a match: trips after repeated provider failures. */
export class ProviderHealth {
  consecutiveFailures = 0;
  tripped = false;
  readonly threshold: number;
  constructor(threshold = 3) {
    this.threshold = threshold;
  }
  record(ok: boolean): void {
    if (ok) this.consecutiveFailures = 0;
    else if (++this.consecutiveFailures >= this.threshold) this.tripped = true;
  }
  reset(): void {
    this.consecutiveFailures = 0;
    this.tripped = false;
  }
}

export interface DecideInput {
  view: ContestantView;
  info: PublicGameInfo;
  mind: ContestantMind;
  persona: Persona;
  provider: LlmProvider | null;
  config: ControllerConfig;
  health: ProviderHealth;
  signal?: { readonly aborted: boolean } | undefined;
  /**
   * Checks an answer against the authoritative state without committing it; returns the engine's
   * (view-safe) reason when it would be refused. Used to give the model one repair attempt.
   */
  validate?: ((optionId: string, trade: TradeOfferInput | null) => string | null) | undefined;
}

/** Options whose answers must carry trade terms. */
export function needsTerms(optionId: string): boolean {
  return optionId === 'trade' || optionId === 'tr:counter';
}

const RETRYABLE: ReadonlySet<LlmErrorKind> = new Set(['timeout', 'rate_limit', 'server', 'network', 'incomplete', 'unknown']);

type OfflineInput = Pick<DecideInput, 'view' | 'info' | 'mind' | 'persona'>;

function heuristicResult(input: OfflineInput, source: DecisionSource, attempts: AttemptRecord[], packetTokens: number, packet: DecisionResult['packet']): DecisionResult {
  const { mind } = input;
  const choice = chooseHeuristic(input.view, input.info, input.persona, mind.strategy?.archetype ?? mind.candidates[0] ?? null, mind);
  // The fallback player answers a reconsideration flag too: it switches strategy when its plan no longer works.
  const strategyUpdate = mind.reconsider && mind.strategy ? reviseStrategy(input.info, input.view, input.persona, mind.strategy, mind.reconsider) : null;
  return { optionId: choice.optionId, say: choice.say ?? null, plan: null, strategyUpdate, trade: choice.trade ?? null, reason: choice.reason, source, attempts, packetTokens, packet };
}

function forcedResult(input: OfflineInput): DecisionResult | null {
  const options = input.view.decision?.options ?? [];
  if (options.length !== 1) return null;
  const only = options[0] as { id: string };
  return { optionId: only.id, say: null, plan: null, strategyUpdate: null, trade: null, reason: 'only option', source: 'forced', attempts: [], packetTokens: 0, packet: null };
}

/** The offline player's decision (headless simulations, no provider, tripped circuit breaker). */
export function decideOffline(input: OfflineInput): DecisionResult {
  if (!input.view.decision) throw new Error('no decision for this contestant');
  return forcedResult(input) ?? heuristicResult(input, 'heuristic', [], 0, null);
}

/**
 * A safe replacement when an answer turns out to be refused by the engine (e.g. trade terms that
 * no longer fit): the fallback player's choice without trading, or rejecting the offer.
 */
export function withoutTrade(input: OfflineInput, result: DecisionResult): DecisionResult {
  const decision = input.view.decision;
  if (!decision) throw new Error('no decision for this contestant');
  if (decision.kind === 'trade') return { ...result, optionId: 'tr:reject', trade: null, reason: 'the terms did not work out' };
  const view = { ...input.view, decision: { ...decision, options: decision.options.filter((o) => o.kind !== 'trade'), previews: decision.previews.filter((p) => p.kind !== 'trade') } };
  const choice = chooseHeuristic(view, input.info, input.persona, input.mind.strategy?.archetype ?? input.mind.candidates[0] ?? null, input.mind);
  return { ...result, optionId: choice.optionId, trade: null, reason: choice.reason, source: result.source === 'llm' || result.source === 'repaired' ? 'fallback' : result.source };
}

export async function decide(input: DecideInput): Promise<DecisionResult> {
  const decision = input.view.decision;
  if (!decision) throw new Error('no decision for this contestant');
  const forced = forcedResult(input);
  if (forced) return forced;
  if (!input.provider || input.mind.controller === 'heuristic' || input.health.tripped) return heuristicResult(input, 'heuristic', [], 0, null);

  const packet = buildDecisionPacket(input.info, input.view, input.mind, input.persona);
  const attempts: AttemptRecord[] = [];
  let extra = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (input.signal?.aborted) return { ...heuristicResult(input, 'aborted', attempts, packet.estimatedTokens, packet), source: 'aborted' };
    const res = await input.provider.complete({
      purpose: 'decision',
      model: input.config.model,
      instructions: packet.instructions,
      input: packet.input + extra,
      schemaName: DECISION_SCHEMA_NAME,
      jsonSchema: DecisionJsonSchema,
      maxOutputTokens: input.config.maxOutputTokens,
      timeoutMs: input.config.timeoutMs,
      reasoningEffort: input.config.reasoningEffort,
      signal: input.signal,
    });
    if (!res.ok) {
      attempts.push({ ok: false, errorKind: res.error, error: res.message, usage: res.usage, latencyMs: res.latencyMs });
      input.health.record(false);
      if (res.error === 'aborted') return { ...heuristicResult(input, 'aborted', attempts, packet.estimatedTokens, packet), source: 'aborted' };
      if (!RETRYABLE.has(res.error) || input.health.tripped) break;
      continue;
    }
    const parsed = parseStructured(DecisionResponseSchema, res.text);
    let problem: string | null = null;
    if (!parsed.ok) problem = parsed.error;
    else if (parsed.value.decisionId !== decision.id) problem = `decisionId must be "${decision.id}".`;
    else if (!decision.options.some((o) => o.id === parsed.value.optionId)) problem = `"${parsed.value.optionId}" is not one of the offered option ids.`;
    else if (needsTerms(parsed.value.optionId) && !parsed.value.trade) problem = `"${parsed.value.optionId}" needs trade terms in "trade".`;
    else problem = input.validate?.(parsed.value.optionId, needsTerms(parsed.value.optionId) ? parsed.value.trade : null) ?? null;
    if (problem !== null || !parsed.ok) {
      attempts.push({ ok: false, errorKind: 'invalid', error: problem, usage: res.usage, latencyMs: res.latencyMs });
      input.health.record(true); // the provider works; the answer was just unusable
      extra = `\n\nYour previous answer was rejected: ${problem} Answer again using one option id from the list above.`;
      continue;
    }
    attempts.push({ ok: true, errorKind: null, error: null, usage: res.usage, latencyMs: res.latencyMs });
    input.health.record(true);
    const v = parsed.value;
    let strategyUpdate: Strategy | null = null;
    if (v.strategyUpdate) {
      strategyUpdate = {
        archetype: v.strategyUpdate.archetype,
        summary: v.strategyUpdate.summary,
        priorities: v.strategyUpdate.priorities,
        avoid: input.mind.strategy?.avoid ?? [],
        adoptedAtRound: input.view.round,
        reason: v.strategyUpdate.reason,
      };
    }
    const trade = needsTerms(v.optionId) ? v.trade : null;
    return { optionId: v.optionId, say: v.say, plan: v.plan, strategyUpdate, trade, reason: v.reason, source: attempt === 0 ? 'llm' : 'repaired', attempts, packetTokens: packet.estimatedTokens, packet };
  }
  return heuristicResult(input, 'fallback', attempts, packet.estimatedTokens, packet);
}

/** Applies a decision's plan/strategy updates to the contestant's mind. */
export function applyToMind(mind: ContestantMind, result: DecisionResult, round: number): void {
  if (result.plan) {
    mind.plan = result.plan;
    mind.planRound = round;
  }
  if (result.strategyUpdate) {
    if (mind.strategy) mind.strategyHistory.push(mind.strategy);
    mind.strategy = result.strategyUpdate;
  }
  // A real decision (not a forced one) is the contestant's chance to react; the flags are answered.
  if (result.source !== 'forced' && result.source !== 'aborted') {
    if (mind.reconsider) {
      mind.reconsider = null;
      mind.lastReconsiderRound = round;
    }
    mind.keyMoment = null;
  }
}

export interface StrategyResult {
  strategy: Strategy;
  plan: string;
  source: 'llm' | 'repaired' | 'fallback' | 'heuristic';
  attempts: AttemptRecord[];
  packet: { instructions: string; input: string } | null;
}

/** Match-start strategy selection from the contestant's own candidates and view. */
export async function chooseStrategy(input: Omit<DecideInput, 'view'> & { view: ContestantView }): Promise<StrategyResult> {
  const first = input.mind.candidates[0] ?? 'opportunist';
  const fallback = (source: StrategyResult['source'], attempts: AttemptRecord[], packet: StrategyResult['packet']): StrategyResult => ({
    strategy: defaultStrategy(input.info, first, input.view.round, 'default for this personality'),
    plan: ARCHETYPE_INFO[first].priorities(input.info)[0] ?? '',
    source,
    attempts,
    packet,
  });
  if (!input.provider || input.mind.controller === 'heuristic' || input.health.tripped) return fallback('heuristic', [], null);
  const packet = buildStrategyPacket(input.info, input.view, input.mind, input.persona);
  const attempts: AttemptRecord[] = [];
  let extra = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await input.provider.complete({
      purpose: 'strategy',
      model: input.config.model,
      instructions: packet.instructions,
      input: packet.input + extra,
      schemaName: STRATEGY_SCHEMA_NAME,
      jsonSchema: StrategyJsonSchema,
      maxOutputTokens: input.config.maxOutputTokens,
      timeoutMs: input.config.timeoutMs,
      reasoningEffort: input.config.reasoningEffort,
      signal: input.signal,
    });
    if (!res.ok) {
      attempts.push({ ok: false, errorKind: res.error, error: res.message, usage: res.usage, latencyMs: res.latencyMs });
      input.health.record(false);
      if (!RETRYABLE.has(res.error) || input.health.tripped) break;
      continue;
    }
    const parsed = parseStructured(StrategyResponseSchema, res.text);
    const problem = !parsed.ok ? parsed.error : !input.mind.candidates.includes(parsed.value.archetype) ? `archetype must be one of: ${input.mind.candidates.join(', ')}.` : null;
    if (problem !== null || !parsed.ok) {
      attempts.push({ ok: false, errorKind: 'invalid', error: problem, usage: res.usage, latencyMs: res.latencyMs });
      input.health.record(true);
      extra = `\n\nYour previous answer was rejected: ${problem}`;
      continue;
    }
    attempts.push({ ok: true, errorKind: null, error: null, usage: res.usage, latencyMs: res.latencyMs });
    input.health.record(true);
    const v = parsed.value;
    return {
      strategy: { archetype: v.archetype, summary: v.summary, priorities: v.priorities, avoid: v.avoid, adoptedAtRound: input.view.round, reason: v.reason },
      plan: v.plan,
      source: attempt === 0 ? 'llm' : 'repaired',
      attempts,
      packet,
    };
  }
  return fallback('fallback', attempts, packet);
}
