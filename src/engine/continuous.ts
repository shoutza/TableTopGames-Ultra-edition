import type { Capability, ContinuousRule } from '../schema/rules.ts';
import type { Entity, GameState } from '../schema/state.ts';
import type { CompiledGame } from './compile.ts';
import { evalCond, evalNum, evalSelector, type Bindings, type EvalEnv } from './eval.ts';
import { hasEffectiveTag, holdersOf } from './queries.ts';
import { RuleFault, UnknownValue } from './util.ts';

/**
 * Continuous rules: additive stat modifiers and capability suppression that hold while a condition
 * holds. They are evaluated on read (effective values, capabilities), in a single pass: their
 * conditions may read base values, tags, statuses, positions and items but never effective stats
 * (the compiler rejects that), so the order of continuous rules does not matter.
 */

class PureEnv implements EvalEnv {
  readonly game: CompiledGame;
  readonly state: GameState;
  readonly selectorLimit: number;
  private steps = 0;
  constructor(game: CompiledGame, state: GameState) {
    this.game = game;
    this.state = state;
    this.selectorLimit = game.def.settings.budgets.selectorSize;
  }
  step(): void {
    if (++this.steps > 2000) throw new RuleFault('continuous rule too complex to evaluate');
  }
  random(): number {
    throw new RuleFault('continuous rules cannot use randomness');
  }
}

export interface ContinuousResult {
  modifiers: Map<string, number>;
  /** Suppressed capability → name of the rule suppressing it. */
  suppress: Map<Capability, string>;
}

const EMPTY: ContinuousResult = { modifiers: new Map(), suppress: new Map() };
let depth = 0;

/**
 * States that are never changed again (an operation's result, a viewer's redacted copy). Their
 * continuous effects are computed once per entity; a state being built by an operation is not
 * sealed, so it is always evaluated afresh.
 */
const sealed = new WeakSet<GameState>();
const memo = new WeakMap<GameState, WeakMap<CompiledGame, Map<string, ContinuousResult>>>();

export function sealState<T extends GameState>(state: T): T {
  sealed.add(state);
  return state;
}

/** Whether `applies` selects the entity; plain "all" / "with tag" selectors are answered directly. */
function applies(env: PureEnv, selector: ContinuousRule['applies'], b: Bindings, entity: Entity): boolean {
  // Exact only while no selector can exceed the size limit (which makes the rule fault).
  if (typeof selector !== 'string' && Object.keys(env.state.entities).length <= env.selectorLimit) {
    if (selector.op === 'all') return selector.kind === undefined || entity.kind === selector.kind;
    if (selector.op === 'withTag') return (selector.kind === undefined || entity.kind === selector.kind) && hasEffectiveTag(env.game, entity, selector.tag);
  }
  return evalSelector(env, selector, b).includes(entity.id);
}

export function continuousEffects(game: CompiledGame, state: GameState, entity: Entity): ContinuousResult {
  if (game.continuous.length === 0 || entity.status !== 'active' || depth > 0) return EMPTY;
  let cache: Map<string, ContinuousResult> | undefined;
  if (sealed.has(state)) {
    let perGame = memo.get(state);
    if (!perGame) {
      perGame = new WeakMap();
      memo.set(state, perGame);
    }
    cache = perGame.get(game);
    if (!cache) {
      cache = new Map();
      perGame.set(game, cache);
    }
    const hit = cache.get(entity.id);
    if (hit) return hit;
  }
  const result = computeContinuous(game, state, entity);
  cache?.set(entity.id, result);
  return result;
}

function computeContinuous(game: CompiledGame, state: GameState, entity: Entity): ContinuousResult {
  depth++;
  try {
    const result: ContinuousResult = { modifiers: new Map(), suppress: new Map() };
    for (const rule of game.continuous) {
      const def = rule.def as ContinuousRule;
      const holders: Array<string | undefined> = rule.owner ? holdersOf(game, state, rule.owner) : [undefined];
      for (const holder of holders) {
        const env = new PureEnv(game, state);
        const b: Bindings = holder !== undefined ? { $holder: holder } : {};
        try {
          if (!applies(env, def.applies, b, entity)) continue;
          const bb: Bindings = { ...b, $it: entity.id };
          if (def.when && !evalCond(env, def.when, bb)) continue;
          for (const m of def.modifiers) result.modifiers.set(m.resource, (result.modifiers.get(m.resource) ?? 0) + evalNum(env, m.add, bb));
          for (const c of def.suppress) if (!result.suppress.has(c)) result.suppress.set(c, def.name);
        } catch (err) {
          // A continuous rule that cannot be evaluated (missing value, hidden data in a view) has no effect.
          if (err instanceof RuleFault || err instanceof UnknownValue) continue;
          throw err;
        }
      }
    }
    return result;
  } finally {
    depth--;
  }
}
