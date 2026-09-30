import type { CompiledGame, CompiledRule } from '../engine/compile.ts';
import { cloneJson } from '../engine/util.ts';
import type { GameEvent, GameState, ModRecord } from '../schema/state.ts';

/**
 * The single place where hidden information is removed. Everything a contestant sees — views,
 * previews, packets, fallback choices — is derived from the redacted state, the contestant-facing
 * game (hidden rules removed) and filtered events.
 */

const viewGames = new WeakMap<CompiledGame, CompiledGame>();

/**
 * The game as contestants know it: hidden reactions, modifiers and continuous rules are removed,
 * so previews, effective values and odds computed for a contestant never include them.
 */
export function viewGame(game: CompiledGame): CompiledGame {
  const cached = viewGames.get(game);
  if (cached) return cached;
  const isPublic = (r: CompiledRule) => r.def.visibility === 'public';
  const ruleIndex = new Map([...game.ruleIndex].map(([k, list]) => [k, list.filter(isPublic)] as const));
  const modifierIndex = new Map([...game.modifierIndex].map(([k, list]) => [k, list.filter(isPublic)] as const).filter(([, list]) => list.length > 0));
  const view: CompiledGame = { ...game, ruleIndex, modifierIndex, continuous: game.continuous.filter(isPublic) };
  viewGames.set(game, view);
  viewGames.set(view, view);
  return view;
}

/** Marks a queued choice offered by a hidden rule in a redacted state (its effects are unknown). */
export const HIDDEN_RULE = '?';

export function isHiddenRule(game: CompiledGame, ruleId: string | undefined): boolean {
  if (ruleId === undefined) return false;
  const rule = game.rules.get(ruleId);
  return rule !== undefined && rule.def.visibility !== 'public';
}

/** Resource ids the viewer may see on a given entity. */
export function visibleResourceIds(game: CompiledGame, viewer: string, entityId: string): Set<string> {
  const out = new Set<string>();
  for (const r of game.resources.values()) {
    if (r.visibility === 'public') out.add(r.id);
    else if (r.visibility === 'owner' && entityId === viewer) out.add(r.id);
  }
  return out;
}

export function isConcealedItem(game: CompiledGame, itemDefId: string): boolean {
  return game.items.get(itemDefId)?.concealed === true;
}

/** A copy of the state with every value the viewer may not know removed or zeroed. */
export function redactStateFor(game: CompiledGame, state: GameState, viewer: string): GameState {
  const copy = cloneJson(state);
  copy.seed = '';
  copy.rng = [0, 0, 0, 0];
  // Counters would reveal how many hidden events happened.
  copy.counters = { entity: 0, item: 0, event: 0, decision: 0, fight: 0, status: 0, choice: 0, objective: 0, trade: 0, commitment: 0 };
  copy.rev = 0;
  if (copy.pendingDecision && copy.pendingDecision.actor !== viewer) copy.pendingDecision = null;
  if (copy.pendingDecision) copy.pendingDecision.issuedRev = 0;
  for (const entity of Object.values(copy.entities)) {
    const allowed = visibleResourceIds(game, viewer, entity.id);
    for (const key of Object.keys(entity.resources)) if (!allowed.has(key)) delete entity.resources[key];
    // Hidden statuses are invisible to everyone; instance ids would leak how many were applied.
    entity.statuses = entity.statuses
      .filter((s) => game.statuses.get(s.defId)?.visibility !== 'hidden')
      .map((s) => ({ ...s, id: `${entity.id}:${s.defId}` }));
  }
  for (const item of Object.values(copy.items)) {
    if (item.holder !== viewer && isConcealedItem(game, item.defId)) item.defId = 'concealed';
  }
  // Pile sizes and the discard pile are public; the order of the draw pile is not.
  for (const pile of Object.values(copy.decks)) pile.draw = pile.draw.map(() => '?');
  // Only the viewer's own queued choices; a choice offered by a hidden rule shows labels, not effects.
  copy.queue = copy.queue
    .filter((c) => c.chooser === viewer)
    .map((c) => {
      if (!isHiddenRule(game, c.rule)) return c;
      return { ...c, rule: HIDDEN_RULE, options: c.options.map((o) => ({ id: o.id, label: o.label, effects: [] })) };
    });
  // Objectives are secret until completed: others only know that one exists.
  copy.objectives = copy.objectives.map((o) => (o.owner === viewer || o.done ? o : { ...o, defId: 'hidden', progress: 0 }));
  // A negotiation is private to its two parties (promises become public once a trade is done).
  if (copy.negotiation && copy.negotiation.from !== viewer && copy.negotiation.to !== viewer) copy.negotiation = null;
  for (const key of Object.keys(copy.ruleCounters)) {
    const ruleId = key.split('@')[0] as string;
    if (game.rules.get(ruleId)?.def.visibility !== 'public') delete copy.ruleCounters[key];
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

function publicMods(game: CompiledGame, mods: ModRecord[] | undefined): ModRecord[] | undefined {
  if (!mods) return undefined;
  const kept = mods.filter((m) => !isHiddenRule(game, m.rule));
  return kept.length > 0 ? kept : undefined;
}

/** Events the viewer observed, with hidden-rule causes, hidden modifiers and concealed items stripped. */
export function visibleEvents(game: CompiledGame, events: GameEvent[], viewer: string): VisibleEvent[] {
  const out: VisibleEvent[] = [];
  for (const e of events) {
    if (!canSee(e, viewer)) continue;
    const hiddenRule = isHiddenRule(game, e.cause.rule);
    if (e.type === 'ruleFault' && (hiddenRule || isHiddenRule(game, e.rule))) continue;
    const event = (hiddenRule ? { ...e, cause: { kind: 'rule' } } : { ...e, cause: { ...e.cause, firing: undefined } }) as GameEvent & Record<string, unknown>;
    if (event.type === 'matchStarted') event.seed = '';
    if ('mods' in event && Array.isArray(event.mods)) {
      const mods = publicMods(game, event.mods as ModRecord[]);
      if (mods) event.mods = mods;
      else delete event.mods;
    }
    if ((event.type === 'itemGained' || event.type === 'itemLost' || event.type === 'itemUsed') && event.entity !== viewer && isConcealedItem(game, event.itemDef)) {
      event.itemDef = 'concealed';
    }
    if (event.type === 'purchased' && event.entity !== viewer) {
      const grants = game.shopEntries.get(event.entry)?.entry.grants;
      if (grants && 'item' in grants && isConcealedItem(game, grants.item)) event.entry = 'concealed';
    }
    out.push({ seq: e.seq, round: e.round, type: e.type, unknownCause: hiddenRule, event });
  }
  return out;
}

/** Visible events with a sequence number above `afterSeq` (history must be in sequence order). */
export function visibleEventsAfter(game: CompiledGame, history: GameEvent[], viewer: string, afterSeq: number): VisibleEvent[] {
  let lo = 0;
  let hi = history.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((history[mid] as GameEvent).seq <= afterSeq) lo = mid + 1;
    else hi = mid;
  }
  return visibleEvents(game, history.slice(lo), viewer);
}

/** The last `limit` events the viewer could see, found by scanning back from the end. */
export function recentVisibleEvents(game: CompiledGame, history: GameEvent[], viewer: string, limit: number): VisibleEvent[] {
  const picked: GameEvent[] = [];
  for (let i = history.length - 1; i >= 0 && picked.length < limit; i--) {
    const e = history[i] as GameEvent;
    if (canSee(e, viewer)) picked.push(e);
  }
  // Redaction may drop a few more (faults of hidden rules); that only shortens the window.
  return visibleEvents(game, picked.reverse(), viewer);
}
