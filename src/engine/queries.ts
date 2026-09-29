import type { Entity, GameState } from '../schema/state.ts';
import type { CompiledGame } from './compile.ts';
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
 * Effective value: stats add modifiers from held items; pools are the stored amount.
 * Returns undefined if the entity does not have this resource (never an implicit 0).
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
    for (const m of itemDef?.modifiers ?? []) if (m.resource === resourceId) total += m.add;
  }
  const max = def.max ?? Number.MAX_SAFE_INTEGER;
  return clamp(total, def.min, max);
}

export function requireValue(game: CompiledGame, state: GameState, entity: Entity, resourceId: string): number {
  const v = effectiveValue(game, state, entity, resourceId);
  if (v === undefined) throw new RuleFault(`${entity.name} has no ${game.resources.get(resourceId)?.name ?? resourceId}`);
  return v;
}

/** Spaces reachable in 0..maxSteps steps, with their distance, in BFS order (stable). */
export function reachableSpaces(game: CompiledGame, from: string, maxSteps: number): Map<string, number> {
  const dist = new Map<string, number>([[from, 0]]);
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    const d = dist.get(cur) as number;
    if (d >= maxSteps) continue;
    for (const next of game.adjacency.get(cur) ?? []) {
      if (!dist.has(next)) {
        dist.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  return dist;
}

/** Shortest path from → to (inclusive), neighbors explored in connection order. */
export function shortestPath(game: CompiledGame, from: string, to: string): string[] {
  if (from === to) return [from];
  const parent = new Map<string, string>();
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
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
