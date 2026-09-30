import type { CompiledGame, CompiledRule } from '../engine/compile.ts';
import type { FiringRecord } from '../engine/context.ts';
import { CheckEnv } from '../engine/decisions.ts';
import { GM } from '../engine/effects.ts';
import { describeCond, describeEvent, describeRule, namesFor } from '../engine/explain.ts';
import { applyGmCommand } from '../engine/gm.ts';
import { computeModifiers } from '../engine/modifiers.ts';
import { effectiveValue, suppressedCapabilities } from '../engine/queries.ts';
import { observeMisses, type MissRecord, type OpOutcome } from '../engine/resolve.ts';
import { advance, answerDecision, createMatch, nextStepKind } from '../engine/turn.ts';
import { GmCommandSchema, type GmCommandInput } from '../schema/commands.ts';
import type { DryRun, DryRunExample } from '../schema/proposal.ts';
import type { ModifierRule, ReactionRule } from '../schema/rules.ts';
import type { GameEvent, GameState } from '../schema/state.ts';

/**
 * Dry runs: before a rule change is applied, show what the new or changed rules would do, on a
 * scratch copy of the match (or a fresh match of the scenario). Reactions are exercised with
 * targeted probes (landing on matching spaces, gaining the named item …) and a short seeded
 * simulation; each example shows the triggering event, the conditions checked and what happened.
 * Modifiers are probed with sample values; continuous rules show the effective values they change.
 */

export type { DryRun, DryRunExample };

const MAX_FIRED = 3;
const MAX_MISSED = 2;

/** A small deterministic generator for the simulation's choices. */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Plays automatic steps until a decision is waiting. */
function settle(game: CompiledGame, state: GameState): GameState {
  let s = state;
  for (let i = 0; i < 50 && nextStepKind(s) === 'auto'; i++) {
    const out = advance(game, s);
    if (!out.ok) break;
    s = out.state;
  }
  return s;
}

/** A fresh match of the scenario, stopped at its first decision. */
export function scratchMatch(game: CompiledGame, seed = 'dry-run'): GameState | null {
  const created = createMatch(game, { matchId: 'dry-run', seed });
  return created.ok ? settle(game, created.state) : null;
}

interface Collector {
  fired: Map<string, DryRunExample[]>;
  missed: Map<string, DryRunExample[]>;
}

function record(game: CompiledGame, targets: Set<string>, out: Extract<OpOutcome, { ok: true }>, misses: MissRecord[], c: Collector, probe: string | null): void {
  const names = namesFor(game, out.state);
  const bySeq = new Map(out.events.map((e) => [e.seq, e]));
  const text = (e: GameEvent | undefined) => (e ? describeEvent(e, names) : 'an event');
  for (const f of out.firings as FiringRecord[]) {
    if (!targets.has(f.rule)) continue;
    const list = c.fired.get(f.rule) ?? [];
    if (list.length >= MAX_FIRED) continue;
    const results = out.events.filter((e) => e.cause.firing === f.id).map((e) => text(e));
    list.push({ trigger: `${probe ? `${probe}: ` : ''}${text(bySeq.get(f.trigger))}`, checks: f.checks, results: results.length > 0 ? results : ['(no visible change)'] });
    c.fired.set(f.rule, list);
  }
  for (const m of misses) {
    if (!targets.has(m.rule)) continue;
    const list = c.missed.get(m.rule) ?? [];
    if (list.length >= MAX_MISSED) continue;
    list.push({ trigger: `${probe ? `${probe}: ` : ''}${text(m.trigger)}`, checks: m.checks, results: ['did not fire'] });
    c.missed.set(m.rule, list);
  }
}

function run(game: CompiledGame, targets: Set<string>, c: Collector, fn: () => OpOutcome, probe: string | null): GameState | null {
  const { result, misses } = observeMisses(fn);
  if (!result.ok) return null;
  record(game, targets, result, misses, c, probe);
  return result.state;
}

function gm(game: CompiledGame, state: GameState, cmd: GmCommandInput): OpOutcome {
  const parsed = GmCommandSchema.safeParse(cmd);
  if (!parsed.success) return { ok: false, kind: 'invalid', message: 'bad probe' };
  return applyGmCommand(game, state, parsed.data);
}

/** Targeted probes for a reaction rule's trigger. */
function probeReaction(game: CompiledGame, base: GameState, rule: ReactionRule, c: Collector): void {
  const targets = new Set([rule.id]);
  const contestants = base.turnOrder.filter((id) => base.entities[id]?.status === 'active').slice(0, 2);
  const names = namesFor(game, base);
  const w = rule.trigger.where ?? {};
  const cmds: Array<{ label: string; cmd: GmCommandInput }> = [];
  const spaceIds = game.spaceOrder;
  switch (rule.trigger.event) {
    case 'landed':
    case 'entered': {
      const matching = spaceIds.filter((s) => (w.space === undefined || s === w.space) && (w.spaceTag === undefined || game.spaces.get(s)?.tags.includes(w.spaceTag)));
      const other = spaceIds.filter((s) => !matching.includes(s));
      for (const space of [...matching.slice(0, 2), ...other.slice(0, 1)]) {
        for (const who of contestants) cmds.push({ label: `${names.entity(who)} lands on ${names.space(space)}`, cmd: { type: 'teleport', entity: who, space, asLanding: true } });
      }
      break;
    }
    case 'resourceChanged': {
      const resource = w.resource ?? game.def.settings.core.gold;
      const delta = w.direction === 'loss' ? -3 : 3;
      for (const who of contestants) cmds.push({ label: `${names.entity(who)} ${delta > 0 ? 'gains' : 'loses'} 3 ${names.resource(resource)}`, cmd: { type: 'adjustResource', entity: who, resource, delta } });
      break;
    }
    case 'itemGained': {
      const item = w.item ?? game.def.items[0]?.id;
      if (item) for (const who of contestants) cmds.push({ label: `${names.entity(who)} receives ${names.item(item)}`, cmd: { type: 'grantItem', entity: who, item } });
      break;
    }
    case 'statusApplied':
    case 'statusRemoved': {
      const status = w.status ?? game.def.statuses[0]?.id;
      if (!status) break;
      for (const who of contestants) {
        cmds.push({ label: `${names.entity(who)} becomes ${names.status(status)}`, cmd: { type: 'applyStatus', entity: who, status } });
        if (rule.trigger.event === 'statusRemoved') cmds.push({ label: `${names.entity(who)} loses ${names.status(status)}`, cmd: { type: 'removeStatus', entity: who, status } });
      }
      break;
    }
    case 'cardDrawn': {
      const deck = w.deck ?? game.def.decks[0]?.id;
      if (deck) for (const who of contestants) cmds.push({ label: `${names.entity(who)} draws from ${names.deck(deck)}`, cmd: { type: 'drawCard', entity: who, deck } });
      break;
    }
    case 'spawned': {
      const enemy = w.enemy ?? game.def.enemies[0]?.id;
      if (enemy) cmds.push({ label: `${names.enemy(enemy)} appears`, cmd: { type: 'spawnEnemy', enemy, space: game.def.settings.startSpace } });
      break;
    }
    default:
      break;
  }
  for (const { label, cmd } of cmds) {
    // A status must exist before it can be removed.
    let from = base;
    if (cmd.type === 'removeStatus') {
      const applied = gm(game, base, { type: 'applyStatus', entity: cmd.entity, status: cmd.status });
      if (applied.ok) from = applied.state;
    }
    run(game, targets, c, () => gm(game, from, cmd), label);
  }
}

/** A short seeded simulation (random legal choices, no trades or freeform, GM rulings "No effect"). */
function simulate(game: CompiledGame, base: GameState, targets: Set<string>, c: Collector, operations: number): void {
  const rand = lcg(targets.size * 7919 + base.rev);
  let state = base;
  for (let i = 0; i < operations && nextStepKind(state) !== 'gameOver'; i++) {
    const d = state.pendingDecision;
    let next: GameState | null;
    if (!d) next = run(game, targets, c, () => advance(game, state), null);
    else {
      const plain = d.options.filter((o) => o.kind !== 'trade' && o.kind !== 'freeform' && o.id !== 'tr:counter');
      const option = d.actor === GM ? 'ch:none' : (plain[Math.floor(rand() * plain.length)]?.id ?? 'pass');
      next = run(game, targets, c, () => answerDecision(game, state, { decisionId: d.id, optionId: option }), null);
    }
    if (!next) break;
    state = next;
  }
}

function probeModifier(game: CompiledGame, base: GameState, compiled: CompiledRule, rule: ModifierRule, c: Collector): void {
  const names = namesFor(game, base);
  const env = new CheckEnv(game, base);
  const contestants = base.turnOrder.filter((id) => base.entities[id]?.status === 'active').slice(0, 3);
  const w = rule.where ?? {};
  const samples: Array<{ label: string; b: Record<string, string | number>; value: number; subject: Parameters<typeof computeModifiers>[4] }> = [];
  for (const who of contestants) {
    switch (rule.on) {
      case 'damage':
        samples.push({ label: `${names.entity(who)} would take 20 damage`, b: { $target: who, amount: 20 }, value: 20, subject: { entity: who } });
        break;
      case 'resourceChange': {
        const resource = w.resource ?? game.def.settings.core.gold;
        for (const delta of w.direction === 'loss' ? [-5] : w.direction === 'gain' ? [5] : [5, -5]) {
          samples.push({ label: `${names.entity(who)} would ${delta > 0 ? 'gain' : 'lose'} 5 ${names.resource(resource)}`, b: { $target: who, amount: delta }, value: delta, subject: { entity: who, resource, direction: delta > 0 ? 'gain' : 'loss' } });
        }
        break;
      }
      case 'price':
        for (const [entryId, { entry }] of [...game.shopEntries].filter(([id]) => w.shopEntry === undefined || id === w.shopEntry).slice(0, 2)) {
          samples.push({ label: `${names.entity(who)} would pay ${entry.price.amount} ${names.resource(entry.price.resource)} for ${names.entry(entryId)}`, b: { $actor: who, amount: entry.price.amount }, value: entry.price.amount, subject: { entity: who, resource: entry.price.resource, shopEntry: entryId } });
        }
        break;
      case 'moveRoll':
        samples.push({ label: `${names.entity(who)} rolls 4`, b: { $actor: who, amount: 4 }, value: 4, subject: { entity: who } });
        break;
      case 'statusApply': {
        const status = w.status ?? game.def.statuses[0]?.id;
        if (status) samples.push({ label: `${names.entity(who)} would become ${names.status(status)} (3 turns)`, b: { $target: who, amount: 3 }, value: 3, subject: { entity: who, status } });
        break;
      }
    }
  }
  for (const s of samples) {
    let out;
    try {
      out = computeModifiers(env, rule.on, s.b as never, s.value, s.subject);
    } catch {
      continue;
    }
    const step = out.steps.find((x) => x.rule === compiled);
    const checks = rule.conditions ? [{ text: describeCond(rule.conditions, names), ok: step !== undefined }] : [];
    if (step) {
      const list = c.fired.get(rule.id) ?? [];
      if (list.length < MAX_FIRED) list.push({ trigger: s.label, checks, results: [out.prevented ? 'prevented' : `${step.from} → ${step.to}`] });
      c.fired.set(rule.id, list);
    } else {
      const list = c.missed.get(rule.id) ?? [];
      if (list.length < MAX_MISSED) list.push({ trigger: s.label, checks, results: ['unchanged'] });
      c.missed.set(rule.id, list);
    }
  }
}

function probeContinuous(game: CompiledGame, base: GameState, compiled: CompiledRule, c: Collector): void {
  const without: CompiledGame = { ...game, continuous: game.continuous.filter((r) => r !== compiled) };
  const names = namesFor(game, base);
  for (const e of Object.values(base.entities)) {
    if (e.status !== 'active') continue;
    const changes: string[] = [];
    for (const r of Object.keys(e.resources)) {
      const a = effectiveValue(without, base, e, r);
      const b = effectiveValue(game, base, e, r);
      if (a !== b) changes.push(`${names.resource(r)} ${a} → ${b}`);
    }
    const before = suppressedCapabilities(without, base, e);
    for (const [cap] of suppressedCapabilities(game, base, e)) if (!before.has(cap)) changes.push(`cannot ${cap} any more`);
    const target = changes.length > 0 ? c.fired : c.missed;
    const list = target.get(compiled.def.id) ?? [];
    if (list.length < (changes.length > 0 ? MAX_FIRED + 2 : MAX_MISSED)) list.push({ trigger: `${e.name} right now`, checks: [], results: changes.length > 0 ? changes : ['unaffected'] });
    target.set(compiled.def.id, list);
  }
}

/**
 * Dry runs for the given rules of `game`, starting from `base` (a state already under `game`).
 */
export function dryRun(game: CompiledGame, base: GameState, ruleIds: string[], options: { simulate?: number } = {}): DryRun[] {
  const c: Collector = { fired: new Map(), missed: new Map() };
  const names = namesFor(game, base);
  const reactions = new Set<string>();
  for (const id of ruleIds) {
    const compiled = game.rules.get(id);
    if (!compiled) continue;
    const def = compiled.def;
    if (def.kind === 'reaction') {
      reactions.add(id);
      probeReaction(game, base, def, c);
    } else if (def.kind === 'modifier') probeModifier(game, base, compiled, def, c);
    else probeContinuous(game, base, compiled, c);
  }
  if (reactions.size > 0) simulate(game, base, reactions, c, options.simulate ?? 300);
  return ruleIds.flatMap((id) => {
    const compiled = game.rules.get(id);
    if (!compiled) return [];
    const fired = c.fired.get(id) ?? [];
    const notFired = c.missed.get(id) ?? [];
    const notes: string[] = [];
    if (!compiled.def.enabled) notes.push('The rule is disabled, so it never runs.');
    if (fired.length === 0) notes.push('No example fired in the probes or a short simulation; it may still fire in play.');
    if (compiled.owner) notes.push(`Attached to ${compiled.owner.kind} ${compiled.owner.defId}: it only runs while that is held or present.`);
    return [{ rule: id, name: compiled.def.name, text: describeRule(compiled.def, names), fired, notFired, notes }];
  });
}
