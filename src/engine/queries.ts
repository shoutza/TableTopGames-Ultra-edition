import type { Capability } from '../schema/rules.ts';
import type { Entity, GameState } from '../schema/state.ts';
import type { CompiledGame, RuleOwner } from './compile.ts';
import { continuousEffects } from './continuous.ts';
import { RuleFault, clamp } from './util.ts';

/** Read helpers over GameState. Pure; never mutate. */

export function getEntity(state: GameState, id: string): Entity {
  const entity = state.entities[id];
  if (!entity) throw new RuleFault(`unknown entity "${id}"`);
  return entity;
}

export function activeContestantId(state: GameState): string | null {
  return state.turnOrder[state.turn.index] ?? null;
}

/** Contestants in turn order starting from the active one, then other entities by creation order. */
export function orderedEntityIds(state: GameState): string[] {
  const n = state.turnOrder.length;
  const start = n > 0 ? state.turn.index % n : 0;
  const contestants: string[] = [];
  for (let i = 0; i < n; i++) contestants.push(state.turnOrder[(start + i) % n] as string);
  const others = Object.keys(state.entities).filter((id) => state.entities[id]?.kind !== 'contestant');
  return [...contestants, ...others];
}

/** Upper bound for a resource on an entity (explicit max or another resource's effective value). */
export function resourceBounds(game: CompiledGame, state: GameState, entity: Entity, resourceId: string): [number, number] {
  const def = game.resources.get(resourceId);
  if (!def) throw new RuleFault(`unknown resource "${resourceId}"`);
  let max = def.max ?? Number.MAX_SAFE_INTEGER;
  if (def.maxFrom !== undefined) {
    const bound = effectiveValue(game, state, entity, def.maxFrom);
    if (bound !== undefined) max = Math.min(max, bound);
  }
  return [def.min, Math.max(def.min, max)];
}

/**
 * Effective value: stats add modifiers from held items, statuses (per stack) and continuous rules,
 * then clamp; pools are the stored amount. Returns undefined if the entity does not have this
 * resource (never an implicit 0).
 */
export function effectiveValue(game: CompiledGame, state: GameState, entity: Entity, resourceId: string): number | undefined {
  const base = entity.resources[resourceId];
  if (base === undefined) return undefined;
  const def = game.resources.get(resourceId);
  if (!def) return undefined;
  if (def.role === 'pool') return base;
  let total = base;
  for (const itemId of entity.items) {
    const item = state.items[itemId];
    const itemDef = item ? game.items.get(item.defId) : undefined;
    // Gear with an equipment slot counts only while worn.
    if (!item || !itemDef || (itemDef.slot !== undefined && !item.equipped)) continue;
    for (const m of itemDef.modifiers) if (m.resource === resourceId) total += m.add;
  }
  for (const s of entity.statuses) {
    const statusDef = game.statuses.get(s.defId);
    for (const m of statusDef?.modifiers ?? []) if (m.resource === resourceId) total += m.add * s.stacks;
  }
  if (game.continuous.length > 0) total += continuousEffects(game, state, entity).modifiers.get(resourceId) ?? 0;
  const max = def.max ?? Number.MAX_SAFE_INTEGER;
  return clamp(total, def.min, max);
}

export function requireValue(game: CompiledGame, state: GameState, entity: Entity, resourceId: string): number {
  const v = effectiveValue(game, state, entity, resourceId);
  if (v === undefined) throw new RuleFault(`${entity.name} has no ${game.resources.get(resourceId)?.name ?? resourceId}`);
  return v;
}

/** Base tags plus tags granted by the entity's statuses. */
export function effectiveTags(game: CompiledGame, entity: Entity): string[] {
  if (entity.statuses.length === 0) return entity.tags;
  const out = [...entity.tags];
  for (const s of entity.statuses) for (const t of game.statuses.get(s.defId)?.grantsTags ?? []) if (!out.includes(t)) out.push(t);
  return out;
}

export function hasEffectiveTag(game: CompiledGame, entity: Entity, tag: string): boolean {
  if (entity.tags.includes(tag)) return true;
  for (const s of entity.statuses) if (game.statuses.get(s.defId)?.grantsTags.includes(tag)) return true;
  return false;
}

const DEFAULT_CAPABILITIES: Record<Entity['kind'], ReadonlySet<Capability>> = {
  contestant: new Set(['takesTurns', 'moves', 'shops', 'attacks', 'attackable', 'usesItems', 'trades']),
  enemy: new Set(['attackable']),
  fixture: new Set(),
};

/** Capabilities suppressed by statuses and continuous rules, with the name of what suppresses them. */
export function suppressedCapabilities(game: CompiledGame, state: GameState, entity: Entity): Map<Capability, string> {
  const out = new Map<Capability, string>();
  for (const s of entity.statuses) {
    const def = game.statuses.get(s.defId);
    for (const c of def?.suppress ?? []) if (!out.has(c)) out.set(c, def?.name ?? s.defId);
  }
  if (game.continuous.length > 0) for (const [c, by] of continuousEffects(game, state, entity).suppress) if (!out.has(c)) out.set(c, by);
  return out;
}

export function hasCapability(game: CompiledGame, state: GameState, entity: Entity, capability: Capability): boolean {
  if (entity.status !== 'active' || !DEFAULT_CAPABILITIES[entity.kind].has(capability)) return false;
  for (const s of entity.statuses) if (game.statuses.get(s.defId)?.suppress.includes(capability)) return false;
  if (game.continuous.length > 0 && continuousEffects(game, state, entity).suppress.has(capability)) return false;
  return true;
}

export function statusOf(entity: Entity, statusId: string): Entity['statuses'][number] | undefined {
  return entity.statuses.find((s) => s.defId === statusId);
}

/** Entities an attached rule currently applies to, in stable order. */
export function holdersOf(game: CompiledGame, state: GameState, owner: RuleOwner): string[] {
  const out: string[] = [];
  for (const id of orderedEntityIds(state)) {
    const e = state.entities[id];
    if (!e || e.status !== 'active') continue;
    if (owner.kind === 'enemy') {
      if (e.kind === 'enemy' && e.defId === owner.defId) out.push(id);
    } else if (owner.kind === 'status') {
      if (e.statuses.some((s) => s.defId === owner.defId)) out.push(id);
    } else if (
      e.items.some((itemId) => {
        const item = state.items[itemId];
        // Rules on gear with a slot apply only while it is worn.
        return item?.defId === owner.defId && (item.equipped || game.items.get(owner.defId)?.slot === undefined);
      })
    )
      out.push(id);
  }
  return out;
}

/** Spaces reachable in 0..maxSteps steps, with their distance, in BFS order (stable). */
const distanceCache = new WeakMap<CompiledGame, Map<string, ReadonlyMap<string, number>>>();

/** Fewest steps from a space to every space it can reach (cached per compiled game: the board never changes). */
export function boardDistances(game: CompiledGame, from: string): ReadonlyMap<string, number> {
  let perGame = distanceCache.get(game);
  if (!perGame) {
    perGame = new Map();
    distanceCache.set(game, perGame);
  }
  const hit = perGame.get(from);
  if (hit) return hit;
  const dist = new Map<string, number>([[from, 0]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head] as string;
    const d = dist.get(cur) as number;
    for (const next of game.adjacency.get(cur) ?? []) {
      if (!dist.has(next)) {
        dist.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  perGame.set(from, dist);
  return dist;
}

/** Spaces within `maxSteps` steps (fewest steps to each). */
export function reachableSpaces(game: CompiledGame, from: string, maxSteps: number): ReadonlyMap<string, number> {
  const all = boardDistances(game, from);
  if (maxSteps >= game.spaceOrder.length) return all;
  const out = new Map<string, number>();
  for (const [space, d] of all) if (d <= maxSteps) out.set(space, d);
  return out;
}

/** Shortest path from → to (inclusive), neighbors explored in connection order. */
export function shortestPath(game: CompiledGame, from: string, to: string): string[] {
  if (from === to) return [from];
  const parent = new Map<string, string>();
  const seen = new Set([from]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head] as string;
    for (const next of game.adjacency.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      parent.set(next, cur);
      if (next === to) {
        const path = [to];
        let p = cur;
        while (p !== from) {
          path.push(p);
          p = parent.get(p) as string;
        }
        path.push(from);
        return path.reverse();
      }
      queue.push(next);
    }
  }
  throw new RuleFault(`no path from ${from} to ${to}`);
}

export function entitiesAt(state: GameState, spaceId: string): Entity[] {
  return orderedEntityIds(state)
    .map((id) => state.entities[id] as Entity)
    .filter((e) => e.spaceId === spaceId);
}
