import type { Commitment, DecisionOption, EventCause, GameState, Goods, Negotiation, PromiseTerm, TradeTerms, TradeTermsView } from '../schema/state.ts';
import type { GoodsInput, PromiseInput, TradeOfferInput } from '../schema/trade.ts';
import type { CompiledGame } from './compile.ts';
import type { OpContext } from './context.ts';
import { changeResource, removeItem } from './effects.ts';
import { effectiveValue, getEntity, hasCapability } from './queries.ts';
import { InvalidInput } from './util.ts';

/**
 * Trading and promises. A trade is negotiated in steps, each its own decision and operation:
 * offer (a free action of the active contestant, once per turn) → the partner accepts, rejects or
 * makes one counteroffer → the proposer accepts or rejects the counteroffer. Acceptance re-checks
 * that both sides can still deliver, then swaps everything at once. Promises attached to a trade
 * are tracked (kept / broken) but never enforced.
 */

export type { GoodsInput, PromiseInput, TradeOfferInput } from '../schema/trade.ts';

export const TRADE_LIMITS = { resourceKinds: 3, items: 3, messageLength: 200, payAmount: 99 } as const;

function resName(game: CompiledGame, id: string): string {
  return game.resources.get(id)?.name ?? id;
}

function itemName(game: CompiledGame, id: string): string {
  return game.items.get(id)?.name ?? id;
}

export function isTradeableResource(game: CompiledGame, id: string): boolean {
  return game.resources.get(id)?.tradeable === true;
}

export function isTradeableItem(game: CompiledGame, defId: string): boolean {
  const def = game.items.get(defId);
  return def !== undefined && def.tradeable && !def.concealed;
}

/** Whether anything in this game can change hands at all. */
export function gameHasTradeables(game: CompiledGame): boolean {
  return game.def.resources.some((r) => r.tradeable) || game.def.items.some((i) => i.tradeable && !i.concealed);
}

/** Contestants the actor could trade with right now. */
export function tradePartners(game: CompiledGame, state: GameState, actorId: string): string[] {
  return state.turnOrder.filter((id) => {
    const e = state.entities[id];
    return id !== actorId && e !== undefined && e.status === 'active' && hasCapability(game, state, e, 'trades');
  });
}

/** The "Propose a trade" option is offered during the main decision, once per turn. */
export function canProposeTrade(game: CompiledGame, state: GameState, actorId: string): boolean {
  const actor = state.entities[actorId];
  if (!actor || actor.status !== 'active' || !game.def.settings.trading.enabled || state.turn.traded || state.negotiation !== null) return false;
  if (!hasCapability(game, state, actor, 'trades') || !gameHasTradeables(game)) return false;
  return tradePartners(game, state, actorId).length > 0;
}

function who(state: GameState, id: string, you: string): { name: string; has: string; does: string } {
  if (id === you) return { name: 'you', has: 'have', does: 'do' };
  return { name: state.entities[id]?.name ?? id, has: 'has', does: 'does' };
}

/** Resolves goods written with item definition ids into the holder's item instances, checking holdings. */
function resolveGoods(game: CompiledGame, state: GameState, holderId: string, author: string, spec: GoodsInput | undefined): Goods {
  const holder = getEntity(state, holderId);
  const w = who(state, holderId, author);
  const resources: Record<string, number> = {};
  const entries = Object.entries(spec?.resources ?? {}).filter(([, amount]) => amount !== 0);
  if (entries.length > TRADE_LIMITS.resourceKinds) throw new InvalidInput(`at most ${TRADE_LIMITS.resourceKinds} kinds of resources per side`);
  for (const [res, amount] of entries) {
    if (!isTradeableResource(game, res)) throw new InvalidInput(`${resName(game, res)} cannot be traded`);
    if (!Number.isInteger(amount) || amount < 1) throw new InvalidInput('amounts must be whole numbers of at least 1');
    const have = effectiveValue(game, state, holder, res) ?? 0;
    if (have < amount) throw new InvalidInput(`${w.name} ${w.has} only ${have} ${resName(game, res)}`);
    resources[res] = amount;
  }
  const wanted = spec?.items ?? [];
  if (wanted.length > TRADE_LIMITS.items) throw new InvalidInput(`at most ${TRADE_LIMITS.items} items per side`);
  const items: string[] = [];
  for (const defId of wanted) {
    if (!game.items.has(defId)) throw new InvalidInput(`unknown item "${defId}"`);
    if (!isTradeableItem(game, defId)) throw new InvalidInput(`${itemName(game, defId)} cannot be traded`);
    const found = holder.items.find((id) => state.items[id]?.defId === defId && !items.includes(id));
    if (found === undefined) throw new InvalidInput(`${w.name} ${w.does} not have ${wanted.filter((x) => x === defId).length > 1 ? 'that many' : 'a'} ${itemName(game, defId)}`);
    items.push(found);
  }
  return { resources, items };
}

function resolvePromises(game: CompiledGame, promises: PromiseInput[] | undefined, authorIsFrom: boolean): PromiseTerm[] {
  const list = promises ?? [];
  const max = game.def.settings.trading.maxPromiseRounds;
  if (list.length > 0 && max === 0) throw new InvalidInput('this game has no promises');
  if (list.filter((p) => p.by === 'me').length > 1 || list.filter((p) => p.by === 'them').length > 1) throw new InvalidInput('at most one promise per side');
  return list.map((p): PromiseTerm => {
    if (!Number.isInteger(p.rounds) || p.rounds < 1 || p.rounds > max) throw new InvalidInput(`a promise lasts 1 to ${max} rounds`);
    const by = (p.by === 'me') === authorIsFrom ? 'from' : 'to';
    if (p.kind === 'noAttack') {
      if (!game.def.settings.combat.pvp) throw new InvalidInput('contestants cannot attack each other in this game');
      return { kind: 'noAttack', by, rounds: p.rounds };
    }
    if (!isTradeableResource(game, p.resource)) throw new InvalidInput(`${resName(game, p.resource)} cannot be promised`);
    if (!Number.isInteger(p.amount) || p.amount < 1 || p.amount > TRADE_LIMITS.payAmount) throw new InvalidInput(`a payment promise is 1 to ${TRADE_LIMITS.payAmount}`);
    return { kind: 'pay', by, resource: p.resource, amount: p.amount, rounds: p.rounds };
  });
}

function isEmpty(g: Goods): boolean {
  return Object.keys(g.resources).length === 0 && g.items.length === 0;
}

/** Items each side would hold afterwards must fit in its inventory. */
function capacityProblem(game: CompiledGame, state: GameState, terms: TradeTerms, from: string, to: string, author: string): string | null {
  const cap = game.def.settings.inventoryCapacity;
  for (const [id, gives, gets] of [
    [from, terms.give.items.length, terms.get.items.length],
    [to, terms.get.items.length, terms.give.items.length],
  ] as const) {
    const held = state.entities[id]?.items.length ?? 0;
    if (held - gives + gets > cap) {
      const w = who(state, id, author);
      return `${w.name} cannot carry that many items`;
    }
  }
  return null;
}

/**
 * Canonical terms (proposer's side) from an offer written by `author`. Throws InvalidInput with a
 * message that only mentions what both parties can see.
 */
export function termsFromOffer(game: CompiledGame, state: GameState, from: string, to: string, author: string, offer: TradeOfferInput): TradeTerms {
  const authorIsFrom = author === from;
  const other = authorIsFrom ? to : from;
  const mine = resolveGoods(game, state, author, author, offer.give);
  const theirs = resolveGoods(game, state, other, author, offer.get);
  const promises = resolvePromises(game, offer.promises, authorIsFrom);
  const terms: TradeTerms = authorIsFrom ? { give: mine, get: theirs, promises } : { give: theirs, get: mine, promises };
  if (isEmpty(terms.give) && isEmpty(terms.get) && promises.length === 0) throw new InvalidInput('a trade needs something to change hands');
  const cap = capacityProblem(game, state, terms, from, to, author);
  if (cap) throw new InvalidInput(cap);
  return terms;
}

/** Why the terms cannot be carried out now (holdings changed, full inventory), or null. */
export function deliveryProblem(game: CompiledGame, state: GameState, terms: TradeTerms, from: string, to: string): string | null {
  for (const [id, goods] of [
    [from, terms.give],
    [to, terms.get],
  ] as const) {
    const e = state.entities[id];
    if (!e || e.status !== 'active') return 'one party is out of play';
    for (const [res, amount] of Object.entries(goods.resources)) if ((effectiveValue(game, state, e, res) ?? 0) < amount) return 'one party could not deliver';
    for (const item of goods.items) if (state.items[item]?.holder !== id) return 'one party could not deliver';
  }
  return capacityProblem(game, state, terms, from, to, '') === null ? null : 'one party cannot carry that many items';
}

export function termsView(state: GameState, terms: TradeTerms): TradeTermsView {
  const goods = (g: Goods) => ({ resources: { ...g.resources }, items: g.items.map((i) => state.items[i]?.defId ?? i) });
  return { give: goods(terms.give), get: goods(terms.get), promises: terms.promises.map((p) => ({ ...p })) };
}

// ---------------------------------------------------------------------------------------------
// Negotiation steps
// ---------------------------------------------------------------------------------------------

/** Who must answer the open negotiation. */
export function awaitingParty(n: Negotiation): string {
  return n.stage === 'response' ? n.to : n.from;
}

/** Options for the party who must answer, or null when it cannot answer (the offer lapses). */
export function negotiationOptions(game: CompiledGame, state: GameState, n: Negotiation): DecisionOption[] | null {
  const actorId = awaitingParty(n);
  const actor = state.entities[actorId];
  if (!actor || actor.status !== 'active' || !hasCapability(game, state, actor, 'trades')) return null;
  const options: DecisionOption[] = [];
  if (deliveryProblem(game, state, n.terms, n.from, n.to) === null) options.push({ id: 'tr:accept', kind: 'tradeAnswer', answer: 'accept', label: n.stage === 'response' ? 'Accept the offer' : 'Accept the counteroffer' });
  options.push({ id: 'tr:reject', kind: 'tradeAnswer', answer: 'reject', label: n.stage === 'response' ? 'Reject the offer' : 'Reject the counteroffer' });
  if (n.stage === 'response') options.push({ id: 'tr:counter', kind: 'tradeAnswer', answer: 'counter', label: 'Make a counteroffer' });
  return options;
}

function clipMessage(m: string | null | undefined): string | null {
  if (m === null || m === undefined) return null;
  const t = m.trim();
  if (t.length === 0) return null;
  return t.length > TRADE_LIMITS.messageLength ? `${t.slice(0, TRADE_LIMITS.messageLength - 1)}…` : t;
}

export function proposeTrade(ctx: OpContext, actorId: string, offer: TradeOfferInput | undefined, cause: EventCause): void {
  const { game, state } = ctx;
  if (!offer) throw new InvalidInput('a trade proposal needs terms');
  if (!canProposeTrade(game, state, actorId)) throw new InvalidInput('you cannot propose a trade now');
  const partner = offer.with;
  if (partner === undefined || !tradePartners(game, state, actorId).includes(partner)) throw new InvalidInput('choose another contestant in play to trade with');
  const terms = termsFromOffer(game, state, actorId, partner, actorId, offer);
  state.counters.trade += 1;
  const id = `t${state.counters.trade}`;
  const message = clipMessage(offer.message);
  state.turn.traded = true;
  const ev = ctx.emit({ type: 'tradeProposed', negotiation: id, from: actorId, to: partner, terms: termsView(state, terms), message }, cause, [actorId, partner]);
  state.negotiation = { id, from: actorId, to: partner, terms, stage: 'response', message, original: null, proposedSeq: ev.seq };
}

function moveItem(ctx: OpContext, itemId: string, fromId: string, toId: string, cause: EventCause): void {
  const defId = ctx.state.items[itemId]?.defId;
  if (defId === undefined) return;
  removeItem(ctx, fromId, itemId, cause, 'given');
  ctx.state.items[itemId] = { id: itemId, defId, holder: toId };
  getEntity(ctx.state, toId).items.push(itemId);
  ctx.emit({ type: 'itemGained', entity: toId, item: itemId, itemDef: defId }, cause);
}

function executeTrade(ctx: OpContext, n: Negotiation, cause: EventCause): void {
  const { state } = ctx;
  const parties = [n.from, n.to];
  const problem = deliveryProblem(ctx.game, state, n.terms, n.from, n.to);
  if (problem) {
    ctx.emit({ type: 'tradeFailed', negotiation: n.id, from: n.from, to: n.to, reason: problem }, cause, parties);
    return;
  }
  const done = ctx.emit({ type: 'tradeCompleted', negotiation: n.id, from: n.from, to: n.to, terms: termsView(state, n.terms) }, cause);
  const inner: EventCause = { ...cause, parent: done.seq };
  // Items first leave both inventories, then arrive, so a swap never overflows a full inventory.
  const outgoing = [...n.terms.give.items.map((i) => [i, n.from, n.to] as const), ...n.terms.get.items.map((i) => [i, n.to, n.from] as const)];
  for (const [item, a, b] of outgoing) moveItem(ctx, item, a, b, inner);
  for (const [goods, a, b] of [
    [n.terms.give, n.from, n.to],
    [n.terms.get, n.to, n.from],
  ] as const) {
    for (const [res, amount] of Object.entries(goods.resources)) {
      changeResource(ctx, a, res, -amount, inner);
      changeResource(ctx, b, res, amount, inner);
    }
  }
  for (const p of n.terms.promises) {
    state.counters.commitment += 1;
    const by = p.by === 'from' ? n.from : n.to;
    const to = p.by === 'from' ? n.to : n.from;
    const c: Commitment = {
      id: `p${state.counters.commitment}`,
      by,
      to,
      kind: p.kind,
      resource: p.kind === 'pay' ? p.resource : null,
      amount: p.kind === 'pay' ? p.amount : 0,
      paid: 0,
      dueRound: state.round + p.rounds,
      status: 'open',
      trade: n.id,
    };
    state.commitments.push(c);
    ctx.emit({ type: 'promiseMade', commitment: c.id, by, to, kind: c.kind, resource: c.resource, amount: c.amount, dueRound: c.dueRound }, inner);
  }
}

/** Accept, reject or counter the open negotiation (the answering party is the decision's actor). */
export function answerTrade(ctx: OpContext, actorId: string, answer: 'accept' | 'reject' | 'counter', offer: TradeOfferInput | undefined, cause: EventCause): void {
  const n = ctx.state.negotiation;
  if (!n || awaitingParty(n) !== actorId) throw new InvalidInput('there is no offer waiting for you');
  const parties = [n.from, n.to];
  switch (answer) {
    case 'accept':
      ctx.state.negotiation = null;
      executeTrade(ctx, n, cause);
      return;
    case 'reject':
      ctx.state.negotiation = null;
      ctx.emit({ type: 'tradeRejected', negotiation: n.id, from: n.from, to: n.to, by: actorId, automatic: false }, cause, parties);
      return;
    case 'counter': {
      if (n.stage !== 'response') throw new InvalidInput('only one counteroffer is allowed');
      if (!offer) throw new InvalidInput('a counteroffer needs terms');
      const terms = termsFromOffer(ctx.game, ctx.state, n.from, n.to, actorId, offer);
      const message = clipMessage(offer.message);
      ctx.state.negotiation = { ...n, original: n.terms, terms, stage: 'final', message };
      ctx.emit({ type: 'tradeCountered', negotiation: n.id, from: n.from, to: n.to, terms: termsView(ctx.state, terms), message }, cause, parties);
      return;
    }
  }
}

/** The party who had to answer can no longer do so: the offer lapses. */
export function lapseNegotiation(ctx: OpContext): void {
  const n = ctx.state.negotiation;
  if (!n) return;
  ctx.state.negotiation = null;
  ctx.emit({ type: 'tradeRejected', negotiation: n.id, from: n.from, to: n.to, by: awaitingParty(n), automatic: true }, { kind: 'system' }, [n.from, n.to]);
}

// ---------------------------------------------------------------------------------------------
// Promises
// ---------------------------------------------------------------------------------------------

function remaining(c: Commitment): number {
  return Math.max(0, c.amount - c.paid);
}

/** "Pay what you promised" options: open payment promises the actor can afford in full. */
export function payOptions(game: CompiledGame, state: GameState, actorId: string): DecisionOption[] {
  const actor = state.entities[actorId];
  if (!actor) return [];
  return state.commitments
    .filter((c) => c.by === actorId && c.kind === 'pay' && c.status === 'open' && c.resource !== null && (effectiveValue(game, state, actor, c.resource) ?? 0) >= remaining(c))
    .map((c) => ({
      id: `pay:${c.id}`,
      kind: 'pay' as const,
      commitment: c.id,
      label: `Pay ${state.entities[c.to]?.name ?? c.to} ${remaining(c)} ${resName(game, c.resource ?? '')} (as promised)`,
    }));
}

export function payCommitment(ctx: OpContext, actorId: string, commitmentId: string, cause: EventCause): void {
  const c = ctx.state.commitments.find((x) => x.id === commitmentId);
  if (!c || c.by !== actorId || c.kind !== 'pay' || c.status !== 'open' || c.resource === null) throw new InvalidInput('there is no such payment to make');
  const owed = remaining(c);
  if ((effectiveValue(ctx.game, ctx.state, getEntity(ctx.state, actorId), c.resource) ?? 0) < owed) throw new InvalidInput('you cannot afford that payment');
  changeResource(ctx, actorId, c.resource, -owed, cause);
  changeResource(ctx, c.to, c.resource, owed, cause);
  c.paid = c.amount;
  c.status = 'kept';
  ctx.emit({ type: 'promiseKept', commitment: c.id, by: c.by, to: c.to, kind: c.kind }, cause);
}

/** A voluntary attack breaks any open no-attack promise the attacker made to the defender. */
export function breakNoAttackPromises(ctx: OpContext, attacker: string, defender: string, cause: EventCause): void {
  for (const c of ctx.state.commitments) {
    if (c.status !== 'open' || c.kind !== 'noAttack' || c.by !== attacker || c.to !== defender) continue;
    c.status = 'broken';
    ctx.emit({ type: 'promiseBroken', commitment: c.id, by: c.by, to: c.to, kind: c.kind }, cause);
  }
}

/**
 * End of round: promises due this round are settled (no attack happened → kept; unpaid → broken).
 * Promises involving an eliminated contestant lapse quietly.
 */
export function settleCommitments(ctx: OpContext): void {
  for (const c of ctx.state.commitments) {
    if (c.status !== 'open') continue;
    if (ctx.state.entities[c.by]?.status === 'eliminated' || ctx.state.entities[c.to]?.status === 'eliminated') {
      c.status = 'void';
      continue;
    }
    if (c.dueRound > ctx.state.round) continue;
    c.status = c.kind === 'noAttack' ? 'kept' : 'broken';
    ctx.emit({ type: c.status === 'kept' ? 'promiseKept' : 'promiseBroken', commitment: c.id, by: c.by, to: c.to, kind: c.kind }, { kind: 'system' });
  }
}

/** Open promises the given contestant has made (for views and the fallback player). */
export function openCommitments(state: GameState, by?: string): Commitment[] {
  return state.commitments.filter((c) => c.status === 'open' && (by === undefined || c.by === by));
}

