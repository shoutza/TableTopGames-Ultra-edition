import { fightOdds } from '../engine/combat.ts';
import type { Archetype, Persona } from '../schema/persona.ts';
import type { ContestantView, FightHint, OptionPreview, ViewEntity } from '../visibility/view.ts';
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
  me: ViewEntity;
  w: Weights;
  gold: number;
  stars: number;
  hp: number;
  maxHp: number;
  power: number;
  starPrice: number | null;
  vendor: ViewEntity | undefined;
}

function stat(e: ViewEntity, id: string): number {
  return e.stats[id] ?? 0;
}

function rewardValue(c: Ctx, enemyName: string): number {
  const def = c.info.enemies.find((e) => e.name === enemyName);
  if (!def) return 0;
  const core = c.info.settings.core;
  let v = 0;
  for (const r of def.rewards) {
    if (r.op !== 'changeResource' || typeof r.amount !== 'number') continue;
    if (r.resource === c.info.settings.victory.resource) v += r.amount * 140 * c.w.stars;
    else if (r.resource === core.power) v += r.amount * 0.35 * c.w.power;
    else if (r.resource === core.gold) v += r.amount * 2 * c.w.gold;
  }
  return v;
}

function koCost(c: Ctx): number {
  const lost = Math.floor((c.gold * c.info.settings.ko.goldLossPercent) / 100);
  return 25 + lost * 2 * c.w.gold + c.info.settings.ko.skipTurns * 20;
}

/** Expected value of a fight, or a strong penalty if it breaks the contestant's risk limits. */
function fightValue(c: Ctx, f: FightHint, voluntary: boolean): number {
  const o = f.odds;
  const win = o.pAttackerWins * rewardValue(c, f.opponentName);
  const lose = o.pDefenderWins * koCost(c);
  const hpCost = o.expectedAttackerHpLoss * 0.25 * c.w.hp;
  let v = win - lose - hpCost;
  if (voluntary && (o.pDefenderWins > c.w.koTolerance || (o.pAttackerWins < c.w.fightThreshold && o.pAttackerWins + o.pBothStand < 0.99))) v -= 200;
  return v;
}

function hintValue(c: Ctx, resource: string | undefined, min: number, max: number): number {
  const avg = (min + max) / 2;
  const core = c.info.settings.core;
  if (resource === core.gold) return avg * 2 * c.w.gold;
  if (resource === core.power) return avg * 0.35 * c.w.power;
  if (resource === core.hp) return avg * (c.hp < c.maxHp * 0.5 ? 1.2 : 0.5) * c.w.hp;
  if (resource === c.info.settings.victory.resource) return avg * 140 * c.w.stars;
  return avg * 0.3;
}

function bestGearGain(c: Ctx): { gain: number; price: number } | null {
  let best: { gain: number; price: number } | null = null;
  for (const shop of c.info.shops) {
    for (const e of shop.entries) {
      if (e.grantsItem === null || e.price > c.gold) continue;
      const item = c.info.items.find((i) => i.id === e.grantsItem);
      const gain = item?.modifiers.filter((m) => m.resource === c.info.settings.core.power).reduce((s, m) => s + m.add, 0) ?? 0;
      if (gain > 0 && (!best || gain > best.gain)) best = { gain, price: e.price };
    }
  }
  return best;
}

function scoreMove(c: Ctx, p: Extract<OptionPreview, { kind: 'move' }>): number {
  let s = 0;
  for (const h of p.hints) if (h.resource !== undefined && h.min !== undefined && h.max !== undefined) s += hintValue(c, h.resource, h.min, h.max) * (h.certain ? 1 : 0.6);
  if (p.fight) s += fightValue(c, p.fight, false) - (p.fight.odds.pDefenderWins > c.w.koTolerance ? 150 : 0);
  const vendorHere = c.vendor !== undefined && c.vendor.spaceId === p.space;
  const canBuyStar = c.starPrice !== null && c.gold >= c.starPrice;
  if (vendorHere && canBuyStar) s += 180 * c.w.stars;
  if (c.vendor && c.starPrice !== null) {
    const d = p.distances.find((x) => x.key === c.vendor?.id)?.steps;
    if (d !== undefined) s -= d * (canBuyStar ? 6 : c.gold >= c.starPrice * 0.6 ? 2.5 : 0.8) * c.w.stars;
  }
  // Shops: worth visiting when an affordable upgrade exists.
  const gear = bestGearGain(c);
  const shopHere = c.view.entities.some((e) => e.kind === 'fixture' && e.spaceId === p.space && e.shopEntries.some((x) => c.info.shops.some((sh) => sh.entries.some((y) => y.id === x.entry && y.grantsItem !== null))));
  if (shopHere && gear && c.me.items.length < c.info.settings.inventoryCapacity) s += gear.gain * 0.3 * c.w.gear;
  // Enemies that can be attacked next (not ambushes): value the follow-up fight.
  for (const e of c.view.entities) {
    if (e.kind !== 'enemy' || e.status !== 'active' || e.spaceId !== p.space || p.fight) continue;
    const settings = c.info.settings.combat;
    const odds = fightOdds({ attackerPower: c.power, attackerHp: c.hp, defenderPower: stat(e, c.info.settings.core.power), defenderHp: stat(e, c.info.settings.core.hp), maxSpins: settings.maxSpinsPerFight, damage: settings.damage });
    const f: FightHint = { opponent: e.id, opponentName: e.name, iAmAttacker: true, myPower: c.power, myHp: c.hp, theirPower: 0, theirHp: 0, odds, rewards: null };
    const v = fightValue(c, f, true);
    if (v > 0) s += v * 0.7;
  }
  return s;
}

function scoreMain(c: Ctx, p: OptionPreview): number {
  switch (p.kind) {
    case 'buy': {
      if (p.grantsResource === c.info.settings.victory.resource) return 1000 * p.grantsAmount;
      let s = (p.powerAfter !== null ? (p.powerAfter - c.power) * 0.35 * c.w.gear : 0) - p.price * 1.2;
      // Saving for a star beats small upgrades for star-focused contestants.
      if (c.starPrice !== null && c.gold - p.price < c.starPrice && c.w.stars > 1.2) s -= 40;
      return s;
    }
    case 'attack':
      return fightValue(c, p.fight, true);
    case 'rest':
      return c.hp < c.maxHp * 0.6 ? (p.hpAfter - c.hp) * 0.8 * c.w.hp : -1;
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
  const starEntry = info.shops.flatMap((s) => s.entries).find((e) => e.grantsResource === info.settings.victory.resource);
  const c: Ctx = {
    view,
    info,
    me,
    w: weightsFor(persona, archetype),
    gold: stat(me, core.gold),
    stars: stat(me, info.settings.victory.resource),
    hp: stat(me, core.hp),
    maxHp: stat(me, core.maxHp),
    power: stat(me, core.power),
    starPrice: starEntry?.price ?? null,
    vendor: view.entities.find((e) => e.kind === 'fixture' && e.shopEntries.some((x) => x.entry === starEntry?.id)),
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
    case 'move':
      return p.fight ? `heading to ${p.spaceName} despite a fight` : p.hints.length > 0 ? `${p.spaceName}: ${p.hints.map((h) => h.text).join(', ')}` : `positioning at ${p.spaceName}`;
    case 'buy':
      return `buying ${p.label}`;
    case 'attack':
      return `attacking ${p.fight.opponentName} (${Math.round(p.fight.odds.pAttackerWins * 100)}% to win)`;
    case 'rest':
      return 'recovering HP';
    case 'pass':
      return 'nothing worth doing';
  }
}
