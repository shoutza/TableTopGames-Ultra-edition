import { fightOdds, type FightOdds } from '../engine/combat.ts';
import type { CompiledGame } from '../engine/compile.ts';
import { evalCond, evalEntityRef, evalNum, evalSelector, evalSpaceRef, type Bindings, type EvalEnv } from '../engine/eval.ts';
import { describeEffect, describeEffects, describeStatus, type Names } from '../engine/explain.ts';
import { computeModifiers, recordFiring } from '../engine/modifiers.ts';
import { effectiveValue, holdersOf } from '../engine/queries.ts';
import { RuleFault, UnknownValue, cloneJson } from '../engine/util.ts';
import type { Effect, Num, ReactionRule } from '../schema/rules.ts';
import type { GameState } from '../schema/state.ts';

/**
 * View-safe previews: what an option would do to the viewer, computed by the real evaluators over
 * the redacted state and the contestant-facing game. Randomness is never drawn: dice become ranges,
 * random branches become probabilities, and anything unknowable is marked uncertain.
 */

export class PreviewEnv implements EvalEnv {
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
    if (++this.steps > 5000) throw new UnknownValue('preview too complex');
  }
  random(): number {
    throw new UnknownValue('random');
  }
}

export function tryEval<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    if (err instanceof UnknownValue || err instanceof RuleFault) return undefined;
    throw err;
  }
}

/** Interval of possible values of a number expression without drawing randomness. */
export function rangeOf(env: EvalEnv, n: Num, b: Bindings): [number, number] | undefined {
  if (typeof n === 'number') return [n, n];
  switch (n.op) {
    case 'roll':
      return [n.count, n.count * n.sides];
    case 'add': {
      let lo = 0;
      let hi = 0;
      for (const a of n.args) {
        const r = rangeOf(env, a, b);
        if (!r) return undefined;
        lo += r[0];
        hi += r[1];
      }
      return [lo, hi];
    }
    case 'sub': {
      const x = rangeOf(env, n.a, b);
      const y = rangeOf(env, n.b, b);
      return x && y ? [x[0] - y[1], x[1] - y[0]] : undefined;
    }
    case 'mul': {
      let lo = 1;
      let hi = 1;
      for (const a of n.args) {
        const r = rangeOf(env, a, b);
        if (!r) return undefined;
        const c = [lo * r[0], lo * r[1], hi * r[0], hi * r[1]];
        lo = Math.min(...c);
        hi = Math.max(...c);
      }
      return [lo, hi];
    }
    default: {
      const v = tryEval(() => evalNum(env, n, b));
      return v === undefined ? undefined : [v, v];
    }
  }
}

export interface FightHint {
  opponent: string;
  opponentName: string;
  opponentKind: 'contestant' | 'enemy' | 'fixture';
  iAmAttacker: boolean;
  myPower: number;
  myHp: number;
  theirPower: number;
  theirHp: number;
  /** From the viewer's perspective: "attacker" fields describe the viewer. */
  odds: FightOdds;
  rewards: string | null;
  /** Gold the viewer takes if it knocks out a contestant opponent. */
  loot: number;
  /** Gold the viewer loses if it is knocked out. */
  risk: number;
}

export interface Hint {
  text: string;
  /** Resource change for the viewer: range of the change. */
  resource?: string | undefined;
  min?: number | undefined;
  max?: number | undefined;
  /** False when it depends on something unknown (conditions, hidden values). */
  certain: boolean;
  /** Probability of this outcome when it comes from a random branch or card (1 otherwise). */
  p: number;
  status?: string | undefined;
  statusStacks?: number | undefined;
  item?: string | undefined;
  losesItem?: boolean | undefined;
  fight?: FightHint | undefined;
  choice?: boolean | undefined;
  /** Part of a card-draw estimate: used for scoring, summarized rather than listed in packets. */
  fromCard?: boolean | undefined;
  deck?: string | undefined;
}

export interface HintScope {
  /** The contestant-facing game (hidden rules removed). */
  game: CompiledGame;
  /** The redacted (possibly hypothetical) state. */
  state: GameState;
  names: Names;
  viewer: string;
}

function signedRange(min: number, max: number): string {
  const s = (v: number) => (v >= 0 ? `+${v}` : `${v}`);
  return min === max ? s(min) : `${s(min)} to ${s(max)}`;
}

/** Damage of each successful hit after public damage modifiers (shields consumed as they go). */
function damageSequence(scope: HintScope, winner: string, loser: string, base: number, n: number): number[] | undefined {
  if (!scope.game.modifierIndex.has('damage')) return undefined;
  // The state is copied only once a modifier actually applies (shields are used up as hits land).
  let sim = scope.state;
  let env = new PreviewEnv(scope.game, sim);
  let copied = false;
  const seq: number[] = [];
  for (let k = 0; k < n; k++) {
    const out = computeModifiers(env, 'damage', { $actor: winner, $target: loser, amount: base }, base, { entity: loser });
    seq.push(Math.max(0, out.value));
    if (out.steps.length > 0 && !copied) {
      sim = cloneJson(sim);
      env = new PreviewEnv(scope.game, sim);
      copied = true;
    }
    for (const step of out.steps) {
      recordFiring(sim, step.rule, step.holder);
      const consume = step.rule.def.kind === 'modifier' ? step.rule.def.consume : undefined;
      if (!consume) continue;
      const who = sim.entities[step.holder ?? loser];
      if (!who) continue;
      if ('status' in consume) {
        const inst = who.statuses.find((s) => s.defId === consume.status);
        if (inst) {
          inst.stacks -= 1;
          if (inst.stacks <= 0) who.statuses = who.statuses.filter((s) => s !== inst);
        }
      } else if (step.rule.owner?.kind === 'item') {
        const itemId = who.items.find((id) => sim.items[id]?.defId === step.rule.owner?.defId);
        if (itemId !== undefined) who.items = who.items.filter((id) => id !== itemId);
      }
    }
  }
  return seq;
}

export function fightHint(scope: HintScope, me: string, opponent: string, iAmAttacker: boolean): FightHint | null {
  const { game, state } = scope;
  const { core, combat, ko } = game.def.settings;
  const mine = state.entities[me];
  const theirs = state.entities[opponent];
  if (!mine || !theirs) return null;
  const myPower = effectiveValue(game, state, mine, core.power);
  const myHp = effectiveValue(game, state, mine, core.hp);
  const theirPower = effectiveValue(game, state, theirs, core.power);
  const theirHp = effectiveValue(game, state, theirs, core.hp);
  if (myPower === undefined || myHp === undefined || theirPower === undefined || theirHp === undefined) return null;
  const [aId, dId, aPow, dPow, aHp, dHp] = iAmAttacker ? [me, opponent, myPower, theirPower, myHp, theirHp] : [opponent, me, theirPower, myPower, theirHp, myHp];
  const probe = fightOdds({ attackerPower: aPow, attackerHp: aHp, defenderPower: dPow, defenderHp: dHp, maxSpins: combat.maxSpinsPerFight, damage: combat.damage });
  const odds = fightOdds({
    attackerPower: aPow,
    attackerHp: aHp,
    defenderPower: dPow,
    defenderHp: dHp,
    maxSpins: combat.maxSpinsPerFight,
    damage: combat.damage,
    attackerHitSeq: damageSequence(scope, aId, dId, probe.attackerHit, combat.maxSpinsPerFight),
    defenderHitSeq: damageSequence(scope, dId, aId, probe.defenderHit, combat.maxSpinsPerFight),
  });
  // Express odds from the viewer's perspective.
  const mineOdds: FightOdds = iAmAttacker
    ? odds
    : {
        attackerChance: 1 - odds.attackerChance,
        attackerHit: odds.defenderHit,
        defenderHit: odds.attackerHit,
        attackerHitsNeeded: odds.defenderHitsNeeded,
        defenderHitsNeeded: odds.attackerHitsNeeded,
        pAttackerWins: odds.pDefenderWins,
        pDefenderWins: odds.pAttackerWins,
        pBothStand: odds.pBothStand,
        expectedAttackerHpLoss: odds.expectedDefenderHpLoss,
        expectedDefenderHpLoss: odds.expectedAttackerHpLoss,
        modified: odds.modified,
      };
  const enemyDef = theirs.kind === 'enemy' ? game.enemies.get(theirs.defId) : undefined;
  const lossOf = (gold: number | undefined) => (gold === undefined || ko.mode === 'eliminate' ? 0 : Math.floor((gold * ko.goldLossPercent) / 100));
  return {
    opponent,
    opponentName: theirs.name,
    opponentKind: theirs.kind,
    iAmAttacker,
    myPower,
    myHp,
    theirPower,
    theirHp,
    odds: mineOdds,
    rewards:
      enemyDef && enemyDef.rewards.length > 0
        ? describeEffects(enemyDef.rewards, { ...scope.names, entity: (id) => (id === me ? 'you' : scope.names.entity(id)) }, { $actor: me, $target: opponent }, { skipAnnouncements: true })
        : null,
    loot: theirs.kind === 'contestant' && ko.lootToVictor ? lossOf(theirs.resources[core.gold]) : 0,
    risk: lossOf(mine.resources[core.gold]),
  };
}

function includesViewer(scope: HintScope, env: EvalEnv, sel: Parameters<typeof evalSelector>[1], b: Bindings): boolean | undefined {
  const targets = tryEval(() => evalSelector(env, sel, b));
  return targets === undefined ? undefined : targets.includes(scope.viewer);
}

function refIsViewer(scope: HintScope, env: EvalEnv, ref: Parameters<typeof evalEntityRef>[1], b: Bindings): boolean | undefined {
  const id = tryEval(() => evalEntityRef(env, ref, b));
  return id === undefined ? undefined : id === scope.viewer;
}

/** Appends what `effects` would do to the viewer. */
export function effectHints(scope: HintScope, effects: Effect[], b: Bindings, sure: boolean, p: number, source: string, out: Hint[], depth = 0): void {
  const env = new PreviewEnv(scope.game, scope.state);
  const { names } = scope;
  const tag = (text: string) => `${text} (${source})`;
  for (const e of effects) {
    switch (e.op) {
      case 'changeResource':
      case 'damage': {
        const mine = includesViewer(scope, env, e.target, b);
        if (mine === false) continue;
        const r = rangeOf(env, e.amount, { ...b, $it: scope.viewer });
        const resource = e.op === 'damage' ? scope.game.def.settings.core.hp : e.resource;
        const range: [number, number] | undefined = r ? (e.op === 'damage' ? [-Math.max(0, r[1]), -Math.max(0, r[0])] : r) : undefined;
        out.push(
          range
            ? { text: tag(`${signedRange(range[0], range[1])} ${names.resource(resource)}${e.op === 'damage' ? ' (damage)' : ''}`), resource, min: range[0], max: range[1], certain: sure && mine === true, p }
            : { text: tag(`${names.resource(resource)} changes`), resource, certain: false, p },
        );
        break;
      }
      case 'transfer': {
        const from = refIsViewer(scope, env, e.from, b);
        const to = refIsViewer(scope, env, e.to, b);
        if (!from && !to) continue;
        const r = rangeOf(env, e.amount, b);
        if (!r) {
          out.push({ text: tag(`${names.resource(e.resource)} changes hands`), resource: e.resource, certain: false, p });
          continue;
        }
        const [lo, hi] = from ? [-r[1], -r[0]] : r;
        out.push({ text: tag(`${signedRange(lo, hi)} ${names.resource(e.resource)}`), resource: e.resource, min: lo, max: hi, certain: false, p });
        break;
      }
      case 'setResource': {
        const mine = includesViewer(scope, env, e.target, b);
        if (mine === false) continue;
        out.push({ text: tag(describeEffect(e, names, b)), certain: false, p });
        break;
      }
      case 'applyStatus': {
        const mine = includesViewer(scope, env, e.target, b);
        if (mine === false) continue;
        const def = scope.game.statuses.get(e.status);
        if (!def) continue;
        out.push({ text: tag(`you become ${describeStatus(def, names, e.stacks ?? 1, e.duration)}`), status: e.status, statusStacks: e.stacks ?? 1, certain: sure && mine === true, p });
        break;
      }
      case 'removeStatus': {
        const mine = includesViewer(scope, env, e.target, b);
        if (mine === false) continue;
        out.push({ text: tag(`you are no longer ${names.status(e.status)}`), certain: sure && mine === true, p });
        break;
      }
      case 'grantItem': {
        if (refIsViewer(scope, env, e.target, b) === false) continue;
        out.push({ text: tag(`you receive ${names.item(e.item)}`), item: e.item, certain: sure, p });
        break;
      }
      case 'transferItem': {
        const from = refIsViewer(scope, env, e.from, b);
        const to = refIsViewer(scope, env, e.to, b);
        if (from) out.push({ text: tag(`you hand over ${e.item === 'random' ? 'a random item' : names.item(e.item)}`), losesItem: true, certain: false, p });
        else if (to) out.push({ text: tag(`you may receive ${e.item === 'random' ? 'a random item' : names.item(e.item)}`), ...(e.item !== 'random' ? { item: e.item } : {}), certain: false, p });
        break;
      }
      case 'loseItem':
        if (refIsViewer(scope, env, e.target, b) === false) continue;
        out.push({ text: tag(`you lose ${e.item === 'random' ? 'a random item' : names.item(e.item)}`), losesItem: true, certain: false, p });
        break;
      case 'fight': {
        const attacker = tryEval(() => evalSelector(env, e.attacker, b)[0]);
        const defender = tryEval(() => evalSelector(env, e.defender, b)[0]);
        if (defender === scope.viewer && attacker !== undefined) {
          const fight = fightHint(scope, scope.viewer, attacker, false);
          out.push({ text: tag(`${names.entity(attacker)} attacks you`), certain: sure, p, ...(fight ? { fight } : {}) });
        } else if (attacker === scope.viewer && defender !== undefined) {
          const fight = fightHint(scope, scope.viewer, defender, true);
          out.push({ text: tag(`you attack ${names.entity(defender)}`), certain: sure, p, ...(fight ? { fight } : {}) });
        }
        break;
      }
      case 'teleport': {
        const mine = includesViewer(scope, env, e.target, b);
        if (mine === false) continue;
        const to = tryEval(() => evalSpaceRef(env, e.to, { ...b, $it: scope.viewer }));
        out.push({ text: tag(`you are teleported to ${to !== undefined ? names.space(to) : 'another space'}`), certain: false, p });
        break;
      }
      case 'drawCard': {
        if (refIsViewer(scope, env, e.for, b) === false) continue;
        out.push({ text: tag(`${names.deck(e.deck)} card`), certain: false, p, deck: e.deck });
        if (depth < 1) deckHints(scope, e.deck, b, p, depth + 1, out);
        break;
      }
      case 'offerChoice':
        if (refIsViewer(scope, env, e.to, b) === false) continue;
        out.push({ text: tag(`you choose: ${e.options.map((o) => o.label).join(' / ')}`), choice: true, certain: sure, p });
        break;
      case 'spawn':
        out.push({ text: tag(describeEffect(e, names, b)), certain: false, p });
        break;
      case 'if': {
        const c = tryEval(() => evalCond(env, e.cond, b));
        if (c !== false) effectHints(scope, e.then, b, sure && c === true, p, source, out, depth);
        if (c !== true && e.else) effectHints(scope, e.else, b, sure && c === false, p, source, out, depth);
        break;
      }
      case 'forEach': {
        const ids = tryEval(() => evalSelector(env, e.of, b));
        if (ids !== undefined && !ids.includes(scope.viewer)) continue;
        effectHints(scope, e.do, { ...b, $it: scope.viewer }, sure && ids !== undefined, p, source, out, depth);
        break;
      }
      case 'randomBranch': {
        const total = e.branches.reduce((s, br) => s + br.weight, 0);
        for (const br of e.branches) effectHints(scope, br.do, b, false, (p * br.weight) / total, source, out, depth);
        break;
      }
      case 'announce':
      case 'addTag':
      case 'removeTag':
      case 'remove':
        break;
    }
  }
}

/**
 * What drawing from a deck is worth on average: the remaining draw pile is known from the public
 * deck list minus the public discard pile (card counting), never from the hidden order.
 */
export function deckHints(scope: HintScope, deckId: string, b: Bindings, p: number, depth: number, out: Hint[]): void {
  const deck = scope.game.decks.get(deckId);
  const pile = scope.state.decks[deckId];
  if (!deck || !pile) return;
  const remaining = new Map<string, number>();
  const total = deck.cards.reduce((s, c) => s + c.count, 0);
  const drawSize = pile.draw.length > 0 ? pile.draw.length : total;
  for (const card of deck.cards) remaining.set(card.id, card.count);
  if (pile.draw.length > 0 && pile.draw.length + pile.discard.length === total) {
    for (const id of pile.discard) remaining.set(id, (remaining.get(id) ?? 0) - 1);
  }
  const start = out.length;
  for (const card of deck.cards) {
    const n = remaining.get(card.id) ?? 0;
    if (n <= 0) continue;
    effectHints(scope, card.effects, { $actor: scope.viewer, ...(b.$space !== undefined ? { $space: b.$space } : {}) }, false, (p * n) / drawSize, `card “${card.name}”`, out, depth);
  }
  for (let i = start; i < out.length; i++) (out[i] as Hint).fromCard = true;
}

/** What landing on a space would do to the viewer, from public rules only (including attached ones). */
export function landingHints(scope: HintScope, space: string): { hints: Hint[]; fight: FightHint | null } {
  const env = new PreviewEnv(scope.game, scope.state);
  const hints: Hint[] = [];
  const spaceDef = scope.game.spaces.get(space);
  for (const rule of scope.game.ruleIndex.get('landed') ?? []) {
    const def = rule.def as ReactionRule;
    const w = def.trigger.where;
    if (w?.space !== undefined && w.space !== space) continue;
    if (w?.spaceTag !== undefined && !spaceDef?.tags.includes(w.spaceTag)) continue;
    if (w?.actorKind !== undefined && w.actorKind !== 'contestant') continue;
    const holders: Array<string | undefined> = rule.owner ? holdersOf(scope.state, rule.owner) : [undefined];
    for (const holder of holders) {
      const b: Bindings = { $actor: scope.viewer, $space: space, ...(holder !== undefined ? { $holder: holder } : {}) };
      const cond = def.conditions ? tryEval(() => evalCond(env, def.conditions as NonNullable<typeof def.conditions>, b)) : true;
      if (cond === false) continue;
      effectHints(scope, def.effects, b, cond === true, 1, def.name, hints);
    }
  }
  return { hints, fight: hints.find((h) => h.fight && !h.fromCard)?.fight ?? null };
}
