import { prepareMind } from '../contestants/memory.ts';
import { newMind, type ContestantMind } from '../contestants/mind.ts';
import { namesFromView } from '../contestants/packet.ts';
import { advance, answerDecision, applyGmCommand, createMatch, loadGame, type CompiledGame, type FiringRecord, type OpOutcome } from '../engine/index.ts';
import { applyCosmeticChange, applyDefinitionChange } from '../engine/migrate.ts';
import { GmCommandSchema } from '../schema/commands.ts';
import type { GameEvent, GameState } from '../schema/state.ts';
import type { TradeOfferInput } from '../schema/trade.ts';
import { ENGINE_VERSION } from '../schema/versions.ts';
import { publicInfo } from '../visibility/public-info.ts';
import { visibleEventsAfter } from '../visibility/redact.ts';
import { buildContestantView } from '../visibility/view.ts';
import { stateHash } from './hash.ts';
import type { DefinitionChangeRecord, RulesVersion } from './session.ts';
import type { HistoryLine } from './store.ts';

/**
 * Re-simulation: the recorded operation inputs are run through the engine again from the match's
 * setup (the model is never called again), checking every recorded state hash. Used to rewind a
 * match to an earlier revision. Only valid with the engine version that recorded the match.
 */

export class ReplayError extends Error {
  override readonly name = 'ReplayError';
}

export interface Replayed {
  game: CompiledGame;
  state: GameState;
  events: GameEvent[];
  firings: FiringRecord[];
  rulesVersion: RulesVersion;
  /** The history lines up to and including the target revision. */
  kept: HistoryLine[];
}

function compileOrThrow(json: unknown, what: string): CompiledGame {
  const loaded = loadGame(json);
  if (!loaded.ok) throw new ReplayError(`${what} no longer compiles: ${loaded.errors.slice(0, 3).join('; ')}`);
  return loaded.game;
}

interface DecisionInput {
  decisionId: string;
  optionId: string;
  say?: string | null;
  trade?: TradeOfferInput | null;
  attempt?: string | null;
}

/** Replays `lines` from the setup up to revision `target` (inclusive). */
export function replay(lines: HistoryLine[], target: number): Replayed {
  const setup = lines[0];
  if (!setup || setup.kind !== 'setup') throw new ReplayError('the history does not start with the match setup');
  const input = setup.input as { matchId: string; seed: string; cast?: string[]; definition?: unknown; engineVersion?: string };
  if (input.definition === undefined) throw new ReplayError('this match was recorded before rewind was available (no starting definition)');
  if (input.engineVersion !== ENGINE_VERSION) throw new ReplayError(`this match was recorded with engine ${input.engineVersion ?? 'unknown'}; rewind needs the same engine (${ENGINE_VERSION})`);
  let game = compileOrThrow(input.definition, 'the starting definition');
  const created = createMatch(game, { matchId: input.matchId, seed: input.seed, ...(input.cast ? { cast: input.cast } : {}) });
  if (!created.ok) throw new ReplayError(`the match setup failed: ${created.message}`);
  let state = created.state;
  const events: GameEvent[] = [...created.events];
  const firings: FiringRecord[] = [];
  const rulesVersion: RulesVersion = { mechanical: 1, cosmetic: 0 };
  const check = (line: HistoryLine) => {
    if (state.rev !== line.rev) throw new ReplayError(`replay diverged at revision ${line.rev} (reached ${state.rev})`);
    if (line.hash !== undefined && stateHash(state) !== line.hash) throw new ReplayError(`replay diverged at revision ${line.rev} (different state)`);
  };
  check(setup);
  const kept: HistoryLine[] = [setup];
  for (const line of lines.slice(1)) {
    if (line.rev > target) break;
    let out: OpOutcome | null = null;
    switch (line.kind) {
      case 'auto':
        out = advance(game, state);
        break;
      case 'decision': {
        const d = line.input as DecisionInput;
        out = answerDecision(game, state, { decisionId: d.decisionId, optionId: d.optionId, say: d.say ?? undefined, trade: d.trade ?? undefined, attempt: d.attempt ?? undefined });
        break;
      }
      case 'gm': {
        const cmd = GmCommandSchema.safeParse(line.input);
        if (!cmd.success) throw new ReplayError(`GM command at revision ${line.rev} is no longer valid`);
        out = applyGmCommand(game, state, cmd.data);
        break;
      }
      case 'rules': {
        const change = line.input as DefinitionChangeRecord;
        const next = compileOrThrow(change.definition, `the rules change at revision ${line.rev}`);
        out = applyDefinitionChange(game, next, state, { answers: change.answers, version: change.rulesVersion.mechanical, summary: change.summary });
        game = next;
        rulesVersion.mechanical = change.rulesVersion.mechanical;
        rulesVersion.cosmetic = change.rulesVersion.cosmetic;
        break;
      }
      case 'cosmetic': {
        const change = line.input as DefinitionChangeRecord;
        game = compileOrThrow(change.definition, `the change at revision ${line.rev}`);
        state = applyCosmeticChange(game, state);
        rulesVersion.cosmetic = change.rulesVersion.cosmetic;
        break;
      }
      default:
        throw new ReplayError(`unknown operation "${line.kind}" at revision ${line.rev}`);
    }
    if (out) {
      if (!out.ok) throw new ReplayError(`operation at revision ${line.rev} failed on replay: ${out.message}`);
      state = out.state;
      events.push(...out.events);
      firings.push(...out.firings);
    }
    check(line);
    kept.push(line);
  }
  if (state.rev !== target) throw new ReplayError(`revision ${target} is not in the history`);
  return { game, state, events, firings, rulesVersion, kept };
}

/**
 * Contestant minds after a rewind: the strategy each had at that point, and memories and
 * relationships rebuilt by observing (again) the events it could see up to then.
 */
export function rewoundMinds(game: CompiledGame, state: GameState, events: GameEvent[], current: ContestantMind[]): ContestantMind[] {
  const info = publicInfo(game);
  return current.map((old) => {
    const all = [...old.strategyHistory, ...(old.strategy ? [old.strategy] : [])];
    let index = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      if ((all[i]?.adoptedAtRound ?? 0) <= state.round) {
        index = i;
        break;
      }
    }
    if (index < 0) index = 0;
    const mind = newMind(old.entityId, old.castId, old.candidates, old.controller);
    mind.strategy = all[index] ?? null;
    mind.strategyHistory = all.slice(0, index);
    if (state.entities[old.entityId]) {
      const view = buildContestantView(game, state, old.entityId, events);
      prepareMind(mind, view, info, visibleEventsAfter(game, events, old.entityId, 0), namesFromView(info, view));
    }
    return mind;
  });
}
