import type { Effect } from '../schema/rules.ts';
import type { EventCause } from '../schema/state.ts';
import { damageFor } from './combat.ts';
import type { OpContext } from './context.ts';
import { evalCond, evalEntityRef, evalNum, evalSelector, evalSpaceRef, type Bindings } from './eval.ts';
import { namesFor } from './explain.ts';
import { effectiveValue, getEntity, requireValue, resourceBounds, shortestPath } from './queries.ts';
import { RuleFault, clamp } from './util.ts';

/**
 * Effect primitives. Every state change goes through these functions so each one is recorded
 * as an event with its cause.
 */

export function changeResource(ctx: OpContext, entityId: string, resourceId: string, delta: number, cause: EventCause): number {
  const entity = getEntity(ctx.state, entityId);
  const before = entity.resources[resourceId];
  if (before === undefined) throw new RuleFault(`${entity.name} has no ${ctx.game.resources.get(resourceId)?.name ?? resourceId}`);
  const [min, max] = resourceBounds(ctx.game, ctx.state, entity, resourceId);
  const after = clamp(before + delta, min, max);
  if (after === before) return 0;
  entity.resources[resourceId] = after;
  ctx.emit({ type: 'resourceChanged', entity: entityId, resource: resourceId, from: before, to: after, requested: delta }, cause);
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
function clampDependents(ctx: OpContext, entityId: string, changed: string, cause: EventCause): void {
  for (const def of ctx.game.resources.values()) {
    if (def.maxFrom !== changed) continue;
    const entity = getEntity(ctx.state, entityId);
    const value = entity.resources[def.id];
    if (value === undefined) continue;
    const [, max] = resourceBounds(ctx.game, ctx.state, entity, def.id);
    if (value > max) changeResource(ctx, entityId, def.id, max - value, cause);
  }
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

export function teleport(ctx: OpContext, entityId: string, spaceId: string, asLanding: boolean, cause: EventCause): void {
  const entity = getEntity(ctx.state, entityId);
  if (!ctx.game.spaces.has(spaceId)) throw new RuleFault(`unknown space "${spaceId}"`);
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

export function grantItem(ctx: OpContext, entityId: string, itemDefId: string, cause: EventCause): boolean {
  const entity = getEntity(ctx.state, entityId);
  if (!ctx.game.items.has(itemDefId)) throw new RuleFault(`unknown item "${itemDefId}"`);
  if (entity.kind !== 'contestant') throw new RuleFault(`${entity.name} cannot hold items`);
  if (entity.items.length >= ctx.game.def.settings.inventoryCapacity) {
    ctx.emit({ type: 'announced', text: `${entity.name}'s inventory is full; ${ctx.game.items.get(itemDefId)?.name ?? itemDefId} was not received.` }, cause);
    return false;
  }
  ctx.state.counters.item += 1;
  const id = `i${ctx.state.counters.item}`;
  ctx.state.items[id] = { id, defId: itemDefId, holder: entityId };
  entity.items.push(id);
  ctx.emit({ type: 'itemGained', entity: entityId, item: id, itemDef: itemDefId }, cause);
  return true;
}

export function removeItem(ctx: OpContext, entityId: string, itemId: string, cause: EventCause): void {
  const entity = getEntity(ctx.state, entityId);
  const i = entity.items.indexOf(itemId);
  const item = ctx.state.items[itemId];
  if (i < 0 || !item) throw new RuleFault(`${entity.name} does not hold item ${itemId}`);
  entity.items.splice(i, 1);
  delete ctx.state.items[itemId];
  ctx.emit({ type: 'itemLost', entity: entityId, item: itemId, itemDef: item.defId }, cause);
}

// ---------------------------------------------------------------------------------------------
// Combat: the weighted wheel. The engine draws every spin; the UI replays the recorded spins.
// ---------------------------------------------------------------------------------------------

export function fight(ctx: OpContext, attackerId: string, defenderId: string, cause: EventCause): void {
  const { core, combat } = ctx.game.def.settings;
  const attacker = getEntity(ctx.state, attackerId);
  const defender = getEntity(ctx.state, defenderId);
  if (attackerId === defenderId) throw new RuleFault('an entity cannot fight itself');
  if (attacker.status !== 'active' || defender.status !== 'active') throw new RuleFault('both fighters must be active');
  if (attacker.kind === 'fixture' || defender.kind === 'fixture') throw new RuleFault('fixtures cannot fight');

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
    const damage = attackerWins ? attackerDamage : defenderDamage;
    const loserEntity = getEntity(ctx.state, loser);
    const hpBefore = requireValue(ctx.game, ctx.state, loserEntity, core.hp);
    const hpAfter = Math.max(0, hpBefore - damage);
    const spin = ctx.emit({ type: 'spin', fight: fightId, index, total, roll, winner, loser, damage, loserHpAfter: hpAfter }, spinCause);
    changeResource(ctx, loser, core.hp, -damage, { ...cause, parent: spin.seq });
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

/**
 * Defined defeat outcomes. Contestants are knocked out (gold loss, return to start, skip turns,
 * HP restored). Enemies grant their rewards to the victor and wait to respawn.
 */
export function handleDefeat(ctx: OpContext, entityId: string, by: string | null, fightId: number | null, cause: EventCause): void {
  const { core, ko, startSpace } = ctx.game.def.settings;
  const entity = getEntity(ctx.state, entityId);
  const defeated = ctx.emit({ type: 'defeated', entity: entityId, by, fight: fightId }, cause);
  const next: EventCause = { ...cause, parent: defeated.seq };
  if (entity.kind === 'contestant') {
    const gold = entity.resources[core.gold] ?? 0;
    const goldLost = Math.floor((gold * ko.goldLossPercent) / 100);
    if (goldLost > 0) changeResource(ctx, entityId, core.gold, -goldLost, next);
    teleport(ctx, entityId, startSpace, false, next);
    const maxHp = requireValue(ctx.game, ctx.state, getEntity(ctx.state, entityId), core.maxHp);
    setResource(ctx, entityId, core.hp, maxHp, next);
    getEntity(ctx.state, entityId).koTurns = ko.skipTurns;
    ctx.koThisOp.add(entityId);
    ctx.emit({ type: 'knockedOut', entity: entityId, goldLost, respawnSpace: startSpace, skipTurns: ko.skipTurns }, next);
    return;
  }
  if (entity.kind === 'enemy') {
    const def = ctx.game.enemies.get(entity.defId);
    entity.status = 'defeated';
    entity.respawnRound = def?.respawnAfterRounds != null ? ctx.state.round + def.respawnAfterRounds : null;
    if (def && def.rewards.length > 0 && by !== null) {
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
// Rule effects
// ---------------------------------------------------------------------------------------------

export function applyEffects(ctx: OpContext, effects: Effect[], b: Bindings, cause: EventCause): void {
  for (const e of effects) applyEffect(ctx, e, b, cause);
}

function fillTemplate(ctx: OpContext, text: string, b: Bindings): string {
  const names = namesFor(ctx.game, ctx.state);
  return text.replace(/\{(actor|target|space|amount)\}/g, (_m, key: string) => {
    if (key === 'actor' && b.$actor) return names.entity(b.$actor);
    if (key === 'target' && b.$target) return names.entity(b.$target);
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
      for (const id of targets) changeResource(ctx, id, e.resource, evalNum(ctx, e.amount, { ...b, $it: id }), cause);
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
    case 'fight': {
      // The first match on each side fights; if either side is empty there is no fight.
      const attacker = evalSelector(ctx, e.attacker, b)[0];
      const defender = evalSelector(ctx, e.defender, b)[0];
      if (attacker !== undefined && defender !== undefined && attacker !== defender) fight(ctx, attacker, defender, cause);
      return;
    }
    case 'announce':
      ctx.emit({ type: 'announced', text: fillTemplate(ctx, e.text, b) }, cause);
      return;
    case 'if':
      if (evalCond(ctx, e.cond, b)) applyEffects(ctx, e.then, b, cause);
      else if (e.else) applyEffects(ctx, e.else, b, cause);
      return;
    case 'forEach':
      for (const id of evalSelector(ctx, e.of, b)) applyEffects(ctx, e.do, { ...b, $it: id }, cause);
      return;
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
