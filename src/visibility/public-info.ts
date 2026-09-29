import type { CompiledGame } from '../engine/compile.ts';
import { describeEffects, describeRule, makeNames } from '../engine/explain.ts';
import type { Effect } from '../schema/rules.ts';
import type { Settings } from '../schema/definition.ts';

/**
 * The public rulebook: everything every contestant may know about the game definition.
 * Hidden rules are excluded here, so nothing downstream can accidentally reveal them.
 */
export interface PublicGameInfo {
  name: string;
  description: string;
  settings: Pick<Settings, 'core' | 'startSpace' | 'movement' | 'inventoryCapacity' | 'rest' | 'combat' | 'ko' | 'victory'>;
  resources: Array<{ id: string; name: string; role: 'pool' | 'stat'; visibility: 'public' | 'owner' | 'gm'; icon: string | undefined }>;
  tags: Array<{ id: string; name: string }>;
  spaces: Array<{ id: string; name: string; tags: string[]; description: string | undefined }>;
  items: Array<{ id: string; name: string; modifiers: Array<{ resource: string; add: number }> }>;
  shops: Array<{ id: string; name: string; entries: Array<{ id: string; label: string; price: number; priceResource: string; grantsItem: string | null; grantsResource: string | null; grantsAmount: number }> }>;
  enemies: Array<{ id: string; name: string; power: number; maxHp: number; regenPerRound: number; respawnAfterRounds: number | null; rewards: Effect[]; rewardsText: string; description: string | undefined }>;
  rules: Array<{ id: string; name: string; text: string; trigger: string; spaceTag: string | undefined }>;
}

export function publicInfo(game: CompiledGame): PublicGameInfo {
  const names = makeNames(game, () => undefined);
  const s = game.def.settings;
  return {
    name: game.def.name,
    description: game.def.description,
    settings: { core: s.core, startSpace: s.startSpace, movement: s.movement, inventoryCapacity: s.inventoryCapacity, rest: s.rest, combat: s.combat, ko: s.ko, victory: s.victory },
    resources: game.def.resources.filter((r) => r.visibility !== 'gm').map((r) => ({ id: r.id, name: r.name, role: r.role, visibility: r.visibility, icon: r.icon })),
    tags: game.def.tags.map((t) => ({ id: t.id, name: t.name })),
    spaces: game.def.spaces.map((sp) => ({ id: sp.id, name: sp.name, tags: sp.tags, description: sp.description })),
    items: game.def.items.map((i) => ({ id: i.id, name: i.name, modifiers: i.modifiers })),
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
      rewards: e.rewards,
      rewardsText: describeEffects(e.rewards, names, {}),
      description: e.description,
    })),
    rules: [...game.rules.values()]
      .filter((r) => r.def.enabled && r.def.visibility === 'public')
      .map((r) => ({ id: r.def.id, name: r.def.name, text: describeRule(r.def, names), trigger: r.def.trigger.event, spaceTag: r.def.trigger.where?.spaceTag })),
  };
}
