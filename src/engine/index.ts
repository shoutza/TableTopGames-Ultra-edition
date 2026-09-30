import { GameDefinitionSchema, type GameDefinition } from '../schema/definition.ts';
import { CompileError, compileGame, type CompiledGame, type Diagnostic } from './compile.ts';

/** Public engine API. Everything is synchronous and deterministic. */

export { compileGame, CompileError, findRuleCycles, TRIGGER_BINDINGS, MODIFIER_BINDINGS } from './compile.ts';
export type { CompiledGame, CompiledRule, Diagnostic, RuleOwner } from './compile.ts';
export type { FiringRecord, FaultRecord } from './context.ts';
export type { OpOutcome } from './resolve.ts';
export { createMatch, advance, answerDecision, nextStepKind, checkVictory, rankContestants } from './turn.ts';
export type { DecisionAnswer, MatchSetup, StepKind } from './turn.ts';
export { moveOptions, mainOptions, choiceOptions, buyPrice, actionAvailable, actionTargets, attackTargets, CheckEnv } from './decisions.ts';
export { applyGmCommand } from './gm.ts';
export { GM } from './effects.ts';
export { dealObjectives, assignObjective } from './objectives.ts';
export {
  canProposeTrade,
  tradePartners,
  termsFromOffer,
  deliveryProblem,
  termsView,
  isTradeableResource,
  isTradeableItem,
  openCommitments,
  TRADE_LIMITS,
} from './trade.ts';
export type { TradeOfferInput, GoodsInput, PromiseInput } from './trade.ts';
export {
  effectiveValue,
  effectiveTags,
  hasEffectiveTag,
  hasCapability,
  suppressedCapabilities,
  activeContestantId,
  reachableSpaces,
  shortestPath,
  orderedEntityIds,
  holdersOf,
} from './queries.ts';
export { computeModifiers } from './modifiers.ts';
export type { ModifierSubject, ModStep } from './modifiers.ts';
export {
  describeEvent,
  describeRule,
  describeEffects,
  describeEffect,
  describeCond,
  describeTrigger,
  describeStatus,
  describeCapabilityLoss,
  describeObjective,
  describeObjectiveGoal,
  describePromise,
  describeTerms,
  makeNames,
  namesFor,
} from './explain.ts';
export type { Names, NameSource } from './explain.ts';
export { damageFor, fightOdds, spinChance, formatPercent } from './combat.ts';
export type { FightOdds, FightInput, DamageSettings } from './combat.ts';
export { cloneJson } from './util.ts';

export type LoadResult = { ok: true; game: CompiledGame } | { ok: false; errors: string[]; diagnostics: Diagnostic[] };

/** Validates untrusted JSON as a game definition and compiles it. */
export function loadGame(json: unknown): LoadResult {
  const parsed = GameDefinitionSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      diagnostics: [],
    };
  }
  try {
    return { ok: true, game: compileGame(parsed.data) };
  } catch (err) {
    if (err instanceof CompileError) {
      return { ok: false, errors: err.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message), diagnostics: err.diagnostics };
    }
    throw err;
  }
}

export type { GameDefinition };
