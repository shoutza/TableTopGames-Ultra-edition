import { describe, expect, it } from 'vitest';
import { loadStarter } from '../src/cli/headless.ts';
import { chooseHeuristic } from '../src/contestants/heuristic.ts';
import { newMind } from '../src/contestants/mind.ts';
import { buildDecisionPacket } from '../src/contestants/packet.ts';
import { advance, answerDecision, cloneJson, compileGame, createMatch, nextStepKind, type CompiledGame } from '../src/engine/index.ts';
import { GameDefinitionSchema } from '../src/schema/definition.ts';
import type { GameEvent, GameState } from '../src/schema/state.ts';
import { publicInfo } from '../src/visibility/public-info.ts';
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
        : answerDecision(game, state, { decisionId: state.pendingDecision?.id as string, optionId: state.pendingDecision?.options.at(-1)?.id as string });
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

function packetFor(game: CompiledGame, state: GameState, events: GameEvent[], viewer: string) {
  const info = publicInfo(game);
  const view = buildContestantView(game, state, viewer, events);
  const castId = state.entities[viewer]?.defId as string;
  const persona = game.cast.get(castId)?.persona;
  if (!persona) throw new Error('persona');
  const mind = newMind(viewer, castId, ['opportunist'], 'llm');
  const packet = buildDecisionPacket(info, view, mind, persona);
  return {
    text: `${packet.instructions}\n---\n${packet.input}`,
    options: view.decision?.options.map((o) => o.id),
    previews: JSON.stringify(view.decision?.previews),
    choice: chooseHeuristic(view, info, persona, 'opportunist').optionId,
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
    moved.pendingDecision = { id: 'd1', actor, kind: 'main', issuedRev: 1, options: [{ id: `atk:${slime?.id}`, kind: 'attack', enemy: slime?.id as string, label: 'Attack Slime' }, { id: 'pass', kind: 'pass', label: 'Pass' }] };
    const p = packetFor(starter, moved, events, actor);
    expect(p.text).toContain('you win each spin 57.1%');
    expect(p.text).toContain('you hit for 33');
    expect(p.text).toContain('it hits for 19');
    expect(p.text).toMatch(/you win 99\.\d%/);
    expect(p.text).toContain('Reward: you gain 50 Power, then you gain 3 Gold.');
  });
});
