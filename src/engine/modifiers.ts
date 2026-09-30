import type { ModifierEvent, ModifierRule, ModifierWhere, ModifyOp } from '../schema/rules.ts';
import type { GameState, RuleCounter } from '../schema/state.ts';
import type { CompiledGame, CompiledRule } from './compile.ts';
import { evalCond, evalNum, type Bindings, type EvalEnv } from './eval.ts';
import { hasEffectiveTag, holdersOf } from './queries.ts';
import { RuleFault, UnknownValue, divide } from './util.ts';

/**
 * Before-modifiers transform (or prevent) a value on its way into an event: combat and effect
 * damage, resource changes from effects, shop prices, movement rolls and status durations. They are
 * pure apart from an optional `consume` (one status stack, or the item carrying the rule), apply in
 * (priority, position, holder) order, at most once each per event, and `prevent` ends the chain.
 */

export interface ModifierSubject {
  /** Entity the targetKind / targetTag filters test (the damaged, changed, buying or rolling entity). */
  entity?: string | undefined;
  resource?: string | undefined;
  direction?: 'gain' | 'loss' | undefined;
  status?: string | undefined;
  shopEntry?: string | undefined;
}

export interface ModStep {
  rule: CompiledRule;
  holder: string | undefined;
  from: number;
  to: number;
}

export interface ModifierOutcome {
  value: number;
  prevented: boolean;
  steps: ModStep[];
  faults: Array<{ rule: string; message: string }>;
}

function whereMatches(game: CompiledGame, state: GameState, w: ModifierWhere | undefined, subject: ModifierSubject): boolean {
  if (!w) return true;
  if (w.resource !== undefined && w.resource !== subject.resource) return false;
  if (w.direction !== undefined && w.direction !== subject.direction) return false;
  if (w.status !== undefined && w.status !== subject.status) return false;
  if (w.shopEntry !== undefined && w.shopEntry !== subject.shopEntry) return false;
  if (w.targetKind !== undefined || w.targetTag !== undefined) {
    const e = subject.entity !== undefined ? state.entities[subject.entity] : undefined;
    if (!e) return false;
    if (w.targetKind !== undefined && e.kind !== w.targetKind) return false;
    if (w.targetTag !== undefined && !hasEffectiveTag(game, e, w.targetTag)) return false;
  }
  return true;
}

function applyOp(env: EvalEnv, op: ModifyOp, b: Bindings, v: number): number {
  switch (op.op) {
    case 'add':
      return v + evalNum(env, op.amount, b);
    case 'scale':
      return divide(v * op.num, op.den, op.rounding);
    case 'clampTo': {
      let x = v;
      if (op.min !== undefined) x = Math.max(x, evalNum(env, op.min, b));
      if (op.max !== undefined) x = Math.min(x, evalNum(env, op.max, b));
      return x;
    }
    case 'prevent':
      return 0;
  }
}

/** Key for rule-limit counters: attached rules count per holder. */
export function counterKey(rule: CompiledRule, holder: string | undefined): string {
  return rule.owner && holder !== undefined ? `${rule.def.id}@${holder}` : rule.def.id;
}

export function turnKey(state: GameState): string {
  const between = state.phase === 'roundStart' || state.phase === 'roundEnd' || state.phase === 'gameOver';
  return `${state.round}:${between ? 'r' : state.turn.index}`;
}

/** Whether a rule's limits allow another firing now (per holder for attached rules). */
export function limitAllows(state: GameState, rule: CompiledRule, holder: string | undefined): boolean {
  const limits = rule.def.limits;
  if (!limits) return true;
  const c: RuleCounter | undefined = state.ruleCounters[counterKey(rule, holder)];
  if (!c) return true;
  if (limits.maxPerTurn !== undefined && c.turnKey === turnKey(state) && c.turnCount >= limits.maxPerTurn) return false;
  if (limits.maxPerRound !== undefined && c.round === state.round && c.roundCount >= limits.maxPerRound) return false;
  if (limits.maxPerGame !== undefined && c.total >= limits.maxPerGame) return false;
  if (limits.cooldownRounds !== undefined && c.lastRound + limits.cooldownRounds > state.round) return false;
  return true;
}

/** Records one firing against the rule's limits. */
export function recordFiring(state: GameState, rule: CompiledRule, holder: string | undefined): void {
  const key = counterKey(rule, holder);
  const tk = turnKey(state);
  const c = state.ruleCounters[key];
  state.ruleCounters[key] = {
    turnKey: tk,
    turnCount: c && c.turnKey === tk ? c.turnCount + 1 : 1,
    round: state.round,
    roundCount: c && c.round === state.round ? c.roundCount + 1 : 1,
    total: (c?.total ?? 0) + 1,
    lastRound: state.round,
  };
}

/**
 * Runs the modifier chain for one value. Pure: limits are checked but not counted and nothing is
 * consumed; the caller does both for the returned steps when the result is applied.
 */
export function computeModifiers(env: EvalEnv, on: ModifierEvent, b: Bindings, value: number, subject: ModifierSubject): ModifierOutcome {
  const rules = env.game.modifierIndex.get(on);
  const out: ModifierOutcome = { value, prevented: false, steps: [], faults: [] };
  if (!rules || rules.length === 0) return out;
  for (const rule of rules) {
    const def = rule.def as ModifierRule;
    // Nothing to prevent (e.g. a zero-damage hit): a consumable shield is not spent on it.
    if (def.modify.op === 'prevent' && out.value === 0) continue;
    if (!whereMatches(env.game, env.state, def.where, subject)) continue;
    const holders: Array<string | undefined> = rule.owner ? holdersOf(env.state, rule.owner) : [undefined];
    for (const holder of holders) {
      if (!limitAllows(env.state, rule, holder)) continue;
      const bb: Bindings = { ...b, amount: out.value, ...(holder !== undefined ? { $holder: holder } : {}) };
      try {
        if (def.conditions && !evalCond(env, def.conditions, bb)) continue;
        const next = applyOp(env, def.modify, bb, out.value);
        if (next === out.value && def.modify.op !== 'prevent') continue;
        out.steps.push({ rule, holder, from: out.value, to: next });
        out.value = next;
        if (def.modify.op === 'prevent') {
          out.prevented = true;
          return out;
        }
      } catch (err) {
        if (err instanceof RuleFault) out.faults.push({ rule: def.id, message: err.message });
        else if (!(err instanceof UnknownValue)) throw err;
      }
    }
  }
  return out;
}
