import type { ActionDef } from '../schema/definition.ts';
import type { Decision, DecisionOption, Entity, GameState, PendingChoice } from '../schema/state.ts';
import type { CompiledGame } from './compile.ts';
import type { OpContext } from './context.ts';
import { evalCond, type Bindings, type EvalEnv } from './eval.ts';
import { computeModifiers, type ModStep } from './modifiers.ts';
import { activeContestantId, effectiveValue, hasCapability, orderedEntityIds, reachableSpaces } from './queries.ts';
import { RuleFault, UnknownValue } from './util.ts';

/**
 * Legal options for every decision, and issuing the next decision at the end of each operation:
 * queued choices first (in order), then the active contestant's move or main decision.
 * Availability depends only on what the deciding contestant can see (requirements are checked
 * for view-safety at compile time), so options never reveal hidden information.
 */

/** Read-only evaluation for requirements and previews of prices: no randomness, bounded work. */
export class CheckEnv implements EvalEnv {
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
    if (++this.steps > 5000) throw new RuleFault('requirement too complex to evaluate');
  }
  random(): number {
    throw new UnknownValue('random');
  }
}

function holds(env: EvalEnv, cond: Parameters<typeof evalCond>[1], b: Bindings): boolean {
  try {
    return evalCond(env, cond, b);
  } catch (err) {
    if (err instanceof RuleFault || err instanceof UnknownValue) return false;
    throw err;
  }
}

/** Shop price for this buyer after (public) price modifiers. */
export function buyPrice(game: CompiledGame, state: GameState, buyerId: string, entryId: string): { price: number; resource: string; steps: ModStep[] } | null {
  const found = game.shopEntries.get(entryId);
  if (!found) return null;
  const { price } = found.entry;
  const out = computeModifiers(new CheckEnv(game, state), 'price', { $actor: buyerId, amount: price.amount }, price.amount, { entity: buyerId, resource: price.resource, shopEntry: entryId });
  return { price: Math.max(0, out.value), resource: price.resource, steps: out.steps };
}

export function moveOptions(game: CompiledGame, state: GameState, actor: Entity): DecisionOption[] {
  if (actor.spaceId === null) return [{ id: 'pass', kind: 'pass', label: 'Pass' }];
  const steps = hasCapability(game, state, actor, 'moves') ? (state.turn.roll ?? 0) : 0;
  const reach = reachableSpaces(game, actor.spaceId, steps);
  const order = new Map(game.spaceOrder.map((id, i) => [id, i]));
  return [...reach.entries()]
    .sort((a, b) => a[1] - b[1] || (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
    .map(([space, n]) => ({
      id: `mv:${space}`,
      kind: 'move' as const,
      space,
      steps: n,
      label: n === 0 ? `Stay at ${game.spaces.get(space)?.name ?? space}` : `Move to ${game.spaces.get(space)?.name ?? space} (${n} step${n === 1 ? '' : 's'})`,
    }));
}

/** Whether the actor may use a custom action now (location, cooldown, cost, requirements). */
export function actionAvailable(game: CompiledGame, state: GameState, actor: Entity, action: ActionDef): boolean {
  if (actor.kind !== 'contestant' || actor.status !== 'active') return false;
  const here = actor.spaceId;
  if (action.where?.space !== undefined && here !== action.where.space) return false;
  if (action.where?.spaceTag !== undefined && (here === null || !game.spaces.get(here)?.tags.includes(action.where.spaceTag))) return false;
  if ((state.cooldowns[`${action.id}:${actor.id}`] ?? 0) > state.round) return false;
  if (action.cost && (effectiveValue(game, state, actor, action.cost.resource) ?? 0) < action.cost.amount) return false;
  if (action.requires && !holds(new CheckEnv(game, state), action.requires, { $actor: actor.id, ...(here !== null ? { $space: here } : {}) })) return false;
  return true;
}

/** Entities a targeted action may be aimed at. */
export function actionTargets(game: CompiledGame, state: GameState, actor: Entity, action: ActionDef): string[] {
  const t = action.target;
  if (!t) return [];
  return orderedEntityIds(state)
    .filter((id) => {
      const e = state.entities[id];
      if (!e || id === actor.id || e.kind !== t.kind || e.status !== 'active') return false;
      if (e.kind === 'contestant' && e.koTurns > 0) return false;
      return t.range === 'anywhere' || (e.spaceId !== null && e.spaceId === actor.spaceId);
    })
    .slice(0, 8);
}

/** Entities the actor may attack here: active, attackable enemies and (with PvP) contestants not recovering from a knockout. */
export function attackTargets(game: CompiledGame, state: GameState, actor: Entity): string[] {
  if (actor.spaceId === null || !hasCapability(game, state, actor, 'attacks')) return [];
  return orderedEntityIds(state).filter((id) => {
    const e = state.entities[id];
    if (!e || id === actor.id || e.spaceId !== actor.spaceId || e.status !== 'active') return false;
    if (e.kind === 'fixture') return false;
    if (e.kind === 'contestant' && (!game.def.settings.combat.pvp || e.koTurns > 0)) return false;
    return hasCapability(game, state, e, 'attackable');
  });
}

export function mainOptions(game: CompiledGame, state: GameState, actor: Entity): DecisionOption[] {
  const { core, rest, inventoryCapacity } = game.def.settings;
  const options: DecisionOption[] = [];
  const here = actor.spaceId;
  const resName = (id: string) => game.resources.get(id)?.name ?? id;
  if (hasCapability(game, state, actor, 'shops')) {
    for (const other of orderedEntityIds(state).map((id) => state.entities[id] as Entity)) {
      if (other.kind !== 'fixture' || other.spaceId !== here || other.status !== 'active') continue;
      const shopId = game.fixtures.get(other.defId)?.shop;
      const shop = shopId !== undefined ? game.shops.get(shopId) : undefined;
      for (const entry of shop?.entries ?? []) {
        const quote = buyPrice(game, state, actor.id, entry.id);
        if (!quote) continue;
        const funds = effectiveValue(game, state, actor, quote.resource);
        if (funds === undefined || funds < quote.price) continue;
        if ('item' in entry.grants && actor.items.length >= inventoryCapacity) continue;
        const what = 'item' in entry.grants ? (game.items.get(entry.grants.item)?.name ?? entry.grants.item) : `${entry.grants.amount} ${resName(entry.grants.resource)}`;
        options.push({
          id: `buy:${other.id}:${entry.id}`,
          kind: 'buy',
          fixture: other.id,
          entry: entry.id,
          price: quote.price,
          label: `Buy ${what} for ${quote.price} ${resName(quote.resource)}`,
        });
      }
    }
  }
  for (const id of attackTargets(game, state, actor)) {
    options.push({ id: `atk:${id}`, kind: 'attack', target: id, label: `Attack ${state.entities[id]?.name ?? id}` });
  }
  if (hasCapability(game, state, actor, 'usesItems')) {
    const seen = new Set<string>();
    for (const itemId of actor.items) {
      const defId = state.items[itemId]?.defId;
      const def = defId !== undefined ? game.items.get(defId) : undefined;
      if (!def?.use || seen.has(def.id)) continue;
      seen.add(def.id);
      options.push({ id: `use:${itemId}`, kind: 'use', item: itemId, label: def.use.label ?? `Use ${def.name}` });
    }
  }
  for (const action of game.def.actions) {
    if (!actionAvailable(game, state, actor, action)) continue;
    const cost = action.cost ? ` (${action.cost.amount} ${resName(action.cost.resource)})` : '';
    if (action.target) {
      for (const t of actionTargets(game, state, actor, action)) {
        options.push({ id: `act:${action.id}:${t}`, kind: 'act', action: action.id, target: t, label: `${action.name}: ${state.entities[t]?.name ?? t}${cost}` });
      }
    } else options.push({ id: `act:${action.id}`, kind: 'act', action: action.id, target: null, label: `${action.name}${cost}` });
  }
  const hp = effectiveValue(game, state, actor, core.hp);
  const maxHp = effectiveValue(game, state, actor, core.maxHp);
  if (hp !== undefined && maxHp !== undefined && hp < maxHp && rest.heal > 0) options.push({ id: 'rest', kind: 'rest', label: `Rest (+${rest.heal} HP)` });
  options.push({ id: 'pass', kind: 'pass', label: 'Pass' });
  return options;
}

/** Options the chooser may pick now, or null when the choice must resolve to its default automatically. */
export function choiceOptions(game: CompiledGame, state: GameState, choice: PendingChoice): DecisionOption[] | null {
  const chooser = state.entities[choice.chooser];
  if (!chooser || chooser.status !== 'active') return null;
  const env = new CheckEnv(game, state);
  const b: Bindings = { ...choice.bindings, $actor: choice.chooser };
  const legal = choice.options.filter((o) => !o.requires || holds(env, o.requires, b));
  if (legal.length === 0) return null;
  return legal.map((o) => ({ id: `ch:${o.id}`, kind: 'choose' as const, label: o.label, option: o.id }));
}

function newDecision(ctx: OpContext, actor: string, kind: Decision['kind'], options: DecisionOption[], extra: { choice?: string; prompt?: string } = {}): Decision {
  ctx.state.counters.decision += 1;
  return { id: `d${ctx.state.counters.decision}`, actor, kind, issuedRev: ctx.state.rev + 1, options, ...extra };
}

/**
 * Called at the end of every operation. Any previously pending decision is replaced (with a new
 * id), so answers prepared against an older state are rejected.
 */
export function issueNextDecision(ctx: OpContext): void {
  const s = ctx.state;
  s.pendingDecision = null;
  if (s.phase === 'gameOver') return;
  if (s.turn.over && (s.phase === 'roll' || s.phase === 'move' || s.phase === 'main')) s.phase = 'turnEnd';
  const head = s.queue[0];
  if (head) {
    const options = choiceOptions(ctx.game, s, head);
    // An unanswerable choice (chooser gone, nothing legal) resolves to its default in the next automatic step.
    if (options) s.pendingDecision = newDecision(ctx, head.chooser, 'choice', options, { choice: head.id, prompt: head.prompt });
    return;
  }
  if (s.phase !== 'move' && s.phase !== 'main') return;
  const actorId = activeContestantId(s);
  const actor = actorId !== null ? s.entities[actorId] : undefined;
  if (!actor || actor.status !== 'active') {
    s.phase = 'turnEnd';
    return;
  }
  s.pendingDecision = newDecision(ctx, actor.id, s.phase, s.phase === 'move' ? moveOptions(ctx.game, s, actor) : mainOptions(ctx.game, s, actor));
}
