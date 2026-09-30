import type { ObjectiveDef, StatusDef } from '../schema/definition.ts';
import type { Capability, Cond, ContinuousRule, Effect, EntityRef, ModifierRule, ModifyOp, Num, ReactionRule, RuleDef, RuleLimits, Selector, SpaceRef, Trigger } from '../schema/rules.ts';
import type { GameEvent, GameState, PromiseTerm, TradeTermsView } from '../schema/state.ts';
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
  status(id: string): string;
  deck(id: string): string;
  card(id: string): string;
  action(id: string): string;
  enemy(id: string): string;
  objective(id: string): string;
}

export interface NameSource {
  resources: Map<string, { name: string }>;
  tags: Map<string, { name: string }>;
  spaces: Map<string, { name: string }>;
  items: Map<string, { name: string }>;
  rules: Map<string, { def: { name: string } }>;
  shopEntries: Map<string, { entry: { grants: { item: string } | { resource: string; amount: number } } }>;
  statuses?: Map<string, { name: string }> | undefined;
  decks?: Map<string, { name: string }> | undefined;
  cards?: Map<string, { card: { name: string } }> | undefined;
  actions?: Map<string, { name: string }> | undefined;
  enemies?: Map<string, { name: string }> | undefined;
  objectives?: Map<string, { name: string }> | undefined;
}

export function makeNames(source: NameSource, entityNames: (id: string) => string | undefined): Names {
  const names: Names = {
    entity: (id) => entityNames(id) ?? (id === 'gm' ? 'the GM' : id),
    space: (id) => source.spaces.get(id)?.name ?? id,
    resource: (id) => source.resources.get(id)?.name ?? id,
    tag: (id) => source.tags.get(id)?.name ?? id,
    item: (id) => (id === 'concealed' ? 'a concealed item' : (source.items.get(id)?.name ?? id)),
    rule: (id) => source.rules.get(id)?.def.name ?? (id.startsWith('card:') ? `card “${names.card(id.slice(5))}”` : id),
    entry: (id) => {
      if (id === 'concealed') return 'something';
      const grants = source.shopEntries.get(id)?.entry.grants;
      if (!grants) return id;
      return 'item' in grants ? names.item(grants.item) : `${names.resource(grants.resource)} ×${grants.amount}`;
    },
    status: (id) => source.statuses?.get(id)?.name ?? id,
    deck: (id) => source.decks?.get(id)?.name ?? id,
    card: (id) => source.cards?.get(id)?.card.name ?? id,
    action: (id) => source.actions?.get(id)?.name ?? id,
    enemy: (id) => source.enemies?.get(id)?.name ?? id,
    objective: (id) => (id === 'hidden' ? 'a secret objective' : (source.objectives?.get(id)?.name ?? id)),
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
  $holder?: string | undefined;
  $space?: string | undefined;
  amount?: number | undefined;
}

const KIND_PLURAL = { contestant: 'contestant', enemy: 'enemy', fixture: 'fixture' } as const;

function ref(r: EntityRef, n: Names, b?: BoundNames): string {
  if (typeof r !== 'string') return n.entity(r.id);
  const bound = b?.[r];
  if (bound !== undefined) return n.entity(bound);
  return r === '$actor' ? 'they' : r === '$target' ? 'the target' : r === '$holder' ? 'the holder' : 'it';
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

function possessive(subject: string): string {
  return subject === 'they' ? 'their' : subject === 'you' ? 'your' : subject === 'it' ? 'its' : `${subject}'s`;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

/** "a contestant tagged Fish" rather than "every contestant tagged Fish" (for "there is …"). */
function describeSome(s: Selector, n: Names, b?: BoundNames): string {
  if (typeof s === 'object') {
    if (s.op === 'withTag') return `${s.kind ? article(KIND_PLURAL[s.kind]) : 'someone'} tagged ${n.tag(s.tag)}`;
    if (s.op === 'all') return s.kind ? article(KIND_PLURAL[s.kind]) : 'someone';
    if (s.op === 'at') return `${s.kind ? article(KIND_PLURAL[s.kind]) : 'someone'} at ${describeSpaceRef(s.space, n, b)}`;
  }
  return describeSelector(s, n, b);
}

export function describeSpaceRef(r: SpaceRef, n: Names, b?: BoundNames): string {
  if (r === '$space') return b?.$space !== undefined ? n.space(b.$space) : 'that space';
  switch (r.op) {
    case 'space':
      return n.space(r.id);
    case 'spaceOf':
      return `${possessive(ref(r.entity, n, b))} space`;
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
    case 'leader':
      return `the contestant(s) with the most ${n.resource(s.resource)}`;
    case 'trailer':
      return `the contestant(s) with the fewest ${n.resource(s.resource)}`;
  }
}

const ROUNDING_TEXT = { floor: 'rounded down', ceil: 'rounded up', halfUp: 'rounded to nearest', towardZero: 'rounded toward zero' } as const;

export function describeNum(x: Num, n: Names, b?: BoundNames): string {
  if (typeof x === 'number') return String(x);
  switch (x.op) {
    case 'res':
      return `${possessive(ref(x.of, n, b))} ${n.resource(x.resource)}${x.ifMissing !== undefined ? ` (or ${x.ifMissing} if none)` : ''}`;
    case 'stat':
      return `${possessive(ref(x.of, n, b))} effective ${n.resource(x.resource)}`;
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
    case 'stacks':
      return `${possessive(ref(x.of, n, b))} ${n.status(x.status)} stacks`;
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
      if (c.equipped === true) return `${who} ${verb(who, 'wears', 'wear')} ${n.item(c.item)}`;
      return `${who} ${verb(who, 'holds', 'hold')} ${n.item(c.item)}${c.equipped === false ? ' (not worn)' : ''}`;
    }
    case 'compare':
      return `${describeNum(c.left, n, b)} ${c.cmp === '==' ? '=' : c.cmp === '!=' ? '≠' : c.cmp === '<=' ? '≤' : c.cmp === '>=' ? '≥' : c.cmp} ${describeNum(c.right, n, b)}`;
    case 'exists':
      return `there is ${describeSome(c.of, n, b)}`;
    case 'hasStatus': {
      const who = ref(c.entity, n, b);
      return `${who} ${verb(who, 'is', 'are')} ${n.status(c.status)}${c.minStacks !== undefined && c.minStacks > 1 ? ` (at least ${c.minStacks} stacks)` : ''}`;
    }
    case 'same':
      return `${ref(c.a, n, b)} is ${refObj(c.b, n, b)}`;
    case 'sameSpace': {
      const who = ref(c.a, n, b);
      return `${who} ${verb(who, 'is', 'are')} on the same space as ${refObj(c.b, n, b)}`;
    }
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
      if (c.equipped === true) return `${who} ${verb(who, 'does', 'do')} not wear ${n.item(c.item)}`;
      return `${who} ${verb(who, 'does', 'do')} not hold ${n.item(c.item)}${c.equipped === false ? ' in the bag' : ''}`;
    }
    case 'hasStatus': {
      const who = ref(c.entity, n, b);
      return `${who} ${verb(who, 'is', 'are')} not ${n.status(c.status)}`;
    }
    case 'same':
      return `${ref(c.a, n, b)} is not ${refObj(c.b, n, b)}`;
    case 'exists':
      return `there is no ${describeSome(c.of, n, b).replace(/^an? /, '')}`;
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

function itemSpec(spec: string, n: Names): string {
  return spec === 'random' ? 'a random item' : n.item(spec);
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
      return `${possessive(who)} ${n.resource(e.resource)} becomes ${describeNum(e.value, n, b)}`;
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
    case 'transferItem': {
      const who = ref(e.from, n, b);
      return `${who} ${verb(who, 'hands', 'hand')} ${itemSpec(e.item, n)} to ${refObj(e.to, n, b)}`;
    }
    case 'loseItem': {
      const who = ref(e.target, n, b);
      return `${who} ${verb(who, 'loses', 'lose')} ${itemSpec(e.item, n)}`;
    }
    case 'fight': {
      const attacker = describeSelector(e.attacker, n, b);
      const defender = describeSelector(e.defender, n, b);
      return `${attacker} ${verb(attacker, 'attacks', 'attack')} ${defender === 'they' ? 'them' : defender} (combat wheel)`;
    }
    case 'damage': {
      const who = describeSelector(e.target, n, b);
      return `${who} ${verb(who, 'takes', 'take')} ${describeNum(e.amount, n, b)} damage`;
    }
    case 'applyStatus': {
      const who = describeSelector(e.target, n, b);
      return `${who} ${verb(who, 'becomes', 'become')} ${n.status(e.status)}${e.stacks && e.stacks > 1 ? ` ×${e.stacks}` : ''}${e.duration !== undefined ? ` for ${e.duration} turn${e.duration === 1 ? '' : 's'}` : ''}`;
    }
    case 'removeStatus': {
      const who = describeSelector(e.target, n, b);
      return `${who} ${verb(who, 'is', 'are')} no longer ${n.status(e.status)}${e.stacks !== undefined ? ` (${e.stacks} stack${e.stacks === 1 ? '' : 's'})` : ''}`;
    }
    case 'spawn':
      return `${e.count && e.count > 1 ? `${e.count}× ` : 'a '}${n.enemy(e.enemy)} appear${e.count && e.count > 1 ? '' : 's'} at ${describeSpaceRef(e.at, n, b)}`;
    case 'remove': {
      const who = describeSelector(e.target, n, b);
      return `${who} ${verb(who, 'leaves', 'leave')} the board for good`;
    }
    case 'drawCard': {
      const who = ref(e.for, n, b);
      return `${who} ${verb(who, 'draws', 'draw')} a card from ${n.deck(e.deck)}`;
    }
    case 'offerChoice': {
      const who = ref(e.to, n, b);
      return `${who} ${verb(who, 'chooses', 'choose')}: ${e.options.map((o) => `“${o.label}”${o.effects.length ? ` (${describeEffects(o.effects, n, { ...b, $actor: undefined }) || 'nothing'})` : ' (nothing)'}`).join(' or ')}`;
    }
    case 'announce':
      return `announce "${e.text}"`;
    case 'askGm': {
      const options = (e.options ?? []).map((o) => `“${o.label}”${o.effects.length ? ` (${describeEffects(o.effects, n, b) || 'nothing'})` : ''}`);
      return `the GM rules on “${e.question}”${e.about !== undefined ? ` about ${refObj(e.about, n, b)}` : ''}: ${[...options, '“No effect”'].join(' or ')}`;
    }
    case 'if':
      return `if ${describeCond(e.cond, n, b)}: ${describeEffects(e.then, n, b) || 'nothing'}${e.else ? `; otherwise: ${describeEffects(e.else, n, b) || 'nothing'}` : ''}`;
    case 'forEach':
      return `for each of ${describeSelector(e.of, n, b)}: ${describeEffects(e.do, n, b)}`;
    case 'randomBranch': {
      const total = e.branches.reduce((sum, br) => sum + br.weight, 0);
      return `at random: ${e.branches.map((br) => `${Math.round((br.weight / total) * 100)}% ${describeEffects(br.do, n, b) || 'nothing'}`).join('; or ')}`;
    }
  }
}

function terseNum(x: Num, n: Names): string {
  if (typeof x === 'number') return String(x);
  if (x.op === 'roll') return `${x.count}d${x.sides}`;
  if (x.op === 'add' && x.args.every((a) => typeof a === 'number' || (typeof a === 'object' && a.op === 'roll'))) return x.args.map((a) => terseNum(a, n)).join('+');
  return describeNum(x, n);
}

function terseSubject(sel: Selector | EntityRef, n: Names): string {
  if (sel === '$actor' || sel === '$holder') return '';
  if (typeof sel === 'object' && sel.op === 'all') return sel.kind === 'contestant' ? 'every contestant: ' : 'everyone: ';
  if (sel === '$it') return '';
  return `${describeSelector(sel as Selector, n)}: `;
}

/**
 * Compact effect text for rulebook digests ("+1d6+2 Gold", "become Blessed", "50%: …"). Generated
 * from the same structured data as the full descriptions; falls back to them for anything unusual.
 */
/** "Stars" → "Star" for a single unit (names are plural nouns like Stars, Bananas, Gold). */
function singular(name: string): string {
  return /[^s]s$/.test(name) ? name.slice(0, -1) : name;
}

export function summarizeEffects(effects: Effect[], n: Names): string {
  const parts: string[] = [];
  for (const e of effects) {
    switch (e.op) {
      case 'changeResource': {
        const loss = asLoss(e.amount);
        const one = e.amount === 1 || e.amount === -1;
        parts.push(`${terseSubject(e.target, n)}${loss !== null ? `−${terseNum(loss, n)}` : `+${terseNum(e.amount, n)}`} ${one ? singular(n.resource(e.resource)) : n.resource(e.resource)}`);
        break;
      }
      case 'damage':
        parts.push(`${terseSubject(e.target, n)}${terseNum(e.amount, n)} damage`);
        break;
      case 'applyStatus':
        parts.push(`${terseSubject(e.target, n)}become ${n.status(e.status)}${e.stacks && e.stacks > 1 ? ` ×${e.stacks}` : ''}`);
        break;
      case 'grantItem':
        parts.push(`get ${n.item(e.item)}`);
        break;
      case 'transfer':
        parts.push(e.from === '$target' && e.to === '$actor' ? `take ${terseNum(e.amount, n)} ${n.resource(e.resource)} from them` : describeEffect(e, n));
        break;
      case 'drawCard':
        parts.push(`draw from ${n.deck(e.deck)}`);
        break;
      case 'offerChoice':
        parts.push(`choose: ${e.options.map((o) => `${o.label}${o.effects.length === 0 ? '' : ''}`).join(' / ')}`);
        break;
      case 'askGm':
        parts.push(`the GM rules: ${[...(e.options ?? []).map((o) => o.label), 'no effect'].join(' / ')}`);
        break;
      case 'spawn':
        parts.push(`${n.enemy(e.enemy)} appears at ${describeSpaceRef(e.at, n)}`);
        break;
      case 'forEach':
        parts.push(`${e.of !== '$actor' ? terseSubject(e.of, n) : ''}${summarizeEffects(e.do, n)}`);
        break;
      case 'if':
        parts.push(`if ${describeCond(e.cond, n)}: ${summarizeEffects(e.then, n) || 'nothing'}${e.else ? `, else ${summarizeEffects(e.else, n) || 'nothing'}` : ''}`);
        break;
      case 'randomBranch': {
        const total = e.branches.reduce((sum, br) => sum + br.weight, 0);
        parts.push(e.branches.map((br) => `${Math.round((br.weight / total) * 100)}%: ${summarizeEffects(br.do, n) || 'nothing'}`).join(' | '));
        break;
      }
      case 'announce':
        break;
      default:
        parts.push(describeEffect(e, n));
    }
  }
  return parts.join(', ');
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
  const target = w.targetTag !== undefined ? `something tagged ${n.tag(w.targetTag)}` : w.targetKind ? `a ${w.targetKind}` : 'someone';
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
      return `${target} ${w.direction === 'loss' ? 'loses' : w.direction === 'gain' ? 'gains' : 'gains or loses'} ${w.resource !== undefined ? n.resource(w.resource) : 'a resource'}`;
    case 'purchased':
      return `${who} buys ${w.shopEntry !== undefined ? n.entry(w.shopEntry) : 'something'}`;
    case 'defeated':
      return `${w.enemy !== undefined ? `a ${n.enemy(w.enemy)}` : w.targetTag !== undefined ? `something tagged ${n.tag(w.targetTag)}` : w.targetKind ? `a ${w.targetKind}` : 'anyone'} is defeated`;
    case 'itemGained':
      return `${who} gains ${w.item !== undefined ? n.item(w.item) : 'an item'}`;
    case 'itemLost':
      return `${who} loses ${w.item !== undefined ? n.item(w.item) : 'an item'}`;
    case 'itemUsed':
      return `${who} uses ${w.item !== undefined ? n.item(w.item) : 'an item'}`;
    case 'statusApplied':
      return `${target} becomes ${w.status !== undefined ? n.status(w.status) : 'affected by a status'}`;
    case 'statusRemoved':
      return `${target} stops being ${w.status !== undefined ? n.status(w.status) : 'affected by a status'}`;
    case 'damaged':
      return `${target} takes damage`;
    case 'cardDrawn':
      return `${who} draws ${w.card !== undefined ? `“${n.card(w.card)}”` : `a card${w.deck !== undefined ? ` from ${n.deck(w.deck)}` : ''}`}`;
    case 'actionUsed':
      return `${who} uses ${w.action !== undefined ? n.action(w.action) : 'an action'}`;
    case 'spawned':
      return `${w.enemy !== undefined ? `a ${n.enemy(w.enemy)}` : 'an enemy'} appears`;
  }
}

function describeLimits(l: RuleLimits | undefined): string {
  if (!l) return '';
  const parts: string[] = [];
  if (l.maxPerTurn !== undefined) parts.push(`at most ${l.maxPerTurn} time${l.maxPerTurn > 1 ? 's' : ''} per turn`);
  if (l.maxPerRound !== undefined) parts.push(`at most ${l.maxPerRound} time${l.maxPerRound > 1 ? 's' : ''} per round`);
  if (l.maxPerGame !== undefined) parts.push(`at most ${l.maxPerGame} time${l.maxPerGame > 1 ? 's' : ''} per game`);
  if (l.cooldownRounds !== undefined) parts.push(`then rests for ${l.cooldownRounds} round${l.cooldownRounds > 1 ? 's' : ''}`);
  if (parts.length === 0) return '';
  const text = parts.join('; ');
  return ` ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

const MODIFIER_SUBJECT: Record<ModifierRule['on'], string> = {
  damage: 'damage dealt to',
  resourceChange: 'a resource change for',
  price: 'the price paid by',
  moveRoll: 'the movement roll of',
  statusApply: 'a status applied to',
};

function describeModify(op: ModifyOp, n: Names): string {
  switch (op.op) {
    case 'add': {
      const loss = asLoss(op.amount);
      return loss !== null ? `reduce it by ${describeNum(loss, n)}` : `increase it by ${describeNum(op.amount, n)}`;
    }
    case 'scale':
      return `multiply it by ${op.num}/${op.den} (${ROUNDING_TEXT[op.rounding]})`;
    case 'clampTo':
      return `keep it ${op.min !== undefined ? `at least ${describeNum(op.min, n)}` : ''}${op.min !== undefined && op.max !== undefined ? ' and ' : ''}${op.max !== undefined ? `at most ${describeNum(op.max, n)}` : ''}`;
    case 'prevent':
      return 'prevent it';
  }
}

function describeModifierRule(rule: ModifierRule, n: Names): string {
  const w = rule.where ?? {};
  const who = w.targetTag !== undefined ? `anyone tagged ${n.tag(w.targetTag)}` : w.targetKind ? `a ${w.targetKind}` : 'anyone';
  const what =
    rule.on === 'resourceChange'
      ? `${w.direction === 'gain' ? 'a gain' : w.direction === 'loss' ? 'a loss' : 'a change'} of ${w.resource !== undefined ? n.resource(w.resource) : 'a resource'} for ${who}`
      : rule.on === 'price'
        ? `the price of ${w.shopEntry !== undefined ? n.entry(w.shopEntry) : 'a purchase'}`
        : rule.on === 'statusApply'
          ? `${w.status !== undefined ? n.status(w.status) : 'a status'} being applied to ${who}`
          : `${MODIFIER_SUBJECT[rule.on]} ${who}`;
  const cond = rule.conditions ? `, if ${describeCond(rule.conditions, n)}` : '';
  const consume = rule.consume ? ('status' in rule.consume ? `; uses up one ${n.status(rule.consume.status)} stack` : '; uses up the item') : '';
  return `Before ${what}${cond}: ${describeModify(rule.modify, n)}${consume}.${describeLimits(rule.limits)}`;
}

const CAPABILITY_TEXT: Record<Capability, string> = {
  takesTurns: 'cannot take turns',
  moves: 'cannot move',
  shops: 'cannot shop',
  attacks: 'cannot attack',
  attackable: 'cannot be attacked',
  usesItems: 'cannot use items',
  trades: 'cannot trade',
};

export { attachedRuleText };

export function describeCapabilityLoss(c: Capability): string {
  return CAPABILITY_TEXT[c];
}

function describeContinuousRule(rule: ContinuousRule, n: Names): string {
  const who = describeSelector(rule.applies, n);
  const cond = rule.when ? ` while ${describeCond(rule.when, n, { $it: undefined })}` : '';
  const parts = [
    ...rule.modifiers.map((m) => {
      const loss = asLoss(m.add);
      return loss !== null ? `−${describeNum(loss, n)} ${n.resource(m.resource)}` : `+${describeNum(m.add, n)} ${n.resource(m.resource)}`;
    }),
    ...rule.suppress.map((c) => CAPABILITY_TEXT[c]),
  ];
  return `${who.charAt(0).toUpperCase()}${who.slice(1)}${cond}: ${parts.join(', ')}.`;
}

function terseTrigger(t: Trigger, n: Names): string {
  const w = t.where ?? {};
  const place = w.space !== undefined ? n.space(w.space) : w.spaceTag !== undefined ? `a ${n.tag(w.spaceTag)} space` : 'a space';
  switch (t.event) {
    case 'landed':
      return `landing on ${place}`;
    case 'entered':
      return `arriving at ${place}`;
    case 'purchased':
      return `buying ${w.shopEntry !== undefined ? n.entry(w.shopEntry) : 'something'}`;
    default:
      return describeTrigger(t, n);
  }
}

/** Compact rule text for the contestants' rulebook digest ("landing on a Coin space: +3 Gold"). */
export function summarizeRule(rule: RuleDef, n: Names): string {
  if (rule.kind !== 'reaction') return describeRule(rule, n, { skipAnnouncements: true });
  const w = rule.trigger.where ?? {};
  const who = w.actorKind === 'contestant' || w.actorKind === undefined ? '' : ` (${w.actorKind}s only)`;
  const cond = rule.conditions ? ` if ${describeCond(rule.conditions, n)}` : '';
  return `${terseTrigger(rule.trigger, n)}${who}${cond}: ${summarizeEffects(rule.effects, n) || 'nothing visible happens'}${describeLimits(rule.limits).replace(/\.$/, '').toLowerCase().replace(/^ (.+)$/, ' ($1)')}`;
}

export function describeRule(rule: RuleDef, n: Names, options: { skipAnnouncements?: boolean } = {}): string {
  switch (rule.kind) {
    case 'reaction': {
      const r: ReactionRule = rule;
      const cond = r.conditions ? `, if ${describeCond(r.conditions, n)}` : '';
      return `Whenever ${describeTrigger(r.trigger, n)}${cond}: ${describeEffects(r.effects, n, undefined, options) || 'nothing visible happens'}.${describeLimits(r.limits)}`;
    }
    case 'modifier':
      return describeModifierRule(rule, n);
    case 'continuous':
      return describeContinuousRule(rule, n);
  }
}

/** Short text for a rule attached to a status or item, from the holder's point of view. */
function attachedRuleText(r: RuleDef, n: Names): string {
  if (r.kind === 'modifier' && r.on === 'damage' && r.modify.op === 'prevent') return `absorbs a hit${r.consume && 'status' in r.consume ? ' (uses a stack)' : r.consume ? ' (then breaks)' : ''}`;
  if (r.kind === 'modifier' && r.on === 'resourceChange' && r.modify.op === 'add') {
    const w = r.where ?? {};
    const loss = asLoss(r.modify.amount);
    const delta = loss !== null ? `−${describeNum(loss, n)}` : `+${describeNum(r.modify.amount, n)}`;
    return `${delta} on every ${w.direction === 'gain' ? 'gain' : w.direction === 'loss' ? 'loss' : 'change'} of ${w.resource !== undefined ? n.resource(w.resource) : 'a resource'}`;
  }
  if (r.kind === 'reaction' && r.trigger.event === 'landed' && r.conditions?.op === 'sameSpace') return `when someone lands on its space: ${summarizeEffects(r.effects, n)}`;
  if (r.kind === 'reaction' && r.trigger.event === 'damaged' && r.conditions) {
    // "when it takes damage, if its HP ≤ 300 and it is not Enraged: become Enraged"
    const isSelf = (c: Cond) => c.op === 'same' && ((c.a === '$target' && c.b === '$holder') || (c.a === '$holder' && c.b === '$target'));
    const rest = r.conditions.op === 'all' ? r.conditions.conds.filter((c) => !isSelf(c)) : isSelf(r.conditions) ? [] : null;
    if (rest !== null && rest.length < (r.conditions.op === 'all' ? r.conditions.conds.length : 1)) {
      const b = { $holder: undefined };
      const cond = rest.length ? `, if ${rest.map((c) => describeCond(c, n, b)).join(' and ')}` : '';
      return `when it takes damage${cond}: ${summarizeEffects(r.effects, n)}${describeLimits(r.limits).replace(/\.$/, '').toLowerCase().replace(/^ /, ' (').replace(/$/, r.limits ? ')' : '')}`;
    }
  }
  if (r.kind === 'reaction' && (r.trigger.event === 'turnEnded' || r.trigger.event === 'turnStarted')) return `at the ${r.trigger.event === 'turnEnded' ? 'end' : 'start'} of the holder's turn: ${summarizeEffects(r.effects, n).replaceAll('the holder: ', '')}`;
  return describeRule(r, n).replace(/\.$/, '');
}

/** "Fish Form (3 turns): tagged Fish, −1 Move, cannot shop." */
export function describeStatus(def: StatusDef, n: Names, stacks = 1, remaining: number | null | undefined = undefined): string {
  const parts = [
    ...def.grantsTags.map((t) => `tagged ${n.tag(t)}`),
    ...def.modifiers.map((m) => `${m.add * stacks >= 0 ? '+' : '−'}${Math.abs(m.add * stacks)} ${n.resource(m.resource)}`),
    ...def.suppress.map((c) => CAPABILITY_TEXT[c]),
    ...def.rules.map((r) => attachedRuleText(r, n)),
  ];
  const turns = remaining !== undefined ? remaining : def.duration;
  const duration = turns === null ? 'until removed' : `${turns} turn${turns === 1 ? '' : 's'}${remaining !== undefined ? ' left' : ''}`;
  const stacking = remaining === undefined && def.stacking === 'stack' && def.maxStacks > 1 ? `, stacks to ${def.maxStacks}` : '';
  return `${def.name}${stacks > 1 ? ` ×${stacks}` : ''} (${duration}${stacking}): ${parts.join('; ') || 'no effect'}`;
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
      return `${n.entity(e.entity)} rolled ${e.value} (d${e.sides})${e.total !== e.value ? ` → moves up to ${e.total}` : ''}`;
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
      return `${n.entity(e.entity)} ${e.reason === 'used' ? 'used up' : e.reason === 'consumed' ? 'spent' : e.reason === 'given' ? 'handed over' : e.reason === 'discarded' ? 'threw away' : 'lost'} ${n.item(e.itemDef)}`;
    case 'itemUsed':
      return `${n.entity(e.entity)} used ${n.item(e.itemDef)}`;
    case 'itemEquipped':
      return `${n.entity(e.entity)} ${e.equipped ? 'equipped' : 'took off'} ${n.item(e.itemDef)}`;
    case 'purchased':
      return `${n.entity(e.entity)} bought ${n.entry(e.entry)} for ${e.price} ${n.resource(e.priceResource)}`;
    case 'rested':
      return `${n.entity(e.entity)} rested (+${e.healed} HP)`;
    case 'passed':
      return `${n.entity(e.entity)} passed`;
    case 'actionUsed':
      return `${n.entity(e.entity)} used ${n.action(e.action)}${e.target !== null ? ` on ${n.entity(e.target)}` : ''}`;
    case 'statusApplied':
      return `${n.entity(e.entity)} is ${n.status(e.status)}${e.stacks > 1 ? ` ×${e.stacks}` : ''}${e.remaining !== null ? ` (${e.remaining} turn${e.remaining === 1 ? '' : 's'})` : ''}`;
    case 'statusRemoved':
      if (e.left > 0) return `${n.entity(e.entity)} ${e.reason === 'consumed' ? 'uses up' : 'loses'} ${e.stacks} ${n.status(e.status)} stack${e.stacks === 1 ? '' : 's'} (${e.left} left)`;
      return `${n.entity(e.entity)} is no longer ${n.status(e.status)}${e.reason === 'consumed' ? ' (used up)' : e.reason === 'expired' ? ' (wore off)' : ''}`;
    case 'statusPrevented':
      return `${n.entity(e.entity)} resisted ${n.status(e.status)}`;
    case 'fightStarted':
      return `⚔ ${n.entity(e.attacker)} (${e.attackerPower} Power, ${e.attackerHp} HP) attacks ${n.entity(e.defender)} (${e.defenderPower} Power, ${e.defenderHp} HP): wheel ${pct(e.attackerPower, e.defenderPower)} vs ${pct(e.defenderPower, e.attackerPower)}, hits ${e.attackerDamage} / ${e.defenderDamage}`;
    case 'spin':
      return `Spin ${e.index}: ${n.entity(e.winner)} wins (${e.roll + 1} of ${e.total}) — ${n.entity(e.loser)} takes ${e.damage} damage (HP ${e.loserHpAfter})${e.mods?.length ? ` [${e.mods.map((m) => n.rule(m.rule)).join(', ')}]` : ''}`;
    case 'fightEnded':
      return `Fight over: ${e.outcome === 'bothStanding' ? 'both fighters still standing' : e.outcome === 'attackerWon' ? 'attacker wins' : 'defender wins'}`;
    case 'fightPrevented':
      return `No fight: ${e.reason}`;
    case 'damaged':
      return `${n.entity(e.entity)} takes ${e.amount} damage${e.by !== null && e.by !== e.entity ? ` from ${n.entity(e.by)}` : ''}${e.amount !== e.base ? ` (${e.base} before ${e.mods?.map((m) => n.rule(m.rule)).join(', ') ?? 'modifiers'})` : ''}`;
    case 'defeated':
      return `${n.entity(e.entity)} was defeated${e.by ? ` by ${n.entity(e.by)}` : ''}`;
    case 'knockedOut':
      return `${n.entity(e.entity)} is knocked out: loses ${e.goldLost} gold${e.lootTo !== null ? ` to ${n.entity(e.lootTo)}` : ''}, returns to ${n.space(e.respawnSpace)}, skips ${e.skipTurns} turn${e.skipTurns === 1 ? '' : 's'}`;
    case 'eliminated':
      return `${n.entity(e.entity)} is eliminated from the match`;
    case 'respawned':
      return `${n.entity(e.entity)} returns at ${n.space(e.space)}`;
    case 'spawned':
      return `${e.boss ? '👑 ' : ''}${n.entity(e.entity)} appears at ${n.space(e.space)}`;
    case 'removed':
      return `${n.entity(e.entity)} leaves the board`;
    case 'deckShuffled':
      return `${n.deck(e.deck)} is reshuffled (${e.size} cards)`;
    case 'cardDrawn':
      return `🃏 ${n.entity(e.entity)} draws “${e.name}”`;
    case 'choiceOffered':
      return `${n.entity(e.entity)} must choose: ${e.prompt} (${e.options.join(' / ')})`;
    case 'choiceMade':
      return `${n.entity(e.entity)} ${e.automatic ? 'gets the default' : 'chooses'}: ${e.label}`;
    case 'objectiveAssigned':
      return `🎯 ${n.entity(e.entity)} receives ${e.def === 'hidden' ? 'a secret objective' : `the secret objective “${n.objective(e.def)}”`}`;
    case 'objectiveCompleted':
      return `🎯 ${n.entity(e.entity)} completes the secret objective “${n.objective(e.def)}”`;
    case 'tradeProposed':
      return `🤝 ${n.entity(e.from)} offers ${n.entity(e.to)} a trade: ${describeTerms(e.terms, e.from, e.to, n)}${e.message ? ` — “${e.message}”` : ''}`;
    case 'tradeCountered':
      return `🤝 ${n.entity(e.to)} counters: ${describeTerms(e.terms, e.from, e.to, n)}${e.message ? ` — “${e.message}”` : ''}`;
    case 'tradeRejected':
      return `${n.entity(e.by)} ${e.automatic ? 'could not answer; the trade is off' : 'rejects the trade'}`;
    case 'tradeCompleted':
      return `🤝 Trade done: ${describeTerms(e.terms, e.from, e.to, n)}`;
    case 'tradeFailed':
      return `The trade between ${n.entity(e.from)} and ${n.entity(e.to)} falls through (${e.reason})`;
    case 'promiseMade':
      return `${e.kind === 'noAttack' ? `${n.entity(e.by)} promises not to attack ${n.entity(e.to)} until the end of round ${e.dueRound}` : `${n.entity(e.by)} promises to pay ${n.entity(e.to)} ${e.amount} ${n.resource(e.resource ?? '')} by the end of round ${e.dueRound}`}`;
    case 'promiseKept':
      return `✅ ${n.entity(e.by)} kept a promise to ${n.entity(e.to)} (${e.kind === 'noAttack' ? 'no attack' : 'paid in full'})`;
    case 'promiseBroken':
      return `💔 ${n.entity(e.by)} broke a promise to ${n.entity(e.to)} (${e.kind === 'noAttack' ? 'attacked anyway' : 'never paid'})`;
    case 'gmAsked':
      return `⚖ The GM is asked: ${e.question}`;
    case 'attempted':
      return `✨ ${n.entity(e.entity)} attempts: “${e.text}” (the GM rules)`;
    case 'rulesChanged':
      return `📜 The rules changed (version ${e.version})${e.summary.length > 0 ? `: ${e.summary.join('; ')}` : ''}${e.invalidated ? ` — the waiting decision ${e.invalidated} was withdrawn and asked again` : ''}`;
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

function times(n: number): string {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
}

/** What an objective asks for, generated from its goal unless the author wrote a text. */
export function describeObjectiveGoal(def: ObjectiveDef, n: Names): string {
  if (def.text) return def.text;
  const g = def.goal;
  if (g.kind === 'reach') return `Have ${g.atLeast} ${n.resource(g.resource)} at once`;
  const w = g.trigger.where ?? {};
  switch (g.trigger.event) {
    case 'landed':
      return `Land on ${w.space !== undefined ? n.space(w.space) : w.spaceTag !== undefined ? article(`${n.tag(w.spaceTag)} space`) : 'a space'} ${times(g.times)}`;
    case 'defeated': {
      const foe = w.enemy !== undefined ? article(n.enemy(w.enemy)) : w.targetTag !== undefined ? `a foe tagged ${n.tag(w.targetTag)}` : w.targetKind === 'contestant' ? 'a rival contestant' : 'a foe';
      return `Defeat ${foe} ${times(g.times)}`;
    }
    case 'purchased':
      return `Buy ${w.shopEntry !== undefined ? n.entry(w.shopEntry) : 'something at a shop'} ${times(g.times)}`;
    case 'actionUsed':
      return `Use ${w.action !== undefined ? n.action(w.action) : 'a special action'} ${times(g.times)}`;
    case 'itemUsed':
      return `Use ${w.item !== undefined ? n.item(w.item) : 'an item'} ${times(g.times)}`;
    case 'cardDrawn':
      return `Draw ${w.card !== undefined ? `“${n.card(w.card)}”` : `a card${w.deck !== undefined ? ` from ${n.deck(w.deck)}` : ''}`} ${times(g.times)}`;
    default:
      return `${describeTrigger(g.trigger, n)} — ${times(g.times)}`;
  }
}

/** "Island Hopper: land on a Mystery space 3 times (reward: +1 Star)". */
export function describeObjective(def: ObjectiveDef, n: Names): string {
  return `${def.name}: ${describeObjectiveGoal(def, n)} (reward: ${summarizeEffects(def.reward, n)})`;
}

function describeGoods(g: { resources: Record<string, number>; items: string[] }, n: Names): string {
  const parts = [...Object.entries(g.resources).map(([r, a]) => `${a} ${n.resource(r)}`), ...g.items.map((i) => n.item(i))];
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

export function describePromise(p: PromiseTerm, byName: string, toName: string, n: Names, dueRound?: number): string {
  const until = dueRound !== undefined ? `until the end of round ${dueRound}` : `for ${p.rounds} round${p.rounds === 1 ? '' : 's'}`;
  if (p.kind === 'noAttack') return `${byName} will not attack ${toName} ${until}`;
  return `${byName} will pay ${toName} ${p.amount} ${n.resource(p.resource)} ${dueRound !== undefined ? `by the end of round ${dueRound}` : `within ${p.rounds} round${p.rounds === 1 ? '' : 's'}`}`;
}

/** Trade terms from the proposer's side in plain words. */
export function describeTerms(terms: TradeTermsView, from: string, to: string, n: Names): string {
  const a = n.entity(from);
  const b = n.entity(to);
  const promises = terms.promises.map((p) => describePromise(p, p.by === 'from' ? a : b, p.by === 'from' ? b : a, n));
  return [`${a} gives ${describeGoods(terms.give, n)}`, `${b} gives ${describeGoods(terms.get, n)}`, ...promises].join('; ');
}

function pct(a: number, b: number): string {
  return `${((a / (a + b)) * 100).toFixed(1)}%`;
}
