import { fightOdds } from '../engine/combat.ts';
import type { TradeOfferInput } from '../schema/trade.ts';
import type { Archetype, Persona } from '../schema/persona.ts';
import {
  threatWeight,
  type ContestantView,
  type FightHint,
  type Hint,
  type OptionPreview,
  type Threat,
  type TradePartnerView,
  type ViewEntity,
  type ViewGoods,
  type ViewNegotiation,
  type ViewObjective,
  type ViewPromise,
} from '../visibility/view.ts';
import type { PublicGameInfo } from '../visibility/public-info.ts';
import type { ContestantMind, Relationship } from './mind.ts';
import { weightsFor, type Weights } from './strategy.ts';

/**
 * The deterministic fallback player. It sees exactly what a model would see (a ContestantView)
 * and scores options with personality- and strategy-weighted heuristics. Used offline, as the
 * fallback when a model call fails, and as a baseline for evaluation.
 */

export interface HeuristicChoice {
  optionId: string;
  reason: string;
  scores: Array<{ optionId: string; score: number }>;
  /** Terms for "Propose a trade" or a counteroffer. */
  trade?: TradeOfferInput | undefined;
  /** A short in-character line at key moments. */
  say?: string | undefined;
}

interface Ctx {
  view: ContestantView;
  info: PublicGameInfo;
  persona: Persona;
  me: ViewEntity;
  w: Weights;
  gold: number;
  stars: number;
  hp: number;
  maxHp: number;
  power: number;
  starPrice: number | null;
  vendor: ViewEntity | undefined;
  /** The best star total among other contestants. */
  rivalStars: number;
  /** Relationships (null for estimates about someone else). */
  mind: ContestantMind | null;
  objectives: ViewObjective[];
  /** Estimates of how other contestants value things (built lazily). */
  others: Map<string, Ctx>;
}

const NEUTRAL: Persona = { voice: '', traits: { risk: 5, aggression: 5, greed: 5, loyalty: 5, vindictiveness: 5, sociability: 5 }, behaviors: [] };

function rel(c: Ctx, other: string): Relationship {
  return c.mind?.relationships[other] ?? { trust: 0, affinity: 0 };
}

/** How much a promise from `other` is worth to this contestant (0..1). */
function trustFactor(c: Ctx, other: string): number {
  return Math.max(0, Math.min(1, 0.6 + rel(c, other).trust * 0.08));
}

function hasOpenPromise(c: Ctx, kind: 'noAttack' | 'pay', by: string, to: string): boolean {
  return c.view.commitments.some((x) => x.kind === kind && x.by === by && x.to === to);
}

// ---------------------------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------------------------

function objectiveRewardValue(c: Ctx, o: ViewObjective): number {
  return o.rewardResources.reduce((v, r) => v + resourceValue(c, r.resource, r.amount), 0);
}

/** Value of one more matching event for the contestant's open count objectives. */
function objectiveBonus(c: Ctx, event: string, matches: (where: Record<string, unknown>) => boolean): number {
  let v = 0;
  for (const o of c.objectives) {
    if (!o.mine || o.done || o.spec?.kind !== 'count' || o.spec.trigger.event !== event) continue;
    if (!matches((o.spec.trigger.where ?? {}) as Record<string, unknown>)) continue;
    v += (objectiveRewardValue(c, o) / Math.max(1, o.target - o.progress)) * 0.9;
  }
  return v;
}

/** Extra value of gaining `amount` of a resource towards a "have N at once" objective. */
function reachBonus(c: Ctx, resource: string, amount: number): number {
  let v = 0;
  for (const o of c.objectives) {
    if (!o.mine || o.done || o.spec?.kind !== 'reach' || o.spec.resource !== resource || amount <= 0) continue;
    const have = o.current ?? 0;
    const missing = o.target - have;
    if (missing <= 0) continue;
    v += objectiveRewardValue(c, o) * (amount >= missing ? 0.9 : (amount / missing) * 0.4);
  }
  return v;
}

function stat(e: ViewEntity, id: string): number {
  return e.stats[id] ?? 0;
}

/** Value of a change of `amount` in a resource. */
function resourceValue(c: Ctx, resource: string, amount: number): number {
  const core = c.info.settings.core;
  if (resource === core.gold) return amount * 2 * c.w.gold;
  if (resource === core.power) return amount * 0.35 * c.w.power;
  if (resource === core.hp) {
    // Healing matters when hurt; losing HP matters more when already low.
    if (amount > 0) return Math.min(amount, c.maxHp - c.hp) * (c.hp < c.maxHp * 0.5 ? 1.2 : 0.5) * c.w.hp;
    return amount * (c.hp + amount <= 0 ? 3 : c.hp < c.maxHp * 0.5 ? 1 : 0.5) * c.w.hp;
  }
  if (resource === c.info.settings.victory.resource) return amount * 140 * c.w.stars;
  if (resource === c.info.settings.movement.bonus) return amount * 6;
  return amount * 0.3;
}

function durationFactor(duration: number | null | undefined): number {
  return duration === null || duration === undefined ? 1.5 : Math.min(1.5, duration / 3);
}

const SUPPRESS_VALUE: Record<string, number> = { takesTurns: -70, moves: -20, shops: -10, attacks: -6, attackable: 12, usesItems: -4, trades: -2 };

function statusValue(c: Ctx, statusId: string, stacks: number, duration?: number | null): number {
  const def = c.info.statuses.find((s) => s.id === statusId);
  if (!def) return -5; // unknown effects: be wary
  const f = durationFactor(duration ?? def.duration);
  let v = 0;
  for (const m of def.modifiers) v += resourceValue(c, m.resource, m.add * stacks) * (m.resource === c.info.settings.core.power ? 0.4 : 1);
  for (const cap of def.suppress) v += SUPPRESS_VALUE[cap] ?? 0;
  if (def.shields) v += 18 * stacks;
  if (def.harmful) v -= 12 * stacks;
  return v * f;
}

function itemValue(c: Ctx, itemId: string): number {
  const item = c.info.items.find((i) => i.id === itemId);
  if (!item) return 10;
  if (c.me.items.length >= c.info.settings.inventoryCapacity) return 0;
  let v = 0;
  for (const m of item.modifiers) v += resourceValue(c, m.resource, m.add) * (m.resource === c.info.settings.core.power ? c.w.gear / Math.max(0.1, c.w.power) : 1);
  if (item.usable) v += 14;
  return v;
}

function koCost(c: Ctx, risk: number): number {
  return 25 + risk * 2 * c.w.gold + c.info.settings.ko.skipTurns * 20 + (c.info.settings.ko.mode === 'eliminate' ? 1000 : 0);
}

function rewardValue(c: Ctx, f: FightHint): number {
  if (f.opponentKind === 'contestant') {
    const opponent = c.view.entities.find((e) => e.id === f.opponent);
    const leader = opponent ? stat(opponent, c.info.settings.victory.resource) >= c.rivalStars && c.rivalStars > c.stars : false;
    return f.loot * 2 * c.w.gold + 10 + c.persona.traits.aggression * 2 + (leader ? 25 : 0);
  }
  const def = c.info.enemies.find((e) => e.name === f.opponentName);
  if (!def) return 0;
  let v = 0;
  for (const r of def.rewards) {
    if (r.op !== 'changeResource' || typeof r.amount !== 'number') continue;
    v += resourceValue(c, r.resource, r.amount);
  }
  return v;
}

/**
 * Whether this personality starts fights with other contestants at all: aggressive characters
 * do; others only go after a runaway leader.
 */
function willingToAttack(c: Ctx, opponent: string): boolean {
  const t = c.persona.traits;
  if (t.aggression >= 6) return true;
  // Grudges: vindictive characters go after those who wronged them.
  if (t.vindictiveness >= 6 && rel(c, opponent).affinity <= -3) return true;
  const target = c.view.entities.find((e) => e.id === opponent);
  const victory = c.info.settings.victory.resource;
  const theirStars = target ? stat(target, victory) : 0;
  return theirStars >= c.stars + 2 && theirStars >= c.rivalStars && t.aggression >= 3;
}

/** Expected value of a fight, or a strong penalty if it breaks the contestant's risk limits or temperament. */
function fightValue(c: Ctx, f: FightHint, voluntary: boolean): number {
  const o = f.odds;
  const win = o.pAttackerWins * rewardValue(c, f);
  const lose = o.pDefenderWins * koCost(c, f.risk);
  const hpCost = o.expectedAttackerHpLoss * 0.25 * c.w.hp;
  let v = win - lose - hpCost;
  if (voluntary && (o.pDefenderWins > c.w.koTolerance || (o.pAttackerWins < c.w.fightThreshold && o.pAttackerWins + o.pBothStand < 0.99))) v -= 200;
  if (voluntary && f.opponentKind === 'contestant' && !willingToAttack(c, f.opponent)) v -= 150;
  // A promise not to attack: loyal characters keep it; others break it only for a big prize.
  if (voluntary && f.opponentKind === 'contestant' && hasOpenPromise(c, 'noAttack', c.me.id, f.opponent)) v -= c.persona.traits.loyalty >= 4 ? 1000 : 40;
  const opponent = c.view.entities.find((e) => e.id === f.opponent);
  if (opponent) {
    v += o.pAttackerWins * objectiveBonus(c, 'defeated', (w) => (w.targetTag === undefined || opponent.tags.includes(w.targetTag as string)) && (w.enemy === undefined || w.enemy === opponent.defId) && (w.targetKind === undefined || w.targetKind === opponent.kind));
  }
  return v;
}

/** Expected cost of standing where rivals can reach and attack (their intent is unknown). */
function threatCost(c: Ctx, threats: Threat[]): number {
  let cost = 0;
  const risk = Math.floor((c.gold * c.info.settings.ko.goldLossPercent) / 100);
  for (const t of threats) cost += t.reach * t.pKnockout * threatWeight(t) * koCost(c, risk);
  return cost * (0.6 + (10 - c.persona.traits.risk) / 20);
}

/** Protection from statuses (smoke, shields) is worth more when rivals threaten the contestant. */
function protectionValue(c: Ctx, hints: Hint[]): number {
  const danger = threatCost(c, c.view.threatsHere);
  if (danger <= 0) return 0;
  let v = 0;
  for (const h of hints) {
    const def = h.status !== undefined ? c.info.statuses.find((s) => s.id === h.status) : undefined;
    if (!def) continue;
    if (def.suppress.includes('attackable')) v += danger * 0.9 * h.p;
    else if (def.shields) v += danger * 0.5 * h.p;
  }
  return v;
}

function hintValue(c: Ctx, h: Hint): number {
  let v = 0;
  if (h.resource !== undefined && h.min !== undefined && h.max !== undefined) v += resourceValue(c, h.resource, (h.min + h.max) / 2) + reachBonus(c, h.resource, (h.min + h.max) / 2);
  if (h.status !== undefined) v += statusValue(c, h.status, h.statusStacks ?? 1);
  if (h.item !== undefined) v += itemValue(c, h.item);
  if (h.losesItem) v -= 20;
  if (h.choice) v += 4;
  return v * h.p * (h.certain ? 1 : 0.8);
}

function hintsValue(c: Ctx, hints: Hint[], skipFights = false): number {
  let v = 0;
  for (const h of hints) {
    if (h.fight) {
      if (!skipFights) v += fightValue(c, h.fight, false) * h.p;
      continue;
    }
    v += hintValue(c, h);
  }
  return v;
}

/** The best affordable Power upgrade sold by shops at a given space (null if none). */
function gearGainAt(c: Ctx, space: string): number | null {
  let best: number | null = null;
  for (const f of c.view.entities) {
    if (f.kind !== 'fixture' || f.status !== 'active' || f.spaceId !== space) continue;
    for (const offer of f.shopEntries) {
      const entry = c.info.shops.flatMap((sh) => sh.entries).find((e) => e.id === offer.entry);
      if (!entry || entry.grantsItem === null || entry.priceResource !== c.info.settings.core.gold || entry.price > c.gold) continue;
      const item = c.info.items.find((i) => i.id === entry.grantsItem);
      const gain = item?.modifiers.filter((m) => m.resource === c.info.settings.core.power).reduce((s, m) => s + m.add, 0) ?? 0;
      if (gain > 0 && (best === null || gain > best)) best = gain;
    }
  }
  return best;
}

function canShop(c: Ctx): boolean {
  return !c.me.suppressed.some((s) => s.capability === 'shops');
}

function scoreMove(c: Ctx, p: Extract<OptionPreview, { kind: 'move' }>): number {
  let s = hintsValue(c, p.hints, true) - threatCost(c, p.threats);
  if (p.steps > 0) {
    s += objectiveBonus(c, 'landed', (w) => (w.space === undefined || w.space === p.space) && (w.spaceTag === undefined || p.tags.includes(w.spaceTag as string)));
    const draws = p.hints.filter((h) => h.deck !== undefined && !h.fromCard);
    for (const h of draws) s += h.p * objectiveBonus(c, 'cardDrawn', (w) => w.deck === undefined || w.deck === h.deck);
  }
  if (p.fight) s += fightValue(c, p.fight, false) - (p.fight.odds.pDefenderWins > c.w.koTolerance ? 150 : 0);
  const vendorHere = c.vendor !== undefined && c.vendor.spaceId === p.space;
  const canBuyStar = c.starPrice !== null && c.gold >= c.starPrice && canShop(c);
  if (vendorHere && canBuyStar) s += 180 * c.w.stars;
  if (c.vendor && c.starPrice !== null) {
    const d = p.distances.find((x) => x.key === c.vendor?.id)?.steps;
    if (d !== undefined) s -= d * (canBuyStar ? 6 : c.gold >= c.starPrice * 0.6 ? 2.5 : 0.8) * c.w.stars;
  }
  // Shops: worth visiting when this shop sells an affordable Power upgrade.
  const gear = gearGainAt(c, p.space);
  if (gear !== null && canShop(c) && c.me.items.length < c.info.settings.inventoryCapacity) s += gear * 0.3 * c.w.gear;
  // Enemies and rivals that can be attacked next turn (not ambushes): value the follow-up fight.
  const settings = c.info.settings.combat;
  for (const e of c.view.entities) {
    if (e.id === c.me.id || e.status !== 'active' || e.spaceId !== p.space || p.fight) continue;
    const isRival = e.kind === 'contestant' && settings.pvp && e.koTurns === 0;
    if (e.kind !== 'enemy' && !isRival) continue;
    if (e.suppressed.some((x) => x.capability === 'attackable')) continue;
    const odds = fightOdds({ attackerPower: c.power, attackerHp: c.hp, defenderPower: stat(e, c.info.settings.core.power), defenderHp: stat(e, c.info.settings.core.hp), maxSpins: settings.maxSpinsPerFight, damage: settings.damage });
    const loot = isRival && c.info.settings.ko.lootToVictor ? Math.floor((stat(e, c.info.settings.core.gold) * c.info.settings.ko.goldLossPercent) / 100) : 0;
    const f: FightHint = { opponent: e.id, opponentName: e.name, opponentKind: e.kind, iAmAttacker: true, myPower: c.power, myHp: c.hp, theirPower: 0, theirHp: 0, odds, rewards: null, loot, risk: Math.floor((c.gold * c.info.settings.ko.goldLossPercent) / 100) };
    const v = fightValue(c, f, true);
    if (v > 0) s += v * (isRival ? 0.3 : 0.7);
  }
  return s;
}

function scoreMain(c: Ctx, p: OptionPreview): number {
  switch (p.kind) {
    case 'buy': {
      if (p.grantsResource === c.info.settings.victory.resource) return 1000 * p.grantsAmount;
      const goal = objectiveBonus(c, 'purchased', (w) => w.shopEntry === undefined || w.shopEntry === p.entry);
      let s = p.grantsItem !== null ? itemValue(c, p.grantsItem) : p.grantsResource !== null ? resourceValue(c, p.grantsResource, p.grantsAmount) : 0;
      if (p.powerAfter !== null) s = Math.max(s, (p.powerAfter - c.power) * 0.35 * c.w.gear);
      s -= p.price * 1.2;
      // Saving for a star beats small upgrades for star-focused contestants.
      if (c.starPrice !== null && c.gold - p.price < c.starPrice && c.w.stars > 1.2) s -= 40;
      return s + goal;
    }
    case 'attack':
      return fightValue(c, p.fight, true);
    case 'use': {
      const defId = c.me.items.find((i) => i.id === p.item)?.defId;
      return hintsValue(c, p.hints) + protectionValue(c, p.hints) - (p.consumed ? 6 : 0) + objectiveBonus(c, 'itemUsed', (w) => w.item === undefined || w.item === defId);
    }
    case 'act': {
      const cost = p.cost ? resourceValue(c, p.cost.resource, -p.cost.amount) : 0;
      return hintsValue(c, p.hints) + protectionValue(c, p.hints) + cost - 2 + objectiveBonus(c, 'actionUsed', (w) => w.action === undefined || w.action === p.action);
    }
    case 'trade':
    case 'pay':
    case 'tradeAnswer':
      // Free actions and trade answers are decided separately (see chooseHeuristic).
      return -1;
    case 'freeform':
      // The offline player never improvises: that is for model-driven contestants.
      return -5;
    case 'choose':
      return p.unknown ? 0 : hintsValue(c, p.hints);
    case 'rest':
      return (c.hp < c.maxHp * 0.6 ? (p.hpAfter - c.hp) * 0.8 * c.w.hp : -1) + (c.view.threatsHere.length > 0 && c.hp < c.maxHp ? 4 : 0);
    case 'pass':
      return 0;
    case 'move':
      return scoreMove(c, p);
  }
}

function ctxFor(view: ContestantView, info: PublicGameInfo, me: ViewEntity, persona: Persona, archetype: Archetype | null, mind: ContestantMind | null): Ctx {
  const core = info.settings.core;
  const victory = info.settings.victory.resource;
  const starEntry = info.shops.flatMap((s) => s.entries).find((e) => e.grantsResource === victory);
  return {
    view,
    info,
    persona,
    me,
    w: weightsFor(persona, archetype),
    gold: stat(me, core.gold),
    stars: stat(me, victory),
    hp: stat(me, core.hp),
    maxHp: stat(me, core.maxHp),
    power: stat(me, core.power),
    starPrice: starEntry?.price ?? null,
    vendor: view.entities.find((e) => e.kind === 'fixture' && e.status === 'active' && e.shopEntries.some((x) => x.entry === starEntry?.id)),
    rivalStars: Math.max(0, ...view.entities.filter((e) => e.kind === 'contestant' && e.id !== me.id).map((e) => stat(e, victory))),
    mind,
    objectives: me.isSelf ? view.objectives : [],
    others: new Map(),
  };
}

export function chooseHeuristic(view: ContestantView, info: PublicGameInfo, persona: Persona, archetype: Archetype | null, mind: ContestantMind | null = null): HeuristicChoice {
  const decision = view.decision;
  if (!decision) throw new Error('no decision for this contestant');
  const me = view.entities.find((e) => e.isSelf);
  if (!me) throw new Error('viewer not found');
  const c = ctxFor(view, info, me, persona, archetype, mind);
  const say = keyMomentLine(c);
  const withSay = (choice: HeuristicChoice): HeuristicChoice => (say ? { ...choice, say } : choice);

  if (decision.kind === 'trade') return withSay(answerOffer(c));

  // Free actions first: they do not use up the main action.
  const pay = decision.previews.find((p): p is Extract<OptionPreview, { kind: 'pay' }> => p.kind === 'pay');
  if (pay && willPay(c, pay)) return withSay({ optionId: pay.optionId, reason: explainChoice(pay), scores: [] });
  const tradeOption = decision.previews.find((p): p is Extract<OptionPreview, { kind: 'trade' }> => p.kind === 'trade');
  if (tradeOption) {
    const deal = bestProposal(c, tradeOption);
    if (deal) return withSay({ optionId: tradeOption.optionId, reason: deal.reason, scores: [], trade: deal.offer });
  }

  const scores = decision.previews.map((p) => ({ optionId: p.optionId, score: Math.round(scoreMain(c, p) * 100) / 100 }));
  let best = scores[0] as { optionId: string; score: number };
  for (const s of scores) if (s.score > best.score) best = s;
  const preview = decision.previews.find((p) => p.optionId === best.optionId);
  return withSay({ optionId: best.optionId, reason: explainChoice(preview), scores });
}

// ---------------------------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------------------------

/** Gold value of one unit of a tradeable resource: its best exchange rate at shops. */
function goldRate(info: PublicGameInfo, resource: string): number {
  const gold = info.settings.core.gold;
  if (resource === gold) return 1;
  const goldPrice = (item: string) => {
    const prices = info.shops.flatMap((sh) => sh.entries).filter((e) => e.grantsItem === item && e.priceResource === gold).map((e) => e.price);
    return prices.length > 0 ? Math.min(...prices) : 0;
  };
  let best = 0;
  for (const e of info.shops.flatMap((sh) => sh.entries)) {
    if (e.priceResource !== resource || e.price <= 0) continue;
    const worth = e.grantsResource === gold ? e.grantsAmount : e.grantsItem !== null ? goldPrice(e.grantsItem) : 0;
    best = Math.max(best, worth / e.price);
  }
  return best;
}

function unitValue(c: Ctx, resource: string): number {
  const goldUnit = resourceValue(c, c.info.settings.core.gold, 1);
  if (resource === c.info.settings.core.gold) return goldUnit;
  // Converting at a shop takes a trip: discount the exchange rate.
  return goldRate(c.info, resource) * goldUnit * 0.75;
}

/** Crossing the price of the victory resource (being able to buy one right away) matters most. */
function starSwing(c: Ctx, goldDelta: number): number {
  if (c.starPrice === null || !c.vendor || !canShop(c) || goldDelta === 0) return 0;
  const before = c.gold >= c.starPrice;
  const after = c.gold + goldDelta >= c.starPrice;
  const big = 60 * c.w.stars;
  return !before && after ? big : before && !after ? -big : 0;
}

function heldItemValue(c: Ctx, defId: string): number {
  const item = c.info.items.find((i) => i.id === defId);
  if (!item) return 10;
  let v = 0;
  for (const m of item.modifiers) v += resourceValue(c, m.resource, m.add) * (m.resource === c.info.settings.core.power ? c.w.gear / Math.max(0.1, c.w.power) : 1);
  if (item.usable) v += 14;
  return v;
}

/** Value to `c` of receiving `inbound` and handing over `outbound`. */
function tradeValue(c: Ctx, inbound: ViewGoods, outbound: ViewGoods): number {
  const gold = c.info.settings.core.gold;
  let v = 0;
  for (const [r, a] of Object.entries(inbound.resources)) v += unitValue(c, r) * a + reachBonus(c, r, a);
  for (const [r, a] of Object.entries(outbound.resources)) v -= unitValue(c, r) * a;
  v += starSwing(c, (inbound.resources[gold] ?? 0) - (outbound.resources[gold] ?? 0));
  for (const i of inbound.items) v += heldItemValue(c, i);
  for (const i of outbound.items) v -= heldItemValue(c, i);
  return v;
}

/** What being free to attack `target` is worth per round: chance to win × loot, by temperament. */
function attackOpportunity(c: Ctx, target: ViewEntity | undefined): number {
  const settings = c.info.settings;
  if (!target || !settings.combat.pvp) return 0;
  const odds = fightOdds({
    attackerPower: c.power,
    attackerHp: c.hp,
    defenderPower: stat(target, settings.core.power),
    defenderHp: stat(target, settings.core.hp),
    maxSpins: settings.combat.maxSpinsPerFight,
    damage: settings.combat.damage,
  });
  const loot = settings.ko.lootToVictor ? Math.floor((stat(target, settings.core.gold) * settings.ko.goldLossPercent) / 100) : 0;
  return odds.pAttackerWins * loot * resourceValue(c, settings.core.gold, 1) * (c.persona.traits.aggression / 10);
}

function promiseValue(c: Ctx, p: { byYou: boolean; kind: 'noAttack' | 'pay'; rounds: number; resource: string | null; amount: number }, partner: string): number {
  const loyal = c.persona.traits.loyalty >= 4;
  if (p.byYou) {
    if (p.kind === 'noAttack') {
      const giveUp = 1 + attackOpportunity(c, c.view.entities.find((e) => e.id === partner));
      return -giveUp * Math.min(3, p.rounds) * (loyal ? 1 : 0.3);
    }
    return -unitValue(c, p.resource ?? '') * p.amount * (loyal ? 1 : 0.3);
  }
  if (p.kind === 'noAttack') {
    const danger = threatCost(c, c.view.threatsHere.filter((t) => t.rival === partner));
    return (2 + danger * Math.min(3, p.rounds) * 0.5) * trustFactor(c, partner);
  }
  return unitValue(c, p.resource ?? '') * p.amount * trustFactor(c, partner);
}

/** The contestant's guess of how a partner values a deal (traits and plans unknown: neutral). */
function partnerValue(c: Ctx, partnerId: string, partnerGets: ViewGoods, partnerGives: ViewGoods, promises: ViewPromise[]): number {
  let pc = c.others.get(partnerId);
  if (!pc) {
    const partner = c.view.entities.find((e) => e.id === partnerId);
    if (!partner) return -Infinity;
    pc = ctxFor(c.view, c.info, partner, NEUTRAL, null, null);
    c.others.set(partnerId, pc);
  }
  let v = tradeValue(pc, partnerGets, partnerGives);
  // `byYou` is from the partner's side: its own promises cost it, promises to it are worth a little.
  for (const p of promises) {
    if (p.byYou) v -= p.kind === 'pay' ? unitValue(pc, p.resource ?? '') * p.amount : (1 + attackOpportunity(pc, c.me)) * Math.min(3, p.rounds);
    else v += p.kind === 'pay' ? unitValue(pc, p.resource ?? '') * p.amount * 0.6 : 2;
  }
  return v;
}

/**
 * Helping a rival towards victory is a cost in itself: more so for the leader, and most when the
 * deal lets them buy a Star right away.
 */
function leaderPenalty(c: Ctx, partnerId: string, partnerGain: number, partnerGoldDelta = 0): number {
  const victory = c.info.settings.victory.resource;
  const partner = c.view.entities.find((e) => e.id === partnerId);
  if (!partner) return 0;
  const theirs = stat(partner, victory);
  let v = theirs > c.stars && theirs >= c.rivalStars && partnerGain > 0 ? partnerGain * 0.5 : 0;
  const price = c.starPrice;
  const gold = stat(partner, c.info.settings.core.gold);
  if (price !== null && partnerGoldDelta > 0 && gold < price && gold + partnerGoldDelta >= price) v += 30 * c.w.stars;
  return v;
}

const goods = (resources: Record<string, number> = {}, items: string[] = []): ViewGoods => ({ resources, items });

interface Deal {
  offer: TradeOfferInput;
  gain: number;
  reason: string;
}

/** Picks the most profitable offer a partner would plausibly accept, or null. */
function bestProposal(c: Ctx, option: Extract<OptionPreview, { kind: 'trade' }>): Deal | null {
  const gold = c.info.settings.core.gold;
  const threshold = 8 - c.persona.traits.sociability * 0.4;
  let best: Deal | null = null;
  const consider = (partner: TradePartnerView, give: ViewGoods, get: ViewGoods, promises: ViewPromise[], reason: string, message: string) => {
    const mine = tradeValue(c, get, give) + promises.reduce((v, p) => v + promiseValue(c, p, partner.id), 0);
    const theirs = partnerValue(c, partner.id, give, get, promises.map((p) => ({ ...p, byYou: !p.byYou })));
    if (theirs < 2) return;
    const goldToPartner = (give.resources[c.info.settings.core.gold] ?? 0) - (get.resources[c.info.settings.core.gold] ?? 0);
    const gain = mine - leaderPenalty(c, partner.id, theirs, goldToPartner) + rel(c, partner.id).affinity * 0.5;
    if (gain < threshold || (best && gain <= best.gain)) return;
    best = {
      gain,
      reason,
      offer: {
        with: partner.id,
        give: { resources: give.resources, items: give.items },
        get: { resources: get.resources, items: get.items },
        promises: promises.map((p) => (p.kind === 'noAttack' ? { by: p.byYou ? 'me' : 'them', kind: 'noAttack', rounds: p.rounds } : { by: p.byYou ? 'me' : 'them', kind: 'pay', resource: p.resource ?? gold, amount: p.amount, rounds: p.rounds })),
        message,
      },
    };
  };
  const myGold = option.youHold.resources[gold] ?? 0;
  // After a rejection, wait a round; someone who turned an offer down is left alone for a while longer.
  const rejections = (c.mind?.memories ?? []).filter((m) => m.kind === 'offerRejected' && m.other !== null);
  if (rejections.some((m) => c.view.round - m.round < 1)) return null;
  const rebuffed = new Set(rejections.filter((m) => c.view.round - m.round < 3).map((m) => m.other as string));
  for (const partner of option.partners) {
    if (rel(c, partner.id).affinity <= -5 || rebuffed.has(partner.id)) continue;
    const theirGold = partner.holds.resources[gold] ?? 0;
    // Resources for gold, both ways.
    for (const r of c.info.resources) {
      if (!r.tradeable || r.id === gold) continue;
      const name = r.name;
      for (let k = 1; k <= Math.min(5, option.youHold.resources[r.id] ?? 0); k++) {
        for (let g = 1; g <= Math.min(15, theirGold); g++) consider(partner, goods({ [r.id]: k }), goods({ [gold]: g }), [], `selling ${k} ${name}`, `${k} ${name} for ${g} Gold?`);
      }
      for (let k = 1; k <= Math.min(5, partner.holds.resources[r.id] ?? 0); k++) {
        for (let g = 1; g <= Math.min(15, myGold); g++) consider(partner, goods({ [gold]: g }), goods({ [r.id]: k }), [], `buying ${k} ${name}`, `${g} Gold for ${k} of your ${name}?`);
      }
    }
    // Items I hold for gold.
    for (const item of option.youHold.items) {
      for (let g = 2; g <= Math.min(20, theirGold); g += 2) consider(partner, goods({}, [item]), goods({ [gold]: g }), [], `selling ${c.info.items.find((i) => i.id === item)?.name ?? item}`, `Want my ${c.info.items.find((i) => i.id === item)?.name ?? item} for ${g} Gold?`);
    }
    // A loan towards the victory resource: gold now, paid back double later (only at the vendor, to buy now).
    const atVendor = c.vendor !== undefined && c.vendor.spaceId === c.me.spaceId && canShop(c);
    if (atVendor && c.starPrice !== null && c.gold < c.starPrice && c.starPrice - c.gold <= 8 && option.maxPromiseRounds >= 3) {
      const d = c.starPrice - c.gold;
      if (theirGold >= d) consider(partner, goods(), goods({ [gold]: d }), [{ byYou: true, kind: 'pay', rounds: 3, resource: gold, amount: d * 2, text: '' }], 'borrowing for a star', `Lend me ${d} Gold and I will pay you back ${d * 2} within 3 rounds.`);
    }
    // A truce with a dangerous rival.
    const danger = c.view.threatsHere.filter((t) => t.rival === partner.id);
    if (danger.length > 0 && option.maxPromiseRounds >= 2 && c.info.settings.combat.pvp) {
      for (let g = 1; g <= Math.min(8, myGold); g++) consider(partner, goods({ [gold]: g }), goods(), [{ byYou: false, kind: 'noAttack', rounds: 2, resource: null, amount: 0, text: '' }], `buying a truce with ${partner.name}`, `${g} Gold if you leave me alone for 2 rounds.`);
    }
  }
  return best;
}

function answerValue(c: Ctx, n: ViewNegotiation): number {
  const mine = tradeValue(c, n.youGet, n.youGive) + n.promises.reduce((v, p) => v + promiseValue(c, p, n.partner), 0);
  const theirs = partnerValue(c, n.partner, n.youGive, n.youGet, n.promises.map((p) => ({ ...p, byYou: !p.byYou })));
  const gold = c.info.settings.core.gold;
  let v = mine - leaderPenalty(c, n.partner, theirs, (n.youGive.resources[gold] ?? 0) - (n.youGet.resources[gold] ?? 0));
  if (rel(c, n.partner).affinity <= -4) v -= 15;
  return v;
}

/** Accept, reject or counter an offer (or a counteroffer to the contestant's own offer). */
function answerOffer(c: Ctx): HeuristicChoice {
  const previews = c.view.decision?.previews ?? [];
  const find = (answer: 'accept' | 'reject' | 'counter') => previews.find((p): p is Extract<OptionPreview, { kind: 'tradeAnswer' }> => p.kind === 'tradeAnswer' && p.answer === answer);
  const reject = find('reject');
  const accept = find('accept');
  const n = (accept ?? reject)?.negotiation;
  if (!n || !reject) return { optionId: previews[0]?.optionId ?? 'tr:reject', reason: 'no offer', scores: [] };
  const value = answerValue(c, n);
  const scores = [{ optionId: reject.optionId, score: 0 }];
  if (accept) scores.push({ optionId: accept.optionId, score: Math.round(value * 100) / 100 });
  if (accept && value >= (n.stage === 'final' ? 0 : 2)) return { optionId: accept.optionId, reason: explainChoice(accept), scores };
  const counter = find('counter');
  if (counter) {
    const better = counterOffer(c, n);
    if (better) return { optionId: counter.optionId, reason: explainChoice(counter), scores, trade: better };
  }
  return { optionId: reject.optionId, reason: explainChoice(reject), scores };
}

/** Asks for more gold (or offers less) until the deal is worth it, if the partner can still afford it. */
function counterOffer(c: Ctx, n: ViewNegotiation): TradeOfferInput | null {
  const gold = c.info.settings.core.gold;
  const partner = c.view.entities.find((e) => e.id === n.partner);
  if (!partner) return null;
  const theirGold = stat(partner, gold);
  const asFor = (give: ViewGoods, get: ViewGoods): TradeOfferInput => ({
    give: { resources: give.resources, items: give.items },
    get: { resources: get.resources, items: get.items },
    promises: n.promises.map((p) => (p.kind === 'noAttack' ? { by: p.byYou ? 'me' : 'them', kind: 'noAttack', rounds: p.rounds } : { by: p.byYou ? 'me' : 'them', kind: 'pay', resource: p.resource ?? gold, amount: p.amount, rounds: p.rounds })),
    message: 'Make it worth my while.',
  });
  const works = (give: ViewGoods, get: ViewGoods) => {
    const alt = { ...n, youGive: give, youGet: get };
    return answerValue(c, alt) >= 4 && partnerValue(c, n.partner, give, get, n.promises.map((p) => ({ ...p, byYou: !p.byYou }))) >= 0;
  };
  const baseGet = n.youGet.resources[gold] ?? 0;
  for (let g = baseGet + 1; g <= Math.min(theirGold, baseGet + 10); g++) {
    const get = goods({ ...n.youGet.resources, [gold]: g }, n.youGet.items);
    if (works(n.youGive, get)) return asFor(n.youGive, get);
  }
  const baseGive = n.youGive.resources[gold] ?? 0;
  for (let g = baseGive - 1; g >= 0; g--) {
    const resources = { ...n.youGive.resources };
    if (g > 0) resources[gold] = g;
    else delete resources[gold];
    const give = goods(resources, n.youGive.items);
    if (works(give, n.youGet)) return asFor(give, n.youGet);
  }
  return null;
}

/** Loyal characters pay debts as soon as they can (unless the money buys a star right now). */
function willPay(c: Ctx, p: Extract<OptionPreview, { kind: 'pay' }>): boolean {
  if (c.persona.traits.loyalty < 4) return false;
  const due = c.view.commitments.find((x) => x.id === p.commitment)?.dueRound ?? c.view.round;
  const buysStar = c.view.decision?.previews.some((x) => x.kind === 'buy' && x.grantsResource === c.info.settings.victory.resource) ?? false;
  const starAfter = c.starPrice !== null && p.resource === c.info.settings.core.gold && c.gold - p.amount < c.starPrice;
  return !(buysStar && starAfter && due > c.view.round);
}

// ---------------------------------------------------------------------------------------------
// Dialogue
// ---------------------------------------------------------------------------------------------

/** Talkative characters say something at key moments (deterministic, from traits). */
function keyMomentLine(c: Ctx): string | undefined {
  const moment = c.mind?.keyMoment;
  if (!moment || c.persona.traits.sociability < 5) return undefined;
  const t = c.persona.traits;
  const who = /^(\S+(?: \S+){0,3}) just/.exec(moment)?.[1];
  if (moment.includes('broke a promise')) return t.vindictiveness >= 6 ? `I will not forget this, ${who ?? 'traitor'}.` : `So much for your word, ${who ?? 'friend'}.`;
  if (moment.includes('just attacked you')) return t.aggression >= 6 ? `You picked the wrong fight, ${who ?? 'rival'}!` : 'Was that really necessary?';
  if (moment.includes('knocked you out') || moment === 'You were just knocked out') return t.vindictiveness >= 6 ? 'This is not over.' : 'I will be back on my feet soon.';
  if (moment.startsWith('You just knocked out')) return t.aggression >= 6 ? 'Stay down.' : 'Nothing personal.';
  if (moment.includes('closed a deal')) return t.greed >= 6 ? 'A fine bargain — for me.' : 'Pleasure doing business.';
  if (moment.includes('secret objective')) return 'Right on schedule.';
  return undefined;
}

function explainChoice(p: OptionPreview | undefined): string {
  if (!p) return 'default';
  switch (p.kind) {
    case 'move': {
      const shown = p.hints.filter((h) => !h.fromCard);
      return p.fight ? `heading to ${p.spaceName} despite a fight` : shown.length > 0 ? `${p.spaceName}: ${shown.map((h) => h.text).join(', ')}` : `positioning at ${p.spaceName}`;
    }
    case 'buy':
      return `buying ${p.label}`;
    case 'attack':
      return `attacking ${p.fight.opponentName} (${Math.round(p.fight.odds.pAttackerWins * 100)}% to win)`;
    case 'use':
      return `using ${p.name}`;
    case 'act':
      return `${p.name}${p.targetName ? ` on ${p.targetName}` : ''}`;
    case 'choose':
      return `choosing “${p.label}”`;
    case 'rest':
      return 'recovering HP';
    case 'pass':
      return 'nothing worth doing';
    case 'trade':
      return 'proposing a trade';
    case 'pay':
      return `paying ${p.toName} as promised`;
    case 'tradeAnswer':
      return p.answer === 'accept' ? 'a fair deal' : p.answer === 'counter' ? 'asking for better terms' : 'not worth it';
    case 'freeform':
      return 'trying something unusual';
  }
}
