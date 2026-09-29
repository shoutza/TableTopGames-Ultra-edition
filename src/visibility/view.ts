import { fightOdds, type FightOdds } from '../engine/combat.ts';
import type { CompiledGame } from '../engine/compile.ts';
import { evalCond, evalNum, evalSelector, evalSpaceRef, type Bindings, type EvalEnv } from '../engine/eval.ts';
import { describeEffect, describeEffects, describeRule, namesFor, type Names } from '../engine/explain.ts';
import { effectiveValue, reachableSpaces } from '../engine/queries.ts';
import { RuleFault, UnknownValue, cloneJson } from '../engine/util.ts';
import type { Effect, Num } from '../schema/rules.ts';
import type { Decision, DecisionOption, GameEvent, GameState } from '../schema/state.ts';
import { redactStateFor, visibleEvents, visibleResourceIds, type VisibleEvent } from './redact.ts';

/**
 * ContestantView: everything one contestant is allowed to know, in a shape made for decision
 * packets and the fallback player. It is built only from the redacted state.
 */

export interface ViewEntity {
  id: string;
  kind: 'contestant' | 'enemy' | 'fixture';
  name: string;
  spaceId: string | null;
  status: 'active' | 'defeated';
  isSelf: boolean;
  /** Effective values of the resources this viewer may see. */
  stats: Record<string, number>;
  /** Resources the entity has whose values are hidden from this viewer. */
  hiddenStats: string[];
  tags: string[];
  items: Array<{ id: string; defId: string; name: string }>;
  koTurns: number;
  respawnRound: number | null;
  shopEntries: Array<{ entry: string; label: string; price: number; priceResource: string }>;
}

export interface Hint {
  text: string;
  resource?: string | undefined;
  min?: number | undefined;
  max?: number | undefined;
  /** False when it depends on something unknown (conditions, hidden values). */
  certain: boolean;
}

export interface FightHint {
  opponent: string;
  opponentName: string;
  iAmAttacker: boolean;
  myPower: number;
  myHp: number;
  theirPower: number;
  theirHp: number;
  odds: FightOdds;
  rewards: string | null;
}

export type OptionPreview =
  | {
      kind: 'move';
      optionId: string;
      space: string;
      spaceName: string;
      steps: number;
      tags: string[];
      occupants: string[];
      hints: Hint[];
      fight: FightHint | null;
      /** Steps from this destination to each point of interest (fixtures, active enemies, key space tags). */
      distances: Array<{ label: string; key: string; steps: number }>;
    }
  | { kind: 'buy'; optionId: string; entry: string; label: string; price: number; priceResource: string; powerAfter: number | null; grantsResource: string | null; grantsAmount: number }
  | { kind: 'attack'; optionId: string; enemy: string; fight: FightHint }
  | { kind: 'rest'; optionId: string; heal: number; hpAfter: number }
  | { kind: 'pass'; optionId: string };

export interface ContestantView {
  viewer: string;
  round: number;
  roundLimit: number;
  phase: GameState['phase'];
  activeContestant: string | null;
  turnOrder: string[];
  roll: number | null;
  entities: ViewEntity[];
  decision: (Decision & { previews: OptionPreview[] }) | null;
  recentEvents: VisibleEvent[];
  winners: string[] | null;
}

class PreviewEnv implements EvalEnv {
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

function tryEval<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    if (err instanceof UnknownValue || err instanceof RuleFault) return undefined;
    throw err;
  }
}

/** Interval of possible values of a number expression without drawing randomness. */
function rangeOf(env: PreviewEnv, n: Num, b: Bindings): [number, number] | undefined {
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
    default: {
      const v = tryEval(() => evalNum(env, n, b));
      return v === undefined ? undefined : [v, v];
    }
  }
}

function signedRange(min: number, max: number): string {
  const s = (v: number) => (v >= 0 ? `+${v}` : `${v}`);
  return min === max ? s(min) : `${s(min)} to ${s(max)}`;
}

function fightHint(game: CompiledGame, state: GameState, names: Names, me: string, opponent: string, iAmAttacker: boolean): FightHint | null {
  const { core, combat } = game.def.settings;
  const mine = state.entities[me];
  const theirs = state.entities[opponent];
  if (!mine || !theirs) return null;
  const myPower = effectiveValue(game, state, mine, core.power);
  const myHp = effectiveValue(game, state, mine, core.hp);
  const theirPower = effectiveValue(game, state, theirs, core.power);
  const theirHp = effectiveValue(game, state, theirs, core.hp);
  if (myPower === undefined || myHp === undefined || theirPower === undefined || theirHp === undefined) return null;
  const odds = iAmAttacker
    ? fightOdds({ attackerPower: myPower, attackerHp: myHp, defenderPower: theirPower, defenderHp: theirHp, maxSpins: combat.maxSpinsPerFight, damage: combat.damage })
    : fightOdds({ attackerPower: theirPower, attackerHp: theirHp, defenderPower: myPower, defenderHp: myHp, maxSpins: combat.maxSpinsPerFight, damage: combat.damage });
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
      };
  const enemyDef = theirs.kind === 'enemy' ? game.enemies.get(theirs.defId) : undefined;
  return {
    opponent,
    opponentName: theirs.name,
    iAmAttacker,
    myPower,
    myHp,
    theirPower,
    theirHp,
    odds: mineOdds,
    rewards:
      enemyDef && enemyDef.rewards.length > 0
        ? describeEffects(enemyDef.rewards, { ...names, entity: (id) => (id === me ? 'you' : names.entity(id)) }, { $actor: me, $target: opponent }, { skipAnnouncements: true })
        : null,
  };
}

/** What landing on a space would do to the viewer, from public rules only. */
function landingHints(game: CompiledGame, hypo: GameState, names: Names, viewer: string, space: string): { hints: Hint[]; fight: FightHint | null } {
  const env = new PreviewEnv(game, hypo);
  const hints: Hint[] = [];
  let fight: FightHint | null = null;
  const b: Bindings = { $actor: viewer, $space: space };
  const spaceDef = game.spaces.get(space);
  for (const rule of game.ruleIndex.get('landed') ?? []) {
    if (rule.def.visibility !== 'public') continue;
    const w = rule.def.trigger.where;
    if (w?.space !== undefined && w.space !== space) continue;
    if (w?.spaceTag !== undefined && !spaceDef?.tags.includes(w.spaceTag)) continue;
    if (w?.actorKind !== undefined && w.actorKind !== 'contestant') continue;
    const cond = rule.def.conditions ? tryEval(() => evalCond(env, rule.def.conditions as NonNullable<typeof rule.def.conditions>, b)) : true;
    if (cond === false) continue;
    const certain = cond === true;
    const summarize = (effects: Effect[], sure: boolean): void => {
      for (const e of effects) {
        if (e.op === 'changeResource') {
          const targets = tryEval(() => evalSelector(env, e.target, b));
          if (targets && !targets.includes(viewer)) continue;
          const r = rangeOf(env, e.amount, b);
          const resName = names.resource(e.resource);
          hints.push(
            r
              ? { text: `${signedRange(r[0], r[1])} ${resName} (${rule.def.name})`, resource: e.resource, min: r[0], max: r[1], certain: sure && targets !== undefined }
              : { text: `${resName} changes (${rule.def.name})`, resource: e.resource, certain: false },
          );
        } else if (e.op === 'fight') {
          const attacker = tryEval(() => evalSelector(env, e.attacker, b)[0]);
          const defender = tryEval(() => evalSelector(env, e.defender, b)[0]);
          if (defender === viewer && attacker !== undefined) {
            fight = fightHint(game, hypo, names, viewer, attacker, false);
            hints.push({ text: `${names.entity(attacker)} attacks you (${rule.def.name})`, certain: sure });
          } else if (attacker === viewer && defender !== undefined) {
            fight = fightHint(game, hypo, names, viewer, defender, true);
            hints.push({ text: `you attack ${names.entity(defender)} (${rule.def.name})`, certain: sure });
          }
        } else if (e.op === 'teleport') {
          const targets = tryEval(() => evalSelector(env, e.target, b));
          if (targets && !targets.includes(viewer)) continue;
          const to = tryEval(() => evalSpaceRef(env, e.to, b));
          hints.push({ text: `teleported to ${to !== undefined ? names.space(to) : 'another space'} (${rule.def.name})`, certain: false });
        } else if (e.op === 'if') {
          const c = tryEval(() => evalCond(env, e.cond, b));
          if (c !== false) summarize(e.then, sure && c === true);
          if (c !== true && e.else) summarize(e.else, sure && c === false);
        } else if (e.op === 'announce') {
          continue;
        } else {
          hints.push({ text: `${describeEffect(e, names, b)} (${rule.def.name})`, certain: false });
        }
      }
    };
    summarize(rule.def.effects, certain);
  }
  return { hints, fight };
}

function distancesFrom(game: CompiledGame, state: GameState, from: string): Array<{ label: string; key: string; steps: number }> {
  const dist = reachableSpaces(game, from, 1000);
  const out: Array<{ label: string; key: string; steps: number }> = [];
  for (const e of Object.values(state.entities)) {
    if (e.spaceId === null || e.kind === 'contestant' || e.status !== 'active') continue;
    const d = dist.get(e.spaceId);
    if (d !== undefined) out.push({ label: e.name, key: e.id, steps: d });
  }
  const tags = new Set<string>();
  for (const rule of game.ruleIndex.get('landed') ?? []) {
    if (rule.def.visibility === 'public' && rule.def.trigger.where?.spaceTag !== undefined) tags.add(rule.def.trigger.where.spaceTag);
  }
  for (const tag of tags) {
    let best: number | undefined;
    for (const [space, d] of dist) if (game.spaces.get(space)?.tags.includes(tag) && (best === undefined || d < best)) best = d;
    if (best !== undefined) out.push({ label: `nearest ${game.tags.get(tag)?.name ?? tag} space`, key: tag, steps: best });
  }
  return out;
}

function previewOption(game: CompiledGame, redacted: GameState, names: Names, viewer: string, option: DecisionOption): OptionPreview {
  const { core, rest } = game.def.settings;
  const me = redacted.entities[viewer];
  switch (option.kind) {
    case 'move': {
      const hypo = cloneJson(redacted);
      const self = hypo.entities[viewer];
      if (self) self.spaceId = option.space;
      const { hints, fight } = option.steps > 0 ? landingHints(game, hypo, names, viewer, option.space) : { hints: [], fight: null };
      const occupants = Object.values(redacted.entities)
        .filter((e) => e.spaceId === option.space && e.id !== viewer && e.status === 'active')
        .map((e) => e.name);
      return {
        kind: 'move',
        optionId: option.id,
        space: option.space,
        spaceName: names.space(option.space),
        steps: option.steps,
        tags: game.spaces.get(option.space)?.tags ?? [],
        occupants,
        hints,
        fight,
        distances: distancesFrom(game, redacted, option.space),
      };
    }
    case 'buy': {
      const found = game.shopEntries.get(option.entry);
      const grants = found?.entry.grants;
      let powerAfter: number | null = null;
      if (grants && 'item' in grants && me) {
        const add = game.items.get(grants.item)?.modifiers.filter((m) => m.resource === core.power).reduce((s, m) => s + m.add, 0) ?? 0;
        if (add !== 0) powerAfter = (effectiveValue(game, redacted, me, core.power) ?? 0) + add;
      }
      return {
        kind: 'buy',
        optionId: option.id,
        entry: option.entry,
        label: option.label,
        price: found?.entry.price.amount ?? 0,
        priceResource: found?.entry.price.resource ?? '',
        powerAfter,
        grantsResource: grants && 'resource' in grants ? grants.resource : null,
        grantsAmount: grants && 'resource' in grants ? grants.amount : 0,
      };
    }
    case 'attack': {
      const fight = fightHint(game, redacted, names, viewer, option.enemy, true);
      if (!fight) throw new Error('attack preview needs visible Power and HP');
      return { kind: 'attack', optionId: option.id, enemy: option.enemy, fight };
    }
    case 'rest': {
      const hp = me ? (effectiveValue(game, redacted, me, core.hp) ?? 0) : 0;
      const max = me ? (effectiveValue(game, redacted, me, core.maxHp) ?? hp) : hp;
      return { kind: 'rest', optionId: option.id, heal: rest.heal, hpAfter: Math.min(max, hp + rest.heal) };
    }
    case 'pass':
      return { kind: 'pass', optionId: option.id };
  }
}

/** Builds the viewer's view from authoritative state; hidden values never enter it. */
export function buildContestantView(game: CompiledGame, state: GameState, viewer: string, history: GameEvent[], recentLimit = 80): ContestantView {
  const redacted = redactStateFor(game, state, viewer);
  const names = namesFor(game, redacted);
  const entities: ViewEntity[] = Object.values(redacted.entities).map((e) => {
    const allowed = visibleResourceIds(game, viewer, e.id);
    const stats: Record<string, number> = {};
    for (const key of Object.keys(e.resources)) {
      const v = effectiveValue(game, redacted, e, key);
      if (v !== undefined) stats[key] = v;
    }
    const original = state.entities[e.id];
    const hiddenStats = original ? Object.keys(original.resources).filter((k) => !allowed.has(k) && game.resources.get(k)?.visibility === 'owner') : [];
    const shopId = e.kind === 'fixture' ? game.fixtures.get(e.defId)?.shop : undefined;
    const shop = shopId !== undefined ? game.shops.get(shopId) : undefined;
    return {
      id: e.id,
      kind: e.kind,
      name: e.name,
      spaceId: e.spaceId,
      status: e.status,
      isSelf: e.id === viewer,
      stats,
      hiddenStats,
      tags: [...e.tags],
      items: e.items.map((id) => ({ id, defId: redacted.items[id]?.defId ?? '', name: names.item(redacted.items[id]?.defId ?? '') })),
      koTurns: e.koTurns,
      respawnRound: e.respawnRound,
      shopEntries: (shop?.entries ?? []).map((entry) => ({ entry: entry.id, label: names.entry(entry.id), price: entry.price.amount, priceResource: entry.price.resource })),
    };
  });
  const pending = redacted.pendingDecision;
  const decision = pending && pending.actor === viewer ? { ...pending, previews: pending.options.map((o) => previewOption(game, redacted, names, viewer, o)) } : null;
  const recent = visibleEvents(game, history, viewer).slice(-recentLimit);
  return {
    viewer,
    round: redacted.round,
    roundLimit: game.def.settings.victory.roundLimit,
    phase: redacted.phase,
    activeContestant: redacted.turnOrder[redacted.turn.index] ?? null,
    turnOrder: [...redacted.turnOrder],
    roll: redacted.turn.roll,
    entities,
    decision,
    recentEvents: recent,
    winners: redacted.winners,
  };
}

/** Public rules as text (hidden rules are never included). */
export function publicRuleTexts(game: CompiledGame, state: GameState, viewer: string): Array<{ id: string; name: string; text: string }> {
  const names = namesFor(game, redactStateFor(game, state, viewer));
  return [...game.rules.values()]
    .filter((r) => r.def.enabled && r.def.visibility === 'public')
    .map((r) => ({ id: r.def.id, name: r.def.name, text: describeRule(r.def, names) }));
}
