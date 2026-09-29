import type { Decision, DecisionOption, Entity, GameState } from '../schema/state.ts';
import { SAVE_FORMAT_VERSION } from '../schema/versions.ts';
import type { CompiledGame } from './compile.ts';
import type { OpContext } from './context.ts';
import { changeResource, fight, grantItem, walk } from './effects.ts';
import { activeContestantId, effectiveValue, getEntity, reachableSpaces, requireValue } from './queries.ts';
import { runOperation, runRoot, type OpOutcome } from './resolve.ts';
import { seedRng } from './rng.ts';
import { InvalidInput, RuleFault } from './util.ts';

/**
 * The fixed turn structure:
 * roundStart → (turnStart → roll → move decision → main decision → turnEnd) × contestants → roundEnd.
 */

export interface DecisionAnswer {
  decisionId: string;
  optionId: string;
  /** Optional state revision the answer was prepared against; must match if given. */
  rev?: number | undefined;
  /** Short in-character line spoken before the outcome is known. */
  say?: string | undefined;
}

export interface MatchSetup {
  matchId: string;
  seed: string;
  /** Cast member ids, in seating order. Defaults to the whole cast. */
  cast?: string[] | undefined;
}

function contestantDefaults(game: CompiledGame): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of game.def.resources) if (r.appliesTo.includes('contestant')) out[r.id] = r.default;
  return out;
}

/** Creates the initial state and runs the setup operation (turn order, fixture placement). */
export function createMatch(game: CompiledGame, setup: MatchSetup): OpOutcome {
  const castIds = setup.cast ?? game.def.cast.map((c) => c.id);
  const { core, startSpace } = game.def.settings;
  const base: GameState = {
    formatVersion: SAVE_FORMAT_VERSION,
    matchId: setup.matchId,
    definitionId: game.def.id,
    rev: 0,
    seed: setup.seed,
    rng: seedRng(setup.seed),
    counters: { entity: 0, item: 0, event: 0, decision: 0, fight: 0 },
    round: 0,
    phase: 'roundStart',
    turn: { index: 0, roll: null },
    turnOrder: [],
    entities: {},
    items: {},
    ruleCounters: {},
    pendingDecision: null,
    winners: null,
    endReason: null,
  };
  const addEntity = (e: Omit<Entity, 'id'>): string => {
    base.counters.entity += 1;
    const id = `e${base.counters.entity}`;
    base.entities[id] = { id, ...e };
    return id;
  };
  const contestants: string[] = [];
  for (const castId of castIds) {
    const member = game.cast.get(castId);
    if (!member) return { ok: false, kind: 'invalid', message: `unknown cast member "${castId}"` };
    contestants.push(
      addEntity({ kind: 'contestant', defId: member.id, name: member.name, spaceId: startSpace, resources: contestantDefaults(game), tags: [], items: [], status: 'active', respawnRound: null, koTurns: 0 }),
    );
  }
  if (contestants.length === 0) return { ok: false, kind: 'invalid', message: 'a match needs at least one contestant' };
  for (const enemy of game.def.enemies) {
    for (const space of enemy.spawns) {
      const resources: Record<string, number> = {};
      for (const r of game.def.resources) if (r.appliesTo.includes('enemy')) resources[r.id] = r.default;
      resources[core.power] = enemy.power;
      resources[core.maxHp] = enemy.maxHp;
      resources[core.hp] = enemy.maxHp;
      addEntity({ kind: 'enemy', defId: enemy.id, name: enemy.name, spaceId: space, resources, tags: [...enemy.tags], items: [], status: 'active', respawnRound: null, koTurns: 0 });
    }
  }
  return runOperation(game, base, (ctx) => {
    // Fixtures (shops, the Star Vendor) and turn order use the match RNG.
    for (const f of game.def.fixtures) {
      let space: string;
      if ('space' in f.start) space = f.start.space;
      else {
        const tag = f.start.randomSpaceTag;
        const candidates = game.spaceOrder.filter((id) => game.spaces.get(id)?.tags.includes(tag));
        if (candidates.length === 0) throw new InvalidInput(`no space tagged ${tag} for fixture ${f.id}`);
        space = candidates[ctx.random(candidates.length)] as string;
      }
      ctx.state.counters.entity += 1;
      const id = `e${ctx.state.counters.entity}`;
      ctx.state.entities[id] = { id, kind: 'fixture', defId: f.id, name: f.name, spaceId: space, resources: {}, tags: [...f.tags], items: [], status: 'active', respawnRound: null, koTurns: 0 };
    }
    const order = [...contestants];
    for (let i = order.length - 1; i > 0; i--) {
      const j = ctx.random(i + 1);
      [order[i], order[j]] = [order[j] as string, order[i] as string];
    }
    ctx.state.turnOrder = order;
    ctx.emit({ type: 'matchStarted', seed: setup.seed, turnOrder: order }, { kind: 'system' });
  });
}

export type StepKind = 'auto' | 'decision' | 'gameOver';

export function nextStepKind(state: GameState): StepKind {
  if (state.phase === 'gameOver') return 'gameOver';
  return state.pendingDecision ? 'decision' : 'auto';
}

// ---------------------------------------------------------------------------------------------
// Decisions and legal options
// ---------------------------------------------------------------------------------------------

export function moveOptions(game: CompiledGame, state: GameState, actor: Entity): DecisionOption[] {
  if (actor.spaceId === null) return [{ id: 'pass', kind: 'pass', label: 'Pass' }];
  const reach = reachableSpaces(game, actor.spaceId, state.turn.roll ?? 0);
  const order = new Map(game.spaceOrder.map((id, i) => [id, i]));
  return [...reach.entries()]
    .sort((a, b) => a[1] - b[1] || (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
    .map(([space, steps]) => ({
      id: `mv:${space}`,
      kind: 'move' as const,
      space,
      steps,
      label: steps === 0 ? `Stay at ${game.spaces.get(space)?.name ?? space}` : `Move to ${game.spaces.get(space)?.name ?? space} (${steps} step${steps === 1 ? '' : 's'})`,
    }));
}

export function mainOptions(game: CompiledGame, state: GameState, actor: Entity): DecisionOption[] {
  const { core, rest, inventoryCapacity } = game.def.settings;
  const options: DecisionOption[] = [];
  const here = actor.spaceId;
  for (const other of Object.values(state.entities)) {
    if (other.spaceId !== here || other.status !== 'active' || other.id === actor.id) continue;
    if (other.kind === 'fixture') {
      const shopId = game.fixtures.get(other.defId)?.shop;
      const shop = shopId !== undefined ? game.shops.get(shopId) : undefined;
      for (const entry of shop?.entries ?? []) {
        const funds = effectiveValue(game, state, actor, entry.price.resource);
        if (funds === undefined || funds < entry.price.amount) continue;
        if ('item' in entry.grants && actor.items.length >= inventoryCapacity) continue;
        const what = 'item' in entry.grants ? (game.items.get(entry.grants.item)?.name ?? entry.grants.item) : `${entry.grants.amount} ${game.resources.get(entry.grants.resource)?.name ?? entry.grants.resource}`;
        options.push({
          id: `buy:${other.id}:${entry.id}`,
          kind: 'buy',
          fixture: other.id,
          entry: entry.id,
          label: `Buy ${what} for ${entry.price.amount} ${game.resources.get(entry.price.resource)?.name ?? entry.price.resource}`,
        });
      }
    }
  }
  for (const other of Object.values(state.entities)) {
    if (other.kind === 'enemy' && other.status === 'active' && other.spaceId === here) {
      options.push({ id: `atk:${other.id}`, kind: 'attack', enemy: other.id, label: `Attack ${other.name}` });
    }
  }
  const hp = effectiveValue(game, state, actor, core.hp);
  const maxHp = effectiveValue(game, state, actor, core.maxHp);
  if (hp !== undefined && maxHp !== undefined && hp < maxHp && rest.heal > 0) options.push({ id: 'rest', kind: 'rest', label: `Rest (+${rest.heal} HP)` });
  options.push({ id: 'pass', kind: 'pass', label: 'Pass' });
  return options;
}

function issueDecision(ctx: OpContext, kind: 'move' | 'main'): void {
  const actorId = activeContestantId(ctx.state);
  if (actorId === null) throw new RuleFault('no active contestant');
  const actor = getEntity(ctx.state, actorId);
  ctx.state.counters.decision += 1;
  const decision: Decision = {
    id: `d${ctx.state.counters.decision}`,
    actor: actorId,
    kind,
    issuedRev: ctx.state.rev + 1,
    options: kind === 'move' ? moveOptions(ctx.game, ctx.state, actor) : mainOptions(ctx.game, ctx.state, actor),
  };
  ctx.state.pendingDecision = decision;
}

/** Re-issues the pending decision with a new id (after GM edits change what is legal). */
export function reissueDecision(ctx: OpContext): void {
  const pending = ctx.state.pendingDecision;
  if (!pending) return;
  if (ctx.koThisOp.has(pending.actor)) {
    ctx.state.pendingDecision = null;
    ctx.state.phase = 'turnEnd';
    return;
  }
  issueDecision(ctx, pending.kind);
}

// ---------------------------------------------------------------------------------------------
// Automatic phase steps
// ---------------------------------------------------------------------------------------------

export function advance(game: CompiledGame, state: GameState): OpOutcome {
  if (state.pendingDecision) return { ok: false, kind: 'invalid', message: 'a decision is pending' };
  switch (state.phase) {
    case 'roundStart':
      return runOperation(game, state, (ctx) => {
        ctx.state.round += 1;
        runRoot(ctx, () => {
          for (const e of Object.values(ctx.state.entities)) {
            if (e.kind === 'enemy' && e.status === 'defeated' && e.respawnRound !== null && e.respawnRound <= ctx.state.round) {
              const def = game.enemies.get(e.defId);
              e.status = 'active';
              e.respawnRound = null;
              e.resources[game.def.settings.core.hp] = def?.maxHp ?? e.resources[game.def.settings.core.maxHp] ?? 1;
              ctx.emit({ type: 'respawned', entity: e.id, space: e.spaceId ?? '' }, { kind: 'system' });
            }
          }
          ctx.emit({ type: 'roundStarted', round: ctx.state.round }, { kind: 'system' });
        });
        ctx.state.turn = { index: 0, roll: null };
        ctx.state.phase = 'turnStart';
      });
    case 'turnStart':
      return runOperation(game, state, (ctx) => {
        const actorId = activeContestantId(ctx.state) as string;
        const actor = getEntity(ctx.state, actorId);
        if (actor.koTurns > 0) {
          actor.koTurns -= 1;
          runRoot(ctx, () => ctx.emit({ type: 'turnSkipped', entity: actorId, reason: 'knocked out' }, { kind: 'system' }));
          ctx.state.phase = 'turnEnd';
          return;
        }
        runRoot(ctx, () => ctx.emit({ type: 'turnStarted', entity: actorId }, { kind: 'system' }));
        ctx.state.phase = ctx.koThisOp.has(actorId) ? 'turnEnd' : 'roll';
      });
    case 'roll':
      return runOperation(game, state, (ctx) => {
        const actorId = activeContestantId(ctx.state) as string;
        const sides = game.def.settings.movement.die;
        runRoot(ctx, () => {
          const value = ctx.random(sides) + 1;
          ctx.state.turn.roll = value;
          ctx.emit({ type: 'rolled', entity: actorId, sides, value }, { kind: 'system' });
        });
        ctx.state.phase = 'move';
        issueDecision(ctx, 'move');
      });
    case 'turnEnd':
      return runOperation(game, state, (ctx) => {
        const actorId = activeContestantId(ctx.state) as string;
        runRoot(ctx, () => ctx.emit({ type: 'turnEnded', entity: actorId }, { kind: 'system' }));
        ctx.state.turn.roll = null;
        if (ctx.state.turn.index + 1 < ctx.state.turnOrder.length) {
          ctx.state.turn.index += 1;
          ctx.state.phase = 'turnStart';
        } else ctx.state.phase = 'roundEnd';
      });
    case 'roundEnd':
      return runOperation(game, state, (ctx) => {
        const { core } = game.def.settings;
        runRoot(ctx, () => {
          for (const e of Object.values(ctx.state.entities)) {
            if (e.kind !== 'enemy' || e.status !== 'active') continue;
            const regen = game.enemies.get(e.defId)?.regenPerRound ?? 0;
            if (regen > 0) changeResource(ctx, e.id, core.hp, regen, { kind: 'system' });
          }
          ctx.emit({ type: 'roundEnded', round: ctx.state.round }, { kind: 'system' });
        });
        const result = checkVictory(game, ctx.state);
        if (result) {
          ctx.state.winners = result.winners;
          ctx.state.endReason = result.reason;
          ctx.state.phase = 'gameOver';
          ctx.emit({ type: 'gameOver', winners: result.winners, reason: result.reason }, { kind: 'system' });
        } else ctx.state.phase = 'roundStart';
      });
    case 'move':
    case 'main':
      return { ok: false, kind: 'invalid', message: `phase ${state.phase} needs a decision` };
    case 'gameOver':
      return { ok: false, kind: 'invalid', message: 'the game is over' };
  }
}

// ---------------------------------------------------------------------------------------------
// Answering decisions
// ---------------------------------------------------------------------------------------------

export function answerDecision(game: CompiledGame, state: GameState, answer: DecisionAnswer): OpOutcome {
  const pending = state.pendingDecision;
  if (!pending) return { ok: false, kind: 'invalid', message: 'no decision is pending' };
  if (answer.decisionId !== pending.id) return { ok: false, kind: 'invalid', message: `decision ${answer.decisionId} is not the pending decision (${pending.id})` };
  if (answer.rev !== undefined && answer.rev !== state.rev) return { ok: false, kind: 'invalid', message: `answer was prepared for revision ${answer.rev}, state is at ${state.rev}` };
  const option = pending.options.find((o) => o.id === answer.optionId);
  if (!option) return { ok: false, kind: 'invalid', message: `"${answer.optionId}" is not one of the offered options` };

  return runOperation(game, state, (ctx) => {
    const actorId = pending.actor;
    ctx.state.pendingDecision = null;
    const cause = { kind: 'action' as const, entity: actorId };
    runRoot(ctx, () => {
      ctx.emit({ type: 'decided', entity: actorId, decision: pending.id, option: option.id, label: option.label, say: answer.say }, cause);
      performOption(ctx, actorId, option, cause);
    });
    if (pending.kind === 'move') {
      if (ctx.koThisOp.has(actorId)) ctx.state.phase = 'turnEnd';
      else {
        ctx.state.phase = 'main';
        issueDecision(ctx, 'main');
      }
    } else ctx.state.phase = 'turnEnd';
  });
}

function performOption(ctx: OpContext, actorId: string, option: DecisionOption, cause: { kind: 'action'; entity: string }): void {
  const { core, rest } = ctx.game.def.settings;
  const actor = getEntity(ctx.state, actorId);
  switch (option.kind) {
    case 'move':
      walk(ctx, actorId, option.space, cause);
      return;
    case 'buy': {
      const found = ctx.game.shopEntries.get(option.entry);
      const fixture = getEntity(ctx.state, option.fixture);
      if (!found || fixture.spaceId !== actor.spaceId || fixture.status !== 'active') throw new InvalidInput('that shop is not here');
      const { entry } = found;
      const funds = requireValue(ctx.game, ctx.state, actor, entry.price.resource);
      if (funds < entry.price.amount) throw new InvalidInput('cannot afford that');
      changeResource(ctx, actorId, entry.price.resource, -entry.price.amount, cause);
      if ('item' in entry.grants) grantItem(ctx, actorId, entry.grants.item, cause);
      else changeResource(ctx, actorId, entry.grants.resource, entry.grants.amount, cause);
      ctx.emit({ type: 'purchased', entity: actorId, fixture: fixture.id, entry: entry.id, priceResource: entry.price.resource, price: entry.price.amount }, cause);
      return;
    }
    case 'attack':
      fight(ctx, actorId, option.enemy, cause);
      return;
    case 'rest': {
      const healed = changeResource(ctx, actorId, core.hp, rest.heal, cause);
      ctx.emit({ type: 'rested', entity: actorId, healed }, cause);
      return;
    }
    case 'pass':
      ctx.emit({ type: 'passed', entity: actorId }, cause);
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// Victory
// ---------------------------------------------------------------------------------------------

export function rankContestants(game: CompiledGame, state: GameState, ids: string[]): string[][] {
  const keys = game.def.settings.victory.ranking;
  const score = (id: string) => keys.map((k) => effectiveValue(game, state, getEntity(state, id), k) ?? Number.NEGATIVE_INFINITY);
  const sorted = [...ids].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < keys.length; i++) if ((sa[i] as number) !== (sb[i] as number)) return (sb[i] as number) - (sa[i] as number);
    return 0;
  });
  const groups: string[][] = [];
  for (const id of sorted) {
    const last = groups[groups.length - 1];
    if (last && score(last[0] as string).every((v, i) => v === score(id)[i])) last.push(id);
    else groups.push([id]);
  }
  return groups;
}

export function checkVictory(game: CompiledGame, state: GameState): { winners: string[]; reason: string } | null {
  const v = game.def.settings.victory;
  const resName = game.resources.get(v.resource)?.name ?? v.resource;
  const qualifiers = state.turnOrder.filter((id) => (effectiveValue(game, state, getEntity(state, id), v.resource) ?? 0) >= v.threshold);
  if (qualifiers.length > 0) {
    return { winners: rankContestants(game, state, qualifiers)[0] ?? qualifiers, reason: `reached ${v.threshold} ${resName}` };
  }
  if (state.round >= v.roundLimit) {
    return { winners: rankContestants(game, state, state.turnOrder)[0] ?? [], reason: `most ${resName} after round ${v.roundLimit}` };
  }
  return null;
}
