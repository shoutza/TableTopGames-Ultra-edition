import type { CompiledGame } from '../engine/compile.ts';
import { attachedRuleText, describeObjectiveGoal, describeStatus, makeNames, summarizeEffects, summarizeRule } from '../engine/explain.ts';
import type { Effect } from '../schema/rules.ts';
import type { Settings } from '../schema/definition.ts';
import { describeItem } from './view.ts';

/**
 * The public rulebook: everything every contestant may know about the game definition.
 * Hidden rules and hidden statuses are excluded here, so nothing downstream can accidentally
 * reveal them. Deck contents are public (their order is not).
 */
export interface PublicGameInfo {
  name: string;
  description: string;
  settings: Pick<Settings, 'core' | 'startSpace' | 'movement' | 'inventoryCapacity' | 'rest' | 'combat' | 'ko' | 'victory' | 'objectives' | 'trading'>;
  resources: Array<{ id: string; name: string; role: 'pool' | 'stat'; visibility: 'public' | 'owner' | 'gm'; icon: string | undefined; tradeable: boolean }>;
  tags: Array<{ id: string; name: string }>;
  spaces: Array<{ id: string; name: string; tags: string[]; description: string | undefined }>;
  items: Array<{ id: string; name: string; modifiers: Array<{ resource: string; add: number }>; concealed: boolean; usable: boolean; tradeable: boolean; text: string }>;
  statuses: Array<{
    id: string;
    name: string;
    icon: string | undefined;
    text: string;
    transformation: boolean;
    duration: number | null;
    modifiers: Array<{ resource: string; add: number }>;
    suppress: string[];
    /** Carries a public rule that prevents damage to its holder (a shield). */
    shields: boolean;
    /** Carries a public rule that damages or drains its holder (poison, burning). */
    harmful: boolean;
  }>;
  shops: Array<{ id: string; name: string; entries: Array<{ id: string; label: string; price: number; priceResource: string; grantsItem: string | null; grantsResource: string | null; grantsAmount: number }> }>;
  enemies: Array<{
    id: string;
    name: string;
    power: number;
    maxHp: number;
    regenPerRound: number;
    respawnAfterRounds: number | null;
    boss: boolean;
    rewards: Effect[];
    rewardsText: string;
    rulesText: string[];
    description: string | undefined;
  }>;
  decks: Array<{ id: string; name: string; description: string | undefined; size: number; cards: Array<{ id: string; name: string; count: number; text: string }> }>;
  actions: Array<{ id: string; name: string; text: string }>;
  /** The pool secret objectives are dealt from (public, like a deck list; who holds which is secret). */
  objectives: Array<{ id: string; name: string; text: string; reward: string }>;
  rules: Array<{ id: string; name: string; kind: 'reaction' | 'modifier' | 'continuous'; text: string; trigger: string | null; spaceTag: string | undefined }>;
}

function describeRuleText(rule: Parameters<typeof attachedRuleText>[0], names: ReturnType<typeof makeNames>): string {
  return summarizeRule(rule, names);
}

/** True when effects damage or drain the entity holding the rule's status (poison, burning). */
function hurtsHolder(effects: Effect[]): boolean {
  return effects.some((e) => {
    switch (e.op) {
      case 'damage':
        return e.target === '$holder';
      case 'changeResource':
        return e.target === '$holder' && (typeof e.amount === 'number' ? e.amount < 0 : e.amount.op === 'sub' && e.amount.a === 0);
      case 'if':
        return hurtsHolder(e.then) || hurtsHolder(e.else ?? []);
      case 'forEach':
        return hurtsHolder(e.do);
      case 'randomBranch':
        return e.branches.some((b) => hurtsHolder(b.do));
      default:
        return false;
    }
  });
}

export function publicInfo(game: CompiledGame): PublicGameInfo {
  const names = makeNames(game, () => undefined);
  const s = game.def.settings;
  return {
    name: game.def.name,
    description: game.def.description,
    settings: { core: s.core, startSpace: s.startSpace, movement: s.movement, inventoryCapacity: s.inventoryCapacity, rest: s.rest, combat: s.combat, ko: s.ko, victory: s.victory, objectives: s.objectives, trading: s.trading },
    resources: game.def.resources.filter((r) => r.visibility !== 'gm').map((r) => ({ id: r.id, name: r.name, role: r.role, visibility: r.visibility, icon: r.icon, tradeable: r.tradeable })),
    tags: game.def.tags.map((t) => ({ id: t.id, name: t.name })),
    spaces: game.def.spaces.map((sp) => ({ id: sp.id, name: sp.name, tags: sp.tags, description: sp.description })),
    items: game.def.items.map((i) => ({ id: i.id, name: i.name, modifiers: i.modifiers, concealed: i.concealed, usable: i.use !== undefined, tradeable: i.tradeable && !i.concealed, text: describeItem(i, names) })),
    statuses: game.def.statuses
      .filter((st) => st.visibility === 'public')
      .map((st) => {
        const rules = st.rules.filter((r) => r.visibility === 'public');
        return {
          id: st.id,
          name: st.name,
          icon: st.icon,
          text: describeStatus({ ...st, rules }, names),
          transformation: st.transformation,
          duration: st.duration,
          modifiers: st.modifiers,
          suppress: st.suppress,
          shields: rules.some((r) => r.kind === 'modifier' && r.on === 'damage' && (r.modify.op === 'prevent' || (r.modify.op === 'add' && typeof r.modify.amount === 'number' && r.modify.amount < 0))),
          harmful: rules.some((r) => r.kind === 'reaction' && hurtsHolder(r.effects)),
        };
      }),
    shops: game.def.shops.map((shop) => ({
      id: shop.id,
      name: shop.name,
      entries: shop.entries.map((e) => ({
        id: e.id,
        label: names.entry(e.id),
        price: e.price.amount,
        priceResource: e.price.resource,
        grantsItem: 'item' in e.grants ? e.grants.item : null,
        grantsResource: 'resource' in e.grants ? e.grants.resource : null,
        grantsAmount: 'resource' in e.grants ? e.grants.amount : 0,
      })),
    })),
    enemies: game.def.enemies.map((e) => ({
      id: e.id,
      name: e.name,
      power: e.power,
      maxHp: e.maxHp,
      regenPerRound: e.regenPerRound,
      respawnAfterRounds: e.respawnAfterRounds,
      boss: e.boss,
      rewards: e.rewards,
      rewardsText: summarizeEffects(e.rewards, names),
      rulesText: e.rules.filter((r) => r.visibility === 'public' && r.enabled).map((r) => `${r.name}: ${attachedRuleText(r, names).replaceAll("the holder's", 'its').replaceAll('the holder', 'it')}.`),
      description: e.description,
    })),
    decks: game.def.decks.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      size: d.cards.reduce((sum, c) => sum + c.count, 0),
      cards: d.cards.map((c) => ({ id: c.id, name: c.name, count: c.count, text: summarizeEffects(c.effects, names) })),
    })),
    actions: game.def.actions.map((a) => {
      const where = a.where?.space !== undefined ? ` at ${names.space(a.where.space)}` : a.where?.spaceTag !== undefined ? ` on a ${names.tag(a.where.spaceTag)} space` : '';
      const cost = a.cost ? `, costs ${a.cost.amount} ${names.resource(a.cost.resource)}` : '';
      const target = a.target ? `, targets ${a.target.range === 'here' ? `a ${a.target.kind} on your space` : `any ${a.target.kind}`}` : '';
      const cooldown = a.cooldownRounds !== undefined ? `, usable again after ${a.cooldownRounds} round${a.cooldownRounds === 1 ? '' : 's'}` : '';
      return { id: a.id, name: a.name, text: `main action${where}${cost}${target}${cooldown}: ${summarizeEffects(a.effects, names)}` };
    }),
    objectives: game.def.objectives.map((o) => ({ id: o.id, name: o.name, text: describeObjectiveGoal(o, names), reward: summarizeEffects(o.reward, names) })),
    rules: [...game.rules.values()]
      .filter((r) => r.def.enabled && r.def.visibility === 'public' && r.owner === null)
      .map((r) => ({
        id: r.def.id,
        name: r.def.name,
        kind: r.def.kind,
        text: describeRuleText(r.def, names),
        trigger: r.def.kind === 'reaction' ? r.def.trigger.event : null,
        spaceTag: r.def.kind === 'reaction' ? r.def.trigger.where?.spaceTag : undefined,
      })),
  };
}
