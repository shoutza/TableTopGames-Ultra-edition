import { advance, answerDecision, applyGmCommand, cloneJson, createMatch, effectiveValue, GM, loadGame, nextStepKind, type CompiledGame, type OpOutcome } from '../engine/index.ts';
import { bagSpacesUsed, equippedIn } from '../engine/inventory.ts';
import { applyDefinitionChange, planMigration } from '../engine/migrate.ts';
import type { GameDefinition } from '../schema/definition.ts';
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
    if (e.kind === 'contestant' && bagSpacesUsed(game, state, e) > game.def.settings.inventoryCapacity) out.push(`${e.id} carries more than its bag holds`);
    for (const slot of game.def.settings.equipment) if (equippedIn(game, state, e, slot.id).length > slot.count) out.push(`${e.id} wears too many ${slot.name}`);
    for (const id of e.items) {
      const item = state.items[id];
      const def = item ? game.items.get(item.defId) : undefined;
      if (item?.equipped && def?.slot === undefined) out.push(`${e.id} wears ${id}, which has no slot`);
      if (item && item.charges !== null && item.charges < 1) out.push(`${id} has ${item.charges} charges`);
    }
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
    if (d.actor === GM) {
      if (d.kind !== 'ruling') out.push('a GM decision that is not a ruling');
    } else if (!actor) out.push('decision for a missing actor');
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
  // Everything in the state refers to the current definition (checked hard after rule changes).
  for (const e of Object.values(state.entities)) {
    if (e.status === 'removed') continue;
    for (const r of Object.keys(e.resources)) {
      const def = game.resources.get(r);
      if (!def) out.push(`${e.id} has unknown resource ${r}`);
      else if (!def.appliesTo.includes(e.kind)) out.push(`${e.id} (${e.kind}) has ${r}`);
    }
    for (const r of game.def.resources) if (r.appliesTo.includes(e.kind) && e.resources[r.id] === undefined) out.push(`${e.id} lacks ${r.id}`);
    for (const t of e.tags) if (!game.tags.has(t)) out.push(`${e.id} has unknown tag ${t}`);
    if (e.spaceId !== null && !game.spaces.has(e.spaceId)) out.push(`${e.id} stands on unknown space ${e.spaceId}`);
    const known = e.kind === 'contestant' ? game.cast.has(e.defId) : e.kind === 'enemy' ? game.enemies.has(e.defId) : game.fixtures.has(e.defId);
    if (!known) out.push(`${e.id} has unknown definition ${e.defId}`);
  }
  for (const item of Object.values(state.items)) if (!game.items.has(item.defId)) out.push(`item ${item.id} has unknown definition ${item.defId}`);
  for (const [id, pile] of Object.entries(state.decks)) {
    const deck = game.decks.get(id);
    if (!deck) {
      out.push(`unknown deck ${id}`);
      continue;
    }
    const total = deck.cards.reduce((n, c) => n + c.count, 0);
    if (pile.draw.length + pile.discard.length !== total) out.push(`deck ${id} has ${pile.draw.length + pile.discard.length} cards, expected ${total}`);
    for (const c of [...pile.draw, ...pile.discard]) if (!game.cards.has(c)) out.push(`deck ${id} holds unknown card ${c}`);
  }
  for (const c of state.queue) if (c.rule !== undefined && !game.rules.has(c.rule)) out.push(`queued choice from unknown rule ${c.rule}`);
  return out;
}

type Step =
  | { kind: 'auto' }
  | { kind: 'answer'; optionId: string; trade?: TradeOfferInput; attempt?: string }
  | { kind: 'gm'; cmd: GmCommandInput }
  | { kind: 'rules'; game: CompiledGame; answers: Record<string, string>; label: string };

type Json = Record<string, unknown>;

/** Whether an id appears anywhere in the definition except as the `id` of its own entry. */
function referenced(def: GameDefinition, id: string, skip: unknown): boolean {
  let found = false;
  const visit = (v: unknown, key: string | null): void => {
    if (found || v === skip) return;
    if (v === id && key !== 'id') found = true;
    else if (Array.isArray(v)) v.forEach((x) => visit(x, null));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Json)) visit(x, k);
  };
  visit(def, null);
  return found;
}

/**
 * A random change to the running match's definition: removing unreferenced entries or spaces,
 * tightening bounds, changing stats, capacities, dice and victory, adding resources, enemies and
 * rules (including GM rulings), and changes that must be blocked (removing a playing contestant,
 * turning a pool into a stat). Returns null when the mutation does not compile.
 */
function randomDefinitionChange(rand: () => number, game: CompiledGame, state: GameState): { game: CompiledGame; label: string } | null {
  const def = cloneJson(game.def);
  const pick = <T>(list: T[]): T | undefined => list[Math.floor(rand() * list.length)];
  const kinds = ['removeEntry', 'removeItem', 'removeItem', 'removeSpace', 'bounds', 'enemyStats', 'capacity', 'addResource', 'addEnemy', 'addRule', 'ruling', 'die', 'victory', 'stacks', 'removeCast', 'role'] as const;
  const kind = pick([...kinds]) as (typeof kinds)[number];
  const suffix = `${state.rev}_${Math.floor(rand() * 1000)}`;
  switch (kind) {
    case 'removeEntry': {
      const sections = ['items', 'statuses', 'enemies', 'decks', 'objectives', 'actions', 'rules', 'tags', 'fixtures', 'shops'] as const;
      const section = pick([...sections]) as (typeof sections)[number];
      const list = def[section] as Array<{ id: string }>;
      const candidates = list.filter((e) => !referenced(def, e.id, e));
      const victim = pick(candidates);
      if (!victim) return null;
      (def as unknown as Record<string, unknown>)[section] = list.filter((e) => e !== victim);
      break;
    }
    case 'removeItem': {
      // An item and the shop entries selling it (as long as each shop keeps something to sell).
      const item = pick(def.items);
      if (!item) return null;
      for (const shop of def.shops) shop.entries = shop.entries.filter((en) => !('item' in en.grants) || en.grants.item !== item.id);
      if (def.shops.some((shop) => shop.entries.length === 0)) return null;
      def.items = def.items.filter((x) => x !== item);
      if (referenced(def, item.id, null)) return null;
      break;
    }
    case 'removeSpace': {
      const victim = pick(def.spaces.filter((sp) => sp.id !== def.settings.startSpace));
      if (!victim) return null;
      const rest = { ...def, connections: [], layout: { ...def.layout, positions: {} } };
      if (referenced(rest as GameDefinition, victim.id, victim)) return null;
      def.spaces = def.spaces.filter((sp) => sp !== victim);
      def.connections = def.connections.filter((c) => c.a !== victim.id && c.b !== victim.id);
      delete def.layout.positions[victim.id];
      break;
    }
    case 'bounds': {
      const r = pick(def.resources.filter((x) => x.role === 'pool' && x.maxFrom === undefined));
      if (!r) return null;
      r.max = Math.max(r.min + 1, Math.floor((r.max ?? 200) * (0.2 + rand() * 0.6)));
      r.default = Math.min(r.default, r.max);
      break;
    }
    case 'enemyStats': {
      const e = pick(def.enemies);
      if (!e) return null;
      e.power = Math.max(1, Math.round(e.power * (0.5 + rand())));
      e.maxHp = Math.max(1, Math.round(e.maxHp * (0.3 + rand())));
      break;
    }
    case 'capacity':
      def.settings.inventoryCapacity = Math.floor(rand() * def.settings.inventoryCapacity);
      break;
    case 'addResource':
      def.resources.push({ id: `res.fz${suffix}`, name: `Fuzz ${suffix}`, role: 'pool', appliesTo: ['contestant'], default: Math.floor(rand() * 5), min: 0, max: 20, visibility: 'public', tradeable: rand() < 0.5 });
      break;
    case 'addEnemy': {
      const space = pick(def.spaces);
      if (!space) return null;
      def.enemies.push({ id: `enemy.fz${suffix}`, name: `Fuzzling ${suffix}`, tags: [], power: 50 + Math.floor(rand() * 150), maxHp: 20 + Math.floor(rand() * 60), regenPerRound: 0, respawnAfterRounds: rand() < 0.5 ? null : 2, rewards: [{ op: 'changeResource', target: '$actor', resource: def.settings.core.gold, amount: 3 }], spawns: [space.id], boss: false, rules: [] });
      break;
    }
    case 'addRule':
      def.rules.push({ id: `rule.fz${suffix}`, name: `Fuzz tax ${suffix}`, kind: 'reaction', enabled: true, visibility: rand() < 0.3 ? 'hidden' : 'public', priority: 0, trigger: { event: 'landed' }, effects: [{ op: 'changeResource', target: '$actor', resource: def.settings.core.gold, amount: -1 - Math.floor(rand() * 3) }] });
      break;
    case 'ruling':
      def.rules.push({ id: `rule.fzgm${suffix}`, name: `Fuzz ruling ${suffix}`, kind: 'reaction', enabled: true, visibility: 'public', priority: 0, limits: { maxPerRound: 1 }, trigger: { event: 'turnStarted' }, effects: [{ op: 'askGm', question: 'Lucky?', about: '$actor', options: [{ id: 'yes', label: 'Yes', effects: [{ op: 'changeResource', target: '$actor', resource: def.settings.core.gold, amount: 2 }] }] }] });
      break;
    case 'die':
      def.settings.movement.die = 2 + Math.floor(rand() * 10);
      break;
    case 'victory':
      def.settings.victory.threshold = Math.max(1, def.settings.victory.threshold + (rand() < 0.5 ? -1 : 1));
      break;
    case 'stacks': {
      const st = pick(def.statuses.filter((x) => x.stacking === 'stack'));
      if (!st) return null;
      st.maxStacks = Math.max(1, st.maxStacks - 1 - Math.floor(rand() * 3));
      if (st.maxStacks === 1) st.stacking = 'refresh';
      break;
    }
    case 'removeCast': {
      const playing = pick(state.turnOrder);
      const castId = playing ? state.entities[playing]?.defId : undefined;
      if (!castId || def.cast.length < 2) return null;
      def.cast = def.cast.filter((c) => c.id !== castId);
      break;
    }
    case 'role': {
      const r = pick(def.resources.filter((x) => x.role === 'pool' && !x.tradeable && x.maxFrom === undefined && !referenced({ ...def, resources: [] } as GameDefinition, x.id, x)));
      if (!r) return null;
      r.role = 'stat';
      break;
    }
  }
  const loaded = loadGame(def);
  return loaded.ok ? { game: loaded.game, label: kind } : null;
}

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
  rulesChanges: number;
  blocked: number;
  problems: string[];
  hash: string;
}

/** One fuzzed match. `gmRate` is the chance of a GM command before each step. */
export function fuzzMatch(game: CompiledGame, seed: string, options: { maxOperations?: number; gmRate?: number; rulesRate?: number } = {}): FuzzResult {
  const rand = mulberry32(hashSeed(seed));
  const created = createMatch(game, { matchId: `fuzz-${seed}`, seed });
  if (!created.ok) return { seed, operations: 0, refused: 0, aborted: 0, gm: 0, trades: 0, rulesChanges: 0, blocked: 0, problems: [`create: ${created.message}`], hash: '' };
  let state = created.state;
  const initial = game;
  const steps: Step[] = [];
  const result: FuzzResult = { seed, operations: 0, refused: 0, aborted: 0, gm: 0, trades: 0, rulesChanges: 0, blocked: 0, problems: [], hash: '' };
  const max = options.maxOperations ?? 1500;
  const gmRate = options.gmRate ?? 0.08;
  const rulesRate = options.rulesRate ?? 0;
  const apply = (step: Step, s: GameState, g: CompiledGame): OpOutcome => {
    if (step.kind === 'auto') return advance(g, s);
    if (step.kind === 'gm') return applyGmCommand(g, s, GmCommandSchema.parse(step.cmd));
    if (step.kind === 'rules') return applyDefinitionChange(g, step.game, s, { answers: step.answers, version: 2, summary: [step.label] });
    return answerDecision(g, s, { decisionId: s.pendingDecision?.id as string, optionId: step.optionId, ...(step.trade ? { trade: step.trade } : {}), ...(step.attempt ? { attempt: step.attempt } : {}) });
  };
  for (let i = 0; i < max && nextStepKind(state) !== 'gameOver'; i++) {
    let step: Step;
    const change = rand() < rulesRate ? randomDefinitionChange(rand, game, state) : null;
    if (change) {
      const plan = planMigration(game, change.game, state);
      const answers: Record<string, string> = {};
      for (const issue of plan.issues) if (issue.options && issue.options.length > 0) answers[issue.id] = (issue.options[Math.floor(rand() * issue.options.length)] as { id: string }).id;
      step = { kind: 'rules', game: change.game, answers, label: change.label };
      if (plan.blocked) {
        // Blocked changes must be refused without touching the state.
        const out = apply(step, state, game);
        result.blocked++;
        if (out.ok) result.problems.push(`step ${i}: blocked change (${change.label}) was applied`);
        continue;
      }
    } else if (rand() < gmRate) step = { kind: 'gm', cmd: randomGm(rand, game, state) };
    else if (nextStepKind(state) === 'auto') step = { kind: 'auto' };
    else {
      const d = state.pendingDecision;
      if (!d) break;
      const option = d.options[Math.floor(rand() * d.options.length)] as { id: string };
      step =
        option.id === 'trade' || option.id === 'tr:counter'
          ? { kind: 'answer', optionId: option.id, trade: randomOffer(rand, game, state, d.actor) }
          : option.id === 'freeform'
            ? { kind: 'answer', optionId: option.id, attempt: rand() < 0.9 ? 'I try to befriend the nearest slime' : '' }
            : { kind: 'answer', optionId: option.id };
    }
    let out: OpOutcome;
    try {
      out = apply(step, state, game);
    } catch (err) {
      result.problems.push(`step ${i} (${JSON.stringify(step).slice(0, 200)}) threw: ${err instanceof Error ? err.stack?.split('\n').slice(0, 3).join(' | ') : String(err)}`);
      break;
    }
    if (!out.ok) {
      if (out.kind === 'aborted') result.aborted++;
      else result.refused++;
      // A refused answer: fall back to a plain option so the match moves on.
      if (step.kind === 'answer') {
        const plain = state.pendingDecision?.options.find((o) => o.kind !== 'trade' && o.kind !== 'freeform' && o.id !== 'tr:counter');
        if (plain) step = { kind: 'answer', optionId: plain.id };
        const retry = apply(step, state, game);
        if (!retry.ok) {
          result.problems.push(`step ${i}: plain answer refused: ${retry.message}`);
          break;
        }
        out = retry;
      } else continue;
    }
    if (step.kind === 'gm') result.gm++;
    if (step.kind === 'rules') {
      result.rulesChanges++;
      game = step.game;
      if (out.events.every((e) => e.type !== 'rulesChanged')) result.problems.push(`step ${i}: no rulesChanged event`);
    }
    if (out.events.some((e) => e.type === 'tradeCompleted')) result.trades++;
    if (out.state.rev !== state.rev + 1) result.problems.push(`step ${i}: rev ${state.rev} → ${out.state.rev}`);
    state = out.state;
    steps.push(step);
    result.operations++;
    const problems = checkInvariants(game, state);
    if (problems.length > 0) {
      result.problems.push(...problems.map((p) => `step ${i} (${step.kind}${step.kind === 'answer' ? ` ${step.optionId}` : step.kind === 'gm' ? ` ${step.cmd.type}` : step.kind === 'rules' ? ` ${step.label} ${JSON.stringify(step.answers)}` : ''}): ${p}`));
      break;
    }
  }
  result.hash = stateHash(state);
  // Determinism: replaying the same inputs reaches the same state.
  if (result.problems.length === 0) {
    let g = initial;
    let replay = expectState(createMatch(g, { matchId: `fuzz-${seed}`, seed }));
    for (const step of steps) {
      replay = expectState(apply(step, replay, g));
      if (step.kind === 'rules') g = step.game;
    }
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
  const { values } = parseArgs({ options: { runs: { type: 'string', default: '50' }, seed: { type: 'string', default: 'fuzz' }, gm: { type: 'string', default: '0.08' }, rules: { type: 'string', default: '0' }, eliminate: { type: 'boolean', default: false } } });
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
  let changes = 0;
  let blocked = 0;
  let bad = 0;
  const started = performance.now();
  for (let i = 0; i < Number(values.runs); i++) {
    const r = fuzzMatch(game, `${values.seed}-${i}`, { gmRate: Number(values.gm), rulesRate: Number(values.rules) });
    ops += r.operations;
    changes += r.rulesChanges;
    blocked += r.blocked;
    refused += r.refused;
    trades += r.trades;
    if (r.problems.length > 0) {
      bad++;
      console.log(`✗ ${r.seed}: ${r.problems.slice(0, 3).join('\n    ')}`);
    }
  }
  console.log(`${values.runs} fuzzed matches · ${ops} operations · ${refused} refused inputs · ${trades} trades · ${changes} rule changes (${blocked} blocked) · ${bad} with problems · ${((performance.now() - started) / 1000).toFixed(1)}s`);
  process.exit(bad > 0 ? 1 : 0);
}
