import type { Archetype, Persona, Strategy } from '../schema/persona.ts';
import type { PublicGameInfo } from '../visibility/public-info.ts';
import type { ContestantView } from '../visibility/view.ts';

/**
 * Match strategies. The engine only offers archetypes the scenario actually supports; a
 * deterministic "casting" step gives each contestant a few candidates that fit its personality.
 */

export interface ArchetypeInfo {
  id: Archetype;
  title: string;
  summary: (info: PublicGameInfo) => string;
  priorities: (info: PublicGameInfo) => string[];
  avoid: string[];
  fits: (p: Persona) => number;
  supported: (info: PublicGameInfo) => boolean;
}

function starEntry(info: PublicGameInfo) {
  for (const shop of info.shops) for (const e of shop.entries) if (e.grantsResource === info.settings.victory.resource) return e;
  return undefined;
}

function victoryEnemy(info: PublicGameInfo) {
  return info.enemies.find((e) => e.rewards.some((r) => r.op === 'changeResource' && r.resource === info.settings.victory.resource));
}

function hasPowerGear(info: PublicGameInfo): boolean {
  return info.items.some((i) => i.modifiers.some((m) => m.resource === info.settings.core.power && m.add > 0)) && info.shops.some((s) => s.entries.some((e) => e.grantsItem !== null));
}

function hasPowerTraining(info: PublicGameInfo): boolean {
  const power = info.settings.core.power;
  return (
    info.rules.some((r) => r.trigger === 'landed' && r.text.includes(nameOf(info, power))) ||
    info.enemies.some((e) => e.rewards.some((r) => r.op === 'changeResource' && r.resource === power))
  );
}

function nameOf(info: PublicGameInfo, resource: string): string {
  return info.resources.find((r) => r.id === resource)?.name ?? resource;
}

export const ARCHETYPE_INFO: Record<Archetype, ArchetypeInfo> = {
  banker: {
    id: 'banker',
    title: 'Banker',
    summary: (info) => {
      const star = starEntry(info);
      return `Farm income spaces and avoid fights. Save ${nameOf(info, star?.priceResource ?? info.settings.core.gold)} and buy a ${nameOf(info, info.settings.victory.resource)} whenever you can afford one${star ? ` (${star.price})` : ''}. Only fight when victory is nearly certain.`;
    },
    priorities: (info) => [`${nameOf(info, info.settings.core.gold)} income every turn`, `buy ${nameOf(info, info.settings.victory.resource)} as soon as affordable`],
    avoid: ['fights with less than 90% win chance', 'hazard spaces'],
    fits: (p) => p.traits.greed + (10 - p.traits.risk) / 2 + (10 - p.traits.aggression) / 2,
    supported: (info) => starEntry(info) !== undefined,
  },
  gearUp: {
    id: 'gearUp',
    title: 'Gear Up',
    summary: (info) => {
      const enemy = victoryEnemy(info);
      return `Spend early ${nameOf(info, info.settings.core.gold)} on equipment to raise ${nameOf(info, info.settings.core.power)}, then challenge the ${enemy?.name ?? 'strongest enemy'} once the combat odds favor you. Buy ${nameOf(info, info.settings.victory.resource)} with spare gold.`;
    },
    priorities: (info) => [`reach ${Math.round((victoryEnemy(info)?.power ?? 500) * 1.5)} ${nameOf(info, info.settings.core.power)}`, `defeat the ${victoryEnemy(info)?.name ?? 'boss'}`],
    avoid: ['fighting the boss before your odds are good', 'knockouts that cost half your gold'],
    fits: (p) => (10 - p.traits.risk) / 2 + p.traits.aggression / 3 + p.traits.greed / 3 + 5,
    supported: (info) => hasPowerGear(info) && victoryEnemy(info) !== undefined,
  },
  powerFarmer: {
    id: 'powerFarmer',
    title: 'Power Farmer',
    summary: (info) =>
      `Train at power spaces and defeat weak enemies to grow ${nameOf(info, info.settings.core.power)} quickly, then hunt the ${victoryEnemy(info)?.name ?? 'strongest enemy'} alone for its big reward.`,
    priorities: (info) => [`gain ${nameOf(info, info.settings.core.power)} every turn`, `defeat the ${victoryEnemy(info)?.name ?? 'boss'} when odds are good`],
    avoid: ['low-HP fights', 'wandering far from training spots'],
    fits: (p) => p.traits.aggression + p.traits.risk / 2 + 1,
    supported: (info) => hasPowerTraining(info) && victoryEnemy(info) !== undefined,
  },
  starChaser: {
    id: 'starChaser',
    title: 'Star Chaser',
    summary: (info) =>
      `Follow the ${nameOf(info, info.settings.victory.resource)} vendor around the board, collecting ${nameOf(info, info.settings.core.gold)} on the way, and buy the moment you arrive with enough. Fight only when the odds are overwhelming.`,
    priorities: (info) => [`stay close to the ${nameOf(info, info.settings.victory.resource)} vendor`, `always carry enough gold to buy`],
    avoid: ['detours for equipment', 'risky fights'],
    fits: (p) => p.traits.sociability / 2 + p.traits.risk / 2 + p.traits.greed / 2 + 2,
    supported: (info) => starEntry(info) !== undefined,
  },
  opportunist: {
    id: 'opportunist',
    title: 'Opportunist',
    summary: () => 'Stay flexible: take the best value each turn, grab cheap power and stars, and strike when a fight is clearly favorable. Adapt to what others are doing.',
    priorities: () => ['best value each turn', 'favorable fights only'],
    avoid: ['long plans that ignore new opportunities'],
    fits: () => 6,
    supported: () => true,
  },
};

export function supportedArchetypes(info: PublicGameInfo): Archetype[] {
  return (Object.keys(ARCHETYPE_INFO) as Archetype[]).filter((a) => ARCHETYPE_INFO[a].supported(info));
}

/**
 * Casting: each contestant receives up to three candidate archetypes ranked by personality fit.
 * First picks are spread out: no archetype is the first pick of more than ceil(n / supported)
 * contestants, so a table of four usually starts with four different approaches.
 */
export function castCandidates(info: PublicGameInfo, personas: Array<{ id: string; persona: Persona }>): Map<string, Archetype[]> {
  const supported = supportedArchetypes(info);
  const cap = Math.max(1, Math.ceil(personas.length / Math.max(1, supported.length)));
  const firstPicks = new Map<Archetype, number>();
  const out = new Map<string, Archetype[]>();
  for (const { id, persona } of personas) {
    const ranked = [...supported].sort((a, b) => ARCHETYPE_INFO[b].fits(persona) - ARCHETYPE_INFO[a].fits(persona) || a.localeCompare(b));
    const first = ranked.find((a) => (firstPicks.get(a) ?? 0) < cap) ?? ranked[0];
    if (first === undefined) continue;
    firstPicks.set(first, (firstPicks.get(first) ?? 0) + 1);
    out.set(id, [first, ...ranked.filter((a) => a !== first)].slice(0, 3));
  }
  return out;
}

function vendorOnBoard(view: ContestantView, info: PublicGameInfo): boolean {
  const entry = starEntry(info);
  return entry !== undefined && view.entities.some((e) => e.kind === 'fixture' && e.status === 'active' && e.shopEntries.some((x) => x.entry === entry.id));
}

function gearShopOnBoard(view: ContestantView, info: PublicGameInfo): boolean {
  const power = info.settings.core.power;
  const gear = new Set(
    info.shops.flatMap((sh) => sh.entries).filter((e) => e.grantsItem !== null && info.items.some((i) => i.id === e.grantsItem && i.modifiers.some((m) => m.resource === power && m.add > 0))).map((e) => e.id),
  );
  return view.entities.some((e) => e.kind === 'fixture' && e.status === 'active' && e.shopEntries.some((x) => gear.has(x.entry)));
}

/** The enemy worth victory points is on the board or will come back. */
function victoryEnemyAround(view: ContestantView, info: PublicGameInfo): boolean {
  const def = victoryEnemy(info);
  return def !== undefined && view.entities.some((e) => e.kind === 'enemy' && e.defId === def.id && (e.status === 'active' || (e.status === 'defeated' && e.respawnRound !== null)));
}

/**
 * Why an archetype's key opportunity is gone right now (e.g. the GM removed the Demon or the Star
 * Vendor), or null while it is still there. Checked from the contestant's own view.
 */
export function opportunityLost(archetype: Archetype, view: ContestantView, info: PublicGameInfo): string | null {
  const victoryName = nameOf(info, info.settings.victory.resource);
  switch (archetype) {
    case 'banker':
    case 'starChaser':
      return vendorOnBoard(view, info) ? null : `Nobody sells ${victoryName} any more: your strategy depends on buying them`;
    case 'gearUp':
      if (!victoryEnemyAround(view, info)) return `${victoryEnemy(info)?.name ?? 'The boss'} is gone for good: your strategy depends on defeating it`;
      if (!gearShopOnBoard(view, info)) return 'No shop sells equipment any more: your strategy depends on buying it';
      return null;
    case 'powerFarmer':
      return victoryEnemyAround(view, info) ? null : `${victoryEnemy(info)?.name ?? 'The boss'} is gone for good: your strategy depends on defeating it`;
    case 'opportunist':
      return null;
  }
}

/**
 * The fallback player's answer to a reconsideration flag: switch to the best-fitting archetype that
 * still works when the current one's key opportunity is gone (or, when far behind, to a
 * higher-reward plan that still works); otherwise keep the strategy.
 */
export function reviseStrategy(info: PublicGameInfo, view: ContestantView, persona: Persona, current: Strategy, reason: string): Strategy | null {
  const viable = supportedArchetypes(info).filter((a) => opportunityLost(a, view, info) === null);
  const ranked = [...viable].sort((a, b) => ARCHETYPE_INFO[b].fits(persona) - ARCHETYPE_INFO[a].fits(persona) || a.localeCompare(b));
  let next: Archetype = current.archetype;
  if (!viable.includes(current.archetype)) next = ranked[0] ?? 'opportunist';
  else if (reason.includes(' behind ') && (current.archetype === 'banker' || current.archetype === 'starChaser') && viable.includes('powerFarmer') && persona.traits.risk >= 5) next = 'powerFarmer';
  if (next === current.archetype) return null;
  return defaultStrategy(info, next, view.round, reason);
}

export function defaultStrategy(info: PublicGameInfo, archetype: Archetype, round: number, reason: string): Strategy {
  const a = ARCHETYPE_INFO[archetype];
  return { archetype, summary: a.summary(info), priorities: a.priorities(info), avoid: a.avoid, adoptedAtRound: round, reason };
}

/** Numeric weights used by the fallback player; strategies change them. */
export interface Weights {
  gold: number;
  power: number;
  stars: number;
  gear: number;
  hp: number;
  /** Minimum chance of defeating the opponent before a fight is considered. */
  fightThreshold: number;
  /** Maximum acceptable chance of being knocked out. */
  koTolerance: number;
}

export function weightsFor(persona: Persona, archetype: Archetype | null): Weights {
  const t = persona.traits;
  const w: Weights = {
    gold: 1 + t.greed / 10,
    power: 0.6 + t.aggression / 20,
    stars: 1,
    gear: 0.8 + t.greed / 20,
    hp: 0.6 + (10 - t.risk) / 20,
    fightThreshold: 0.85 - t.risk * 0.04,
    koTolerance: 0.05 + t.risk * 0.025,
  };
  switch (archetype) {
    case 'banker':
      return { ...w, gold: w.gold * 1.4, power: w.power * 0.5, gear: w.gear * 0.3, fightThreshold: Math.max(w.fightThreshold, 0.9), koTolerance: Math.min(w.koTolerance, 0.05) };
    case 'gearUp':
      return { ...w, gear: w.gear * 2.2, power: w.power * 1.2 };
    case 'powerFarmer':
      return { ...w, power: w.power * 2, gear: w.gear * 1.2, fightThreshold: w.fightThreshold - 0.05 };
    case 'starChaser':
      return { ...w, stars: 1.6, gold: w.gold * 1.2, gear: w.gear * 0.5, fightThreshold: Math.max(w.fightThreshold, 0.85) };
    case 'opportunist':
    case null:
      return w;
  }
}
