import type { MigrationIssue, MigrationPlan } from '../schema/proposal.ts';
import type { GameState } from '../schema/state.ts';
import type { CompiledGame } from './compile.ts';
import type { OpContext } from './context.ts';
import { clampDependents, removeEntity, removeItem, removeTag, spawnEnemy, teleport } from './effects.ts';
import { runOperation, runRoot, type OpOutcome } from './resolve.ts';
import { cloneJson, InvalidInput } from './util.ts';

/**
 * Changing a match's definition while it is running. `planMigration` lists what the change means
 * for the current state: steps that happen automatically, steps the GM must confirm (and choose how),
 * and changes that cannot be applied mid-match at all (blocked, with an explanation).
 * `applyDefinitionChange` then runs the whole change as one operation, so the waiting decision is
 * withdrawn and asked again under the new rules.
 */

export type { MigrationIssue, MigrationPlan };

function nameOf(list: Map<string, { name: string }>, id: string): string {
  return list.get(id)?.name ?? id;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Live entities (tombstones excluded). */
function liveEntities(state: GameState) {
  return Object.values(state.entities).filter((e) => e.status !== 'removed');
}

export function planMigration(oldGame: CompiledGame, newGame: CompiledGame, state: GameState): MigrationPlan {
  const issues: MigrationIssue[] = [];
  const add = (issue: MigrationIssue) => issues.push(issue);
  const entities = liveEntities(state);

  // --- resources ----------------------------------------------------------------------------
  for (const r of newGame.def.resources) {
    const old = oldGame.resources.get(r.id);
    const newKinds = old ? r.appliesTo.filter((k) => !old.appliesTo.includes(k)) : r.appliesTo;
    const receivers = entities.filter((e) => newKinds.includes(e.kind) && e.resources[r.id] === undefined);
    if (receivers.length > 0) add({ id: `resource.added:${r.id}`, severity: 'auto', title: `${r.name} is added`, detail: `${plural(receivers.length, 'entity', 'entities')} start with ${r.default} ${r.name}.` });
    if (!old) continue;
    if (old.role !== r.role) {
      add({ id: `resource.role:${r.id}`, severity: 'blocked', title: `${r.name} changes from a ${old.role} to a ${r.role}`, detail: `Existing values cannot be converted mid-match. Add a new resource instead, or make this change before a match starts.` });
      continue;
    }
    const dropped = entities.filter((e) => !r.appliesTo.includes(e.kind) && e.resources[r.id] !== undefined);
    if (dropped.length > 0) {
      add({ id: `resource.appliesTo:${r.id}`, severity: 'confirm', title: `${plural(dropped.length, 'entity', 'entities')} will no longer have ${r.name}`, detail: `Their current ${r.name} is deleted.`, options: [{ id: 'drop', label: `Delete their ${r.name}` }] });
    }
    const outside = entities.filter((e) => {
      const v = e.resources[r.id];
      return v !== undefined && (v < r.min || (r.max !== null && v > r.max));
    });
    if (outside.length > 0) {
      add({
        id: `resource.bounds:${r.id}`,
        severity: 'confirm',
        title: `${plural(outside.length, 'entity', 'entities')} ${outside.length === 1 ? 'has' : 'have'} ${r.name} outside the new bounds (${r.min}–${r.max ?? '∞'})`,
        detail: outside.map((e) => `${e.name}: ${e.resources[r.id]}`).join(', '),
        options: [{ id: 'clamp', label: 'Clamp them into the new bounds' }],
      });
    }
  }
  for (const r of oldGame.def.resources) {
    if (newGame.resources.has(r.id)) continue;
    const holders = entities.filter((e) => e.resources[r.id] !== undefined);
    if (holders.length > 0) add({ id: `resource.removed:${r.id}`, severity: 'confirm', title: `${r.name} is deleted`, detail: `${plural(holders.length, 'entity', 'entities')} lose their ${r.name}.`, options: [{ id: 'drop', label: `Delete everyone's ${r.name}` }] });
  }

  // --- tags ---------------------------------------------------------------------------------
  for (const t of oldGame.def.tags) {
    if (newGame.tags.has(t.id)) continue;
    const tagged = entities.filter((e) => e.tags.includes(t.id));
    if (tagged.length > 0) add({ id: `tag.removed:${t.id}`, severity: 'auto', title: `Tag ${t.name} is deleted`, detail: `It is removed from ${plural(tagged.length, 'entity', 'entities')}.` });
  }

  // --- spaces -------------------------------------------------------------------------------
  const standing = entities.filter((e) => e.spaceId !== null && !newGame.spaces.has(e.spaceId));
  if (standing.length > 0) {
    add({
      id: 'space.removed',
      severity: 'confirm',
      title: `${plural(standing.length, 'entity', 'entities')} stand on deleted spaces`,
      detail: `${standing.map((e) => `${e.name} (${nameOf(oldGame.spaces, e.spaceId ?? '')})`).join(', ')}.`,
      options: [{ id: 'move', label: `Move them to ${nameOf(newGame.spaces, newGame.def.settings.startSpace)} (not a landing)` }],
    });
  }

  // --- items --------------------------------------------------------------------------------
  const itemsOf = (defId: string) => Object.values(state.items).filter((i) => i.defId === defId);
  for (const i of oldGame.def.items) {
    if (newGame.items.has(i.id)) continue;
    const held = itemsOf(i.id);
    if (held.length > 0) add({ id: `item.removed:${i.id}`, severity: 'confirm', title: `${i.name} is deleted`, detail: `${plural(held.length, 'copy', 'copies')} ${held.length === 1 ? 'is' : 'are'} held right now.`, options: [{ id: 'remove', label: 'Take them away from their holders' }] });
  }
  const cap = newGame.def.settings.inventoryCapacity;
  if (cap < oldGame.def.settings.inventoryCapacity) {
    const over = entities.filter((e) => e.items.length > cap);
    if (over.length > 0) add({ id: 'inventory.capacity', severity: 'confirm', title: `Inventory shrinks to ${cap}`, detail: `${over.map((e) => `${e.name} holds ${e.items.length}`).join(', ')}.`, options: [{ id: 'drop', label: 'Drop their newest items beyond the limit' }] });
  }

  // --- statuses -----------------------------------------------------------------------------
  for (const st of oldGame.def.statuses) {
    const holders = entities.filter((e) => e.statuses.some((x) => x.defId === st.id));
    if (holders.length === 0) continue;
    const next = newGame.statuses.get(st.id);
    if (!next) add({ id: `status.removed:${st.id}`, severity: 'confirm', title: `Status ${st.name} is deleted`, detail: `It ends on ${holders.map((e) => e.name).join(', ')}.`, options: [{ id: 'remove', label: 'End it on them' }] });
    else if (next.maxStacks < st.maxStacks && holders.some((e) => (e.statuses.find((x) => x.defId === st.id)?.stacks ?? 0) > next.maxStacks)) {
      add({ id: `status.stacks:${st.id}`, severity: 'auto', title: `${st.name} stacks are capped at ${next.maxStacks}`, detail: 'Extra stacks are removed.' });
    }
  }

  // --- enemies and fixtures -----------------------------------------------------------------
  for (const en of oldGame.def.enemies) {
    const onBoard = entities.filter((e) => e.kind === 'enemy' && e.defId === en.id);
    if (onBoard.length === 0) continue;
    const next = newGame.enemies.get(en.id);
    if (!next) {
      add({ id: `enemy.removed:${en.id}`, severity: 'confirm', title: `Enemy ${en.name} is deleted`, detail: `${plural(onBoard.length, 'copy', 'copies')} ${onBoard.length === 1 ? 'is' : 'are'} in the match.`, options: [{ id: 'remove', label: 'Take them off the board for good' }] });
    } else if (next.power !== en.power || next.maxHp !== en.maxHp) {
      add({
        id: `enemy.stats:${en.id}`,
        severity: 'confirm',
        title: `${en.name}: ${en.power !== next.power ? `Power ${en.power} → ${next.power}` : ''}${en.power !== next.power && en.maxHp !== next.maxHp ? ', ' : ''}${en.maxHp !== next.maxHp ? `max HP ${en.maxHp} → ${next.maxHp}` : ''}`,
        detail: `${plural(onBoard.length, 'copy', 'copies')} ${onBoard.length === 1 ? 'is' : 'are'} already in the match.`,
        options: [
          { id: 'update', label: 'Give the ones already in play the new values' },
          { id: 'keep', label: 'Keep their current values (only new ones use the new stats)' },
        ],
      });
    }
  }
  for (const en of newGame.def.enemies) {
    if (!oldGame.enemies.has(en.id) && en.spawns.length > 0) add({ id: `enemy.added:${en.id}`, severity: 'auto', title: `${en.name} is added`, detail: `${plural(en.spawns.length, 'copy', 'copies')} appear at ${en.spawns.map((s) => nameOf(newGame.spaces, s)).join(', ')}.` });
  }
  for (const f of oldGame.def.fixtures) {
    if (newGame.fixtures.has(f.id)) continue;
    const onBoard = entities.filter((e) => e.kind === 'fixture' && e.defId === f.id);
    if (onBoard.length > 0) add({ id: `fixture.removed:${f.id}`, severity: 'confirm', title: `${f.name} is deleted`, detail: 'It is taken off the board (its shop closes).', options: [{ id: 'remove', label: 'Take it off the board' }] });
  }
  for (const f of newGame.def.fixtures) {
    if (!oldGame.fixtures.has(f.id)) add({ id: `fixture.added:${f.id}`, severity: 'auto', title: `${f.name} is added`, detail: 'It appears on the board now.' });
  }

  // --- cast ---------------------------------------------------------------------------------
  for (const id of state.turnOrder) {
    const e = state.entities[id];
    if (e && !newGame.cast.has(e.defId)) add({ id: `cast.removed:${e.defId}`, severity: 'blocked', title: `${e.name} is playing in this match`, detail: 'Contestants cannot be removed mid-match. Knock them out or eliminate them instead, or keep their cast entry.' });
  }

  // --- decks --------------------------------------------------------------------------------
  for (const d of newGame.def.decks) {
    const pile = state.decks[d.id];
    if (!pile) {
      add({ id: `deck.added:${d.id}`, severity: 'auto', title: `Deck ${d.name} is added`, detail: 'It is shuffled with the match dice.' });
      continue;
    }
    const known = new Set(d.cards.map((c) => c.id));
    const gone = [...pile.draw, ...pile.discard].filter((c) => !known.has(c)).length;
    const counts = new Map<string, number>();
    for (const c of [...pile.draw, ...pile.discard]) counts.set(c, (counts.get(c) ?? 0) + 1);
    const extra = d.cards.reduce((n, c) => n + Math.max(0, c.count - (counts.get(c.id) ?? 0)), 0);
    const excess = d.cards.reduce((n, c) => n + Math.max(0, (counts.get(c.id) ?? 0) - c.count), 0);
    if (gone + extra + excess > 0) {
      add({
        id: `deck.cards:${d.id}`,
        severity: 'auto',
        title: `Deck ${d.name} changes`,
        detail: [gone + excess > 0 ? `${plural(gone + excess, 'card')} leave the piles` : '', extra > 0 ? `${plural(extra, 'card')} are shuffled into the draw pile` : ''].filter(Boolean).join('; '),
      });
    }
  }
  for (const id of Object.keys(state.decks)) {
    if (!newGame.decks.has(id)) add({ id: `deck.removed:${id}`, severity: 'auto', title: `Deck ${nameOf(oldGame.decks, id)} is deleted`, detail: 'Its piles are dropped.' });
  }

  // --- objectives, choices, trades, promises ------------------------------------------------
  for (const o of oldGame.def.objectives) {
    if (newGame.objectives.has(o.id)) continue;
    const held = state.objectives.filter((x) => x.defId === o.id && !x.done);
    if (held.length > 0) add({ id: `objective.removed:${o.id}`, severity: 'confirm', title: `Objective ${o.name} is deleted`, detail: `${plural(held.length, 'contestant')} ${held.length === 1 ? 'holds' : 'hold'} it.`, options: [{ id: 'remove', label: 'Take it away' }] });
  }
  const orphaned = state.queue.filter((c) => c.rule !== undefined && !newGame.rules.has(c.rule));
  if (orphaned.length > 0) add({ id: 'queue.orphaned', severity: 'auto', title: `${plural(orphaned.length, 'waiting choice')} came from deleted rules`, detail: 'They are withdrawn.' });
  if (state.negotiation && tradeBroken(newGame, state)) add({ id: 'trade.withdrawn', severity: 'auto', title: 'The open trade offer is withdrawn', detail: 'Something in it can no longer be traded.' });
  const voided = state.commitments.filter((c) => c.status === 'open' && c.resource !== null && newGame.resources.get(c.resource)?.tradeable !== true);
  if (voided.length > 0) add({ id: 'promises.void', severity: 'auto', title: `${plural(voided.length, 'payment promise')} lapse`, detail: 'The promised resource can no longer be traded.' });

  // --- settings -----------------------------------------------------------------------------
  const v0 = oldGame.def.settings.victory;
  const v1 = newGame.def.settings.victory;
  if (JSON.stringify(v0) !== JSON.stringify(v1)) add({ id: 'victory', severity: 'auto', title: 'The victory condition changes', detail: `It is checked from the next end of round (round ${state.round}).` });

  return { issues, blocked: issues.some((i) => i.severity === 'blocked') };
}

function tradeBroken(game: CompiledGame, state: GameState): boolean {
  const n = state.negotiation;
  if (!n) return false;
  const res = [...Object.keys(n.terms.give.resources), ...Object.keys(n.terms.get.resources)];
  const items = [...n.terms.give.items, ...n.terms.get.items].map((i) => state.items[i]?.defId ?? '');
  return res.some((r) => game.resources.get(r)?.tradeable !== true) || items.some((d) => { const def = game.items.get(d); return !def || !def.tradeable || def.concealed; });
}

function shuffleInto(ctx: OpContext, list: string[], cards: string[]): void {
  for (const c of cards) list.splice(ctx.random(list.length + 1), 0, c);
}

export interface DefinitionChangeInput {
  /** Answers to `confirm` issues: issue id → option id. */
  answers: Record<string, string>;
  /** The ruleset's new mechanical version (shown to everyone). */
  version: number;
  /** Public summary of the change (no hidden rules). */
  summary: string[];
}

/**
 * Applies a definition change to a running match as one operation under the new rules. Every
 * `confirm` issue needs an answer; blocked changes are refused. The waiting decision is withdrawn
 * and issued again (with a new id) by the new rules.
 */
export function applyDefinitionChange(oldGame: CompiledGame, newGame: CompiledGame, state: GameState, input: DefinitionChangeInput): OpOutcome {
  const plan = planMigration(oldGame, newGame, state);
  const blocked = plan.issues.find((i) => i.severity === 'blocked');
  if (blocked) return { ok: false, kind: 'invalid', message: `${blocked.title}: ${blocked.detail}` };
  const missing = plan.issues.find((i) => i.severity === 'confirm' && !(i.options ?? []).some((o) => o.id === input.answers[i.id]));
  if (missing) return { ok: false, kind: 'invalid', message: `needs confirmation: ${missing.title}` };
  const answer = (id: string) => input.answers[id];

  return runOperation(newGame, state, (ctx) => {
    const cause = { kind: 'gm' as const };
    const invalidated = ctx.state.pendingDecision?.id ?? null;
    ctx.state.definitionId = newGame.def.id;
    runRoot(
      ctx,
      () => {
        const live = () => liveEntities(ctx.state);
        // Resources: new ones start at their default; deleted or no longer applicable ones are dropped.
        for (const e of live()) {
          for (const r of newGame.def.resources) if (r.appliesTo.includes(e.kind) && e.resources[r.id] === undefined) e.resources[r.id] = r.default;
          for (const key of Object.keys(e.resources)) {
            const r = newGame.resources.get(key);
            if (!r || !r.appliesTo.includes(e.kind)) delete e.resources[key];
          }
        }
        // Bounds: clamp base values (confirmed above), then pools bounded by other stats.
        for (const r of newGame.def.resources) {
          if (answer(`resource.bounds:${r.id}`) !== 'clamp') continue;
          for (const e of live()) {
            const v = e.resources[r.id];
            if (v === undefined) continue;
            e.resources[r.id] = Math.max(r.min, r.max === null ? v : Math.min(r.max, v));
          }
        }
        // Tags that no longer exist.
        for (const e of live()) for (const t of [...e.tags]) if (!newGame.tags.has(t)) removeTag(ctx, e.id, t, cause);
        // Items of deleted definitions; inventories over a smaller capacity.
        for (const item of Object.values(ctx.state.items)) {
          if (!newGame.items.has(item.defId)) removeItem(ctx, item.holder, item.id, cause, 'removed');
        }
        if (answer('inventory.capacity') === 'drop') {
          for (const e of live()) while (e.items.length > newGame.def.settings.inventoryCapacity) removeItem(ctx, e.id, e.items[e.items.length - 1] as string, cause, 'removed');
        }
        // Statuses of deleted definitions (hidden ones quietly), stack caps.
        for (const e of live()) {
          for (const inst of [...e.statuses]) {
            const def = newGame.statuses.get(inst.defId);
            if (!def) {
              e.statuses = e.statuses.filter((x) => x !== inst);
              const hidden = oldGame.statuses.get(inst.defId)?.visibility === 'hidden';
              ctx.emit({ type: 'statusRemoved', entity: e.id, status: inst.defId, stacks: inst.stacks, left: 0, reason: 'removed' }, cause, hidden ? 'gm' : 'all');
            } else if (inst.stacks > def.maxStacks) inst.stacks = def.maxStacks;
          }
        }
        // Enemies and fixtures.
        for (const e of live()) {
          if (e.kind === 'enemy') {
            const def = newGame.enemies.get(e.defId);
            if (!def) removeEntity(ctx, e.id, cause);
            else if (answer(`enemy.stats:${e.defId}`) === 'update') {
              const { core } = newGame.def.settings;
              e.resources[core.power] = def.power;
              e.resources[core.maxHp] = def.maxHp;
              clampDependents(ctx, e.id, core.maxHp, cause);
            }
          } else if (e.kind === 'fixture' && !newGame.fixtures.has(e.defId)) removeEntity(ctx, e.id, cause);
        }
        for (const en of newGame.def.enemies) if (!oldGame.enemies.has(en.id)) for (const space of en.spawns) spawnEnemy(ctx, en.id, space, cause);
        for (const f of newGame.def.fixtures) {
          if (oldGame.fixtures.has(f.id)) continue;
          let space: string;
          if ('space' in f.start) space = f.start.space;
          else {
            const tag = f.start.randomSpaceTag;
            const candidates = newGame.spaceOrder.filter((id) => newGame.spaces.get(id)?.tags.includes(tag));
            if (candidates.length === 0) throw new InvalidInput(`no space tagged ${tag} for ${f.name}`);
            space = candidates[ctx.random(candidates.length)] as string;
          }
          ctx.state.counters.entity += 1;
          const id = `e${ctx.state.counters.entity}`;
          const resources: Record<string, number> = {};
          for (const r of newGame.def.resources) if (r.appliesTo.includes('fixture')) resources[r.id] = r.default;
          ctx.state.entities[id] = { id, kind: 'fixture', defId: f.id, name: f.name, spaceId: space, resources, tags: [...f.tags], items: [], statuses: [], status: 'active', respawnRound: null, koTurns: 0 };
          ctx.emit({ type: 'entered', entity: id, space, mode: 'teleport' }, cause);
        }
        // Entities standing on deleted spaces.
        for (const e of live()) {
          if (e.spaceId !== null && !newGame.spaces.has(e.spaceId)) {
            e.spaceId = null;
            teleport(ctx, e.id, newGame.def.settings.startSpace, false, cause);
          }
        }
        // Names follow the definitions (renaming is cosmetic).
        for (const e of Object.values(ctx.state.entities)) {
          const def = e.kind === 'contestant' ? newGame.cast.get(e.defId) : e.kind === 'enemy' ? newGame.enemies.get(e.defId) : newGame.fixtures.get(e.defId);
          if (def) e.name = def.name;
        }
        // Decks: new ones are shuffled, deleted ones dropped, piles follow card counts.
        for (const id of Object.keys(ctx.state.decks)) if (!newGame.decks.has(id)) delete ctx.state.decks[id];
        for (const d of newGame.def.decks) {
          const pile = ctx.state.decks[d.id] ?? { draw: [], discard: [] };
          ctx.state.decks[d.id] = pile;
          for (const card of d.cards) {
            const present = [...pile.draw, ...pile.discard].filter((c) => c === card.id).length;
            let excess = present - card.count;
            for (const list of [pile.discard, pile.draw]) {
              for (let i = list.length - 1; i >= 0 && excess > 0; i--) {
                if (list[i] === card.id) {
                  list.splice(i, 1);
                  excess--;
                }
              }
            }
            if (present < card.count) shuffleInto(ctx, pile.draw, Array.from({ length: card.count - present }, () => card.id));
          }
          const known = new Set(d.cards.map((c) => c.id));
          pile.draw = pile.draw.filter((c) => known.has(c));
          pile.discard = pile.discard.filter((c) => known.has(c));
        }
        // Objectives, cooldowns, rule counters, waiting choices, trades and promises.
        ctx.state.objectives = ctx.state.objectives.filter((o) => newGame.objectives.has(o.defId));
        for (const key of Object.keys(ctx.state.cooldowns)) {
          const action = key.split(':')[0] as string;
          if (action !== 'freeform' && !newGame.actions.has(action)) delete ctx.state.cooldowns[key];
        }
        for (const key of Object.keys(ctx.state.ruleCounters)) if (!newGame.rules.has(key.split('@')[0] as string)) delete ctx.state.ruleCounters[key];
        ctx.state.queue = ctx.state.queue.filter((c) => c.rule === undefined || newGame.rules.has(c.rule));
        if (tradeBroken(newGame, ctx.state) && ctx.state.negotiation) {
          const n = ctx.state.negotiation;
          ctx.state.negotiation = null;
          ctx.emit({ type: 'tradeFailed', negotiation: n.id, from: n.from, to: n.to, reason: 'the rules changed' }, cause, [n.from, n.to]);
        }
        for (const c of ctx.state.commitments) if (c.status === 'open' && c.resource !== null && newGame.resources.get(c.resource)?.tradeable !== true) c.status = 'void';
        // A change contestants cannot see (hidden rules only) is not announced to them.
        ctx.emit({ type: 'rulesChanged', version: input.version, summary: input.summary, invalidated }, cause, input.summary.length > 0 ? 'all' : 'gm');
      },
      { reactions: false },
    );
  });
}

/**
 * A purely cosmetic change (names, descriptions, icons, layout): entity names follow the new
 * definitions; nothing else changes, no decision is withdrawn and the revision stays the same.
 */
export function applyCosmeticChange(newGame: CompiledGame, state: GameState): GameState {
  const next = cloneJson(state);
  for (const e of Object.values(next.entities)) {
    const def = e.kind === 'contestant' ? newGame.cast.get(e.defId) : e.kind === 'enemy' ? newGame.enemies.get(e.defId) : newGame.fixtures.get(e.defId);
    if (def) e.name = def.name;
  }
  return next;
}

