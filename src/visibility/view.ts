import type { CompiledGame } from '../engine/compile.ts';
import { attachedRuleText, describeCapabilityLoss, describeObjectiveGoal, describePromise, describeRule, describeStatus, namesFor, summarizeEffects, type Names } from '../engine/explain.ts';
import { bagSpacesUsed, equippedIn, receivePlan } from '../engine/inventory.ts';
import { effectiveTags, effectiveValue, hasCapability, reachableSpaces, suppressedCapabilities } from '../engine/queries.ts';
import { isTradeableItem, isTradeableResource, tradePartners, termsView } from '../engine/trade.ts';
import type { ItemDef, ObjectiveDef } from '../schema/definition.ts';
import type { Capability } from '../schema/rules.ts';
import type { Decision, DecisionOption, GameEvent, GameState, PromiseTerm, TradeTermsView } from '../schema/state.ts';
import { effectHints, fightHint, landingHints, targetHints, type FightHint, type Hint, type HintScope } from './hints.ts';
import { HIDDEN_RULE, recentVisibleEvents, redactStateFor, viewGame, visibleResourceIds, type VisibleEvent } from './redact.ts';

export type { FightHint, Hint } from './hints.ts';

/**
 * ContestantView: everything one contestant is allowed to know, in a shape made for decision
 * packets and the fallback player. It is built only from the redacted state and the
 * contestant-facing game (hidden rules removed).
 */

export interface ViewStatus {
  defId: string;
  name: string;
  icon: string | undefined;
  stacks: number;
  remaining: number | null;
  text: string;
}

export interface ViewItem {
  id: string;
  defId: string;
  name: string;
  /** Another contestant's concealed item: its identity and bonuses are unknown. */
  concealed: boolean;
  usable: boolean;
  text: string;
  /** Worn in its equipment slot (its bonuses apply). */
  equipped: boolean;
  /** Equipment slot name, for gear. */
  slot: string | null;
  /** Uses left, for items with charges. */
  charges: number | null;
  /** Rough worth in Gold, when the scenario gives one. */
  value: number | null;
  /** The GM's advice on when to use it (own items only). */
  hint: string | null;
}

/** The viewer's bag and equipment slots. */
export interface ViewInventory {
  bagUsed: number;
  bagCapacity: number;
  slots: Array<{ id: string; name: string; count: number; items: string[] }>;
}

export interface ViewEntity {
  id: string;
  kind: 'contestant' | 'enemy' | 'fixture';
  /** Cast member, enemy or fixture definition. */
  defId: string;
  name: string;
  spaceId: string | null;
  status: 'active' | 'defeated' | 'eliminated' | 'removed';
  isSelf: boolean;
  boss: boolean;
  /** Effective values of the resources this viewer may see. */
  stats: Record<string, number>;
  /** Resources the entity has whose values are hidden from this viewer. */
  hiddenStats: string[];
  /** Effective tags (base tags plus tags granted by visible statuses). */
  tags: string[];
  items: ViewItem[];
  statuses: ViewStatus[];
  /** Capabilities currently suppressed, and by what. */
  suppressed: Array<{ capability: Capability; by: string }>;
  koTurns: number;
  respawnRound: number | null;
  shopEntries: Array<{ entry: string; label: string; price: number; priceResource: string }>;
  /** Objectives this contestant holds that the viewer knows nothing about (others' secrets). */
  secretObjectives: number;
}

/** What one side hands over in a trade: tradeable resources and item definitions. */
export interface ViewGoods {
  resources: Record<string, number>;
  items: string[];
}

export interface ViewObjective {
  id: string;
  owner: string;
  ownerName: string;
  mine: boolean;
  name: string;
  /** What it asks for, e.g. "Land on a Mystery space 3 times". */
  goal: string;
  reward: string;
  progress: number;
  /** Count goals: the number needed; reach goals: the amount needed. */
  target: number;
  /** Reach goals: the owner's current amount. */
  current: number | null;
  done: boolean;
  /** The goal as data (for the fallback player). */
  spec: ObjectiveDef['goal'] | null;
  /** Fixed resource rewards for the owner. */
  rewardResources: Array<{ resource: string; amount: number }>;
}

export interface ViewPromise {
  text: string;
  byYou: boolean;
  kind: 'noAttack' | 'pay';
  rounds: number;
  resource: string | null;
  amount: number;
}

/** The viewer's own open negotiation, from its side. */
export interface ViewNegotiation {
  id: string;
  partner: string;
  partnerName: string;
  /** Who made the terms currently on the table. */
  proposedByYou: boolean;
  stage: 'response' | 'final';
  youGive: ViewGoods;
  youGet: ViewGoods;
  promises: ViewPromise[];
  message: string | null;
}

export interface ViewCommitment {
  id: string;
  by: string;
  to: string;
  kind: 'noAttack' | 'pay';
  resource: string | null;
  amount: number;
  dueRound: number;
  text: string;
}

export interface TradePartnerView {
  id: string;
  name: string;
  /** Tradeable goods the partner visibly holds. */
  holds: ViewGoods;
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
      /** Rivals who could reach this space on their next turn, and what happens if they attack there. */
      threats: Threat[];
    }
  | {
      kind: 'buy';
      optionId: string;
      entry: string;
      label: string;
      price: number;
      basePrice: number;
      priceResource: string;
      powerAfter: number | null;
      grantsResource: string | null;
      grantsAmount: number;
      grantsItem: string | null;
      itemText: string | null;
    }
  | { kind: 'attack'; optionId: string; target: string; fight: FightHint }
  | { kind: 'use'; optionId: string; item: string; name: string; consumed: boolean; hints: Hint[]; target: string | null; targetName: string | null; free: boolean; charges: number | null; aiHint: string | null }
  | { kind: 'equip'; optionId: string; item: string; name: string; replaces: string | null; replacesName: string | null; changes: StatChange[] }
  | { kind: 'drop'; optionId: string; item: string; name: string; worn: boolean; value: number | null; changes: StatChange[] }
  | {
      kind: 'act';
      optionId: string;
      action: string;
      name: string;
      description: string | null;
      target: string | null;
      targetName: string | null;
      cost: { resource: string; amount: number } | null;
      cooldownRounds: number | null;
      hints: Hint[];
    }
  | { kind: 'rest'; optionId: string; heal: number; hpAfter: number }
  | { kind: 'pass'; optionId: string }
  | { kind: 'choose'; optionId: string; option: string; label: string; hints: Hint[]; unknown: boolean }
  | { kind: 'trade'; optionId: string; partners: TradePartnerView[]; youHold: ViewGoods; maxPromiseRounds: number }
  | { kind: 'pay'; optionId: string; commitment: string; to: string; toName: string; resource: string; amount: number }
  | { kind: 'tradeAnswer'; optionId: string; answer: 'accept' | 'reject' | 'counter'; negotiation: ViewNegotiation }
  | { kind: 'freeform'; optionId: string; cooldownRounds: number };

export interface Threat {
  rival: string;
  name: string;
  steps: number;
  /** Chance the rival's next movement roll reaches this space. */
  reach: number;
  /** Chance of being knocked out if the rival attacks here (current HP and Power). */
  pKnockout: number;
  /** Chance of knocking the rival out if it attacks here. */
  pWin: number;
}

/**
 * How tempting the fight is for the rival (0..1): evenly matched rivals rarely start fights,
 * clearly stronger ones often do. Used to weigh threats; the rival's real intent is unknown.
 */
export function threatWeight(t: Threat): number {
  return Math.max(0, Math.min(1, (t.pKnockout - t.pWin - 0.1) * 2));
}

/** A change of one of the viewer's effective stats. */
export interface StatChange {
  resource: string;
  from: number;
  to: number;
}

export interface ContestantView {
  viewer: string;
  round: number;
  roundLimit: number;
  phase: GameState['phase'];
  activeContestant: string | null;
  turnOrder: string[];
  roll: number | null;
  entities: ViewEntity[];
  /** The viewer's own bag and equipment slots. */
  inventory: ViewInventory;
  decision: (Decision & { previews: OptionPreview[] }) | null;
  /** Rivals who could reach and attack the viewer where it stands now (main decisions and choices). */
  threatsHere: Threat[];
  decks: Array<{ id: string; name: string; drawCount: number; discardCount: number }>;
  /** The viewer's objectives, and everyone's completed (revealed) objectives. */
  objectives: ViewObjective[];
  /** The viewer's open negotiation, if any. */
  negotiation: ViewNegotiation | null;
  /** Open promises between contestants (promises are public once a trade is done). */
  commitments: ViewCommitment[];
  recentEvents: VisibleEvent[];
  winners: string[] | null;
}

function goodsOf(v: { resources: Record<string, number>; items: string[] }): ViewGoods {
  return { resources: { ...v.resources }, items: [...v.items] };
}

function negotiationView(state: GameState, viewer: string, names: Names): ViewNegotiation | null {
  const n = state.negotiation;
  if (!n || (n.from !== viewer && n.to !== viewer)) return null;
  const t: TradeTermsView = termsView(state, n.terms);
  const iAmFrom = n.from === viewer;
  const partner = iAmFrom ? n.to : n.from;
  const promises = t.promises.map((p: PromiseTerm) => {
    const byYou = (p.by === 'from') === iAmFrom;
    return {
      byYou,
      text: describePromise(p, byYou ? 'you' : names.entity(partner), byYou ? names.entity(partner) : 'you', names),
      kind: p.kind,
      rounds: p.rounds,
      resource: p.kind === 'pay' ? p.resource : null,
      amount: p.kind === 'pay' ? p.amount : 0,
    };
  });
  return {
    id: n.id,
    partner,
    partnerName: names.entity(partner),
    proposedByYou: (n.stage === 'response') === iAmFrom,
    stage: n.stage,
    youGive: goodsOf(iAmFrom ? t.give : t.get),
    youGet: goodsOf(iAmFrom ? t.get : t.give),
    promises,
    message: n.message,
  };
}

/** Tradeable goods an entity visibly holds (concealed items never count). */
function tradeableHoldings(game: CompiledGame, state: GameState, id: string): ViewGoods {
  const e = state.entities[id];
  const resources: Record<string, number> = {};
  const items: string[] = [];
  if (!e) return { resources, items };
  for (const r of game.def.resources) {
    if (!isTradeableResource(game, r.id)) continue;
    const v = effectiveValue(game, state, e, r.id);
    if (v !== undefined && v > 0) resources[r.id] = v;
  }
  for (const item of e.items) {
    const defId = state.items[item]?.defId;
    if (defId !== undefined && defId !== 'concealed' && isTradeableItem(game, defId)) items.push(defId);
  }
  return { resources, items };
}

/** Plain-language summary of an item's bonuses, use and attached rules. */
export function describeItem(item: ItemDef, names: Names): string {
  const use = item.use;
  const useBits = use
    ? [
        use.target ? `on ${use.target.range === 'here' ? `a ${use.target.kind} here` : `any ${use.target.kind}`}` : '',
        use.consumed ? (use.charges !== undefined && use.charges > 1 ? `${use.charges} uses` : 'once') : '',
        use.free ? 'free action' : '',
        use.cooldownRounds !== undefined ? `every ${use.cooldownRounds} rounds` : '',
      ].filter(Boolean)
    : [];
  const parts = [
    ...(item.slot !== undefined ? [`worn (${item.slot.replace(/^[a-z]+\./, '')})`] : []),
    ...item.modifiers.map((m) => `${m.add >= 0 ? '+' : ''}${m.add} ${names.resource(m.resource)}${item.slot !== undefined ? ' while worn' : ''}`),
    ...(use ? [`use${useBits.length ? ` (${useBits.join(', ')})` : ''}: ${summarizeEffects(use.effects, names)}`] : []),
    ...item.rules.filter((r) => r.visibility === 'public').map((r) => attachedRuleText(r, names)),
    ...(item.stackSize > 1 ? [`stacks ${item.stackSize} per space`] : []),
    ...(item.concealed ? ['others cannot see it'] : []),
  ];
  return parts.join('; ') || (item.description ?? '');
}

/** How the viewer's effective stats change if items are put on / taken off or removed. */
function statChanges(scope: HintScope, equipped: Record<string, boolean>, removed: string[]): StatChange[] {
  const { game, state, viewer } = scope;
  const me = state.entities[viewer];
  if (!me) return [];
  const items = { ...state.items };
  for (const [id, on] of Object.entries(equipped)) {
    const it = items[id];
    if (it) items[id] = { ...it, equipped: on };
  }
  for (const id of removed) delete items[id];
  const after: GameState = { ...state, items, entities: { ...state.entities, [viewer]: { ...me, items: me.items.filter((id) => !removed.includes(id)) } } };
  const meAfter = after.entities[viewer] ?? me;
  const out: StatChange[] = [];
  for (const r of game.def.resources) {
    if (r.role !== 'stat' || me.resources[r.id] === undefined) continue;
    const from = effectiveValue(game, state, me, r.id);
    const to = effectiveValue(game, after, meAfter, r.id);
    if (from !== undefined && to !== undefined && from !== to) out.push({ resource: r.id, from, to });
  }
  return out;
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
    if (rule.def.kind === 'reaction' && rule.def.trigger.where?.spaceTag !== undefined) tags.add(rule.def.trigger.where.spaceTag);
  }
  for (const tag of tags) {
    let best: number | undefined;
    for (const [space, d] of dist) if (game.spaces.get(space)?.tags.includes(tag) && (best === undefined || d < best)) best = d;
    if (best !== undefined) out.push({ label: `nearest ${game.tags.get(tag)?.name ?? tag} space`, key: tag, steps: best });
  }
  return out;
}

/** Chance that 1d(die) + bonus reaches at least `steps`. */
function reachChance(die: number, bonus: number, steps: number): number {
  if (steps <= 0) return 1;
  let hits = 0;
  for (let r = 1; r <= die; r++) if (r + bonus >= steps) hits++;
  return hits / die;
}

/**
 * Rivals able to attack the viewer next turn, per space: their board distance, the chance their roll
 * reaches, and the fight odds if they attack. Built from public positions, stats and statuses only.
 */
function threatMap(scope: HintScope): (space: string) => Threat[] {
  const { game, state, viewer } = scope;
  const settings = game.def.settings;
  if (!settings.combat.pvp) return () => [];
  const me = state.entities[viewer];
  if (!me || !hasCapability(game, state, me, 'attackable')) return () => [];
  const rivals: Array<{ id: string; name: string; dist: Map<string, number>; bonus: number; moves: boolean; pKnockout: number; pWin: number }> = [];
  for (const id of state.turnOrder) {
    const e = state.entities[id];
    if (!e || id === viewer || e.status !== 'active' || e.spaceId === null || e.koTurns > 0 || !hasCapability(game, state, e, 'attacks')) continue;
    const fight = fightHint(scope, viewer, id, false);
    if (!fight || fight.odds.pDefenderWins < 0.05) continue;
    rivals.push({
      id,
      name: e.name,
      dist: reachableSpaces(game, e.spaceId, 64),
      bonus: settings.movement.bonus !== undefined ? (effectiveValue(game, state, e, settings.movement.bonus) ?? 0) : 0,
      moves: hasCapability(game, state, e, 'moves'),
      pKnockout: fight.odds.pDefenderWins,
      pWin: fight.odds.pAttackerWins,
    });
  }
  return (space) =>
    rivals
      .map((r) => {
        const steps = r.dist.get(space);
        if (steps === undefined) return null;
        const reach = r.moves ? reachChance(settings.movement.die, r.bonus, steps) : steps === 0 ? 1 : 0;
        return reach > 0 ? { rival: r.id, name: r.name, steps, reach, pKnockout: r.pKnockout, pWin: r.pWin } : null;
      })
      .filter((t): t is Threat => t !== null);
}

function previewOption(scope: HintScope, option: DecisionOption, decision: Decision, threats: (space: string) => Threat[]): OptionPreview {
  const { game, state: redacted, names, viewer } = scope;
  const { core, rest } = game.def.settings;
  const me = redacted.entities[viewer];
  const here = me?.spaceId ?? undefined;
  switch (option.kind) {
    case 'move': {
      // Hints only read the state: a shallow copy with the viewer moved is enough.
      const self = redacted.entities[viewer];
      const hypo: GameState = self ? { ...redacted, entities: { ...redacted.entities, [viewer]: { ...self, spaceId: option.space } } } : redacted;
      const { hints, fight } = option.steps > 0 ? landingHints({ ...scope, state: hypo }, option.space) : { hints: [], fight: null };
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
        threats: threats(option.space),
      };
    }
    case 'buy': {
      const found = game.shopEntries.get(option.entry);
      const grants = found?.entry.grants;
      const itemDef = grants && 'item' in grants ? game.items.get(grants.item) : undefined;
      let powerAfter: number | null = null;
      if (itemDef && me) {
        const powerOf = (defId: string | undefined) => game.items.get(defId ?? '')?.modifiers.filter((m) => m.resource === core.power).reduce((s, m) => s + m.add, 0) ?? 0;
        let add = powerOf(itemDef.id);
        // Gear counts only while worn: with its slot full, the gain is the swap for the weakest worn piece.
        if (itemDef.slot !== undefined && receivePlan(game, redacted, me, itemDef.id) !== 'equip') {
          const worn = equippedIn(game, redacted, me, itemDef.slot).map((id) => powerOf(redacted.items[id]?.defId));
          add = worn.length > 0 ? add - Math.min(...worn) : 0;
        }
        if (add > 0 || (add < 0 && itemDef.slot === undefined)) powerAfter = (effectiveValue(game, redacted, me, core.power) ?? 0) + add;
      }
      return {
        kind: 'buy',
        optionId: option.id,
        entry: option.entry,
        label: option.label,
        price: option.price,
        basePrice: found?.entry.price.amount ?? option.price,
        priceResource: found?.entry.price.resource ?? '',
        powerAfter,
        grantsResource: grants && 'resource' in grants ? grants.resource : null,
        grantsAmount: grants && 'resource' in grants ? grants.amount : 0,
        grantsItem: itemDef?.id ?? null,
        itemText: itemDef ? describeItem(itemDef, names) : null,
      };
    }
    case 'attack': {
      const fight = fightHint(scope, viewer, option.target, true);
      if (!fight) throw new Error('attack preview needs visible Power and HP');
      return { kind: 'attack', optionId: option.id, target: option.target, fight };
    }
    case 'use': {
      const item = redacted.items[option.item];
      const def = item ? game.items.get(item.defId) : undefined;
      const hints: Hint[] = [];
      const target = option.target !== null ? { $target: option.target } : {};
      const b = { $actor: viewer, $holder: viewer, ...target, ...(here ? { $space: here } : {}) };
      if (def?.use) effectHints(scope, def.use.effects, b, true, 1, def.name, hints);
      if (def?.use && option.target !== null) hints.push(...targetHints(scope, def.use.effects, b, option.target, def.name));
      return {
        kind: 'use',
        optionId: option.id,
        item: option.item,
        name: def?.name ?? option.item,
        consumed: def?.use?.consumed ?? false,
        hints,
        target: option.target,
        targetName: option.target !== null ? names.entity(option.target) : null,
        free: option.free,
        charges: item?.charges ?? null,
        aiHint: def?.aiHint ?? null,
      };
    }
    case 'equip': {
      const def = game.items.get(redacted.items[option.item]?.defId ?? '');
      const replaced = option.replaces !== null ? game.items.get(redacted.items[option.replaces]?.defId ?? '') : undefined;
      const flips: Record<string, boolean> = { [option.item]: true, ...(option.replaces !== null ? { [option.replaces]: false } : {}) };
      return { kind: 'equip', optionId: option.id, item: option.item, name: def?.name ?? option.item, replaces: option.replaces, replacesName: replaced?.name ?? null, changes: statChanges(scope, flips, []) };
    }
    case 'drop': {
      const item = redacted.items[option.item];
      const def = game.items.get(item?.defId ?? '');
      return { kind: 'drop', optionId: option.id, item: option.item, name: def?.name ?? option.item, worn: item?.equipped === true, value: def?.value ?? null, changes: statChanges(scope, {}, [option.item]) };
    }
    case 'act': {
      const action = game.actions.get(option.action);
      const hints: Hint[] = [];
      const ab = { $actor: viewer, ...(option.target !== null ? { $target: option.target } : {}), ...(here ? { $space: here } : {}) };
      if (action) effectHints(scope, action.effects, ab, true, 1, action.name, hints);
      if (action && option.target !== null) hints.push(...targetHints(scope, action.effects, ab, option.target, action.name));
      return {
        kind: 'act',
        optionId: option.id,
        action: option.action,
        name: action?.name ?? option.action,
        description: action?.description ?? null,
        target: option.target,
        targetName: option.target !== null ? names.entity(option.target) : null,
        cost: action?.cost ?? null,
        cooldownRounds: action?.cooldownRounds ?? null,
        hints,
      };
    }
    case 'rest': {
      const hp = me ? (effectiveValue(game, redacted, me, core.hp) ?? 0) : 0;
      const max = me ? (effectiveValue(game, redacted, me, core.maxHp) ?? hp) : hp;
      return { kind: 'rest', optionId: option.id, heal: rest.heal, hpAfter: Math.min(max, hp + rest.heal) };
    }
    case 'pass':
      return { kind: 'pass', optionId: option.id };
    case 'choose': {
      const choice = redacted.queue.find((c) => c.id === decision.choice);
      const opt = choice?.options.find((o) => o.id === option.option);
      const hints: Hint[] = [];
      const unknown = !opt || choice?.rule === HIDDEN_RULE;
      if (choice && opt && !unknown) effectHints(scope, opt.effects, { ...choice.bindings, $actor: viewer }, true, 1, 'your choice', hints);
      return { kind: 'choose', optionId: option.id, option: option.option, label: option.label, hints, unknown };
    }
    case 'trade':
      return {
        kind: 'trade',
        optionId: option.id,
        partners: tradePartners(game, redacted, viewer).map((id) => ({ id, name: names.entity(id), holds: tradeableHoldings(game, redacted, id) })),
        youHold: tradeableHoldings(game, redacted, viewer),
        maxPromiseRounds: game.def.settings.trading.maxPromiseRounds,
      };
    case 'pay': {
      const c = redacted.commitments.find((x) => x.id === option.commitment);
      return { kind: 'pay', optionId: option.id, commitment: option.commitment, to: c?.to ?? '', toName: names.entity(c?.to ?? ''), resource: c?.resource ?? '', amount: c ? c.amount - c.paid : 0 };
    }
    case 'freeform':
      return { kind: 'freeform', optionId: option.id, cooldownRounds: game.def.settings.adjudication.freeformCooldownRounds };
    case 'tradeAnswer': {
      const negotiation = negotiationView(redacted, viewer, names);
      if (!negotiation) throw new Error('trade answer without a negotiation');
      return { kind: 'tradeAnswer', optionId: option.id, answer: option.answer, negotiation };
    }
  }
}

/** Builds the viewer's view from authoritative state; hidden values never enter it. */
export function buildContestantView(fullGame: CompiledGame, state: GameState, viewer: string, history: GameEvent[], recentLimit = 80): ContestantView {
  const game = viewGame(fullGame);
  const redacted = redactStateFor(fullGame, state, viewer);
  const names = namesFor(game, redacted);
  const scope: HintScope = { game, state: redacted, names, viewer };
  const entities: ViewEntity[] = Object.values(redacted.entities).map((e) => {
    const allowed = visibleResourceIds(fullGame, viewer, e.id);
    const stats: Record<string, number> = {};
    for (const key of Object.keys(e.resources)) {
      const v = effectiveValue(game, redacted, e, key);
      if (v !== undefined) stats[key] = v;
    }
    const original = state.entities[e.id];
    const hiddenStats = original ? Object.keys(original.resources).filter((k) => !allowed.has(k) && fullGame.resources.get(k)?.visibility === 'owner') : [];
    const shopId = e.kind === 'fixture' ? game.fixtures.get(e.defId)?.shop : undefined;
    const shop = shopId !== undefined ? game.shops.get(shopId) : undefined;
    return {
      id: e.id,
      kind: e.kind,
      defId: e.defId,
      name: e.name,
      spaceId: e.spaceId,
      status: e.status,
      isSelf: e.id === viewer,
      boss: e.kind === 'enemy' && game.enemies.get(e.defId)?.boss === true,
      stats,
      hiddenStats,
      tags: [...effectiveTags(game, e)],
      items: e.items.map((id) => {
        const inst = redacted.items[id];
        const defId = inst?.defId ?? '';
        const def = game.items.get(defId);
        const slot = def?.slot !== undefined ? (game.def.settings.equipment.find((s) => s.id === def.slot)?.name ?? def.slot) : null;
        return {
          id,
          defId,
          name: names.item(defId),
          concealed: defId === 'concealed',
          usable: def?.use !== undefined,
          text: def ? describeItem(def, names) : 'unknown',
          equipped: inst?.equipped === true,
          slot,
          charges: inst?.charges ?? null,
          value: def?.value ?? null,
          hint: e.id === viewer ? (def?.aiHint ?? null) : null,
        };
      }),
      statuses: e.statuses.map((s) => {
        const def = game.statuses.get(s.defId);
        return { defId: s.defId, name: def?.name ?? s.defId, icon: def?.icon, stacks: s.stacks, remaining: s.remaining, text: def ? describeStatus(def, names, s.stacks, s.remaining) : s.defId };
      }),
      suppressed: [...suppressedCapabilities(game, redacted, e)].map(([capability, by]) => ({ capability, by })),
      koTurns: e.koTurns,
      respawnRound: e.respawnRound,
      shopEntries: e.status === 'active' ? (shop?.entries ?? []).map((entry) => ({ entry: entry.id, label: names.entry(entry.id), price: entry.price.amount, priceResource: entry.price.resource })) : [],
      secretObjectives: redacted.objectives.filter((o) => o.owner === e.id && o.defId === 'hidden').length,
    };
  });
  const objectives: ViewObjective[] = redacted.objectives
    .filter((o) => o.defId !== 'hidden')
    .map((o) => {
      const def = game.objectives.get(o.defId);
      const owner = redacted.entities[o.owner];
      const goal = def?.goal;
      const current = goal?.kind === 'reach' && owner ? (effectiveValue(game, redacted, owner, goal.resource) ?? 0) : null;
      return {
        id: o.id,
        owner: o.owner,
        ownerName: names.entity(o.owner),
        mine: o.owner === viewer,
        name: def?.name ?? o.defId,
        goal: def ? describeObjectiveGoal(def, names) : '',
        reward: def ? summarizeEffects(def.reward, names) : '',
        progress: o.progress,
        target: goal ? (goal.kind === 'count' ? goal.times : goal.atLeast) : 0,
        current,
        done: o.done,
        spec: goal ?? null,
        rewardResources: (def?.reward ?? []).flatMap((e) => (e.op === 'changeResource' && e.target === '$actor' && typeof e.amount === 'number' ? [{ resource: e.resource, amount: e.amount }] : [])),
      };
    });
  const commitments: ViewCommitment[] = redacted.commitments
    .filter((c) => c.status === 'open')
    .map((c) => {
      const byName = c.by === viewer ? 'you' : names.entity(c.by);
      const toName = c.to === viewer ? 'you' : names.entity(c.to);
      const term: PromiseTerm = c.kind === 'noAttack' ? { kind: 'noAttack', by: 'from', rounds: 1 } : { kind: 'pay', by: 'from', resource: c.resource ?? '', amount: c.amount - c.paid, rounds: 1 };
      return { id: c.id, by: c.by, to: c.to, kind: c.kind, resource: c.resource, amount: c.amount - c.paid, dueRound: c.dueRound, text: describePromise(term, byName, toName, names, c.dueRound) };
    });
  const pending = redacted.pendingDecision;
  const mine = pending !== null && pending.actor === viewer;
  const threats = mine ? threatMap(scope) : () => [];
  const decision = mine ? { ...pending, previews: pending.options.map((o) => previewOption(scope, o, pending, threats)) } : null;
  const here = redacted.entities[viewer]?.spaceId;
  const recent = recentVisibleEvents(fullGame, history, viewer, recentLimit);
  return {
    viewer,
    round: redacted.round,
    roundLimit: game.def.settings.victory.roundLimit,
    phase: redacted.phase,
    activeContestant: redacted.turnOrder[redacted.turn.index] ?? null,
    turnOrder: [...redacted.turnOrder],
    roll: redacted.turn.roll,
    entities,
    inventory: inventoryOf(game, redacted, viewer),
    decision,
    threatsHere: mine && pending.kind !== 'move' && here ? threats(here) : [],
    decks: game.def.decks.map((d) => ({ id: d.id, name: d.name, drawCount: redacted.decks[d.id]?.draw.length ?? 0, discardCount: redacted.decks[d.id]?.discard.length ?? 0 })),
    objectives,
    negotiation: negotiationView(redacted, viewer, names),
    commitments,
    recentEvents: recent,
    winners: redacted.winners,
  };
}

function inventoryOf(game: CompiledGame, state: GameState, viewer: string): ViewInventory {
  const me = state.entities[viewer];
  if (!me) return { bagUsed: 0, bagCapacity: game.def.settings.inventoryCapacity, slots: [] };
  return {
    bagUsed: bagSpacesUsed(game, state, me),
    bagCapacity: game.def.settings.inventoryCapacity,
    slots: game.def.settings.equipment.map((s) => ({ id: s.id, name: s.name, count: s.count, items: equippedIn(game, state, me, s.id) })),
  };
}

/** Public rules as text (hidden rules are never included). */
export function publicRuleTexts(game: CompiledGame, state: GameState, viewer: string): Array<{ id: string; name: string; text: string }> {
  const names = namesFor(game, redactStateFor(game, state, viewer));
  return [...game.rules.values()]
    .filter((r) => r.def.enabled && r.def.visibility === 'public' && r.owner === null)
    .map((r) => ({ id: r.def.id, name: r.def.name, text: describeRule(r.def, names) }));
}

export { describeCapabilityLoss };
