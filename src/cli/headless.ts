import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { castCandidates, defaultStrategy } from '../contestants/strategy.ts';
import { chooseHeuristic } from '../contestants/heuristic.ts';
import { advance, answerDecision, createMatch, loadGame, nextStepKind, type CompiledGame } from '../engine/index.ts';
import type { Archetype } from '../schema/persona.ts';
import type { GameEvent, GameState } from '../schema/state.ts';
import { publicInfo } from '../visibility/public-info.ts';
import { buildContestantView } from '../visibility/view.ts';

/** Headless, synchronous match runner with the offline heuristic player (tests and the sim CLI). */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Loads the starter scenario. `rounds` forces full-length games of that many rounds (no early
 * victory), which exercises more of the content in long simulations.
 */
export function loadStarter(options: { rounds?: number | undefined } = {}): CompiledGame {
  const json = JSON.parse(readFileSync(path.join(repoRoot, 'content/starter/star-chase.json'), 'utf8')) as { settings: { victory: { roundLimit: number; threshold: number } } };
  if (options.rounds !== undefined) {
    json.settings.victory.roundLimit = options.rounds;
    json.settings.victory.threshold = 99;
  }
  const loaded = loadGame(json);
  if (!loaded.ok) throw new Error(`starter scenario invalid:\n${loaded.errors.join('\n')}`);
  return loaded.game;
}

export { stateHash } from '../server/hash.ts';

export interface HeadlessResult {
  state: GameState;
  events: GameEvent[];
  archetypes: Map<string, Archetype>;
  decisions: number;
  forcedDecisions: number;
  faults: number;
  aborted: string | null;
  operations: number;
  /** Wall-clock milliseconds of each engine operation (excluding the fallback player's thinking). */
  opMs: number[];
}

export function runHeadlessMatch(game: CompiledGame, seed: string, options: { maxOperations?: number } = {}): HeadlessResult {
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
  for (const c of contestants) {
    const first = candidates.get(c.id)?.[0] ?? 'opportunist';
    archetypes.set(c.id, defaultStrategy(info, first, 0, 'casting').archetype);
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
      let optionId: string;
      if (decision.options.length === 1) {
        forced++;
        optionId = (decision.options[0] as { id: string }).id;
      } else {
        const view = buildContestantView(game, state, decision.actor, events);
        const persona = contestants.find((c) => c.id === decision.actor)?.persona;
        if (!persona) throw new Error('persona missing');
        optionId = chooseHeuristic(view, info, persona, archetypes.get(decision.actor) ?? null).optionId;
      }
      const t0 = performance.now();
      out = answerDecision(game, state, { decisionId: decision.id, optionId });
      opMs.push(performance.now() - t0);
    }
    if (!out.ok) {
      if (out.kind === 'aborted') return { state, events, archetypes, decisions, forcedDecisions: forced, faults, aborted: out.message, operations, opMs };
      throw new Error(`operation rejected: ${out.message}`);
    }
    state = out.state;
    events.push(...out.events);
    faults += out.faults.length;
  }
  return { state, events, archetypes, decisions, forcedDecisions: forced, faults, aborted: null, operations, opMs };
}
