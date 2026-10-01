import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyToMind, decideOffline, withoutTrade } from '../contestants/controller.ts';
import { prepareMind } from '../contestants/memory.ts';
import { newMind, type ContestantMind } from '../contestants/mind.ts';
import { namesFromView } from '../contestants/packet.ts';
import { ARCHETYPE_INFO, castCandidates, defaultStrategy } from '../contestants/strategy.ts';
import { advance, answerDecision, createMatch, GM, loadGame, nextStepKind, type CompiledGame } from '../engine/index.ts';
import type { Archetype, Persona } from '../schema/persona.ts';
import type { GameEvent, GameState } from '../schema/state.ts';
import { publicInfo, type PublicGameInfo } from '../visibility/public-info.ts';
import { visibleEventsAfter } from '../visibility/redact.ts';
import { buildContestantView, type ContestantView } from '../visibility/view.ts';

/** Headless, synchronous match runner with the offline heuristic player (tests and the sim CLI). */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Loads a built-in scenario (Star Chase by default). `rounds` forces full-length games of that many rounds (no early
 * victory), which exercises more of the content in long simulations.
 */
export function loadStarter(options: { rounds?: number | undefined; scenario?: string | undefined } = {}): CompiledGame {
  const file = `content/starter/${options.scenario ?? 'star-chase'}.json`;
  const json = JSON.parse(readFileSync(path.join(repoRoot, file), 'utf8')) as { settings: { victory: { roundLimit: number; threshold: number } } };
  if (options.rounds !== undefined) {
    json.settings.victory.roundLimit = options.rounds;
    json.settings.victory.threshold = 99;
  }
  const loaded = loadGame(json);
  if (!loaded.ok) throw new Error(`${file} invalid:\n${loaded.errors.join('\n')}`);
  return loaded.game;
}

export { stateHash } from '../server/hash.ts';

export interface HeadlessResult {
  state: GameState;
  events: GameEvent[];
  /** Strategy each contestant was cast with at match start. */
  archetypes: Map<string, Archetype>;
  /** Contestant minds at the end (strategies, relationships, memories). */
  minds: Map<string, ContestantMind>;
  decisions: number;
  forcedDecisions: number;
  faults: number;
  aborted: string | null;
  operations: number;
  /** Wall-clock milliseconds of each engine operation (excluding the fallback player's thinking). */
  opMs: number[];
}

export interface HeadlessOptions {
  maxOperations?: number;
  /** Called at every real contestant decision with what a model-driven contestant would see. */
  onDecision?: (input: { view: ContestantView; info: PublicGameInfo; mind: ContestantMind; persona: Persona }) => void;
}

export function runHeadlessMatch(game: CompiledGame, seed: string, options: HeadlessOptions = {}): HeadlessResult {
  const created = createMatch(game, { matchId: `sim-${seed}`, seed });
  if (!created.ok) throw new Error(`createMatch failed: ${created.message}`);
  let state = created.state;
  const events: GameEvent[] = [...created.events];
  const info = publicInfo(game);
  const contestants = state.turnOrder.map((id) => {
    const member = game.cast.get(state.entities[id]?.defId ?? '');
    if (!member) throw new Error('cast member missing');
    return { id, persona: member.persona };
  });
  const candidates = castCandidates(info, [...contestants].sort((a, b) => a.id.localeCompare(b.id)));
  const archetypes = new Map<string, Archetype>();
  const minds = new Map<string, ContestantMind>();
  for (const c of contestants) {
    const list = candidates.get(c.id) ?? ['opportunist'];
    const first = list[0] ?? 'opportunist';
    const mind = newMind(c.id, state.entities[c.id]?.defId ?? '', list, 'heuristic');
    mind.strategy = defaultStrategy(info, first, 0, 'casting');
    mind.plan = ARCHETYPE_INFO[first].priorities(info)[0] ?? '';
    minds.set(c.id, mind);
    archetypes.set(c.id, first);
  }
  let decisions = 0;
  let forced = 0;
  let faults = 0;
  let operations = 0;
  const opMs: number[] = [];
  const max = options.maxOperations ?? 20_000;
  while (nextStepKind(state) !== 'gameOver' && operations < max) {
    operations++;
    let out;
    if (nextStepKind(state) === 'auto') {
      const t0 = performance.now();
      out = advance(game, state);
      opMs.push(performance.now() - t0);
    } else {
      const decision = state.pendingDecision;
      if (!decision) throw new Error('missing decision');
      decisions++;
      if (decision.actor === GM) {
        // No GM at a headless table: rulings resolve to "No effect".
        forced++;
        out = answerDecision(game, state, { decisionId: decision.id, optionId: 'ch:none' });
      } else if (decision.options.length === 1) {
        forced++;
        const t0 = performance.now();
        out = answerDecision(game, state, { decisionId: decision.id, optionId: (decision.options[0] as { id: string }).id });
        opMs.push(performance.now() - t0);
      } else {
        const view = buildContestantView(game, state, decision.actor, events);
        const persona = contestants.find((c) => c.id === decision.actor)?.persona;
        const mind = minds.get(decision.actor);
        if (!persona || !mind) throw new Error('persona missing');
        prepareMind(mind, view, info, visibleEventsAfter(game, events, decision.actor, mind.lastSeenEventSeq), namesFromView(info, view));
        options.onDecision?.({ view, info, mind, persona });
        let result = decideOffline({ view, info, mind, persona });
        const t0 = performance.now();
        out = answerDecision(game, state, { decisionId: decision.id, optionId: result.optionId, say: result.say ?? undefined, trade: result.trade ?? undefined });
        if (!out.ok && out.kind === 'invalid') {
          result = withoutTrade({ view, info, mind, persona }, result);
          out = answerDecision(game, state, { decisionId: decision.id, optionId: result.optionId });
        }
        opMs.push(performance.now() - t0);
        if (out.ok) applyToMind(mind, result, state.round);
      }
    }
    if (!out.ok) {
      if (out.kind === 'aborted') return { state, events, archetypes, minds, decisions, forcedDecisions: forced, faults, aborted: out.message, operations, opMs };
      throw new Error(`operation rejected: ${out.message}`);
    }
    state = out.state;
    events.push(...out.events);
    faults += out.faults.length;
  }
  return { state, events, archetypes, minds, decisions, forcedDecisions: forced, faults, aborted: null, operations, opMs };
}
