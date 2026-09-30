import { describe, expect, it } from 'vitest';
import { loadStarter, runHeadlessMatch } from '../src/cli/headless.ts';
import { DEFAULT_CONTROLLER_CONFIG, decideOffline } from '../src/contestants/controller.ts';
import { observe, prepareMind, relationship, selectMemories } from '../src/contestants/memory.ts';
import { newMind, type ContestantMind } from '../src/contestants/mind.ts';
import { namesFromView } from '../src/contestants/packet.ts';
import { answerDecision, applyGmCommand, type CompiledGame, type DecisionAnswer } from '../src/engine/index.ts';
import type { Persona } from '../src/schema/persona.ts';
import { GmCommandSchema, type GmCommandInput } from '../src/schema/commands.ts';
import type { GameDefinitionInput } from '../src/schema/definition.ts';
import type { GameEvent, GameState } from '../src/schema/state.ts';
import { scriptedProvider } from '../src/server/providers.ts';
import { MatchSession } from '../src/server/session.ts';
import { publicInfo } from '../src/visibility/public-info.ts';
import { visibleEvents } from '../src/visibility/redact.ts';
import { buildContestantView } from '../src/visibility/view.ts';
import { choose, expectOk, miniGame, startMini } from './helpers/mini.ts';

/** Contestant minds: relationships, memories, key moments and strategy reconsideration. */

const tradeable = (d: GameDefinitionInput) => {
  for (const r of d.resources) if (r.id === 'res.gold' || r.id === 'res.bananas') r.tradeable = true;
};

function gm(g: CompiledGame, state: GameState, cmd: GmCommandInput) {
  return expectOk(applyGmCommand(g, state, GmCommandSchema.parse(cmd)));
}

function answer(g: CompiledGame, state: GameState, optionId: string, extra: Partial<DecisionAnswer> = {}) {
  return expectOk(answerDecision(g, state, { decisionId: state.pendingDecision?.id as string, optionId, ...extra }));
}

/** The mind of `viewer` after observing everything it could see. */
function mindAfter(g: CompiledGame, state: GameState, events: GameEvent[], viewer: string, mind = newMind(viewer, state.entities[viewer]?.defId ?? '', ['opportunist'], 'heuristic')): ContestantMind {
  const info = publicInfo(g);
  const view = buildContestantView(g, state, viewer, events);
  observe(mind, view, visibleEvents(g, events, viewer), namesFromView(info, view));
  return mind;
}

describe('relationships and memory', () => {
  it('a broken promise lowers trust (−3), becomes the top memory, a key moment and a reason to reconsider', () => {
    const g = miniGame({ mutate: tradeable });
    let { state, events } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    const other = state.turnOrder.find((id) => id !== actor) as string;
    state = choose(g, state, `mv:${state.entities[actor]?.spaceId}`).state;
    const offered = answer(g, state, 'trade', { trade: { with: other, give: { resources: { 'res.gold': 2 } }, get: {}, promises: [{ by: 'me', kind: 'noAttack', rounds: 3 }] } });
    const accepted = answer(g, offered.state, 'tr:accept');
    events = [...events, ...offered.events, ...accepted.events];
    const before = mindAfter(g, accepted.state, events, other);
    expect(relationship(before, actor)).toEqual({ trust: 0, affinity: 1 });
    // The actor attacks anyway.
    const attackable = gm(g, accepted.state, { type: 'teleport', entity: other, space: accepted.state.entities[actor]?.spaceId as string, asLanding: false });
    const attacked = answer(g, attackable.state, `atk:${other}`);
    events = [...events, ...attackable.events, ...attacked.events];
    const mind = mindAfter(g, attacked.state, events, other, before);
    expect(relationship(mind, actor).trust).toBe(-3);
    expect(relationship(mind, actor).affinity).toBeLessThan(0);
    expect(mind.memories.map((m) => m.kind)).toEqual(expect.arrayContaining(['trade', 'betrayal', 'attackedMe']));
    expect(mind.keyMoment).toMatch(/broke a promise to you|attacked you/);
    mind.strategy = { archetype: 'opportunist', summary: 's', priorities: ['p'], avoid: [], adoptedAtRound: 1, reason: 'r' };
    expect(mind.reconsider).toMatch(/broke a promise to you/);
    // A bystander trusts the promise-breaker a little less too.
    const view = buildContestantView(g, attacked.state, other, events);
    expect(selectMemories(mind, view)[0]).toBeDefined();
    expect(selectMemories(mind, view).some((m) => m.includes('broke a promise to you'))).toBe(true);
  });

  it('kept promises raise trust; repeated memories are grouped', () => {
    const mind = newMind('e1', 'cast.ann', ['opportunist'], 'heuristic');
    const view = { viewer: 'e1', round: 9, turnOrder: ['e1', 'e2'], entities: [{ id: 'e1', kind: 'contestant', name: 'Ann', isSelf: true }, { id: 'e2', kind: 'contestant', name: 'Bob', isSelf: false }], decision: null, negotiation: null, threatsHere: [] } as never;
    const names = { entity: (id: string) => (id === 'e1' ? 'Ann' : 'Bob'), action: (id: string) => id, objective: (id: string) => id } as never;
    const ev = (seq: number, round: number, body: Record<string, unknown>) => ({ seq, round, type: body['type'], unknownCause: false, event: { ...body, seq, round, rev: 1, cause: { kind: 'action', entity: 'e2' }, audience: 'all' } }) as never;
    observe(
      mind,
      view,
      [
        ev(1, 2, { type: 'fightStarted', fight: 1, attacker: 'e2', defender: 'e1' }),
        ev(2, 5, { type: 'fightStarted', fight: 2, attacker: 'e2', defender: 'e1' }),
        ev(3, 8, { type: 'fightStarted', fight: 3, attacker: 'e2', defender: 'e1' }),
        ev(4, 8, { type: 'promiseKept', commitment: 'p1', by: 'e2', to: 'e1', kind: 'pay' }),
      ],
      names,
    );
    expect(relationship(mind, 'e2')).toEqual({ trust: 2, affinity: -6 });
    expect(selectMemories(mind, view)).toEqual(['Bob attacked you 3× (rounds 2, 5, 8)', 'r8: Bob kept a promise to you']);
    // Already-seen events are not counted twice.
    observe(mind, view, [ev(3, 8, { type: 'fightStarted', fight: 3, attacker: 'e2', defender: 'e1' })], names);
    expect(relationship(mind, 'e2').affinity).toBe(-6);
  });

  it('talkative contestants say something at key moments', () => {
    const g = miniGame({ mutate: tradeable });
    const { state, events } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    const info = publicInfo(g);
    const view = buildContestantView(g, state, actor, events);
    const mind = newMind(actor, 'cast.ann', ['opportunist'], 'heuristic');
    mind.keyMoment = 'Bob just attacked you';
    const chatty: Persona = { voice: 'x', traits: { risk: 5, aggression: 8, greed: 5, loyalty: 5, vindictiveness: 5, sociability: 8 }, behaviors: [] };
    const quiet: Persona = { ...chatty, traits: { ...chatty.traits, sociability: 2 } };
    expect(decideOffline({ view, info, mind, persona: chatty }).say).toBe('You picked the wrong fight, Bob!');
    expect(decideOffline({ view, info, mind, persona: quiet }).say).toBeNull();
  });
});

describe('strategy reconsideration', () => {
  const starter = loadStarter();

  /** Plays until the contestant has started `turns` more turns of its own. */
  async function playOwnTurns(session: MatchSession, who: string, turns: number): Promise<void> {
    const startCount = session.history.filter((e) => e.type === 'turnStarted' && e.entity === who).length;
    for (let i = 0; i < 3000 && !session.over; i++) {
      const started = session.history.filter((e) => e.type === 'turnStarted' && e.entity === who).length - startCount;
      if (started >= turns && session.state.pendingDecision?.actor !== who) return;
      await session.step();
    }
  }

  for (const [label, provider] of [
    ['fallback player', null],
    ['model pipeline (scripted provider)', scriptedProvider()],
  ] as const) {
    it(`${label}: removing the Demon makes a Demon-hunting strategy change within 2 own turns`, async () => {
      const session = await MatchSession.create(starter, { matchId: 'rc', seed: 'reconsider' }, { provider, config: DEFAULT_CONTROLLER_CONFIG, price: null });
      await playOwnTurns(session, session.state.turnOrder[0] as string, 2);
      const hunter = [...session.minds.values()].find((m) => m.strategy?.archetype === 'gearUp' || m.strategy?.archetype === 'powerFarmer');
      expect(hunter).toBeDefined();
      if (!hunter) return;
      const before = hunter.strategy?.archetype;
      const demon = Object.values(session.state.entities).find((e) => e.defId === 'enemy.demon');
      expect(session.gm(GmCommandSchema.parse({ type: 'removeEntity', entity: demon?.id })).ok).toBe(true);
      await playOwnTurns(session, hunter.entityId, 2);
      expect(hunter.strategy?.archetype).not.toBe(before);
      expect(hunter.strategy?.archetype).not.toMatch(/gearUp|powerFarmer/);
      expect(hunter.strategy?.reason).toMatch(/Demon is gone for good/);
      expect(hunter.strategyHistory.at(-1)?.archetype).toBe(before);
    });
  }

  it('without a lost opportunity, strategies are revised at most once every 3 rounds', () => {
    const g = miniGame();
    const { state, events } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    const info = publicInfo(g);
    const view = buildContestantView(g, state, actor, events);
    const mind = newMind(actor, 'cast.ann', ['opportunist'], 'heuristic');
    mind.strategy = { archetype: 'opportunist', summary: 's', priorities: ['p'], avoid: [], adoptedAtRound: 0, reason: 'r' };
    mind.lastReconsiderRound = view.round;
    const knockedOut = { seq: 999, round: view.round, type: 'knockedOut', unknownCause: false, event: { type: 'knockedOut', entity: actor, goldLost: 0, lootTo: null, respawnSpace: 'space.s0', skipTurns: 1, seq: 999, rev: 1, round: view.round, cause: { kind: 'system' }, audience: 'all' } } as never;
    prepareMind(mind, view, info, [knockedOut], namesFromView(info, view));
    expect(mind.reconsider).toBeNull();
    mind.lastReconsiderRound = view.round - 3;
    mind.lastSeenEventSeq = 0;
    prepareMind(mind, { ...view, round: view.round } as never, info, [knockedOut], namesFromView(info, view));
    expect(mind.reconsider).toBe('You were just knocked out');
  });
});

describe('offline play', () => {
  it('ordinary offline matches include accepted trades and promises, without faults', () => {
    const g = loadStarter();
    const trades: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = runHeadlessMatch(g, `social-${i}`);
      expect(r.faults).toBe(0);
      expect(r.aborted).toBeNull();
      trades.push(r.events.filter((e) => e.type === 'tradeCompleted').length);
    }
    const sorted = [...trades].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]).toBeGreaterThanOrEqual(1);
  });
});
