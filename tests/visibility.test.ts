import { describe, expect, it } from 'vitest';
import { loadStarter } from '../src/cli/headless.ts';
import { chooseHeuristic } from '../src/contestants/heuristic.ts';
import { prepareMind, selectMemories } from '../src/contestants/memory.ts';
import { newMind, type ContestantMind } from '../src/contestants/mind.ts';
import { buildDecisionPacket, namesFromView } from '../src/contestants/packet.ts';
import { advance, answerDecision, applyGmCommand, cloneJson, compileGame, createMatch, nextStepKind, type CompiledGame } from '../src/engine/index.ts';
import { GmCommandSchema } from '../src/schema/commands.ts';
import { GameDefinitionSchema } from '../src/schema/definition.ts';
import type { GameEvent, GameState } from '../src/schema/state.ts';
import { publicInfo } from '../src/visibility/public-info.ts';
import { visibleEvents } from '../src/visibility/redact.ts';
import { buildContestantView } from '../src/visibility/view.ts';

/**
 * Hidden-information pairs: states that differ only in what a contestant may not know must
 * produce identical packets, options, previews and fallback choices for that contestant.
 */

const starter = loadStarter();

function playUntil(game: CompiledGame, seed: string, operations: number): { state: GameState; events: GameEvent[] } {
  const created = createMatch(game, { matchId: 'vis', seed });
  if (!created.ok) throw new Error('create failed');
  let state = created.state;
  const events = [...created.events];
  for (let i = 0; i < operations && nextStepKind(state) !== 'gameOver'; i++) {
    const out =
      nextStepKind(state) === 'auto'
        ? advance(game, state)
        : answerDecision(game, state, { decisionId: state.pendingDecision?.id as string, optionId: state.pendingDecision?.options.filter((o) => o.kind !== 'trade' && o.id !== 'tr:counter').at(-1)?.id as string });
    if (!out.ok) throw new Error(out.message);
    state = out.state;
    events.push(...out.events);
  }
  // Stop at a decision so there is a packet to compare.
  while (nextStepKind(state) === 'auto') {
    const out = advance(game, state);
    if (!out.ok) throw new Error(out.message);
    state = out.state;
    events.push(...out.events);
  }
  return { state, events };
}

/**
 * Everything a contestant's decision depends on. The mind is built the way the coordinator builds
 * it: from the events this contestant could see (memories, relationships, flags).
 */
function packetFor(game: CompiledGame, state: GameState, events: GameEvent[], viewer: string) {
  const info = publicInfo(game);
  const view = buildContestantView(game, state, viewer, events);
  const castId = state.entities[viewer]?.defId as string;
  const persona = game.cast.get(castId)?.persona;
  if (!persona) throw new Error('persona');
  const mind: ContestantMind = newMind(viewer, castId, ['opportunist'], 'llm');
  prepareMind(mind, view, info, visibleEvents(game, events, viewer), namesFromView(info, view));
  const packet = buildDecisionPacket(info, view, mind, persona);
  const choice = chooseHeuristic(view, info, persona, 'opportunist', mind);
  return {
    text: `${packet.instructions}\n---\n${packet.input}`,
    options: view.decision?.options.map((o) => o.id),
    previews: JSON.stringify(view.decision?.previews),
    choice: choice.optionId,
    trade: JSON.stringify(choice.trade ?? null),
    memories: selectMemories(mind, view),
    relationships: JSON.stringify(mind.relationships),
  };
}

describe('hidden-information pairs', () => {
  const base = playUntil(starter, 'pairs', 140);
  const viewer = base.state.pendingDecision?.actor as string;
  const other = base.state.turnOrder.find((id) => id !== viewer) as string;

  it('another contestant’s secret Stash, the RNG state and the seed do not change the packet', () => {
    const variant = cloneJson(base.state);
    (variant.entities[other] as { resources: Record<string, number> }).resources['res.stash'] = 999;
    variant.rng = [1, 2, 3, 4];
    variant.seed = 'another-seed';
    variant.counters.event += 17;
    const a = packetFor(starter, base.state, base.events, viewer);
    const b = packetFor(starter, variant, base.events, viewer);
    expect(b).toEqual(a);
  });

  it('owner-only events of other contestants leave no trace in the packet', () => {
    const hiddenEvent = {
      type: 'resourceChanged',
      entity: other,
      resource: 'res.stash',
      from: 0,
      to: 6,
      requested: 6,
      seq: 99_999,
      rev: base.state.rev,
      round: base.state.round,
      cause: { kind: 'rule', rule: 'rule.old_well' },
      audience: [other],
    } as GameEvent;
    const a = packetFor(starter, base.state, base.events, viewer);
    const b = packetFor(starter, base.state, [...base.events, hiddenEvent], viewer);
    expect(b).toEqual(a);
  });

  it('a hidden rule in the definition never appears in the packet', () => {
    const def = cloneJson(starter.def);
    def.rules.push({
      id: 'rule.secret_trap',
      name: 'Secret Trap',
      kind: 'reaction',
      enabled: true,
      visibility: 'hidden',
      priority: 0,
      trigger: { event: 'landed', where: { spaceTag: 'tag.coin' } },
      effects: [{ op: 'changeResource', target: '$actor', resource: 'res.hp', amount: -50 }],
    });
    const withSecret = compileGame(GameDefinitionSchema.parse(def));
    const a = packetFor(starter, base.state, base.events, viewer);
    const b = packetFor(withSecret, base.state, base.events, viewer);
    expect(b).toEqual(a);
    expect(b.text).not.toContain('Secret Trap');
  });

  it('shows the viewer its own secret value but only "hidden" for others', () => {
    const state = cloneJson(base.state);
    (state.entities[viewer] as { resources: Record<string, number> }).resources['res.stash'] = 7;
    const p = packetFor(starter, state, base.events, viewer);
    expect(p.text).toContain('Stash 7 (secret)');
    expect(p.text).toMatch(/Stash hidden/);
  });

  it('effects of hidden rules are reported with an unknown cause', () => {
    // Land on the Gilded Idol, whose curse is a hidden rule.
    let found = false;
    for (let seed = 0; seed < 40 && !found; seed++) {
      const { state, events } = playUntil(starter, `idol-${seed}`, 400);
      const idolHit = events.find((e) => e.type === 'resourceChanged' && e.cause.rule === 'rule.idol_curse');
      if (!idolHit || idolHit.type !== 'resourceChanged') continue;
      const watcher = state.turnOrder.find((id) => id !== idolHit.entity) as string;
      const view = buildContestantView(starter, state, watcher, events, 100_000);
      const seen = view.recentEvents.find((v) => v.seq === idolHit.seq);
      expect(seen?.unknownCause).toBe(true);
      expect(seen?.event.cause.rule).toBeUndefined();
      found = true;
    }
    expect(found).toBe(true);
  });
});

describe('combat odds in packets', () => {
  it('attack options state per-spin chance, damage both ways, outcome odds and rewards', () => {
    const { state, events } = playUntil(starter, 'odds', 0);
    // Put the first contestant on a Slime's space at its main decision.
    const actor = state.pendingDecision?.actor as string;
    const slime = Object.values(state.entities).find((e) => e.defId === 'enemy.slime');
    const moved = cloneJson(state);
    (moved.entities[actor] as { spaceId: string | null }).spaceId = slime?.spaceId ?? null;
    moved.phase = 'main';
    moved.pendingDecision = { id: 'd1', actor, kind: 'main', issuedRev: 1, options: [{ id: `atk:${slime?.id}`, kind: 'attack', target: slime?.id as string, label: 'Attack Slime' }, { id: 'pass', kind: 'pass', label: 'Pass' }] };
    const p = packetFor(starter, moved, events, actor);
    expect(p.text).toContain('you win each spin 57.1%');
    expect(p.text).toContain('you hit for 33');
    expect(p.text).toContain('it hits for 19');
    expect(p.text).toMatch(/you win 99\.\d%/);
    expect(p.text).toContain('Reward: you gain 50 Power, then you gain 3 Gold.');
  });
});

describe('hidden-information pairs for M4 mechanics', () => {
  const base = playUntil(starter, 'pairs-m4', 160);
  const viewer = base.state.pendingDecision?.actor as string;
  const other = base.state.turnOrder.find((id) => id !== viewer) as string;

  function withItem(state: GameState, holder: string, defId: string): GameState {
    const s = cloneJson(state);
    s.counters.item += 1;
    const id = `i${s.counters.item}`;
    s.items[id] = { id, defId, holder, equipped: false, charges: null };
    (s.entities[holder] as { items: string[] }).items.push(id);
    return s;
  }

  it('which concealed item another contestant holds does not change the packet', () => {
    // Two concealed items with different bonuses; only their holder may know which is which.
    const def = cloneJson(starter.def);
    def.items.push({ id: 'item.cursed_coin', name: 'Cursed Coin', concealed: true, tradeable: true, tags: [], modifiers: [{ resource: 'res.power', add: -30 }], stackSize: 1, rules: [] });
    const g = compileGame(GameDefinitionSchema.parse(def));
    const a = packetFor(g, withItem(base.state, other, 'item.lucky_coin'), base.events, viewer);
    const b = packetFor(g, withItem(base.state, other, 'item.cursed_coin'), base.events, viewer);
    expect(b).toEqual(a);
    expect(a.text).toContain('a concealed item');
  });

  it('the order of the draw pile does not change the packet (its size and the discards do)', () => {
    const shuffled = cloneJson(base.state);
    const pile = shuffled.decks['deck.island'];
    if (!pile) throw new Error('no deck');
    pile.draw = [...pile.draw].reverse();
    expect(packetFor(starter, shuffled, base.events, viewer)).toEqual(packetFor(starter, base.state, base.events, viewer));
  });

  it('a hidden status (on anyone) does not change the packet', () => {
    const def = cloneJson(starter.def);
    def.statuses.push({ id: 'status.secret_hex', name: 'Secret Hex', duration: null, stacking: 'ignore', maxStacks: 1, grantsTags: [], modifiers: [{ resource: 'res.power', add: -60 }], suppress: [], visibility: 'hidden', transformation: false, rules: [] });
    const g = compileGame(GameDefinitionSchema.parse(def));
    for (const target of [viewer, other]) {
      const hexed = cloneJson(base.state);
      (hexed.entities[target] as { statuses: GameState['entities'][string]['statuses'] }).statuses.push({ id: 's99', defId: 'status.secret_hex', stacks: 1, remaining: null, fresh: false });
      expect(packetFor(g, hexed, base.events, viewer)).toEqual(packetFor(g, base.state, base.events, viewer));
    }
  });

  it('another contestant’s secret objective (which one, and its progress) does not change the packet', () => {
    const theirs = base.state.objectives.find((o) => o.owner === other);
    expect(theirs).toBeDefined();
    const mine = base.state.objectives.find((o) => o.owner === viewer);
    const variant = cloneJson(base.state);
    const swapped = variant.objectives.find((o) => o.owner === other) as GameState['objectives'][number];
    swapped.defId = starter.def.objectives.find((o) => o.id !== theirs?.defId && o.id !== mine?.defId)?.id as string;
    swapped.progress = 2;
    const a = packetFor(starter, base.state, base.events, viewer);
    const b = packetFor(starter, variant, base.events, viewer);
    expect(b).toEqual(a);
    // The viewer's own objective is in its packet.
    const own = starter.def.objectives.find((o) => o.id === mine?.defId);
    expect(a.text).toContain(`YOUR SECRET OBJECTIVE: ${own?.name}`);
  });

  it('memories and relationships come only from what the contestant saw: private trades between others leave no trace', () => {
    const third = base.state.turnOrder.find((id) => id !== viewer && id !== other) as string;
    const at = { rev: base.state.rev, round: base.state.round };
    const terms = { give: { resources: { 'res.gold': 3 }, items: [] }, get: { resources: {}, items: [] }, promises: [] };
    const privateEvents = [
      { type: 'tradeProposed', negotiation: 't99', from: other, to: third, terms, message: 'secret deal', seq: 99_990, ...at, cause: { kind: 'action', entity: other }, audience: [other, third] },
      { type: 'tradeRejected', negotiation: 't99', from: other, to: third, by: third, automatic: false, seq: 99_991, ...at, cause: { kind: 'action', entity: third }, audience: [other, third] },
      { type: 'objectiveAssigned', entity: other, objective: 'o99', def: 'obj.angler', seq: 99_992, ...at, cause: { kind: 'gm' }, audience: [other] },
    ] as GameEvent[];
    const a = packetFor(starter, base.state, base.events, viewer);
    const b = packetFor(starter, base.state, [...base.events, ...privateEvents], viewer);
    expect(b).toEqual(a);
    expect(b.text).not.toContain('secret deal');
  });

  it('Fish Form is explained in the packet: −1 Move on the roll and no shopping', () => {
    const created = createMatch(starter, { matchId: 'fish', seed: 'fish-form' });
    if (!created.ok) throw new Error('create failed');
    let state = created.state;
    const events = [...created.events];
    while (nextStepKind(state) === 'auto') {
      const out = advance(starter, state);
      if (!out.ok) throw new Error(out.message);
      state = out.state;
      events.push(...out.events);
    }
    const actor = state.pendingDecision?.actor as string;
    const fish = applyGmCommand(starter, state, GmCommandSchema.parse({ type: 'applyStatus', entity: actor, status: 'status.fish_form' }));
    if (!fish.ok) throw new Error('fish');
    // Answer this move, then play to the actor's next move decision so the roll includes −1 Move.
    state = fish.state;
    events.push(...fish.events);
    for (let i = 0; i < 200 && !(state.pendingDecision?.kind === 'move' && state.pendingDecision.actor === actor && state.round > 1); i++) {
      const out =
        nextStepKind(state) === 'auto'
          ? advance(starter, state)
          : answerDecision(starter, state, { decisionId: state.pendingDecision?.id as string, optionId: state.pendingDecision?.options.find((o) => o.kind === 'pass' || (o.kind === 'move' && o.steps === 0))?.id ?? (state.pendingDecision?.options[0]?.id as string) });
      if (!out.ok) throw new Error(out.message);
      state = out.state;
      events.push(...out.events);
    }
    const p = packetFor(starter, state, events, actor);
    expect(p.text).toMatch(/Statuses: Fish Form \(\d turns? left\)/);
    expect(p.text).toMatch(/You rolled \d; −1 Move \(Fish Form\) → move up to \d steps?\./);
    expect(p.text).toContain('Right now you cannot shop (Fish Form)');
  });
});
