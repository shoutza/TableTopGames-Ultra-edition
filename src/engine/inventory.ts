import type { Entity, GameState, ItemInstance } from '../schema/state.ts';
import type { CompiledGame } from './compile.ts';

/**
 * Inventory rules. A contestant has a bag of `settings.inventoryCapacity` spaces and the equipment
 * slots of `settings.equipment`. Carried items take bag spaces — copies of a stackable item share a
 * space up to its `stackSize` — while equipped items are worn and take none. An item with a slot
 * gives its modifiers and attached rules only while equipped; items without a slot always do.
 */

/** Whether an item's modifiers and attached rules apply right now. */
export function itemActive(game: CompiledGame, item: ItemInstance): boolean {
  const def = game.items.get(item.defId);
  return def !== undefined && (def.slot === undefined || item.equipped);
}

/** Bag spaces taken by these carried item definitions (one entry per item). */
export function bagSpaces(game: CompiledGame, carried: string[]): number {
  const counts = new Map<string, number>();
  for (const d of carried) counts.set(d, (counts.get(d) ?? 0) + 1);
  let used = 0;
  for (const [d, n] of counts) used += Math.ceil(n / (game.items.get(d)?.stackSize ?? 1));
  return used;
}

/** Definitions of the items an entity carries in its bag (not equipped), optionally leaving some out. */
export function carriedDefs(state: GameState, entity: Entity, except: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (const id of entity.items) {
    const item = state.items[id];
    if (item && !item.equipped && !except.has(id)) out.push(item.defId);
  }
  return out;
}

export function bagSpacesUsed(game: CompiledGame, state: GameState, entity: Entity): number {
  return bagSpaces(game, carriedDefs(state, entity));
}

/** How many items fit in a slot (0 when the slot does not exist). */
export function slotCount(game: CompiledGame, slot: string): number {
  return game.def.settings.equipment.find((s) => s.id === slot)?.count ?? 0;
}

/** Items equipped in a slot, in inventory order. */
export function equippedIn(game: CompiledGame, state: GameState, entity: Entity, slot: string): string[] {
  return entity.items.filter((id) => {
    const item = state.items[id];
    return item?.equipped === true && game.items.get(item.defId)?.slot === slot;
  });
}

/** Where a newly received item goes: straight into a free slot, into the bag, or nowhere (no room). */
export function receivePlan(game: CompiledGame, state: GameState, entity: Entity, defId: string): 'equip' | 'bag' | null {
  const def = game.items.get(defId);
  if (!def) return null;
  if (def.slot !== undefined && equippedIn(game, state, entity, def.slot).length < slotCount(game, def.slot)) return 'equip';
  return bagSpaces(game, [...carriedDefs(state, entity), defId]) <= game.def.settings.inventoryCapacity ? 'bag' : null;
}

/** Whether the entity could receive these item definitions all at once (trades). */
export function roomForAll(game: CompiledGame, state: GameState, entity: Entity, incoming: string[], outgoing: ReadonlySet<string> = new Set()): boolean {
  const free = new Map<string, number>();
  for (const s of game.def.settings.equipment) free.set(s.id, s.count - equippedIn(game, state, entity, s.id).filter((id) => !outgoing.has(id)).length);
  const bag = carriedDefs(state, entity, outgoing);
  for (const d of incoming) {
    const slot = game.items.get(d)?.slot;
    if (slot !== undefined && (free.get(slot) ?? 0) > 0) free.set(slot, (free.get(slot) ?? 0) - 1);
    else bag.push(d);
  }
  return bagSpaces(game, bag) <= game.def.settings.inventoryCapacity;
}

/**
 * Equipping a carried item: into a free slot, or swapping with the first item worn there (which goes
 * back into the bag). Null when it cannot be equipped (no slot, or no bag room for the swapped item).
 */
export function equipPlan(game: CompiledGame, state: GameState, entity: Entity, itemId: string): { replaces: string | null } | null {
  const item = state.items[itemId];
  const slot = item ? game.items.get(item.defId)?.slot : undefined;
  if (!item || item.equipped || item.holder !== entity.id || slot === undefined) return null;
  const count = slotCount(game, slot);
  if (count === 0) return null;
  const worn = equippedIn(game, state, entity, slot);
  if (worn.length < count) return { replaces: null };
  const replaced = worn[0] as string;
  const replacedDef = state.items[replaced]?.defId;
  if (replacedDef === undefined) return null;
  const bag = [...carriedDefs(state, entity, new Set([itemId])), replacedDef];
  return bagSpaces(game, bag) <= game.def.settings.inventoryCapacity ? { replaces: replaced } : null;
}

/** Whether an equipped item can be taken off (its bag needs room for it). */
export function canUnequip(game: CompiledGame, state: GameState, entity: Entity, itemId: string): boolean {
  const item = state.items[itemId];
  if (!item?.equipped) return false;
  return bagSpaces(game, [...carriedDefs(state, entity), item.defId]) <= game.def.settings.inventoryCapacity;
}

/** Uses left for a fresh copy of an item (null when uses are not counted). */
export function initialCharges(game: CompiledGame, defId: string): number | null {
  const use = game.items.get(defId)?.use;
  return use?.consumed && use.charges !== undefined && use.charges > 1 ? use.charges : null;
}

/** Most free item actions (equip, discard, free uses) a contestant may take in one turn. */
export const MAX_FREE_ITEM_ACTIONS = 4;
