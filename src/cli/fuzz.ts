import { advance, answerDecision, applyGmCommand, createMatch, effectiveValue, nextStepKind, type CompiledGame, type OpOutcome } from '../engine/index.ts';
import { resourceBounds } from '../engine/queries.ts';
import { GmCommandSchema, type GmCommandInput } from '../schema/commands.ts';
import type { TradeOfferInput } from '../schema/trade.ts';
import { GameStateSchema, type GameState } from '../schema/state.ts';
import { stateHash } from '../server/hash.ts';

/**
 * Fuzzing: random (but seeded) decisions — including random trade terms and counteroffers — mixed
 * with random GM commands. After every operation the state must satisfy the invariants below; the
 * engine may refuse an input ("invalid") but must never throw, and a replay of the same inputs
 * must reach the same state.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Problems with a state, empty when all invariants hold. */
export function checkInvariants(game: CompiledGame, state: GameState): string[] {
  const out: string[] = [];
  const parsed = GameStateSchema.safeParse(state);
  if (!parsed.success) out.push(`schema: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  for (const [id, item] of Object.entries(state.items)) {
    const holder = state.entities[item.holder];
    if (!holder) out.push(`item ${id} held by missing ${item.holder}`);
    else if (!holder.items.includes(id)) out.push(`item ${id} not in ${holder.id}'s inventory`);
  }
  for (const e of Object.values(state.entities)) {
    for (const id of e.items) if (state.items[id]?.holder !== e.id) out.push(`${e.id} lists item ${id} it does not hold`);
    if (new Set(e.items).size !== e.items.length) out.push(`${e.id} lists an item twice`);
    if (e.kind === 'contestant' && e.items.length > game.def.settings.inventoryCapacity) out.push(`${e.id} carries too many items`);
    for (const [r, v] of Object.entries(e.resources)) {
      if (!Number.isInteger(v)) out.push(`${e.id}.${r} is not an integer`);
      const def = game.resources.get(r);
      if (!def) continue;
      if (def.role === 'pool') {
        const [min, max] = resourceBounds(game, state, e, r);
        if (v < min || v > max) out.push(`${e.id}.${r}=${v} outside [${min}, ${max}]`);
      }
    }
    if (e.kind === 'contestant' && e.status === 'active' && e.spaceId === null) out.push(`${e.id} active but off the board`);
    if ((e.status === 'eliminated' || e.status === 'removed') && e.spaceId !== null) out.push(`${e.id} ${e.status} but on the board`);
    if (e.status === 'active' && e.kind !== 'fixture') {
      const hp = effectiveValue(game, state, e, game.def.settings.core.hp);
      if (hp !== undefined && hp <= 0) out.push(`${e.id} active with ${hp} HP`);
    }
    for (const st of e.statuses) {
      const def = game.statuses.get(st.defId);
      if (!def) out.push(`${e.id} has unknown status ${st.defId}`);
      else if (st.stacks > def.maxStacks) out.push(`${e.id} ${st.defId} has ${st.stacks} stacks`);
      if (st.remaining !== null && st.remaining <= 0) out.push(`${e.id} ${st.defId} expired but kept`);
    }
    if (new Set(e.statuses.map((x) => x.defId)).size !== e.statuses.length) out.push(`${e.id} has a status twice`);
    if (e.statuses.filter((x) => game.statuses.get(x.defId)?.transformation).length > 1) out.push(`${e.id} has two transformations`);
  }
  const d = state.pendingDecision;
  if (d) {
    const actor = state.entities[d.actor];
    if (!actor) out.push('decision for a missing actor');
    else if (actor.status !== 'active') out.push(`decision for ${d.actor} who is ${actor.status}`);
    if (new Set(d.options.map((o) => o.id)).size !== d.options.length) out.push('duplicate option ids');
  } else if (state.phase === 'move' || state.phase === 'main') {
    if (state.queue.length === 0 && state.negotiation === null) out.push(`phase ${state.phase} without a decision`);
  }
  const n = state.negotiation;
  if (n) {
    if (state.entities[n.from]?.kind !== 'contestant' || state.entities[n.to]?.kind !== 'contestant' || n.from === n.to) out.push('bad negotiation parties');
    if (d && d.kind !== 'trade' && state.queue.length === 0) out.push('negotiation open but another decision is pending');
  }
  for (const c of state.commitments) {
    if (c.paid > c.amount) out.push(`${c.id} overpaid`);
    if (c.status === 'open' && c.dueRound < state.round && state.phase !== 'roundEnd') out.push(`${c.id} overdue but open`);
  }
  for (const o of state.objectives) {
    const goal = game.objectives.get(o.defId)?.goal;
    if (!goal) out.push(`objective ${o.id} has unknown definition`);
    else if (goal.kind === 'count' && o.progress > goal.times) out.push(`objective ${o.id} over-counted`);
  }
  if (state.phase === 'gameOver' && (!state.winners || state.winners.length === 0)) out.push('game over without winners');
  return out;
}

type Step = { kind: 'auto' } | { kind: 'answer'; optionId: string; trade?: TradeOfferInput } | { kind: 'gm'; cmd: GmCommandInput };

function randomOffer(rand: () => number, game: CompiledGame, state: GameState, actor: string): TradeOfferInput {
  const pick = <T,>(list: T[]): T | undefined => list[Math.floor(rand() * list.length)];
  const contestants = state.turnOrder.filter((id) => id !== actor);
  const tradeable = game.def.resources.filter((r) => r.tradeable).map((r) => r.id);
  const itemsOf = (id: string) => (state.entities[id]?.items ?? []).map((i) => state.items[i]?.defId ?? '');
  const goods = (holder: string | undefined) => {
    const resources: Record<string, number> = {};
    if (rand() < 0.7 && tradeable.length > 0) resources[pick(tradeable) as string] = 1 + Math.floor(rand() * 12);
    const items = rand() < 0.3 && holder ? [pick(itemsOf(holder)) ?? pick(game.def.items)?.id ?? 'nope'] : [];
    return { resources, items };
  };
  const partner = pick(contestants);
  const promises: NonNullable<TradeOfferInput['promises']> = [];
  if (rand() < 0.3) promises.push(rand() < 0.5 ? { by: 'me', kind: 'noAttack', rounds: 1 + Math.floor(rand() * 6) } : { by: 'them', kind: 'pay', resource: pick(tradeable) ?? 'res.gold', amount: 1 + Math.floor(rand() * 10), rounds: 1 + Math.floor(rand() * 6) });
  return { ...(partner !== undefined ? { with: partner } : {}), give: goods(actor), get: goods(partner), promises, message: rand() < 0.5 ? 'deal?' : null };
}

function randomGm(rand: () => number, game: CompiledGame, state: GameState): GmCommandInput {
  const pick = <T,>(list: T[]): T => list[Math.floor(rand() * list.length)] as T;
  const entities = Object.keys(state.entities);
  const contestants = state.turnOrder;
  const entity = rand() < 0.7 ? pick(contestants) : pick(entities);
  const def = game.def;
  const silent = rand() < 0.2;
  switch (Math.floor(rand() * 12)) {
    case 0:
      return { type: 'adjustResource', entity, resource: pick(def.resources).id, delta: Math.floor(rand() * 60) - 30, silent };
    case 1:
      return { type: 'setResource', entity, resource: rand() < 0.5 ? def.settings.core.hp : pick(def.resources).id, value: Math.floor(rand() * 120) - 10, silent };
    case 2:
      return { type: 'teleport', entity, space: pick(def.spaces).id, asLanding: rand() < 0.6, silent };
    case 3:
      return { type: 'grantItem', entity, item: pick(def.items).id, silent };
    case 4:
      return def.statuses.length > 0 ? { type: 'applyStatus', entity, status: pick(def.statuses).id, stacks: 1 + Math.floor(rand() * 3), silent } : { type: 'announce', text: 'x' };
    case 5:
      return def.statuses.length > 0 ? { type: 'removeStatus', entity, status: pick(def.statuses).id, silent } : { type: 'announce', text: 'x' };
    case 6:
      return def.enemies.length > 0 ? { type: 'spawnEnemy', enemy: pick(def.enemies).id, space: pick(def.spaces).id, silent } : { type: 'announce', text: 'x' };
    case 7:
      return def.decks.length > 0 ? { type: 'drawCard', entity, deck: pick(def.decks).id, silent } : { type: 'announce', text: 'x' };
    case 8:
      return def.objectives.length > 0 ? { type: 'assignObjective', entity, objective: pick(def.objectives).id, silent } : { type: 'announce', text: 'x' };
    case 9:
      return { type: 'addTag', entity, tag: pick(def.tags).id, silent };
    case 10: {
      const e = state.entities[entity];
      const item = e?.items[0];
      return item !== undefined ? { type: 'removeItem', entity, item, silent } : { type: 'announce', text: 'x' };
    }
    default:
      return { type: 'removeEntity', entity: pick(entities.filter((id) => state.entities[id]?.kind !== 'contestant')), silent };
  }
}

export interface FuzzResult {
  seed: string;
  operations: number;
  refused: number;
  aborted: number;
  gm: number;
  trades: number;
  problems: string[];
  hash: string;
}

/** One fuzzed match. `gmRate` is the chance of a GM command before each step. */
export function fuzzMatch(game: CompiledGame, seed: string, options: { maxOperations?: number; gmRate?: number } = {}): FuzzResult {
  const rand = mulberry32(hashSeed(seed));
  const created = createMatch(game, { matchId: `fuzz-${seed}`, seed });
  if (!created.ok) return { seed, operations: 0, refused: 0, aborted: 0, gm: 0, trades: 0, problems: [`create: ${created.message}`], hash: '' };
  let state = created.state;
  const steps: Step[] = [];
  const result: FuzzResult = { seed, operations: 0, refused: 0, aborted: 0, gm: 0, trades: 0, problems: [], hash: '' };
  const max = options.maxOperations ?? 1500;
  const gmRate = options.gmRate ?? 0.08;
  const apply = (step: Step, s: GameState): OpOutcome => {
    if (step.kind === 'auto') return advance(game, s);
    if (step.kind === 'gm') return applyGmCommand(game, s, GmCommandSchema.parse(step.cmd));
    return answerDecision(game, s, { decisionId: s.pendingDecision?.id as string, optionId: step.optionId, ...(step.trade ? { trade: step.trade } : {}) });
  };
  for (let i = 0; i < max && nextStepKind(state) !== 'gameOver'; i++) {
    let step: Step;
    if (rand() < gmRate) step = { kind: 'gm', cmd: randomGm(rand, game, state) };
    else if (nextStepKind(state) === 'auto') step = { kind: 'auto' };
    else {
      const d = state.pendingDecision;
      if (!d) break;
      const option = d.options[Math.floor(rand() * d.options.length)] as { id: string };
      step = option.id === 'trade' || option.id === 'tr:counter' ? { kind: 'answer', optionId: option.id, trade: randomOffer(rand, game, state, d.actor) } : { kind: 'answer', optionId: option.id };
    }
    let out: OpOutcome;
    try {
      out = apply(step, state);
    } catch (err) {
      result.problems.push(`step ${i} (${JSON.stringify(step).slice(0, 200)}) threw: ${err instanceof Error ? err.stack?.split('\n').slice(0, 3).join(' | ') : String(err)}`);
      break;
    }
    if (!out.ok) {
      if (out.kind === 'aborted') result.aborted++;
      else result.refused++;
      // A refused answer: fall back to a plain option so the match moves on.
      if (step.kind === 'answer') {
        const plain = state.pendingDecision?.options.find((o) => o.kind !== 'trade' && o.id !== 'tr:counter');
        if (plain) step = { kind: 'answer', optionId: plain.id };
        const retry = apply(step, state);
        if (!retry.ok) {
          result.problems.push(`step ${i}: plain answer refused: ${retry.message}`);
          break;
        }
        out = retry;
      } else continue;
    }
    if (step.kind === 'gm') result.gm++;
    if (out.events.some((e) => e.type === 'tradeCompleted')) result.trades++;
    if (out.state.rev !== state.rev + 1) result.problems.push(`step ${i}: rev ${state.rev} → ${out.state.rev}`);
    state = out.state;
    steps.push(step);
    result.operations++;
    const problems = checkInvariants(game, state);
    if (problems.length > 0) {
      result.problems.push(...problems.map((p) => `step ${i} (${step.kind}${step.kind === 'answer' ? ` ${step.optionId}` : step.kind === 'gm' ? ` ${step.cmd.type}` : ''}): ${p}`));
      break;
    }
  }
  result.hash = stateHash(state);
  // Determinism: replaying the same inputs reaches the same state.
  if (result.problems.length === 0) {
    let replay = expectState(createMatch(game, { matchId: `fuzz-${seed}`, seed }));
    for (const step of steps) replay = expectState(apply(step, replay));
    if (stateHash(replay) !== result.hash) result.problems.push('replay reached a different state');
  }
  return result;
}

function expectState(out: OpOutcome): GameState {
  if (!out.ok) throw new Error(`replay step failed: ${out.message}`);
  return out.state;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { parseArgs } = await import('node:util');
  const { loadStarter } = await import('./headless.ts');
  const { loadGame, cloneJson } = await import('../engine/index.ts');
  const { values } = parseArgs({ options: { runs: { type: 'string', default: '50' }, seed: { type: 'string', default: 'fuzz' }, gm: { type: 'string', default: '0.08' }, eliminate: { type: 'boolean', default: false } } });
  let game = loadStarter();
  if (values.eliminate) {
    const def = cloneJson(game.def);
    def.settings.ko.mode = 'eliminate';
    const loaded = loadGame(def);
    if (!loaded.ok) throw new Error(loaded.errors.join('; '));
    game = loaded.game;
  }
  let ops = 0;
  let refused = 0;
  let trades = 0;
  let bad = 0;
  const started = performance.now();
  for (let i = 0; i < Number(values.runs); i++) {
    const r = fuzzMatch(game, `${values.seed}-${i}`, { gmRate: Number(values.gm) });
    ops += r.operations;
    refused += r.refused;
    trades += r.trades;
    if (r.problems.length > 0) {
      bad++;
      console.log(`✗ ${r.seed}: ${r.problems.slice(0, 3).join('\n    ')}`);
    }
  }
  console.log(`${values.runs} fuzzed matches · ${ops} operations · ${refused} refused inputs · ${trades} trades · ${bad} with problems · ${((performance.now() - started) / 1000).toFixed(1)}s`);
  process.exit(bad > 0 ? 1 : 0);
}
