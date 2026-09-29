import type { Cond, EntityRef, Num, Selector, SpaceRef } from '../schema/rules.ts';
import type { GameState } from '../schema/state.ts';
import type { CompiledGame } from './compile.ts';
import { effectiveValue, getEntity, orderedEntityIds } from './queries.ts';
import { RuleFault, divide } from './util.ts';
import { describeCond, namesFor } from './explain.ts';

/**
 * Evaluators for the rule language. The same code runs authoritative resolution (OpContext)
 * and view-safe previews (a redacted state whose random() throws UnknownValue).
 */

export interface EvalEnv {
  readonly game: CompiledGame;
  readonly state: GameState;
  readonly selectorLimit: number;
  step(): void;
  random(n: number): number;
}

export interface Bindings {
  $actor?: string | undefined;
  $target?: string | undefined;
  $it?: string | undefined;
  $space?: string | undefined;
  amount?: number | undefined;
}

export function evalEntityRef(env: EvalEnv, ref: EntityRef, b: Bindings): string {
  env.step();
  if (typeof ref === 'string') {
    const id = b[ref];
    if (id === undefined) throw new RuleFault(`binding ${ref} is empty`);
    getEntity(env.state, id);
    return id;
  }
  getEntity(env.state, ref.id);
  return ref.id;
}

export function evalSpaceRef(env: EvalEnv, ref: SpaceRef, b: Bindings): string {
  env.step();
  if (ref === '$space') {
    if (b.$space === undefined) throw new RuleFault('binding $space is empty');
    return b.$space;
  }
  switch (ref.op) {
    case 'space':
      if (!env.game.spaces.has(ref.id)) throw new RuleFault(`unknown space "${ref.id}"`);
      return ref.id;
    case 'spaceOf': {
      const entity = getEntity(env.state, evalEntityRef(env, ref.entity, b));
      if (entity.spaceId === null) throw new RuleFault(`${entity.name} is not on the board`);
      return entity.spaceId;
    }
    case 'randomSpace': {
      const exclude = ref.excludeSpaceOf !== undefined ? getEntity(env.state, evalEntityRef(env, ref.excludeSpaceOf, b)).spaceId : null;
      const candidates = env.game.spaceOrder.filter((id) => id !== exclude && env.game.spaces.get(id)?.tags.includes(ref.tag));
      if (candidates.length === 0) throw new RuleFault(`no space tagged ${ref.tag} to choose from`);
      return candidates[env.random(candidates.length)] as string;
    }
  }
}

function isSelectable(env: EvalEnv, id: string): boolean {
  const e = env.state.entities[id];
  return e !== undefined && e.status === 'active';
}

export function evalSelector(env: EvalEnv, sel: Selector, b: Bindings): string[] {
  env.step();
  let result: string[];
  if (typeof sel === 'string') result = [evalEntityRef(env, sel, b)];
  else {
    switch (sel.op) {
      case 'entity':
        result = [evalEntityRef(env, sel, b)];
        break;
      case 'all':
        result = orderedEntityIds(env.state).filter((id) => isSelectable(env, id) && (sel.kind === undefined || env.state.entities[id]?.kind === sel.kind));
        break;
      case 'at': {
        const space = evalSpaceRef(env, sel.space, b);
        result = orderedEntityIds(env.state).filter((id) => {
          const e = env.state.entities[id];
          return isSelectable(env, id) && e?.spaceId === space && (sel.kind === undefined || e.kind === sel.kind);
        });
        break;
      }
      case 'withTag':
        result = orderedEntityIds(env.state).filter((id) => {
          const e = env.state.entities[id];
          return isSelectable(env, id) && e?.tags.includes(sel.tag) === true && (sel.kind === undefined || e.kind === sel.kind);
        });
        break;
      case 'filter': {
        const from = evalSelector(env, sel.from, b);
        result = from.filter((id) => evalCond(env, sel.where, { ...b, $it: id }));
        break;
      }
      case 'random': {
        const pool = [...evalSelector(env, sel.from, b)];
        result = [];
        while (result.length < sel.count && pool.length > 0) {
          const i = env.random(pool.length);
          result.push(pool.splice(i, 1)[0] as string);
        }
        break;
      }
    }
  }
  if (result.length > env.selectorLimit) throw new RuleFault(`selector matched ${result.length} entities (limit ${env.selectorLimit})`);
  return result;
}

export function evalNum(env: EvalEnv, num: Num, b: Bindings): number {
  env.step();
  if (typeof num === 'number') return num;
  switch (num.op) {
    case 'res':
    case 'stat': {
      const entity = getEntity(env.state, evalEntityRef(env, num.of, b));
      const v = num.op === 'stat' ? effectiveValue(env.game, env.state, entity, num.resource) : entity.resources[num.resource];
      if (v !== undefined) return v;
      if (num.op === 'res' && num.ifMissing !== undefined) return num.ifMissing;
      throw new RuleFault(`${entity.name} has no ${env.game.resources.get(num.resource)?.name ?? num.resource}`);
    }
    case 'roll': {
      let total = 0;
      for (let i = 0; i < num.count; i++) total += env.random(num.sides) + 1;
      return total;
    }
    case 'add':
      return num.args.reduce<number>((sum, a) => sum + evalNum(env, a, b), 0);
    case 'sub':
      return evalNum(env, num.a, b) - evalNum(env, num.b, b);
    case 'mul':
      return num.args.reduce<number>((prod, a) => prod * evalNum(env, a, b), 1);
    case 'div':
      return divide(evalNum(env, num.a, b), evalNum(env, num.b, b), num.rounding);
    case 'min':
      return Math.min(...num.args.map((a) => evalNum(env, a, b)));
    case 'max':
      return Math.max(...num.args.map((a) => evalNum(env, a, b)));
    case 'count':
      return evalSelector(env, num.of, b).length;
    case 'round':
      return env.state.round;
    case 'amount':
      if (b.amount === undefined) throw new RuleFault('no amount in this context');
      return b.amount;
  }
}

/**
 * Evaluates a condition. When `trace` is given, the result of every atomic check is recorded
 * with its plain-language text for "why did this happen?".
 */
export function evalCond(env: EvalEnv, cond: Cond, b: Bindings, trace?: Array<{ text: string; ok: boolean }>): boolean {
  env.step();
  const record = (ok: boolean): boolean => {
    trace?.push({ text: describeCond(cond, namesFor(env.game, env.state), b), ok });
    return ok;
  };
  switch (cond.op) {
    case 'all':
      return cond.conds.every((c) => evalCond(env, c, b, trace));
    case 'any':
      return cond.conds.some((c) => evalCond(env, c, b, trace));
    case 'not':
      return record(!evalCond(env, cond.cond, b));
    case 'hasTag':
      return record(getEntity(env.state, evalEntityRef(env, cond.entity, b)).tags.includes(cond.tag));
    case 'spaceHasTag':
      return record(env.game.spaces.get(evalSpaceRef(env, cond.space, b))?.tags.includes(cond.tag) === true);
    case 'isKind':
      return record(getEntity(env.state, evalEntityRef(env, cond.entity, b)).kind === cond.kind);
    case 'holds': {
      const entity = getEntity(env.state, evalEntityRef(env, cond.entity, b));
      return record(entity.items.some((id) => env.state.items[id]?.defId === cond.item));
    }
    case 'compare': {
      const l = evalNum(env, cond.left, b);
      const r = evalNum(env, cond.right, b);
      const ok =
        cond.cmp === '<' ? l < r : cond.cmp === '<=' ? l <= r : cond.cmp === '==' ? l === r : cond.cmp === '!=' ? l !== r : cond.cmp === '>=' ? l >= r : l > r;
      return record(ok);
    }
    case 'exists':
      return record(evalSelector(env, cond.of, b).length > 0);
  }
}
