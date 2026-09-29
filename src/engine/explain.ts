import type { Cond, Effect, EntityRef, Num, RuleDef, Selector, SpaceRef, Trigger } from '../schema/rules.ts';
import type { GameEvent, GameState } from '../schema/state.ts';
import type { CompiledGame } from './compile.ts';

/**
 * Structured → plain English. Every explanation shown to the GM or to a contestant is generated
 * from the structured definitions, so the text always matches what the engine does.
 */

export interface Names {
  entity(id: string): string;
  space(id: string): string;
  resource(id: string): string;
  tag(id: string): string;
  item(id: string): string;
  rule(id: string): string;
  entry(id: string): string;
}

export interface NameSource {
  resources: Map<string, { name: string }>;
  tags: Map<string, { name: string }>;
  spaces: Map<string, { name: string }>;
  items: Map<string, { name: string }>;
  rules: Map<string, { def: { name: string } }>;
  shopEntries: Map<string, { entry: { grants: { item: string } | { resource: string; amount: number } } }>;
}

export function makeNames(source: NameSource, entityNames: (id: string) => string | undefined): Names {
  const names: Names = {
    entity: (id) => entityNames(id) ?? id,
    space: (id) => source.spaces.get(id)?.name ?? id,
    resource: (id) => source.resources.get(id)?.name ?? id,
    tag: (id) => source.tags.get(id)?.name ?? id,
    item: (id) => source.items.get(id)?.name ?? id,
    rule: (id) => source.rules.get(id)?.def.name ?? id,
    entry: (id) => {
      const grants = source.shopEntries.get(id)?.entry.grants;
      if (!grants) return id;
      return 'item' in grants ? names.item(grants.item) : `${names.resource(grants.resource)} ×${grants.amount}`;
    },
  };
  return names;
}

export function namesFor(game: CompiledGame, state: GameState): Names {
  return makeNames(game, (id) => state.entities[id]?.name);
}

export interface BoundNames {
  $actor?: string | undefined;
  $target?: string | undefined;
  $it?: string | undefined;
  $space?: string | undefined;
  amount?: number | undefined;
}

const KIND_PLURAL = { contestant: 'contestant', enemy: 'enemy', fixture: 'fixture' } as const;

function ref(r: EntityRef, n: Names, b?: BoundNames): string {
  if (typeof r !== 'string') return n.entity(r.id);
  const bound = b?.[r];
  if (bound !== undefined) return n.entity(bound);
  return r === '$actor' ? 'they' : r === '$target' ? 'the target' : 'it';
}

/** Object form of a reference ("them" instead of "they"). */
function refObj(r: EntityRef, n: Names, b?: BoundNames): string {
  const s = ref(r, n, b);
  return s === 'they' ? 'them' : s;
}

/** Picks the verb form that agrees with a subject ("they gain" / "Ann gains"). */
function verb(subject: string, singular: string, plural: string): string {
  return subject === 'they' || subject === 'you' ? plural : singular;
}

export function describeSpaceRef(r: SpaceRef, n: Names, b?: BoundNames): string {
  if (r === '$space') return b?.$space !== undefined ? n.space(b.$space) : 'that space';
  switch (r.op) {
    case 'space':
      return n.space(r.id);
    case 'spaceOf':
      return `${ref(r.entity, n, b)}'s space`;
    case 'randomSpace':
      return `a random ${n.tag(r.tag)} space${r.excludeSpaceOf !== undefined ? ' (a different one)' : ''}`;
  }
}

export function describeSelector(s: Selector, n: Names, b?: BoundNames): string {
  if (typeof s === 'string') return ref(s, n, b);
  switch (s.op) {
    case 'entity':
      return n.entity(s.id);
    case 'all':
      return s.kind ? `every ${KIND_PLURAL[s.kind]}` : 'everyone';
    case 'at':
      return `${s.kind ? `every ${KIND_PLURAL[s.kind]}` : 'everyone'} at ${describeSpaceRef(s.space, n, b)}`;
    case 'withTag':
      return `every ${s.kind ? KIND_PLURAL[s.kind] : 'one'} tagged ${n.tag(s.tag)}`;
    case 'filter': {
      const w = s.where;
      if (w.op === 'hasTag' && w.entity === '$it') return `${describeSelector(s.from, n, b)} tagged ${n.tag(w.tag)}`;
      return `${describeSelector(s.from, n, b)} where ${describeCond(w, n, b)}`;
    }
    case 'random':
      return `${s.count} random ${describeSelector(s.from, n, b)}`;
  }
}

const ROUNDING_TEXT = { floor: 'rounded down', ceil: 'rounded up', halfUp: 'rounded to nearest', towardZero: 'rounded toward zero' } as const;

export function describeNum(x: Num, n: Names, b?: BoundNames): string {
  if (typeof x === 'number') return String(x);
  switch (x.op) {
    case 'res':
      return `${ref(x.of, n, b)}'s ${n.resource(x.resource)}${x.ifMissing !== undefined ? ` (or ${x.ifMissing} if none)` : ''}`;
    case 'stat':
      return `${ref(x.of, n, b)}'s effective ${n.resource(x.resource)}`;
    case 'roll':
      return `${x.count}d${x.sides}`;
    case 'add':
      return x.args.map((a) => describeNum(a, n, b)).join(' + ');
    case 'sub':
      return `${describeNum(x.a, n, b)} − ${describeNum(x.b, n, b)}`;
    case 'mul':
      return x.args.map((a) => describeNum(a, n, b)).join(' × ');
    case 'div':
      return `(${describeNum(x.a, n, b)} ÷ ${describeNum(x.b, n, b)}, ${ROUNDING_TEXT[x.rounding]})`;
    case 'min':
      return `the lowest of ${x.args.map((a) => describeNum(a, n, b)).join(', ')}`;
    case 'max':
      return `the highest of ${x.args.map((a) => describeNum(a, n, b)).join(', ')}`;
    case 'count':
      return `the number of ${describeSelector(x.of, n, b)}`;
    case 'round':
      return 'the round number';
    case 'amount':
      return b?.amount !== undefined ? String(b.amount) : 'the amount';
  }
}

export function describeCond(c: Cond, n: Names, b?: BoundNames): string {
  switch (c.op) {
    case 'all':
      return c.conds.map((x) => describeCond(x, n, b)).join(' and ');
    case 'any':
      return `(${c.conds.map((x) => describeCond(x, n, b)).join(' or ')})`;
    case 'not':
      return negate(c.cond, n, b);
    case 'hasTag': {
      const who = ref(c.entity, n, b);
      return `${who} ${verb(who, 'is', 'are')} tagged ${n.tag(c.tag)}`;
    }
    case 'spaceHasTag':
      return `${describeSpaceRef(c.space, n, b)} is a ${n.tag(c.tag)} space`;
    case 'isKind': {
      const who = ref(c.entity, n, b);
      return `${who} ${verb(who, 'is', 'are')} a ${c.kind}`;
    }
    case 'holds': {
      const who = ref(c.entity, n, b);
      return `${who} ${verb(who, 'holds', 'hold')} ${n.item(c.item)}`;
    }
    case 'compare':
      return `${describeNum(c.left, n, b)} ${c.cmp === '==' ? '=' : c.cmp === '!=' ? '≠' : c.cmp === '<=' ? '≤' : c.cmp === '>=' ? '≥' : c.cmp} ${describeNum(c.right, n, b)}`;
    case 'exists':
      return `there is ${describeSelector(c.of, n, b)}`;
  }
}

function negate(c: Cond, n: Names, b?: BoundNames): string {
  switch (c.op) {
    case 'hasTag': {
      const who = ref(c.entity, n, b);
      return `${who} ${verb(who, 'is', 'are')} not tagged ${n.tag(c.tag)}`;
    }
    case 'spaceHasTag':
      return `${describeSpaceRef(c.space, n, b)} is not a ${n.tag(c.tag)} space`;
    case 'isKind': {
      const who = ref(c.entity, n, b);
      return `${who} ${verb(who, 'is', 'are')} not a ${c.kind}`;
    }
    case 'holds': {
      const who = ref(c.entity, n, b);
      return `${who} ${verb(who, 'does', 'do')} not hold ${n.item(c.item)}`;
    }
    default:
      return `not (${describeCond(c, n, b)})`;
  }
}

/** "0 − X" reads better as a loss of X. */
function asLoss(x: Num): Num | null {
  if (typeof x === 'number') return x < 0 ? -x : null;
  if (x.op === 'sub' && x.a === 0) return x.b;
  return null;
}

export function describeEffect(e: Effect, n: Names, b?: BoundNames): string {
  switch (e.op) {
    case 'changeResource': {
      const who = describeSelector(e.target, n, b);
      const loss = asLoss(e.amount);
      if (loss !== null) return `${who} ${verb(who, 'loses', 'lose')} ${describeNum(loss, n, b)} ${n.resource(e.resource)}`;
      return `${who} ${verb(who, 'gains', 'gain')} ${describeNum(e.amount, n, b)} ${n.resource(e.resource)}`;
    }
    case 'setResource': {
      const who = describeSelector(e.target, n, b);
      return `${who === 'they' ? 'their' : `${who}'s`} ${n.resource(e.resource)} becomes ${describeNum(e.value, n, b)}`;
    }
    case 'transfer': {
      const who = ref(e.from, n, b);
      return `${who} ${verb(who, 'gives', 'give')} ${describeNum(e.amount, n, b)} ${n.resource(e.resource)} to ${refObj(e.to, n, b)}${e.ifShort === 'skip' ? ' (only if they have enough)' : ''}`;
    }
    case 'addTag': {
      const who = describeSelector(e.target, n, b);
      return `${who} ${verb(who, 'becomes', 'become')} tagged ${n.tag(e.tag)}`;
    }
    case 'removeTag': {
      const who = describeSelector(e.target, n, b);
      return `${who} ${verb(who, 'loses', 'lose')} the ${n.tag(e.tag)} tag`;
    }
    case 'teleport': {
      const who = describeSelector(e.target, n, b);
      return `${who} ${verb(who, 'teleports', 'teleport')} to ${describeSpaceRef(e.to, n, b)}${e.asLanding ? ' (counts as landing)' : ' (not a landing)'}`;
    }
    case 'grantItem': {
      const who = ref(e.target, n, b);
      return `${who} ${verb(who, 'receives', 'receive')} ${e.count && e.count > 1 ? `${e.count}× ` : ''}${n.item(e.item)}`;
    }
    case 'fight': {
      const attacker = describeSelector(e.attacker, n, b);
      const defender = describeSelector(e.defender, n, b);
      return `${attacker} ${verb(attacker, 'attacks', 'attack')} ${defender === 'they' ? 'them' : defender} (combat wheel)`;
    }
    case 'announce':
      return `announce "${e.text}"`;
    case 'if':
      return `if ${describeCond(e.cond, n, b)}: ${describeEffects(e.then, n, b)}${e.else ? `; otherwise: ${describeEffects(e.else, n, b)}` : ''}`;
    case 'forEach':
      return `for each of ${describeSelector(e.of, n, b)}: ${describeEffects(e.do, n, b)}`;
    case 'randomBranch': {
      const total = e.branches.reduce((sum, br) => sum + br.weight, 0);
      return `at random: ${e.branches.map((br) => `${Math.round((br.weight / total) * 100)}% ${describeEffects(br.do, n, b) || 'nothing'}`).join('; or ')}`;
    }
  }
}

export function describeEffects(effects: Effect[], n: Names, b?: BoundNames, options: { skipAnnouncements?: boolean } = {}): string {
  return effects
    .filter((e) => !(options.skipAnnouncements && e.op === 'announce'))
    .map((e) => describeEffect(e, n, b))
    .join(', then ');
}

export function describeTrigger(t: Trigger, n: Names): string {
  const w = t.where ?? {};
  const who = w.actorKind ? `a ${w.actorKind}` : 'someone';
  const place = w.space !== undefined ? n.space(w.space) : w.spaceTag !== undefined ? `a ${n.tag(w.spaceTag)} space` : 'a space';
  switch (t.event) {
    case 'roundStarted':
      return 'a round starts';
    case 'roundEnded':
      return 'a round ends';
    case 'turnStarted':
      return `${who}'s turn starts`;
    case 'turnEnded':
      return `${who}'s turn ends`;
    case 'landed':
      return `${who} lands on ${place}`;
    case 'entered':
      return `${who} arrives at ${place} (walking or teleporting)`;
    case 'left':
      return `${who} leaves ${place}`;
    case 'resourceChanged':
      return `${w.targetKind ? `a ${w.targetKind}` : 'someone'} ${w.direction === 'loss' ? 'loses' : w.direction === 'gain' ? 'gains' : 'gains or loses'} ${w.resource !== undefined ? n.resource(w.resource) : 'a resource'}`;
    case 'purchased':
      return `${who} buys ${w.shopEntry !== undefined ? n.entry(w.shopEntry) : 'something'}`;
    case 'defeated':
      return `${w.targetTag !== undefined ? `something tagged ${n.tag(w.targetTag)}` : w.targetKind ? `a ${w.targetKind}` : 'anyone'} is defeated`;
    case 'itemGained':
      return `${who} gains ${w.item !== undefined ? n.item(w.item) : 'an item'}`;
  }
}

export function describeRule(rule: RuleDef, n: Names): string {
  const cond = rule.conditions ? `, if ${describeCond(rule.conditions, n)}` : '';
  const limit = rule.limits?.maxPerTurn !== undefined ? ` At most ${rule.limits.maxPerTurn} time${rule.limits.maxPerTurn > 1 ? 's' : ''} per turn.` : '';
  return `Whenever ${describeTrigger(rule.trigger, n)}${cond}: ${describeEffects(rule.effects, n)}.${limit}`;
}

function signed(v: number): string {
  return v >= 0 ? `+${v}` : `${v}`;
}

/** One-line description of a committed event for logs and packets. */
export function describeEvent(e: GameEvent, n: Names): string {
  switch (e.type) {
    case 'matchStarted':
      return `Match started. Turn order: ${e.turnOrder.map((id) => n.entity(id)).join(', ')}`;
    case 'roundStarted':
      return `Round ${e.round} begins`;
    case 'roundEnded':
      return `Round ${e.round} ends`;
    case 'turnStarted':
      return `${n.entity(e.entity)}'s turn`;
    case 'turnSkipped':
      return `${n.entity(e.entity)} skips this turn (${e.reason})`;
    case 'turnEnded':
      return `${n.entity(e.entity)} ends their turn`;
    case 'rolled':
      return `${n.entity(e.entity)} rolled ${e.value} (d${e.sides})`;
    case 'decided':
      return `${n.entity(e.entity)} chose: ${e.label}${e.say ? ` — “${e.say}”` : ''}`;
    case 'moved':
      return e.mode === 'teleport'
        ? `${n.entity(e.entity)} teleported to ${n.space(e.to)}`
        : `${n.entity(e.entity)} moved to ${n.space(e.to)} (${e.path.length - 1} step${e.path.length === 2 ? '' : 's'})`;
    case 'left':
      return `${n.entity(e.entity)} left ${n.space(e.space)}`;
    case 'entered':
      return `${n.entity(e.entity)} arrived at ${n.space(e.space)}`;
    case 'landed':
      return `${n.entity(e.entity)} landed on ${n.space(e.space)}`;
    case 'resourceChanged':
      return `${n.entity(e.entity)} ${signed(e.to - e.from)} ${n.resource(e.resource)} (${e.from}→${e.to})${e.to - e.from !== e.requested ? ` [requested ${signed(e.requested)}]` : ''}`;
    case 'tagAdded':
      return `${n.entity(e.entity)} is now tagged ${n.tag(e.tag)}`;
    case 'tagRemoved':
      return `${n.entity(e.entity)} is no longer tagged ${n.tag(e.tag)}`;
    case 'itemGained':
      return `${n.entity(e.entity)} gained ${n.item(e.itemDef)}`;
    case 'itemLost':
      return `${n.entity(e.entity)} lost ${n.item(e.itemDef)}`;
    case 'purchased':
      return `${n.entity(e.entity)} bought ${n.entry(e.entry)} for ${e.price} ${n.resource(e.priceResource)}`;
    case 'rested':
      return `${n.entity(e.entity)} rested (+${e.healed} HP)`;
    case 'passed':
      return `${n.entity(e.entity)} passed`;
    case 'fightStarted':
      return `⚔ ${n.entity(e.attacker)} (${e.attackerPower} Power, ${e.attackerHp} HP) attacks ${n.entity(e.defender)} (${e.defenderPower} Power, ${e.defenderHp} HP): wheel ${pct(e.attackerPower, e.defenderPower)} vs ${pct(e.defenderPower, e.attackerPower)}, hits ${e.attackerDamage} / ${e.defenderDamage}`;
    case 'spin':
      return `Spin ${e.index}: ${n.entity(e.winner)} wins (${e.roll + 1} of ${e.total}) — ${n.entity(e.loser)} takes ${e.damage} damage (HP ${e.loserHpAfter})`;
    case 'fightEnded':
      return `Fight over: ${e.outcome === 'bothStanding' ? 'both fighters still standing' : e.outcome === 'attackerWon' ? 'attacker wins' : 'defender wins'}`;
    case 'defeated':
      return `${n.entity(e.entity)} was defeated${e.by ? ` by ${n.entity(e.by)}` : ''}`;
    case 'knockedOut':
      return `${n.entity(e.entity)} is knocked out: loses ${e.goldLost} gold, returns to ${n.space(e.respawnSpace)}, skips ${e.skipTurns} turn${e.skipTurns === 1 ? '' : 's'}`;
    case 'respawned':
      return `${n.entity(e.entity)} returns at ${n.space(e.space)}`;
    case 'announced':
      return `📣 ${e.text}`;
    case 'ruleFault':
      return `⚠ Rule "${n.rule(e.rule)}" could not run: ${e.message}`;
    case 'gmCommand':
      return `GM: ${e.summary}`;
    case 'gameOver':
      return `🏆 Game over — ${e.winners.map((id) => n.entity(id)).join(' & ')} win${e.winners.length === 1 ? 's' : ''} (${e.reason})`;
  }
}

function pct(a: number, b: number): string {
  return `${((a / (a + b)) * 100).toFixed(1)}%`;
}
