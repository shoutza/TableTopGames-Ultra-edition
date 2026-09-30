import type { CompiledGame } from '../engine/compile.ts';
import { attachedRuleText, describeCapabilityLoss, describeRule, describeStatus, namesFor, summarizeEffects, type Names } from '../engine/explain.ts';
import { effectiveTags, effectiveValue, hasCapability, reachableSpaces, suppressedCapabilities } from '../engine/queries.ts';
import { cloneJson } from '../engine/util.ts';
import type { ItemDef } from '../schema/definition.ts';
import type { Capability } from '../schema/rules.ts';
import type { Decision, DecisionOption, GameEvent, GameState } from '../schema/state.ts';
import { effectHints, fightHint, landingHints, type FightHint, type Hint, type HintScope } from './hints.ts';
import { HIDDEN_RULE, redactStateFor, viewGame, visibleEvents, visibleResourceIds, type VisibleEvent } from './redact.ts';

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
}

export interface ViewEntity {
  id: string;
  kind: 'contestant' | 'enemy' | 'fixture';
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
  | { kind: 'use'; optionId: string; item: string; name: string; consumed: boolean; hints: Hint[] }
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
  | { kind: 'choose'; optionId: string; option: string; label: string; hints: Hint[]; unknown: boolean };

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
  /** Rivals who could reach and attack the viewer where it stands now (main decisions and choices). */
  threatsHere: Threat[];
  decks: Array<{ id: string; name: string; drawCount: number; discardCount: number }>;
  recentEvents: VisibleEvent[];
  winners: string[] | null;
}

/** Plain-language summary of an item's bonuses, use and attached rules. */
export function describeItem(item: ItemDef, names: Names): string {
  const parts = [
    ...item.modifiers.map((m) => `${m.add >= 0 ? '+' : ''}${m.add} ${names.resource(m.resource)}`),
    ...(item.use ? [`use${item.use.consumed ? ' once' : ''}: ${summarizeEffects(item.use.effects, names)}`] : []),
    ...item.rules.filter((r) => r.visibility === 'public').map((r) => attachedRuleText(r, names)),
    ...(item.concealed ? ['others cannot see it'] : []),
  ];
  return parts.join('; ') || (item.description ?? '');
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
      const hypo = cloneJson(redacted);
      const self = hypo.entities[viewer];
      if (self) self.spaceId = option.space;
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
        const add = itemDef.modifiers.filter((m) => m.resource === core.power).reduce((s, m) => s + m.add, 0);
        if (add !== 0) powerAfter = (effectiveValue(game, redacted, me, core.power) ?? 0) + add;
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
      const defId = redacted.items[option.item]?.defId;
      const def = defId !== undefined ? game.items.get(defId) : undefined;
      const hints: Hint[] = [];
      if (def?.use) effectHints(scope, def.use.effects, { $actor: viewer, $holder: viewer, ...(here ? { $space: here } : {}) }, true, 1, def.name, hints);
      return { kind: 'use', optionId: option.id, item: option.item, name: def?.name ?? option.item, consumed: def?.use?.consumed ?? false, hints };
    }
    case 'act': {
      const action = game.actions.get(option.action);
      const hints: Hint[] = [];
      if (action) effectHints(scope, action.effects, { $actor: viewer, ...(option.target !== null ? { $target: option.target } : {}), ...(here ? { $space: here } : {}) }, true, 1, action.name, hints);
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
      name: e.name,
      spaceId: e.spaceId,
      status: e.status,
      isSelf: e.id === viewer,
      boss: e.kind === 'enemy' && game.enemies.get(e.defId)?.boss === true,
      stats,
      hiddenStats,
      tags: [...effectiveTags(game, e)],
      items: e.items.map((id) => {
        const defId = redacted.items[id]?.defId ?? '';
        const def = game.items.get(defId);
        return { id, defId, name: names.item(defId), concealed: defId === 'concealed', usable: def?.use !== undefined, text: def ? describeItem(def, names) : 'unknown' };
      }),
      statuses: e.statuses.map((s) => {
        const def = game.statuses.get(s.defId);
        return { defId: s.defId, name: def?.name ?? s.defId, icon: def?.icon, stacks: s.stacks, remaining: s.remaining, text: def ? describeStatus(def, names, s.stacks, s.remaining) : s.defId };
      }),
      suppressed: [...suppressedCapabilities(game, redacted, e)].map(([capability, by]) => ({ capability, by })),
      koTurns: e.koTurns,
      respawnRound: e.respawnRound,
      shopEntries: e.status === 'active' ? (shop?.entries ?? []).map((entry) => ({ entry: entry.id, label: names.entry(entry.id), price: entry.price.amount, priceResource: entry.price.resource })) : [],
    };
  });
  const pending = redacted.pendingDecision;
  const mine = pending !== null && pending.actor === viewer;
  const threats = mine ? threatMap(scope) : () => [];
  const decision = mine ? { ...pending, previews: pending.options.map((o) => previewOption(scope, o, pending, threats)) } : null;
  const here = redacted.entities[viewer]?.spaceId;
  const recent = visibleEvents(fullGame, history, viewer).slice(-recentLimit);
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
    threatsHere: mine && pending.kind !== 'move' && here ? threats(here) : [],
    decks: game.def.decks.map((d) => ({ id: d.id, name: d.name, drawCount: redacted.decks[d.id]?.draw.length ?? 0, discardCount: redacted.decks[d.id]?.discard.length ?? 0 })),
    recentEvents: recent,
    winners: redacted.winners,
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
