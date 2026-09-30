import type { ChoiceOption, Effect, ModifierEvent, ModifierRule } from '../schema/rules.ts';
import type { EventCause, ModRecord, PendingChoice } from '../schema/state.ts';
import { damageFor } from './combat.ts';
import type { OpContext } from './context.ts';
import { evalCond, evalEntityRef, evalNum, evalSelector, evalSpaceRef, type Bindings } from './eval.ts';
import { namesFor } from './explain.ts';
import { canUnequip, equipPlan, initialCharges, receivePlan } from './inventory.ts';
import { computeModifiers, recordFiring, type ModifierSubject } from './modifiers.ts';
import { activeContestantId, effectiveValue, getEntity, hasCapability, requireValue, resourceBounds, shortestPath, statusOf } from './queries.ts';
import { RuleFault, clamp, cloneJson } from './util.ts';

/**
 * Effect primitives. Every state change goes through these functions so each one is recorded
 * as an event with its cause.
 */

// ---------------------------------------------------------------------------------------------
// Before-modifiers, applied: limits are counted, consumption is paid, faults are recorded.
// ---------------------------------------------------------------------------------------------

export function modify(ctx: OpContext, on: ModifierEvent, b: Bindings, value: number, subject: ModifierSubject): { value: number; prevented: boolean; mods: ModRecord[] | undefined } {
  if (!ctx.game.modifierIndex.has(on)) return { value, prevented: false, mods: undefined };
  const out = computeModifiers(ctx, on, b, value, subject);
  for (const f of out.faults) {
    ctx.faults.push({ rule: f.rule, message: f.message, trigger: null });
    ctx.emit({ type: 'ruleFault', rule: f.rule, message: f.message }, { kind: 'rule', rule: f.rule });
  }
  for (const step of out.steps) {
    recordFiring(ctx.state, step.rule, step.holder);
    const consume = (step.rule.def as ModifierRule).consume;
    if (!consume) continue;
    const cause: EventCause = { kind: 'rule', rule: step.rule.def.id };
    if ('status' in consume) {
      const who = step.holder ?? subject.entity;
      if (who !== undefined) removeStatus(ctx, who, consume.status, 1, 'consumed', cause);
    } else if (step.holder !== undefined && step.rule.owner?.kind === 'item') {
      const holder = getEntity(ctx.state, step.holder);
      const itemId = holder.items.find((id) => ctx.state.items[id]?.defId === step.rule.owner?.defId);
      if (itemId !== undefined) removeItem(ctx, step.holder, itemId, cause, 'consumed');
    }
  }
  const mods = out.steps.length > 0 ? out.steps.map((s) => ({ rule: s.rule.def.id, ...(s.holder !== undefined ? { holder: s.holder } : {}), from: s.from, to: s.to })) : undefined;
  return { value: out.value, prevented: out.prevented, mods };
}

// ---------------------------------------------------------------------------------------------
// Resources and tags
// ---------------------------------------------------------------------------------------------

/**
 * Changes a resource with clamping. With `modify`, resourceChange modifiers run first (rule
 * effects and rewards use this; payments, knockouts, damage and GM edits change exact amounts).
 */
export function changeResource(ctx: OpContext, entityId: string, resourceId: string, delta: number, cause: EventCause, opts: { modify?: boolean } = {}): number {
  const entity = getEntity(ctx.state, entityId);
  const before = entity.resources[resourceId];
  if (before === undefined) throw new RuleFault(`${entity.name} has no ${ctx.game.resources.get(resourceId)?.name ?? resourceId}`);
  let wanted = delta;
  let mods: ModRecord[] | undefined;
  if (opts.modify && delta !== 0) {
    const m = modify(ctx, 'resourceChange', { $target: entityId, amount: delta }, delta, { entity: entityId, resource: resourceId, direction: delta > 0 ? 'gain' : 'loss' });
    wanted = m.value;
    mods = m.mods;
  }
  const [min, max] = resourceBounds(ctx.game, ctx.state, entity, resourceId);
  const after = clamp(before + wanted, min, max);
  if (after === before) return 0;
  entity.resources[resourceId] = after;
  ctx.emit({ type: 'resourceChanged', entity: entityId, resource: resourceId, from: before, to: after, requested: delta, ...(mods ? { mods } : {}) }, cause);
  clampDependents(ctx, entityId, resourceId, cause);
  return after - before;
}

export function setResource(ctx: OpContext, entityId: string, resourceId: string, value: number, cause: EventCause): void {
  const entity = getEntity(ctx.state, entityId);
  const before = entity.resources[resourceId];
  if (before === undefined) throw new RuleFault(`${entity.name} has no ${ctx.game.resources.get(resourceId)?.name ?? resourceId}`);
  changeResource(ctx, entityId, resourceId, value - before, cause);
}

/** When a bound resource (e.g. max HP) drops, re-clamp resources bounded by it (e.g. HP). */
export function clampDependents(ctx: OpContext, entityId: string, changed: string, cause: EventCause): void {
  for (const def of ctx.game.resources.values()) {
    if (def.maxFrom !== changed) continue;
    const entity = getEntity(ctx.state, entityId);
    const value = entity.resources[def.id];
    if (value === undefined) continue;
    const [, max] = resourceBounds(ctx.game, ctx.state, entity, def.id);
    if (value > max) changeResource(ctx, entityId, def.id, max - value, cause);
  }
}

/** Re-clamps every bounded resource of an entity (after its modifiers changed, e.g. a status expired). */
export function clampAllDependents(ctx: OpContext, entityId: string, cause: EventCause): void {
  for (const def of ctx.game.resources.values()) if (def.maxFrom !== undefined) clampDependents(ctx, entityId, def.maxFrom, cause);
}

export function addTag(ctx: OpContext, entityId: string, tag: string, cause: EventCause): void {
  const entity = getEntity(ctx.state, entityId);
  if (!ctx.game.tags.has(tag)) throw new RuleFault(`unknown tag "${tag}"`);
  if (entity.tags.includes(tag)) return;
  entity.tags.push(tag);
  ctx.emit({ type: 'tagAdded', entity: entityId, tag }, cause);
}

export function removeTag(ctx: OpContext, entityId: string, tag: string, cause: EventCause): void {
  const entity = getEntity(ctx.state, entityId);
  const i = entity.tags.indexOf(tag);
  if (i < 0) return;
  entity.tags.splice(i, 1);
  ctx.emit({ type: 'tagRemoved', entity: entityId, tag }, cause);
}

// ---------------------------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------------------------

export function teleport(ctx: OpContext, entityId: string, spaceId: string, asLanding: boolean, cause: EventCause): void {
  const entity = getEntity(ctx.state, entityId);
  if (!ctx.game.spaces.has(spaceId)) throw new RuleFault(`unknown space "${spaceId}"`);
  if (entity.status === 'removed' || entity.status === 'eliminated') throw new RuleFault(`${entity.name} is no longer in play`);
  const from = entity.spaceId;
  if (from !== null) ctx.emit({ type: 'left', entity: entityId, space: from }, cause);
  entity.spaceId = spaceId;
  ctx.emit({ type: 'moved', entity: entityId, from, to: spaceId, path: [spaceId], mode: 'teleport' }, cause);
  ctx.emit({ type: 'entered', entity: entityId, space: spaceId, mode: 'teleport' }, cause);
  if (asLanding) ctx.emit({ type: 'landed', entity: entityId, space: spaceId }, cause);
}

/** Walks along the shortest path. `landed` fires only for walks of at least one step. */
export function walk(ctx: OpContext, entityId: string, to: string, cause: EventCause): void {
  const entity = getEntity(ctx.state, entityId);
  const from = entity.spaceId;
  if (from === null) throw new RuleFault(`${entity.name} is not on the board`);
  if (from === to) return;
  const path = shortestPath(ctx.game, from, to);
  ctx.emit({ type: 'left', entity: entityId, space: from }, cause);
  entity.spaceId = to;
  ctx.emit({ type: 'moved', entity: entityId, from, to, path, mode: 'walk' }, cause);
  ctx.emit({ type: 'entered', entity: entityId, space: to, mode: 'walk' }, cause);
  ctx.emit({ type: 'landed', entity: entityId, space: to }, cause);
}

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

export function grantItem(ctx: OpContext, entityId: string, itemDefId: string, cause: EventCause): boolean {
  const entity = getEntity(ctx.state, entityId);
  if (!ctx.game.items.has(itemDefId)) throw new RuleFault(`unknown item "${itemDefId}"`);
  if (entity.kind !== 'contestant') throw new RuleFault(`${entity.name} cannot hold items`);
  const plan = receivePlan(ctx.game, ctx.state, entity, itemDefId);
  if (plan === null) {
    ctx.emit({ type: 'announced', text: `${entity.name}'s inventory is full; ${ctx.game.items.get(itemDefId)?.name ?? itemDefId} was not received.` }, cause);
    return false;
  }
  ctx.state.counters.item += 1;
  const id = `i${ctx.state.counters.item}`;
  ctx.state.items[id] = { id, defId: itemDefId, holder: entityId, equipped: false, charges: initialCharges(ctx.game, itemDefId) };
  entity.items.push(id);
  ctx.emit({ type: 'itemGained', entity: entityId, item: id, itemDef: itemDefId }, cause);
  // Received into a free equipment slot: worn at once.
  if (plan === 'equip') setEquipped(ctx, entityId, id, true, cause);
  return true;
}

/**
 * Puts an item on (into its slot; a full slot's first item goes back into the bag) or takes it off
 * (into the bag). Refused when the slot or the bag has no room.
 */
export function setEquipped(ctx: OpContext, entityId: string, itemId: string, equipped: boolean, cause: EventCause): void {
  const entity = getEntity(ctx.state, entityId);
  const item = ctx.state.items[itemId];
  if (!item || item.holder !== entityId) throw new RuleFault(`${entity.name} does not hold item ${itemId}`);
  if (item.equipped === equipped) return;
  if (equipped) {
    const plan = equipPlan(ctx.game, ctx.state, entity, itemId);
    if (!plan) throw new RuleFault(`${ctx.game.items.get(item.defId)?.name ?? item.defId} cannot be equipped now`);
    if (plan.replaces !== null) {
      const old = ctx.state.items[plan.replaces];
      if (old) {
        old.equipped = false;
        ctx.emit({ type: 'itemEquipped', entity: entityId, item: old.id, itemDef: old.defId, equipped: false }, cause);
      }
    }
  } else if (!canUnequip(ctx.game, ctx.state, entity, itemId)) throw new RuleFault(`no room in ${entity.name}'s bag`);
  item.equipped = equipped;
  ctx.emit({ type: 'itemEquipped', entity: entityId, item: itemId, itemDef: item.defId, equipped }, cause);
  clampAllDependents(ctx, entityId, cause);
}

export function removeItem(ctx: OpContext, entityId: string, itemId: string, cause: EventCause, reason: 'removed' | 'used' | 'given' | 'lost' | 'consumed' | 'discarded' = 'removed'): void {
  const entity = getEntity(ctx.state, entityId);
  const i = entity.items.indexOf(itemId);
  const item = ctx.state.items[itemId];
  if (i < 0 || !item) throw new RuleFault(`${entity.name} does not hold item ${itemId}`);
  entity.items.splice(i, 1);
  delete ctx.state.items[itemId];
  ctx.emit({ type: 'itemLost', entity: entityId, item: itemId, itemDef: item.defId, reason }, cause);
  clampAllDependents(ctx, entityId, cause);
}

/** Picks one held item instance: a given definition, or a random one ("random"). */
function pickItem(ctx: OpContext, entityId: string, spec: string): string | undefined {
  const entity = getEntity(ctx.state, entityId);
  if (spec === 'random') return entity.items.length > 0 ? entity.items[ctx.random(entity.items.length)] : undefined;
  if (!ctx.game.items.has(spec)) throw new RuleFault(`unknown item "${spec}"`);
  return entity.items.find((id) => ctx.state.items[id]?.defId === spec);
}

/** Moves a specific held item (with its charges) to another contestant; false when it does not fit. */
export function moveItemInstance(ctx: OpContext, fromId: string, itemId: string, toId: string, cause: EventCause): boolean {
  const to = getEntity(ctx.state, toId);
  const item = ctx.state.items[itemId];
  if (!item || item.holder !== fromId) throw new RuleFault(`${getEntity(ctx.state, fromId).name} does not hold item ${itemId}`);
  if (to.kind !== 'contestant') throw new RuleFault(`${to.name} cannot hold items`);
  const plan = receivePlan(ctx.game, ctx.state, to, item.defId);
  if (plan === null) return false;
  const { defId, charges } = item;
  removeItem(ctx, fromId, itemId, cause, 'given');
  ctx.state.items[itemId] = { id: itemId, defId, holder: toId, equipped: false, charges };
  to.items.push(itemId);
  ctx.emit({ type: 'itemGained', entity: toId, item: itemId, itemDef: defId }, cause);
  if (plan === 'equip') setEquipped(ctx, toId, itemId, true, cause);
  return true;
}

/** Moves one item to another contestant. Nothing happens if there is no such item or no room. */
export function transferItem(ctx: OpContext, fromId: string, toId: string, spec: string, cause: EventCause): void {
  const to = getEntity(ctx.state, toId);
  if (to.kind !== 'contestant') throw new RuleFault(`${to.name} cannot hold items`);
  if (fromId === toId) return;
  const itemId = pickItem(ctx, fromId, spec);
  if (itemId === undefined) return;
  const item = ctx.state.items[itemId];
  if (!item) return;
  const defId = item.defId;
  const plan = receivePlan(ctx.game, ctx.state, to, defId);
  if (plan === null) {
    ctx.emit({ type: 'announced', text: `${to.name}'s inventory is full; nothing changed hands.` }, cause);
    return;
  }
  const charges = item.charges;
  removeItem(ctx, fromId, itemId, cause, 'given');
  ctx.state.items[itemId] = { id: itemId, defId, holder: toId, equipped: false, charges };
  to.items.push(itemId);
  ctx.emit({ type: 'itemGained', entity: toId, item: itemId, itemDef: defId }, cause);
  if (plan === 'equip') setEquipped(ctx, toId, itemId, true, cause);
}

// ---------------------------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------------------------

/** True while the entity's own turn is in progress (a status applied now skips its first countdown). */
function inOwnTurn(ctx: OpContext, entityId: string): boolean {
  const entity = ctx.state.entities[entityId];
  if (!entity) return false;
  if (entity.kind !== 'contestant') return ctx.state.phase !== 'roundEnd';
  const phase = ctx.state.phase;
  return activeContestantId(ctx.state) === entityId && (phase === 'turnStart' || phase === 'roll' || phase === 'move' || phase === 'main' || phase === 'turnEnd');
}

export function applyStatus(ctx: OpContext, entityId: string, statusId: string, stacks: number, durationOverride: number | undefined, cause: EventCause, source?: string): void {
  const def = ctx.game.statuses.get(statusId);
  if (!def) throw new RuleFault(`unknown status "${statusId}"`);
  const entity = getEntity(ctx.state, entityId);
  if (entity.status !== 'active') return;
  const baseDuration = durationOverride ?? def.duration;
  const m = modify(ctx, 'statusApply', { $target: entityId, ...(source !== undefined ? { $actor: source } : {}), amount: baseDuration ?? 1 }, baseDuration ?? 1, { entity: entityId, status: statusId });
  if (m.prevented || (baseDuration !== null && m.value <= 0)) {
    ctx.emit({ type: 'statusPrevented', entity: entityId, status: statusId, mods: m.mods ?? [] }, cause);
    return;
  }
  const duration = baseDuration === null ? null : m.value;
  const existing = statusOf(entity, statusId);
  const fresh = inOwnTurn(ctx, entityId);
  if (!existing) {
    // One transformation at a time: turning into a frog ends Fish Form.
    if (def.transformation) {
      for (const other of [...entity.statuses]) if (ctx.game.statuses.get(other.defId)?.transformation) removeStatus(ctx, entityId, other.defId, 'all', 'removed', cause);
    }
    ctx.state.counters.status += 1;
    const inst = { id: `s${ctx.state.counters.status}`, defId: statusId, stacks: Math.min(def.maxStacks, Math.max(1, stacks)), remaining: duration, fresh };
    entity.statuses.push(inst);
    ctx.emit({ type: 'statusApplied', entity: entityId, status: statusId, stacks: inst.stacks, remaining: inst.remaining, ...(m.mods ? { mods: m.mods } : {}) }, cause);
    return;
  }
  switch (def.stacking) {
    case 'ignore':
      return;
    case 'refresh':
      existing.remaining = duration;
      break;
    case 'extend':
      existing.remaining = existing.remaining === null || duration === null ? null : existing.remaining + duration;
      break;
    case 'stack':
      existing.stacks = Math.min(def.maxStacks, existing.stacks + Math.max(1, stacks));
      existing.remaining = duration;
      break;
  }
  existing.fresh = existing.fresh || fresh;
  ctx.emit({ type: 'statusApplied', entity: entityId, status: statusId, stacks: existing.stacks, remaining: existing.remaining, ...(m.mods ? { mods: m.mods } : {}) }, cause);
}

/** Removes some stacks (or all) of a status. */
export function removeStatus(ctx: OpContext, entityId: string, statusId: string, stacks: number | 'all', reason: 'expired' | 'removed' | 'consumed', cause: EventCause): void {
  const entity = getEntity(ctx.state, entityId);
  const inst = statusOf(entity, statusId);
  if (!inst) return;
  const removed = stacks === 'all' ? inst.stacks : Math.min(inst.stacks, stacks);
  inst.stacks -= removed;
  if (inst.stacks <= 0) entity.statuses = entity.statuses.filter((s) => s !== inst);
  ctx.emit({ type: 'statusRemoved', entity: entityId, status: statusId, stacks: removed, left: Math.max(0, inst.stacks), reason }, cause);
  clampAllDependents(ctx, entityId, cause);
}

/** One tick of every status on the entity (end of its turn; for enemies and fixtures, end of round). */
export function countDownStatuses(ctx: OpContext, entityId: string, cause: EventCause): void {
  const entity = getEntity(ctx.state, entityId);
  for (const inst of [...entity.statuses]) {
    if (inst.fresh) {
      inst.fresh = false;
      continue;
    }
    if (inst.remaining === null) continue;
    inst.remaining -= 1;
    if (inst.remaining <= 0) removeStatus(ctx, entityId, inst.defId, 'all', 'expired', cause);
  }
}

// ---------------------------------------------------------------------------------------------
// Damage and combat: the weighted wheel. The engine draws every spin; the UI replays them.
// ---------------------------------------------------------------------------------------------

/** HP loss through damage modifiers. Returns the damage dealt. */
export function dealDamage(ctx: OpContext, targetId: string, sourceId: string | null, base: number, cause: EventCause): number {
  const { hp } = ctx.game.def.settings.core;
  const target = getEntity(ctx.state, targetId);
  if (target.status !== 'active' || target.resources[hp] === undefined) return 0;
  const start = Math.max(0, base);
  const m = modify(ctx, 'damage', { $target: targetId, ...(sourceId !== null ? { $actor: sourceId } : {}), amount: start }, start, { entity: targetId });
  const amount = Math.max(0, m.value);
  if (amount > 0) changeResource(ctx, targetId, hp, -amount, cause);
  ctx.emit({ type: 'damaged', entity: targetId, by: sourceId, amount, base: start, ...(m.mods ? { mods: m.mods } : {}) }, cause);
  return amount;
}

export function fight(ctx: OpContext, attackerId: string, defenderId: string, cause: EventCause): void {
  const { core, combat } = ctx.game.def.settings;
  const attacker = getEntity(ctx.state, attackerId);
  const defender = getEntity(ctx.state, defenderId);
  if (attackerId === defenderId) throw new RuleFault('an entity cannot fight itself');
  if (attacker.status !== 'active' || defender.status !== 'active') throw new RuleFault('both fighters must be active');
  if (attacker.kind === 'fixture' || defender.kind === 'fixture') throw new RuleFault('fixtures cannot fight');
  if (!hasCapability(ctx.game, ctx.state, defender, 'attackable')) {
    ctx.emit({ type: 'fightPrevented', attacker: attackerId, defender: defenderId, reason: `${defender.name} cannot be attacked right now` }, cause);
    return;
  }

  const attackerPower = requireValue(ctx.game, ctx.state, attacker, core.power);
  const defenderPower = requireValue(ctx.game, ctx.state, defender, core.power);
  const attackerDamage = damageFor(attackerPower, defenderPower, combat.damage);
  const defenderDamage = damageFor(defenderPower, attackerPower, combat.damage);
  ctx.state.counters.fight += 1;
  const fightId = ctx.state.counters.fight;
  const started = ctx.emit(
    {
      type: 'fightStarted',
      fight: fightId,
      attacker: attackerId,
      defender: defenderId,
      attackerPower,
      defenderPower,
      attackerHp: requireValue(ctx.game, ctx.state, attacker, core.hp),
      defenderHp: requireValue(ctx.game, ctx.state, defender, core.hp),
      attackerDamage,
      defenderDamage,
      maxSpins: combat.maxSpinsPerFight,
    },
    cause,
  );
  const spinCause: EventCause = { ...cause, parent: started.seq };
  const total = attackerPower + defenderPower;
  let loserDown: string | null = null;
  let winnerOfFight: string | null = null;
  for (let index = 1; index <= combat.maxSpinsPerFight; index++) {
    const roll = ctx.random(total);
    const attackerWins = roll < attackerPower;
    const winner = attackerWins ? attackerId : defenderId;
    const loser = attackerWins ? defenderId : attackerId;
    const base = attackerWins ? attackerDamage : defenderDamage;
    const m = modify(ctx, 'damage', { $actor: winner, $target: loser, amount: base }, base, { entity: loser });
    const damage = Math.max(0, m.value);
    const hpBefore = requireValue(ctx.game, ctx.state, getEntity(ctx.state, loser), core.hp);
    const hpAfter = Math.max(0, hpBefore - damage);
    const spin = ctx.emit({ type: 'spin', fight: fightId, index, total, roll, winner, loser, damage, loserHpAfter: hpAfter, ...(m.mods ? { mods: m.mods } : {}) }, spinCause);
    const hitCause: EventCause = { ...cause, parent: spin.seq };
    if (damage > 0) changeResource(ctx, loser, core.hp, -damage, hitCause);
    ctx.emit({ type: 'damaged', entity: loser, by: winner, amount: damage, base, ...(m.mods ? { mods: m.mods } : {}) }, hitCause);
    if (requireValue(ctx.game, ctx.state, getEntity(ctx.state, loser), core.hp) <= 0) {
      loserDown = loser;
      winnerOfFight = winner;
      break;
    }
  }
  const aHp = requireValue(ctx.game, ctx.state, getEntity(ctx.state, attackerId), core.hp);
  const dHp = requireValue(ctx.game, ctx.state, getEntity(ctx.state, defenderId), core.hp);
  ctx.emit(
    {
      type: 'fightEnded',
      fight: fightId,
      outcome: loserDown === null ? 'bothStanding' : winnerOfFight === attackerId ? 'attackerWon' : 'defenderWon',
      attackerHp: aHp,
      defenderHp: dHp,
    },
    spinCause,
  );
  if (loserDown !== null) handleDefeat(ctx, loserDown, winnerOfFight, fightId, spinCause);
}

/** Ends the active contestant's turn if it is knocked out or eliminated while the turn is in progress. */
function endTurnIfActive(ctx: OpContext, entityId: string): void {
  const phase = ctx.state.phase;
  if (activeContestantId(ctx.state) === entityId && (phase === 'turnStart' || phase === 'roll' || phase === 'move' || phase === 'main')) ctx.state.turn.over = true;
}

/**
 * Defined defeat outcomes. Contestants are knocked out (gold loss — to the victor if a contestant
 * won the fight — return to start, skip turns, HP restored) or, in elimination mode, leave the
 * match. Enemies grant their rewards to the victor and wait to respawn.
 */
export function handleDefeat(ctx: OpContext, entityId: string, by: string | null, fightId: number | null, cause: EventCause): void {
  const { core, ko, startSpace } = ctx.game.def.settings;
  const entity = getEntity(ctx.state, entityId);
  const defeated = ctx.emit({ type: 'defeated', entity: entityId, by, fight: fightId }, cause);
  const next: EventCause = { ...cause, parent: defeated.seq };
  if (entity.kind === 'contestant') {
    endTurnIfActive(ctx, entityId);
    if (ko.mode === 'eliminate') {
      const from = entity.spaceId;
      entity.status = 'eliminated';
      entity.spaceId = null;
      entity.statuses = [];
      if (from !== null) ctx.emit({ type: 'left', entity: entityId, space: from }, next);
      ctx.emit({ type: 'eliminated', entity: entityId }, next);
      return;
    }
    const gold = entity.resources[core.gold] ?? 0;
    const goldLost = Math.floor((gold * ko.goldLossPercent) / 100);
    if (goldLost > 0) changeResource(ctx, entityId, core.gold, -goldLost, next);
    const victor = by !== null ? ctx.state.entities[by] : undefined;
    const lootTo = goldLost > 0 && ko.lootToVictor && victor?.kind === 'contestant' && victor.status === 'active' ? victor.id : null;
    if (lootTo !== null) changeResource(ctx, lootTo, core.gold, goldLost, next);
    teleport(ctx, entityId, startSpace, false, next);
    if (ko.clearStatuses) for (const inst of [...getEntity(ctx.state, entityId).statuses]) removeStatus(ctx, entityId, inst.defId, 'all', 'removed', next);
    const maxHp = requireValue(ctx.game, ctx.state, getEntity(ctx.state, entityId), core.maxHp);
    setResource(ctx, entityId, core.hp, maxHp, next);
    getEntity(ctx.state, entityId).koTurns = ko.skipTurns;
    ctx.emit({ type: 'knockedOut', entity: entityId, goldLost, lootTo, respawnSpace: startSpace, skipTurns: ko.skipTurns }, next);
    return;
  }
  if (entity.kind === 'enemy') {
    const def = ctx.game.enemies.get(entity.defId);
    entity.status = 'defeated';
    entity.statuses = [];
    entity.respawnRound = def?.respawnAfterRounds != null ? ctx.state.round + def.respawnAfterRounds : null;
    if (def && def.rewards.length > 0 && by !== null && ctx.state.entities[by]?.status === 'active') {
      const rewardCause: EventCause = { kind: 'reward', entity: entityId, parent: defeated.seq };
      const sp = ctx.savepoint();
      try {
        applyEffects(ctx, def.rewards, { $actor: by, $target: entityId }, rewardCause);
      } catch (err) {
        if (!(err instanceof RuleFault)) throw err;
        ctx.restore(sp);
        ctx.emit({ type: 'ruleFault', rule: `rewards of ${def.name}`, message: err.message }, rewardCause);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Spawning and removal
// ---------------------------------------------------------------------------------------------

export function spawnEnemy(ctx: OpContext, enemyDefId: string, spaceId: string, cause: EventCause): string {
  const def = ctx.game.enemies.get(enemyDefId);
  if (!def) throw new RuleFault(`unknown enemy "${enemyDefId}"`);
  if (!ctx.game.spaces.has(spaceId)) throw new RuleFault(`unknown space "${spaceId}"`);
  ctx.countSpawn();
  const { core } = ctx.game.def.settings;
  const resources: Record<string, number> = {};
  for (const r of ctx.game.def.resources) if (r.appliesTo.includes('enemy')) resources[r.id] = r.default;
  resources[core.power] = def.power;
  resources[core.maxHp] = def.maxHp;
  resources[core.hp] = def.maxHp;
  ctx.state.counters.entity += 1;
  const id = `e${ctx.state.counters.entity}`;
  ctx.state.entities[id] = { id, kind: 'enemy', defId: def.id, name: def.name, spaceId, resources, tags: [...def.tags], items: [], statuses: [], status: 'active', respawnRound: null, koTurns: 0 };
  ctx.emit({ type: 'spawned', entity: id, enemy: def.id, space: spaceId, boss: def.boss }, cause);
  return id;
}

/** Takes an enemy or fixture off the board for good; it stays in history as a tombstone. */
export function removeEntity(ctx: OpContext, entityId: string, cause: EventCause): void {
  const entity = getEntity(ctx.state, entityId);
  if (entity.kind === 'contestant') throw new RuleFault('contestants cannot be removed from the board');
  if (entity.status === 'removed') return;
  entity.status = 'removed';
  entity.spaceId = null;
  entity.statuses = [];
  entity.respawnRound = null;
  ctx.emit({ type: 'removed', entity: entityId }, cause);
}

// ---------------------------------------------------------------------------------------------
// Decks and choices
// ---------------------------------------------------------------------------------------------

function shuffle(ctx: OpContext, list: string[]): string[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = ctx.random(i + 1);
    [out[i], out[j]] = [out[j] as string, out[i] as string];
  }
  return out;
}

/** Builds and shuffles every deck (match setup). */
export function setUpDecks(ctx: OpContext): void {
  for (const deck of ctx.game.def.decks) {
    const cards: string[] = [];
    for (const card of deck.cards) for (let i = 0; i < card.count; i++) cards.push(card.id);
    ctx.state.decks[deck.id] = { draw: shuffle(ctx, cards), discard: [] };
  }
}

export function drawCard(ctx: OpContext, deckId: string, forId: string, cause: EventCause): void {
  const pile = ctx.state.decks[deckId];
  const deck = ctx.game.decks.get(deckId);
  if (!pile || !deck) throw new RuleFault(`unknown deck "${deckId}"`);
  const drawer = getEntity(ctx.state, forId);
  if (pile.draw.length === 0 && pile.discard.length > 0) {
    pile.draw = shuffle(ctx, pile.discard);
    pile.discard = [];
    ctx.emit({ type: 'deckShuffled', deck: deckId, size: pile.draw.length }, cause);
  }
  const cardId = pile.draw.shift();
  if (cardId === undefined) throw new RuleFault(`${deck.name} is empty`);
  pile.discard.push(cardId);
  const card = ctx.game.cards.get(cardId)?.card;
  if (!card) throw new RuleFault(`unknown card "${cardId}"`);
  const drawn = ctx.emit({ type: 'cardDrawn', entity: forId, deck: deckId, card: cardId, name: card.name }, cause);
  const cardCause: EventCause = { kind: 'card', card: cardId, entity: forId, parent: drawn.seq };
  const sp = ctx.savepoint();
  try {
    applyEffects(ctx, card.effects, { $actor: forId, ...(drawer.spaceId !== null ? { $space: drawer.spaceId } : {}) }, cardCause);
  } catch (err) {
    if (!(err instanceof RuleFault)) throw err;
    ctx.restore(sp);
    ctx.faults.push({ rule: `card:${cardId}`, message: err.message, trigger: drawn.seq });
    ctx.emit({ type: 'ruleFault', rule: `card:${cardId}`, message: err.message }, cardCause);
  }
}

/** Queues a choice. It is answered in its own later operation, after this one commits. */
export function offerChoice(ctx: OpContext, e: Extract<Effect, { op: 'offerChoice' }>, b: Bindings, cause: EventCause): void {
  const chooserId = evalEntityRef(ctx, e.to, b);
  const chooser = getEntity(ctx.state, chooserId);
  if (chooser.kind !== 'contestant') throw new RuleFault(`${chooser.name} cannot make choices`);
  if (chooser.status !== 'active') return;
  ctx.countChoice();
  ctx.state.counters.choice += 1;
  const id = `c${ctx.state.counters.choice}`;
  const withChooser: Bindings = { ...b, $actor: chooserId };
  const prompt = fillTemplate(ctx, e.prompt, withChooser);
  const options = e.options.map((o) => ({ ...o, label: fillTemplate(ctx, o.label, withChooser) }));
  const offered = ctx.emit({ type: 'choiceOffered', entity: chooserId, choice: id, prompt, options: options.map((o) => o.label) }, cause);
  const saved: PendingChoice['bindings'] = {};
  if (b.$target !== undefined) saved.$target = b.$target;
  if (b.$space !== undefined) saved.$space = b.$space;
  if (b.$it !== undefined) saved.$it = b.$it;
  if (b.$holder !== undefined) saved.$holder = b.$holder;
  if (b.amount !== undefined) saved.amount = b.amount;
  ctx.state.queue.push({
    id,
    chooser: chooserId,
    prompt,
    options: cloneJson(options),
    default: e.default,
    bindings: saved,
    offeredSeq: offered.seq,
    ...(cause.rule !== undefined ? { rule: cause.rule } : {}),
  });
}

/** The GM's own "chooser" id for rulings. */
export const GM = 'gm';

/**
 * Queues a ruling for the GM: the authored options plus "No effect" (the default, also used when the
 * GM does not answer in time). Effects of the chosen option run with the asking rule's bindings.
 */
export function queueGmRuling(ctx: OpContext, question: string, about: string | null, options: ChoiceOption[], b: Bindings, cause: EventCause): string {
  ctx.countChoice();
  ctx.state.counters.choice += 1;
  const id = `c${ctx.state.counters.choice}`;
  const all = [...options.filter((o) => o.id !== 'none'), { id: 'none', label: 'No effect', effects: [] }];
  const asked = ctx.emit({ type: 'gmAsked', choice: id, question, about }, cause);
  const saved: PendingChoice['bindings'] = {};
  if (b.$actor !== undefined) saved.$actor = b.$actor;
  if (b.$target !== undefined) saved.$target = b.$target;
  if (b.$space !== undefined) saved.$space = b.$space;
  if (b.$it !== undefined) saved.$it = b.$it;
  if (b.$holder !== undefined) saved.$holder = b.$holder;
  if (b.amount !== undefined) saved.amount = b.amount;
  ctx.state.queue.push({
    id,
    chooser: GM,
    prompt: question,
    options: cloneJson(all),
    default: 'none',
    bindings: saved,
    offeredSeq: asked.seq,
    ...(cause.rule !== undefined ? { rule: cause.rule } : {}),
  });
  return id;
}

// ---------------------------------------------------------------------------------------------
// Rule effects
// ---------------------------------------------------------------------------------------------

export function applyEffects(ctx: OpContext, effects: Effect[], b: Bindings, cause: EventCause): void {
  for (const e of effects) applyEffect(ctx, e, b, cause);
}

export function fillTemplate(ctx: OpContext, text: string, b: Bindings): string {
  const names = namesFor(ctx.game, ctx.state);
  return text.replace(/\{(actor|target|space|amount|holder)\}/g, (_m, key: string) => {
    if (key === 'actor' && b.$actor) return names.entity(b.$actor);
    if (key === 'target' && b.$target) return names.entity(b.$target);
    if (key === 'holder' && b.$holder) return names.entity(b.$holder);
    if (key === 'space' && b.$space) return names.space(b.$space);
    if (key === 'amount' && b.amount !== undefined) return String(b.amount);
    return `{${key}}`;
  });
}

export function applyEffect(ctx: OpContext, e: Effect, b: Bindings, cause: EventCause): void {
  ctx.step();
  switch (e.op) {
    case 'changeResource': {
      const targets = evalSelector(ctx, e.target, b);
      for (const id of targets) changeResource(ctx, id, e.resource, evalNum(ctx, e.amount, { ...b, $it: id }), cause, { modify: true });
      return;
    }
    case 'setResource': {
      for (const id of evalSelector(ctx, e.target, b)) setResource(ctx, id, e.resource, evalNum(ctx, e.value, { ...b, $it: id }), cause);
      return;
    }
    case 'transfer': {
      const from = evalEntityRef(ctx, e.from, b);
      const to = evalEntityRef(ctx, e.to, b);
      const wanted = Math.max(0, evalNum(ctx, e.amount, b));
      const fromEntity = getEntity(ctx.state, from);
      const available = fromEntity.resources[e.resource];
      if (available === undefined) throw new RuleFault(`${fromEntity.name} has no ${ctx.game.resources.get(e.resource)?.name ?? e.resource}`);
      const [min] = resourceBounds(ctx.game, ctx.state, fromEntity, e.resource);
      const canGive = Math.max(0, available - min);
      if (canGive < wanted && e.ifShort === 'skip') return;
      const moved = -changeResource(ctx, from, e.resource, -Math.min(wanted, canGive), cause);
      if (moved > 0) changeResource(ctx, to, e.resource, moved, cause);
      return;
    }
    case 'addTag':
      for (const id of evalSelector(ctx, e.target, b)) addTag(ctx, id, e.tag, cause);
      return;
    case 'removeTag':
      for (const id of evalSelector(ctx, e.target, b)) removeTag(ctx, id, e.tag, cause);
      return;
    case 'teleport': {
      const targets = evalSelector(ctx, e.target, b);
      for (const id of targets) teleport(ctx, id, evalSpaceRef(ctx, e.to, { ...b, $it: id }), e.asLanding === true, cause);
      return;
    }
    case 'grantItem': {
      const target = evalEntityRef(ctx, e.target, b);
      for (let i = 0; i < (e.count ?? 1); i++) grantItem(ctx, target, e.item, cause);
      return;
    }
    case 'transferItem':
      transferItem(ctx, evalEntityRef(ctx, e.from, b), evalEntityRef(ctx, e.to, b), e.item, cause);
      return;
    case 'loseItem': {
      const target = evalEntityRef(ctx, e.target, b);
      const itemId = pickItem(ctx, target, e.item);
      if (itemId !== undefined) removeItem(ctx, target, itemId, cause, 'lost');
      return;
    }
    case 'fight': {
      // The first match on each side fights; if either side is empty there is no fight.
      const attacker = evalSelector(ctx, e.attacker, b)[0];
      const defender = evalSelector(ctx, e.defender, b)[0];
      if (attacker !== undefined && defender !== undefined && attacker !== defender) fight(ctx, attacker, defender, cause);
      return;
    }
    case 'damage': {
      for (const id of evalSelector(ctx, e.target, b)) dealDamage(ctx, id, b.$actor ?? null, evalNum(ctx, e.amount, { ...b, $it: id }), cause);
      return;
    }
    case 'applyStatus':
      for (const id of evalSelector(ctx, e.target, b)) applyStatus(ctx, id, e.status, e.stacks ?? 1, e.duration, cause, b.$actor);
      return;
    case 'removeStatus':
      for (const id of evalSelector(ctx, e.target, b)) removeStatus(ctx, id, e.status, e.stacks ?? 'all', 'removed', cause);
      return;
    case 'spawn': {
      const space = evalSpaceRef(ctx, e.at, b);
      for (let i = 0; i < (e.count ?? 1); i++) spawnEnemy(ctx, e.enemy, space, cause);
      return;
    }
    case 'remove':
      for (const id of evalSelector(ctx, e.target, b)) removeEntity(ctx, id, cause);
      return;
    case 'drawCard':
      drawCard(ctx, e.deck, evalEntityRef(ctx, e.for, b), cause);
      return;
    case 'offerChoice':
      offerChoice(ctx, e, b, cause);
      return;
    case 'announce':
      ctx.emit({ type: 'announced', text: fillTemplate(ctx, e.text, b) }, cause);
      return;
    case 'askGm': {
      const about = e.about !== undefined ? evalEntityRef(ctx, e.about, b) : null;
      queueGmRuling(ctx, fillTemplate(ctx, e.question, b), about, e.options ?? [], b, cause);
      return;
    }
    case 'if':
      if (evalCond(ctx, e.cond, b)) applyEffects(ctx, e.then, b, cause);
      else if (e.else) applyEffects(ctx, e.else, b, cause);
      return;
    case 'forEach': {
      const ids = evalSelector(ctx, e.of, b);
      ctx.countLoopIterations(ids.length);
      for (const id of ids) applyEffects(ctx, e.do, { ...b, $it: id }, cause);
      return;
    }
    case 'randomBranch': {
      const total = e.branches.reduce((s, br) => s + br.weight, 0);
      let r = ctx.random(total);
      for (const br of e.branches) {
        if (r < br.weight) {
          applyEffects(ctx, br.do, b, cause);
          return;
        }
        r -= br.weight;
      }
      return;
    }
  }
}

export { effectiveValue };
