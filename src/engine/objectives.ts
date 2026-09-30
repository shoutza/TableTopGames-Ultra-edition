import type { EventCause, GameEvent, ObjectiveInstance } from '../schema/state.ts';
import type { OpContext } from './context.ts';
import { applyEffects } from './effects.ts';
import { effectiveValue } from './queries.ts';
import { bindingsFor, matchesWhere, runRoot } from './resolve.ts';
import { RuleFault } from './util.ts';

/**
 * Secret objectives. Dealt at match start with the match RNG; progress is counted from committed
 * events at the end of every operation; a completed objective is revealed to everyone and its
 * reward runs for the owner. Only the owner (and the GM) sees an objective before that.
 */

function shuffle(ctx: OpContext, list: string[]): void {
  for (let i = list.length - 1; i > 0; i--) {
    const j = ctx.random(i + 1);
    [list[i], list[j]] = [list[j] as string, list[i] as string];
  }
}

export function assignObjective(ctx: OpContext, owner: string, defId: string, cause: EventCause): ObjectiveInstance {
  ctx.state.counters.objective += 1;
  const inst: ObjectiveInstance = { id: `o${ctx.state.counters.objective}`, defId, owner, progress: 0, done: false };
  ctx.state.objectives.push(inst);
  ctx.emit({ type: 'objectiveAssigned', entity: owner, objective: inst.id, def: defId }, cause, [owner]);
  return inst;
}

/** Deals `settings.objectives.perContestant` different objectives to each contestant. */
export function dealObjectives(ctx: OpContext): void {
  const defs = ctx.game.def.objectives;
  const per = Math.min(ctx.game.def.settings.objectives.perContestant, defs.length);
  if (per === 0) return;
  let pile: string[] = [];
  const refill = () => {
    pile = defs.map((d) => d.id);
    shuffle(ctx, pile);
  };
  for (const owner of ctx.state.turnOrder) {
    const mine = new Set<string>();
    for (let k = 0; k < per; k++) {
      let index = pile.findIndex((id) => !mine.has(id));
      if (index < 0) {
        refill();
        index = pile.findIndex((id) => !mine.has(id));
      }
      const [defId] = pile.splice(index, 1) as [string];
      mine.add(defId);
      assignObjective(ctx, owner, defId, { kind: 'system' });
    }
  }
}

function countEvent(ctx: OpContext, ev: GameEvent): void {
  for (const o of ctx.state.objectives) {
    if (o.done) continue;
    const goal = ctx.game.objectives.get(o.defId)?.goal;
    if (goal?.kind !== 'count' || goal.trigger.event !== ev.type) continue;
    const b = bindingsFor(ctx, ev);
    if (b.$actor === o.owner && matchesWhere(ctx, goal.trigger.where, ev, b)) o.progress = Math.min(goal.times, o.progress + 1);
  }
}

function isComplete(ctx: OpContext, o: ObjectiveInstance): boolean {
  const owner = ctx.state.entities[o.owner];
  const goal = ctx.game.objectives.get(o.defId)?.goal;
  if (!owner || owner.status !== 'active' || !goal) return false;
  if (goal.kind === 'count') return o.progress >= goal.times;
  return (effectiveValue(ctx.game, ctx.state, owner, goal.resource) ?? 0) >= goal.atLeast;
}

function complete(ctx: OpContext, o: ObjectiveInstance): void {
  const def = ctx.game.objectives.get(o.defId);
  o.done = true;
  runRoot(ctx, () => {
    const done = ctx.emit({ type: 'objectiveCompleted', entity: o.owner, objective: o.id, def: o.defId }, { kind: 'objective', entity: o.owner });
    if (!def) return;
    const cause: EventCause = { kind: 'objective', entity: o.owner, parent: done.seq };
    const sp = ctx.savepoint();
    try {
      applyEffects(ctx, def.reward, { $actor: o.owner }, cause);
    } catch (err) {
      if (!(err instanceof RuleFault)) throw err;
      ctx.restore(sp);
      ctx.faults.push({ rule: `objective ${def.name}`, message: err.message, trigger: done.seq });
      ctx.emit({ type: 'ruleFault', rule: `objective ${def.name}`, message: err.message }, cause);
    }
  });
}

/**
 * Called at the end of every operation: counts the operation's events towards count goals, then
 * completes finished objectives. Rewards can finish further objectives, so this repeats (bounded).
 */
export function settleObjectives(ctx: OpContext): void {
  if (ctx.state.objectives.length === 0) return;
  let from = 0;
  for (let pass = 0; pass <= ctx.state.objectives.length; pass++) {
    const events = ctx.events.slice(from);
    from = ctx.events.length;
    for (const ev of events) countEvent(ctx, ev);
    const finished = ctx.state.objectives.filter((o) => !o.done && isComplete(ctx, o));
    if (finished.length === 0) return;
    for (const o of finished) complete(ctx, o);
  }
}
