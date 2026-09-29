import type { CompiledGame } from '../engine/compile.ts';
import { cloneJson } from '../engine/util.ts';
import type { GameEvent, GameState } from '../schema/state.ts';

/**
 * The single place where hidden information is removed. Everything a contestant sees — views,
 * previews, packets, fallback choices — is derived from the redacted state and filtered events.
 */

/** Resource ids the viewer may see on a given entity. */
export function visibleResourceIds(game: CompiledGame, viewer: string, entityId: string): Set<string> {
  const out = new Set<string>();
  for (const r of game.resources.values()) {
    if (r.visibility === 'public') out.add(r.id);
    else if (r.visibility === 'owner' && entityId === viewer) out.add(r.id);
  }
  return out;
}

/** A copy of the state with every value the viewer may not know removed or zeroed. */
export function redactStateFor(game: CompiledGame, state: GameState, viewer: string): GameState {
  const copy = cloneJson(state);
  copy.seed = '';
  copy.rng = [0, 0, 0, 0];
  // Counters would reveal how many hidden events happened.
  copy.counters = { entity: 0, item: 0, event: 0, decision: 0, fight: 0 };
  copy.rev = 0;
  if (copy.pendingDecision && copy.pendingDecision.actor !== viewer) copy.pendingDecision = null;
  if (copy.pendingDecision) copy.pendingDecision.issuedRev = 0;
  for (const entity of Object.values(copy.entities)) {
    const allowed = visibleResourceIds(game, viewer, entity.id);
    for (const key of Object.keys(entity.resources)) if (!allowed.has(key)) delete entity.resources[key];
  }
  for (const ruleId of Object.keys(copy.ruleCounters)) {
    if (game.rules.get(ruleId)?.def.visibility !== 'public') delete copy.ruleCounters[ruleId];
  }
  return copy;
}

export interface VisibleEvent {
  seq: number;
  round: number;
  type: GameEvent['type'];
  /** True when a hidden rule caused this event; the cause is not revealed. */
  unknownCause: boolean;
  event: GameEvent;
}

function canSee(e: GameEvent, viewer: string): boolean {
  if (e.audience === 'all') return true;
  if (e.audience === 'gm') return false;
  return e.audience.includes(viewer);
}

/** Events the viewer observed, with hidden-rule causes stripped. */
export function visibleEvents(game: CompiledGame, events: GameEvent[], viewer: string): VisibleEvent[] {
  const out: VisibleEvent[] = [];
  for (const e of events) {
    if (!canSee(e, viewer)) continue;
    const hiddenRule = e.cause.rule !== undefined && game.rules.get(e.cause.rule)?.def.visibility !== 'public';
    if (e.type === 'ruleFault' && hiddenRule) continue;
    const event: GameEvent = hiddenRule ? { ...e, cause: { kind: 'rule' } } : { ...e, cause: { ...e.cause, firing: undefined } };
    if (event.type === 'matchStarted') (event as { seed: string }).seed = '';
    out.push({ seq: e.seq, round: e.round, type: e.type, unknownCause: hiddenRule, event });
  }
  return out;
}
