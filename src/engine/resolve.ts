import type { EventCause, GameEvent, GameState } from '../schema/state.ts';
import type { CompiledGame, CompiledRule } from './compile.ts';
import { OpContext, type FaultRecord, type FiringRecord } from './context.ts';
import { applyEffects, handleDefeat } from './effects.ts';
import { evalCond, type Bindings } from './eval.ts';
import { BudgetExceeded, InvalidInput, RuleFault, cloneJson } from './util.ts';

/**
 * Operations, transactions and the reaction cascade.
 *
 * - An operation works on a private copy of the state; it commits only if it finishes.
 * - A firing's effects all complete before any reaction to them runs.
 * - Reactions run depth-first, ordered by (priority, ruleset position).
 * - Conditions are evaluated when the rule is about to run.
 * - A faulting firing is rolled back on its own; exceeding a budget aborts the whole operation.
 */

export type OpOutcome =
  | { ok: true; state: GameState; events: GameEvent[]; firings: FiringRecord[]; faults: FaultRecord[] }
  | { ok: false; kind: 'invalid'; message: string }
  | { ok: false; kind: 'aborted'; budget: string; message: string; events: GameEvent[] };

export function runOperation(game: CompiledGame, state: GameState, body: (ctx: OpContext) => void): OpOutcome {
  const ctx = new OpContext(game, cloneJson(state));
  try {
    body(ctx);
    ctx.state.rev += 1;
    return { ok: true, state: ctx.state, events: ctx.events, firings: ctx.firings, faults: ctx.faults };
  } catch (err) {
    if (err instanceof BudgetExceeded) return { ok: false, kind: 'aborted', budget: err.budget, message: err.message, events: ctx.events };
    if (err instanceof InvalidInput) return { ok: false, kind: 'invalid', message: err.message };
    if (err instanceof RuleFault) return { ok: false, kind: 'invalid', message: err.message };
    throw err;
  }
}

/** Runs a root firing (an action, phase step or GM command), its reactions and state checks. */
export function runRoot(ctx: OpContext, fn: () => void, options: { reactions: boolean } = { reactions: true }): void {
  const emitted = ctx.collect(fn);
  if (options.reactions) runReactions(ctx, emitted, 1);
  stateChecks(ctx, options.reactions);
}

function bindingsFor(ev: GameEvent): Bindings {
  switch (ev.type) {
    case 'landed':
    case 'left':
      return { $actor: ev.entity, $space: ev.space };
    case 'entered':
      return { $actor: ev.entity, $space: ev.space };
    case 'turnStarted':
    case 'turnEnded':
      return { $actor: ev.entity };
    case 'resourceChanged':
      return { $target: ev.entity, amount: ev.to - ev.from };
    case 'purchased':
      return { $actor: ev.entity, $target: ev.fixture };
    case 'defeated':
      return { $target: ev.entity, $actor: ev.by ?? undefined };
    case 'itemGained':
      return { $actor: ev.entity };
    default:
      return {};
  }
}

function matchesWhere(ctx: OpContext, rule: CompiledRule, ev: GameEvent, b: Bindings): boolean {
  const w = rule.def.trigger.where;
  if (!w) return true;
  const space = 'space' in ev && typeof ev.space === 'string' ? ev.space : undefined;
  if (w.space !== undefined && space !== w.space) return false;
  if (w.spaceTag !== undefined && (space === undefined || !ctx.game.spaces.get(space)?.tags.includes(w.spaceTag))) return false;
  if (ev.type === 'resourceChanged') {
    if (w.resource !== undefined && ev.resource !== w.resource) return false;
    if (w.direction === 'gain' && ev.to <= ev.from) return false;
    if (w.direction === 'loss' && ev.to >= ev.from) return false;
  }
  if (w.actorKind !== undefined && (b.$actor === undefined || ctx.state.entities[b.$actor]?.kind !== w.actorKind)) return false;
  if (w.targetKind !== undefined && (b.$target === undefined || ctx.state.entities[b.$target]?.kind !== w.targetKind)) return false;
  if (w.targetTag !== undefined && (b.$target === undefined || !ctx.state.entities[b.$target]?.tags.includes(w.targetTag))) return false;
  if (w.item !== undefined && !(ev.type === 'itemGained' && ev.itemDef === w.item)) return false;
  if (w.shopEntry !== undefined && !(ev.type === 'purchased' && ev.entry === w.shopEntry)) return false;
  return true;
}

function turnKey(state: GameState): string {
  return `${state.round}:${state.turn.index}`;
}

export function runReactions(ctx: OpContext, events: GameEvent[], depth: number): void {
  for (const ev of events) {
    const candidates = ctx.game.ruleIndex.get(ev.type as never) ?? [];
    for (const rule of candidates) {
      const b = bindingsFor(ev);
      if (!matchesWhere(ctx, rule, ev, b)) continue;
      fireRule(ctx, rule, ev, b, depth);
    }
  }
}

function fault(ctx: OpContext, rule: CompiledRule, ev: GameEvent, message: string): void {
  ctx.faults.push({ rule: rule.def.id, message, trigger: ev.seq });
  ctx.emit({ type: 'ruleFault', rule: rule.def.id, message }, { kind: 'rule', rule: rule.def.id, parent: ev.seq });
}

function fireRule(ctx: OpContext, rule: CompiledRule, ev: GameEvent, b: Bindings, depth: number): void {
  const max = rule.def.limits?.maxPerTurn;
  const counter = ctx.state.ruleCounters[rule.def.id];
  const key = turnKey(ctx.state);
  if (max !== undefined && counter && counter.turnKey === key && counter.count >= max) return;

  const checks: Array<{ text: string; ok: boolean }> = [];
  const rngBefore = [...ctx.state.rng] as GameState['rng'];
  let ok: boolean;
  try {
    ok = rule.def.conditions ? evalCond(ctx, rule.def.conditions, b, checks) : true;
  } catch (err) {
    if (!(err instanceof RuleFault)) throw err;
    ctx.state.rng = rngBefore;
    fault(ctx, rule, ev, err.message);
    return;
  }
  if (!ok) return;

  const firingId = ctx.countFiring(rule.def.id, depth);
  const sp = ctx.savepoint();
  try {
    ctx.state.ruleCounters[rule.def.id] = { turnKey: key, count: counter && counter.turnKey === key ? counter.count + 1 : 1 };
    const bindings: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(b)) if (v !== undefined) bindings[k] = v;
    ctx.firings.push({ id: firingId, rule: rule.def.id, trigger: ev.seq, bindings, checks });
    const cause: EventCause = { kind: 'rule', rule: rule.def.id, parent: ev.seq, firing: firingId };
    const emitted = ctx.collect(() => applyEffects(ctx, rule.def.effects, b, cause));
    runReactions(ctx, emitted, depth + 1);
  } catch (err) {
    if (!(err instanceof RuleFault)) throw err;
    ctx.restore(sp);
    fault(ctx, rule, ev, err.message);
  }
}

/** Defeats caused outside combat (hazards, GM edits) are resolved here until nothing changes. */
export function stateChecks(ctx: OpContext, reactions: boolean): void {
  const { hp } = ctx.game.def.settings.core;
  for (let pass = 0; pass < 20; pass++) {
    const down = Object.values(ctx.state.entities).filter(
      (e) => e.status === 'active' && e.kind !== 'fixture' && e.resources[hp] !== undefined && (e.resources[hp] as number) <= 0,
    );
    if (down.length === 0) return;
    const emitted = ctx.collect(() => {
      for (const e of down) handleDefeat(ctx, e.id, null, null, { kind: 'system' });
    });
    if (reactions) runReactions(ctx, emitted, 1);
  }
  throw new BudgetExceeded('stateChecks', 'defeat checks did not settle');
}
