import type { Capability, ContinuousRule } from '../schema/rules.ts';
import type { Entity, GameState } from '../schema/state.ts';
import type { CompiledGame } from './compile.ts';
import { evalCond, evalNum, evalSelector, type Bindings, type EvalEnv } from './eval.ts';
import { holdersOf } from './queries.ts';
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

export function continuousEffects(game: CompiledGame, state: GameState, entity: Entity): ContinuousResult {
  if (game.continuous.length === 0 || entity.status !== 'active' || depth > 0) return EMPTY;
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
          if (!evalSelector(env, def.applies, b).includes(entity.id)) continue;
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
