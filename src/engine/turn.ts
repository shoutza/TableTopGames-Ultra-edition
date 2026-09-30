import type { DecisionOption, Entity, EventCause, GameState, PendingChoice } from '../schema/state.ts';
import { SAVE_FORMAT_VERSION } from '../schema/versions.ts';
import type { CompiledGame } from './compile.ts';
import type { OpContext } from './context.ts';
import { actionAvailable, actionTargets, attackTargets, buyPrice, canAttemptFreeform } from './decisions.ts';
import {
  applyEffects,
  changeResource,
  countDownStatuses,
  fight,
  grantItem,
  GM,
  modify,
  queueGmRuling,
  removeItem,
  setUpDecks,
  walk,
} from './effects.ts';
import { activeContestantId, effectiveValue, getEntity, hasCapability, requireValue, suppressedCapabilities } from './queries.ts';
import { dealObjectives } from './objectives.ts';
import { runOperation, runRoot, type OpOutcome } from './resolve.ts';
import { seedRng } from './rng.ts';
import { answerTrade, breakNoAttackPromises, lapseNegotiation, payCommitment, proposeTrade, settleCommitments, type TradeOfferInput } from './trade.ts';
import { InvalidInput, RuleFault } from './util.ts';

/**
 * The fixed turn structure:
 * roundStart → (turnStart → roll → move decision → main decision → turnEnd) × contestants → roundEnd.
 * Queued choices are answered before the phase decision, each in its own operation.
 */

export interface DecisionAnswer {
  decisionId: string;
  optionId: string;
  /** Optional state revision the answer was prepared against; must match if given. */
  rev?: number | undefined;
  /** Short in-character line spoken before the outcome is known. */
  say?: string | undefined;
  /** Terms for "Propose a trade" and for a counteroffer, from the answering contestant's side. */
  trade?: TradeOfferInput | undefined;
  /** What a contestant attempts with the freeform option (≤ 200 characters). */
  attempt?: string | undefined;
}

export interface MatchSetup {
  matchId: string;
  seed: string;
  /** Cast member ids, in seating order. Defaults to the whole cast. */
  cast?: string[] | undefined;
}

function defaultsFor(game: CompiledGame, kind: Entity['kind']): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of game.def.resources) if (r.appliesTo.includes(kind)) out[r.id] = r.default;
  return out;
}

/** Creates the initial state and runs the setup operation (turn order, fixture placement, decks). */
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
    counters: { entity: 0, item: 0, event: 0, decision: 0, fight: 0, status: 0, choice: 0, objective: 0, trade: 0, commitment: 0 },
    round: 0,
    phase: 'roundStart',
    turn: { index: 0, roll: null, over: false, traded: false },
    turnOrder: [],
    entities: {},
    items: {},
    ruleCounters: {},
    cooldowns: {},
    decks: {},
    queue: [],
    objectives: [],
    negotiation: null,
    commitments: [],
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
      addEntity({ kind: 'contestant', defId: member.id, name: member.name, spaceId: startSpace, resources: defaultsFor(game, 'contestant'), tags: [], items: [], statuses: [], status: 'active', respawnRound: null, koTurns: 0 }),
    );
  }
  if (contestants.length === 0) return { ok: false, kind: 'invalid', message: 'a match needs at least one contestant' };
  for (const enemy of game.def.enemies) {
    for (const space of enemy.spawns) {
      const resources = defaultsFor(game, 'enemy');
      resources[core.power] = enemy.power;
      resources[core.maxHp] = enemy.maxHp;
      resources[core.hp] = enemy.maxHp;
      addEntity({ kind: 'enemy', defId: enemy.id, name: enemy.name, spaceId: space, resources, tags: [...enemy.tags], items: [], statuses: [], status: 'active', respawnRound: null, koTurns: 0 });
    }
  }
  return runOperation(game, base, (ctx) => {
    // Fixtures (shops, the Star Vendor), turn order and deck order use the match RNG.
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
      ctx.state.entities[id] = { id, kind: 'fixture', defId: f.id, name: f.name, spaceId: space, resources: defaultsFor(game, 'fixture'), tags: [...f.tags], items: [], statuses: [], status: 'active', respawnRound: null, koTurns: 0 };
    }
    const order = [...contestants];
    for (let i = order.length - 1; i > 0; i--) {
      const j = ctx.random(i + 1);
      [order[i], order[j]] = [order[j] as string, order[i] as string];
    }
    ctx.state.turnOrder = order;
    setUpDecks(ctx);
    ctx.emit({ type: 'matchStarted', seed: setup.seed, turnOrder: order }, { kind: 'system' });
    dealObjectives(ctx);
  });
}

export type StepKind = 'auto' | 'decision' | 'gameOver';

export function nextStepKind(state: GameState): StepKind {
  if (state.phase === 'gameOver') return 'gameOver';
  return state.pendingDecision ? 'decision' : 'auto';
}

// ---------------------------------------------------------------------------------------------
// Automatic phase steps
// ---------------------------------------------------------------------------------------------

/** Runs a queued choice's option (answered, or its default when the chooser cannot answer). */
function resolveChoice(ctx: OpContext, choice: PendingChoice, optionId: string, automatic: boolean): void {
  const option = choice.options.find((o) => o.id === optionId) ?? choice.options.find((o) => o.id === choice.default) ?? choice.options[0];
  ctx.state.queue = ctx.state.queue.filter((c) => c.id !== choice.id);
  if (!option) return;
  const cause: EventCause = { kind: 'choice', entity: choice.chooser, parent: choice.offeredSeq, ...(choice.rule !== undefined ? { rule: choice.rule } : {}) };
  const ruling = choice.chooser === GM;
  runRoot(ctx, () => {
    const made = ctx.emit({ type: 'choiceMade', entity: choice.chooser, choice: choice.id, option: option.id, label: option.label, automatic }, cause);
    // A GM ruling keeps the bindings of the rule that asked; a contestant's choice acts as the chooser.
    const chooserActive = ruling || ctx.state.entities[choice.chooser]?.status === 'active';
    if (!chooserActive) return;
    const effectCause: EventCause = { ...cause, parent: made.seq };
    const sp = ctx.savepoint();
    try {
      const { $actor: asker, ...rest } = choice.bindings;
      applyEffects(ctx, option.effects, ruling ? { ...rest, ...(asker !== undefined ? { $actor: asker } : {}) } : { ...rest, $actor: choice.chooser }, effectCause);
    } catch (err) {
      if (!(err instanceof RuleFault)) throw err;
      ctx.restore(sp);
      ctx.faults.push({ rule: choice.rule ?? `choice ${choice.id}`, message: err.message, trigger: made.seq });
      ctx.emit({ type: 'ruleFault', rule: choice.rule ?? `choice ${choice.id}`, message: err.message }, effectCause);
    }
  });
}

function skipReason(game: CompiledGame, state: GameState, actor: Entity): string | null {
  if (actor.status !== 'active') return 'out of play';
  if (actor.koTurns > 0) return 'knocked out';
  if (!hasCapability(game, state, actor, 'takesTurns')) return `cannot act (${suppressedCapabilities(game, state, actor).get('takesTurns') ?? 'status'})`;
  return null;
}

/** Hands the turn to the next contestant in the order, or ends the round after the last one. */
function passTurn(state: GameState): void {
  if (state.turn.index + 1 < state.turnOrder.length) {
    state.turn = { index: state.turn.index + 1, roll: null, over: false, traded: false };
    state.phase = 'turnStart';
  } else {
    state.turn.roll = null;
    state.phase = 'roundEnd';
  }
}

export function advance(game: CompiledGame, state: GameState): OpOutcome {
  if (state.pendingDecision) return { ok: false, kind: 'invalid', message: 'a decision is pending' };
  const queued = state.queue[0];
  if (queued) return runOperation(game, state, (ctx) => resolveChoice(ctx, queued, queued.default, true));
  if (state.negotiation) return runOperation(game, state, (ctx) => runRoot(ctx, () => lapseNegotiation(ctx)));
  switch (state.phase) {
    case 'roundStart':
      return runOperation(game, state, (ctx) => {
        ctx.state.round += 1;
        ctx.state.turn = { index: 0, roll: null, over: false, traded: false };
        runRoot(ctx, () => {
          for (const e of Object.values(ctx.state.entities)) {
            if (e.kind === 'enemy' && e.status === 'defeated' && e.respawnRound !== null && e.respawnRound <= ctx.state.round) {
              const { core } = game.def.settings;
              e.status = 'active';
              e.respawnRound = null;
              // Back at full HP: the enemy's current (effective) max HP, which the GM may have changed.
              e.resources[core.hp] = Math.max(1, effectiveValue(game, ctx.state, e, core.maxHp) ?? game.enemies.get(e.defId)?.maxHp ?? 1);
              ctx.emit({ type: 'respawned', entity: e.id, space: e.spaceId ?? '' }, { kind: 'system' });
            }
          }
          ctx.emit({ type: 'roundStarted', round: ctx.state.round }, { kind: 'system' });
        });
        ctx.state.phase = 'turnStart';
      });
    case 'turnStart':
      return runOperation(game, state, (ctx) => {
        const actorId = activeContestantId(ctx.state) as string;
        const actor = getEntity(ctx.state, actorId);
        // Eliminated contestants take no further part: no turn, no turn events, no countdowns.
        if (actor.status === 'eliminated') return passTurn(ctx.state);
        ctx.state.turn = { index: ctx.state.turn.index, roll: null, over: false, traded: false };
        const skip = skipReason(game, ctx.state, actor);
        if (skip !== null) {
          if (actor.koTurns > 0) actor.koTurns -= 1;
          runRoot(ctx, () => ctx.emit({ type: 'turnSkipped', entity: actorId, reason: skip }, { kind: 'system' }));
          ctx.state.phase = 'turnEnd';
          return;
        }
        runRoot(ctx, () => ctx.emit({ type: 'turnStarted', entity: actorId }, { kind: 'system' }));
        ctx.state.phase = ctx.state.turn.over ? 'turnEnd' : 'roll';
      });
    case 'roll':
      return runOperation(game, state, (ctx) => {
        const actorId = activeContestantId(ctx.state) as string;
        const actor = getEntity(ctx.state, actorId);
        const { die, bonus: bonusResource } = game.def.settings.movement;
        runRoot(ctx, () => {
          const value = ctx.random(die) + 1;
          const bonus = bonusResource !== undefined ? (effectiveValue(game, ctx.state, actor, bonusResource) ?? 0) : 0;
          const m = modify(ctx, 'moveRoll', { $actor: actorId, amount: value + bonus }, value + bonus, { entity: actorId });
          const total = Math.max(0, m.value);
          ctx.state.turn.roll = total;
          ctx.emit({ type: 'rolled', entity: actorId, sides: die, value, bonus, total, ...(m.mods ? { mods: m.mods } : {}) }, { kind: 'system' });
        });
        ctx.state.phase = 'move';
      });
    case 'turnEnd':
      return runOperation(game, state, (ctx) => {
        const actorId = activeContestantId(ctx.state) as string;
        if (getEntity(ctx.state, actorId).status !== 'eliminated') {
          runRoot(ctx, () => ctx.emit({ type: 'turnEnded', entity: actorId }, { kind: 'system' }));
          // Statuses count down after the turn-end reactions, so "at the end of your turn" effects of a
          // status still fire on its last turn.
          runRoot(ctx, () => countDownStatuses(ctx, actorId, { kind: 'system' }));
        }
        passTurn(ctx.state);
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
        runRoot(ctx, () => settleCommitments(ctx));
        runRoot(ctx, () => {
          for (const e of Object.values(ctx.state.entities)) if (e.kind !== 'contestant' && e.status === 'active' && e.statuses.length > 0) countDownStatuses(ctx, e.id, { kind: 'system' });
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
    const cause = { kind: 'action' as const, entity: actorId };
    if (pending.kind === 'trade') {
      const n = ctx.state.negotiation;
      if (!n || n.id !== pending.negotiation || option.kind !== 'tradeAnswer') throw new InvalidInput('that negotiation is over');
      runRoot(ctx, () => {
        // Negotiations are private to the two parties, including what they say.
        ctx.emit({ type: 'decided', entity: actorId, decision: pending.id, option: option.id, label: option.label, say: answer.say }, cause, [n.from, n.to]);
        answerTrade(ctx, actorId, option.answer, answer.trade, cause);
      });
      return;
    }
    if (pending.kind === 'choice' || pending.kind === 'ruling') {
      const choice = ctx.state.queue.find((c) => c.id === pending.choice);
      if (!choice || option.kind !== 'choose') throw new InvalidInput('that choice is no longer open');
      runRoot(ctx, () => ctx.emit({ type: 'decided', entity: actorId, decision: pending.id, option: option.id, label: option.label, say: answer.say }, cause));
      resolveChoice(ctx, choice, option.option, false);
      return;
    }
    const partner = option.kind === 'trade' ? answer.trade?.with : undefined;
    runRoot(ctx, () => {
      ctx.emit({ type: 'decided', entity: actorId, decision: pending.id, option: option.id, label: option.label, say: answer.say }, cause, partner !== undefined ? [actorId, partner] : undefined);
      performOption(ctx, actorId, option, cause, answer);
    });
    // Trading and paying debts are free actions: the main decision comes back afterwards.
    const free = option.kind === 'trade' || option.kind === 'pay';
    ctx.state.phase = pending.kind === 'move' || free ? 'main' : 'turnEnd';
  });
}

function performOption(ctx: OpContext, actorId: string, option: DecisionOption, cause: { kind: 'action'; entity: string }, answer: DecisionAnswer): void {
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
      if (!hasCapability(ctx.game, ctx.state, actor, 'shops')) throw new InvalidInput('cannot shop right now');
      const { entry } = found;
      // Price modifiers run for real now (limits counted, consumables spent); the quote was computed the same way.
      const m = modify(ctx, 'price', { $actor: actorId, amount: entry.price.amount }, entry.price.amount, { entity: actorId, resource: entry.price.resource, shopEntry: entry.id });
      const price = Math.max(0, m.value);
      const funds = requireValue(ctx.game, ctx.state, actor, entry.price.resource);
      if (funds < price) throw new InvalidInput('cannot afford that');
      if (price > 0) changeResource(ctx, actorId, entry.price.resource, -price, cause);
      if ('item' in entry.grants) grantItem(ctx, actorId, entry.grants.item, cause);
      else changeResource(ctx, actorId, entry.grants.resource, entry.grants.amount, cause);
      ctx.emit({ type: 'purchased', entity: actorId, fixture: fixture.id, entry: entry.id, priceResource: entry.price.resource, price, ...(m.mods ? { mods: m.mods } : {}) }, cause);
      return;
    }
    case 'attack':
      if (!attackTargets(ctx.game, ctx.state, actor).includes(option.target)) throw new InvalidInput('that target cannot be attacked now');
      breakNoAttackPromises(ctx, actorId, option.target, cause);
      fight(ctx, actorId, option.target, cause);
      return;
    case 'use': {
      const item = ctx.state.items[option.item];
      const def = item ? ctx.game.items.get(item.defId) : undefined;
      if (!item || item.holder !== actorId || !def?.use) throw new InvalidInput('that item cannot be used');
      if (!hasCapability(ctx.game, ctx.state, actor, 'usesItems')) throw new InvalidInput('cannot use items right now');
      ctx.emit({ type: 'itemUsed', entity: actorId, item: option.item, itemDef: def.id }, cause);
      if (def.use.consumed) removeItem(ctx, actorId, option.item, cause, 'used');
      runGuarded(ctx, def.use.effects, { $actor: actorId, $holder: actorId, ...(actor.spaceId !== null ? { $space: actor.spaceId } : {}) }, cause, `item ${def.name}`);
      return;
    }
    case 'act': {
      const action = ctx.game.actions.get(option.action);
      if (!action || !actionAvailable(ctx.game, ctx.state, actor, action)) throw new InvalidInput('that action is not available');
      if (option.target !== null && !actionTargets(ctx.game, ctx.state, actor, action).includes(option.target)) throw new InvalidInput('that target is not available');
      if (action.cost) changeResource(ctx, actorId, action.cost.resource, -action.cost.amount, cause);
      if (action.cooldownRounds !== undefined) ctx.state.cooldowns[`${action.id}:${actorId}`] = ctx.state.round + action.cooldownRounds;
      ctx.emit({ type: 'actionUsed', entity: actorId, action: action.id, target: option.target }, cause);
      runGuarded(ctx, action.effects, { $actor: actorId, ...(option.target !== null ? { $target: option.target } : {}), ...(actor.spaceId !== null ? { $space: actor.spaceId } : {}) }, cause, `action ${action.name}`);
      return;
    }
    case 'rest': {
      const healed = changeResource(ctx, actorId, core.hp, rest.heal, cause);
      ctx.emit({ type: 'rested', entity: actorId, healed }, cause);
      return;
    }
    case 'pass':
      ctx.emit({ type: 'passed', entity: actorId }, cause);
      return;
    case 'trade':
      proposeTrade(ctx, actorId, answer.trade, cause);
      return;
    case 'pay':
      payCommitment(ctx, actorId, option.commitment, cause);
      return;
    case 'freeform': {
      const text = (answer.attempt ?? '').trim().slice(0, 200);
      if (text.length === 0) throw new InvalidInput('describe what you attempt');
      if (!canAttemptFreeform(ctx.game, ctx.state, actor)) throw new InvalidInput('you cannot attempt that now');
      ctx.state.cooldowns[`freeform:${actorId}`] = ctx.state.round + Math.max(1, ctx.game.def.settings.adjudication.freeformCooldownRounds);
      const choice = queueGmRuling(ctx, `${actor.name} attempts: “${text}”`, actorId, [{ id: 'success', label: 'It works (apply the result with the GM tools first)', effects: [] }], { $actor: actorId, ...(actor.spaceId !== null ? { $space: actor.spaceId } : {}) }, cause);
      ctx.emit({ type: 'attempted', entity: actorId, text, choice }, cause);
      return;
    }
    case 'choose':
      throw new InvalidInput('choices are answered through their own decision');
    case 'tradeAnswer':
      throw new InvalidInput('trade answers belong to a trade decision');
  }
}

/** Runs authored effects (item uses, actions); a fault undoes only those effects and is reported. */
function runGuarded(ctx: OpContext, effects: Parameters<typeof applyEffects>[1], b: Parameters<typeof applyEffects>[2], cause: EventCause, label: string): void {
  const sp = ctx.savepoint();
  try {
    applyEffects(ctx, effects, b, cause);
  } catch (err) {
    if (!(err instanceof RuleFault)) throw err;
    ctx.restore(sp);
    ctx.faults.push({ rule: label, message: err.message, trigger: null });
    ctx.emit({ type: 'ruleFault', rule: label, message: err.message }, cause);
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

/**
 * Victory checkpoint (end of round): the threshold, then the round limit. Eliminated contestants
 * cannot win; in elimination mode the last contestant standing wins.
 */
export function checkVictory(game: CompiledGame, state: GameState): { winners: string[]; reason: string } | null {
  const v = game.def.settings.victory;
  const resName = game.resources.get(v.resource)?.name ?? v.resource;
  const inPlay = state.turnOrder.filter((id) => state.entities[id]?.status !== 'eliminated');
  if (game.def.settings.ko.mode === 'eliminate' && state.turnOrder.length > 1 && inPlay.length <= 1) {
    return inPlay.length === 1 ? { winners: inPlay, reason: 'last contestant standing' } : { winners: rankContestants(game, state, state.turnOrder)[0] ?? [], reason: 'everyone was eliminated' };
  }
  const qualifiers = inPlay.filter((id) => (effectiveValue(game, state, getEntity(state, id), v.resource) ?? 0) >= v.threshold);
  if (qualifiers.length > 0) {
    return { winners: rankContestants(game, state, qualifiers)[0] ?? qualifiers, reason: `reached ${v.threshold} ${resName}` };
  }
  if (state.round >= v.roundLimit) {
    return { winners: rankContestants(game, state, inPlay.length > 0 ? inPlay : state.turnOrder)[0] ?? [], reason: `most ${resName} after round ${v.roundLimit}` };
  }
  return null;
}

export { buyPrice };
