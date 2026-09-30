import type { ReactionRule, TriggerWhere } from '../schema/rules.ts';
import type { EventCause, GameEvent, GameState } from '../schema/state.ts';
import type { CompiledGame, CompiledRule } from './compile.ts';
import { OpContext, type FaultRecord, type FiringRecord } from './context.ts';
import { issueNextDecision } from './decisions.ts';
import { applyEffects, handleDefeat } from './effects.ts';
import { evalCond, type Bindings } from './eval.ts';
import { limitAllows, recordFiring } from './modifiers.ts';
import { settleObjectives } from './objectives.ts';
import { hasEffectiveTag, holdersOf } from './queries.ts';
import { BudgetExceeded, InvalidInput, RuleFault, cloneJson } from './util.ts';

/**
 * Operations, transactions and the reaction cascade.
 *
 * - An operation works on a private copy of the state; it commits only if it finishes.
 * - A firing's effects all complete before any reaction to them runs.
 * - Reactions run depth-first, ordered by (priority, ruleset position, holder).
 * - Conditions are evaluated when the rule is about to run.
 * - A faulting firing is rolled back on its own; exceeding a budget aborts the whole operation.
 * - Every operation ends by issuing the next decision (queued choices first).
 */

/** A reaction whose trigger matched but whose conditions did not hold (recorded only in dry runs). */
export interface MissRecord {
  rule: string;
  trigger: GameEvent;
  bindings: Record<string, string | number>;
  checks: Array<{ text: string; ok: boolean }>;
}

let missObserver: ((miss: MissRecord) => void) | null = null;

/** Runs `fn` while recording every rule whose conditions failed (for dry runs; synchronous). */
export function observeMisses<T>(fn: () => T): { result: T; misses: MissRecord[] } {
  const misses: MissRecord[] = [];
  const previous = missObserver;
  missObserver = (m) => misses.push(m);
  try {
    return { result: fn(), misses };
  } finally {
    missObserver = previous;
  }
}

export type OpOutcome =
  | { ok: true; state: GameState; events: GameEvent[]; firings: FiringRecord[]; faults: FaultRecord[] }
  | { ok: false; kind: 'invalid'; message: string }
  | { ok: false; kind: 'aborted'; budget: string; message: string; events: GameEvent[] };

export function runOperation(game: CompiledGame, state: GameState, body: (ctx: OpContext) => void): OpOutcome {
  const ctx = new OpContext(game, cloneJson(state));
  try {
    body(ctx);
    settleObjectives(ctx);
    issueNextDecision(ctx);
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

/** Bindings a trigger event provides to rules (and to objective goals). */
export function bindingsFor(ctx: { state: GameState }, ev: GameEvent): Bindings {
  switch (ev.type) {
    case 'landed':
    case 'left':
    case 'entered':
      return { $actor: ev.entity, $space: ev.space };
    case 'turnStarted':
    case 'turnEnded':
    case 'itemGained':
    case 'itemLost':
      return { $actor: ev.entity };
    case 'itemUsed':
    case 'cardDrawn': {
      const space = ctx.state.entities[ev.entity]?.spaceId;
      return { $actor: ev.entity, ...(space ? { $space: space } : {}) };
    }
    case 'actionUsed': {
      const space = ctx.state.entities[ev.entity]?.spaceId;
      return { $actor: ev.entity, ...(ev.target !== null ? { $target: ev.target } : {}), ...(space ? { $space: space } : {}) };
    }
    case 'resourceChanged':
      return { $target: ev.entity, amount: ev.to - ev.from };
    case 'purchased':
      return { $actor: ev.entity, $target: ev.fixture };
    case 'defeated':
      return { $target: ev.entity, ...(ev.by !== null ? { $actor: ev.by } : {}) };
    case 'statusApplied':
    case 'statusRemoved':
      return { $target: ev.entity, amount: ev.stacks };
    case 'damaged':
      return { $target: ev.entity, ...(ev.by !== null ? { $actor: ev.by } : {}), amount: ev.amount };
    case 'spawned':
      return { $target: ev.entity, $space: ev.space };
    default:
      return {};
  }
}

/** Whether an event passes a trigger's static filter. */
export function matchesWhere(ctx: { game: CompiledGame; state: GameState }, w: TriggerWhere | undefined, ev: GameEvent, b: Bindings): boolean {
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
  if (w.targetTag !== undefined) {
    const target = b.$target !== undefined ? ctx.state.entities[b.$target] : undefined;
    if (!target || !hasEffectiveTag(ctx.game, target, w.targetTag)) return false;
  }
  if (w.item !== undefined && !((ev.type === 'itemGained' || ev.type === 'itemLost' || ev.type === 'itemUsed') && ev.itemDef === w.item)) return false;
  if (w.shopEntry !== undefined && !(ev.type === 'purchased' && ev.entry === w.shopEntry)) return false;
  if (w.status !== undefined && !((ev.type === 'statusApplied' || ev.type === 'statusRemoved') && ev.status === w.status)) return false;
  if (w.deck !== undefined && !(ev.type === 'cardDrawn' && ev.deck === w.deck)) return false;
  if (w.card !== undefined && !(ev.type === 'cardDrawn' && ev.card === w.card)) return false;
  if (w.action !== undefined && !(ev.type === 'actionUsed' && ev.action === w.action)) return false;
  if (w.enemy !== undefined) {
    const subject = ev.type === 'spawned' ? ev.enemy : ev.type === 'defeated' ? ctx.state.entities[ev.entity]?.defId : undefined;
    if (subject !== w.enemy) return false;
  }
  return true;
}

export function runReactions(ctx: OpContext, events: GameEvent[], depth: number): void {
  for (const ev of events) {
    const candidates = ctx.game.ruleIndex.get(ev.type as never) ?? [];
    for (const rule of candidates) {
      const def = rule.def as ReactionRule;
      if (rule.owner) {
        // Attached rules fire once per current holder, in stable holder order.
        for (const holder of holdersOf(ctx.state, rule.owner)) {
          const b: Bindings = { ...bindingsFor(ctx, ev), $holder: holder };
          if (matchesWhere(ctx, def.trigger.where, ev, b)) fireRule(ctx, rule, ev, b, depth, holder);
        }
      } else {
        const b = bindingsFor(ctx, ev);
        if (matchesWhere(ctx, def.trigger.where, ev, b)) fireRule(ctx, rule, ev, b, depth, undefined);
      }
    }
  }
}

function fault(ctx: OpContext, rule: CompiledRule, ev: GameEvent, message: string): void {
  ctx.faults.push({ rule: rule.def.id, message, trigger: ev.seq });
  ctx.emit({ type: 'ruleFault', rule: rule.def.id, message }, { kind: 'rule', rule: rule.def.id, parent: ev.seq });
}

function fireRule(ctx: OpContext, rule: CompiledRule, ev: GameEvent, b: Bindings, depth: number, holder: string | undefined): void {
  if (!limitAllows(ctx.state, rule, holder)) return;
  const def = rule.def as ReactionRule;
  const checks: Array<{ text: string; ok: boolean }> = [];
  const rngBefore = [...ctx.state.rng] as GameState['rng'];
  let ok: boolean;
  try {
    ok = def.conditions ? evalCond(ctx, def.conditions, b, checks) : true;
  } catch (err) {
    if (!(err instanceof RuleFault)) throw err;
    ctx.state.rng = rngBefore;
    fault(ctx, rule, ev, err.message);
    return;
  }
  if (!ok) {
    missObserver?.({ rule: def.id, trigger: ev, bindings: Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) as Record<string, string | number>, checks });
    return;
  }

  const firingId = ctx.countFiring(def.id, depth);
  const sp = ctx.savepoint();
  try {
    recordFiring(ctx.state, rule, holder);
    const bindings: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(b)) if (v !== undefined) bindings[k] = v;
    ctx.firings.push({ id: firingId, rule: def.id, trigger: ev.seq, bindings, checks });
    const cause: EventCause = { kind: 'rule', rule: def.id, parent: ev.seq, firing: firingId };
    const emitted = ctx.collect(() => applyEffects(ctx, def.effects, b, cause));
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
