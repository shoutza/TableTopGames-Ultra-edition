import { fightOdds } from '../engine/combat.ts';
import type { Archetype, Persona } from '../schema/persona.ts';
import { threatWeight, type ContestantView, type FightHint, type Hint, type OptionPreview, type Threat, type ViewEntity } from '../visibility/view.ts';
import type { PublicGameInfo } from '../visibility/public-info.ts';
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
  if (h.resource !== undefined && h.min !== undefined && h.max !== undefined) v += resourceValue(c, h.resource, (h.min + h.max) / 2);
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
      let s = p.grantsItem !== null ? itemValue(c, p.grantsItem) : p.grantsResource !== null ? resourceValue(c, p.grantsResource, p.grantsAmount) : 0;
      if (p.powerAfter !== null) s = Math.max(s, (p.powerAfter - c.power) * 0.35 * c.w.gear);
      s -= p.price * 1.2;
      // Saving for a star beats small upgrades for star-focused contestants.
      if (c.starPrice !== null && c.gold - p.price < c.starPrice && c.w.stars > 1.2) s -= 40;
      return s;
    }
    case 'attack':
      return fightValue(c, p.fight, true);
    case 'use':
      return hintsValue(c, p.hints) + protectionValue(c, p.hints) - (p.consumed ? 6 : 0);
    case 'act': {
      const cost = p.cost ? resourceValue(c, p.cost.resource, -p.cost.amount) : 0;
      return hintsValue(c, p.hints) + protectionValue(c, p.hints) + cost - 2;
    }
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

export function chooseHeuristic(view: ContestantView, info: PublicGameInfo, persona: Persona, archetype: Archetype | null): HeuristicChoice {
  const decision = view.decision;
  if (!decision) throw new Error('no decision for this contestant');
  const me = view.entities.find((e) => e.isSelf);
  if (!me) throw new Error('viewer not found');
  const core = info.settings.core;
  const victory = info.settings.victory.resource;
  const starEntry = info.shops.flatMap((s) => s.entries).find((e) => e.grantsResource === victory);
  const c: Ctx = {
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
    rivalStars: Math.max(0, ...view.entities.filter((e) => e.kind === 'contestant' && !e.isSelf).map((e) => stat(e, victory))),
  };
  const scores = decision.previews.map((p) => ({ optionId: p.optionId, score: Math.round(scoreMain(c, p) * 100) / 100 }));
  let best = scores[0] as { optionId: string; score: number };
  for (const s of scores) if (s.score > best.score) best = s;
  const preview = decision.previews.find((p) => p.optionId === best.optionId);
  return { optionId: best.optionId, reason: explainChoice(preview), scores };
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
  }
}
