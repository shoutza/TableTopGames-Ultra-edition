import { describe, expect, it } from 'vitest';
import { loadStarter, runHeadlessMatch, stateHash } from '../src/cli/headless.ts';
import { advance, answerDecision, applyGmCommand, createMatch, nextStepKind } from '../src/engine/index.ts';
import { GmCommandSchema } from '../src/schema/commands.ts';
import { GameStateSchema, type GameState } from '../src/schema/state.ts';
import { choose, deepFreeze, entityByName, expectOk, miniGame, startMini } from './helpers/mini.ts';

const starter = loadStarter();

describe('starter scenario', () => {
  it('compiles without warnings', () => {
    expect(starter.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
  });

  it('is deterministic: the same seed gives the same final state', () => {
    const a = runHeadlessMatch(starter, 'det-1');
    const b = runHeadlessMatch(starter, 'det-1');
    const c = runHeadlessMatch(starter, 'det-2');
    expect(stateHash(a.state)).toBe(stateHash(b.state));
    expect(stateHash(a.state)).not.toBe(stateHash(c.state));
  });

  it('plays many seeded matches to completion without faults or aborts, with real decisions', () => {
    let turns = 0;
    let real = 0;
    let demonFights = 0;
    for (let i = 0; i < 25; i++) {
      const r = runHeadlessMatch(starter, `bulk-${i}`);
      expect(r.aborted).toBeNull();
      expect(r.faults).toBe(0);
      expect(r.state.phase).toBe('gameOver');
      expect(r.state.winners?.length).toBeGreaterThan(0);
      expect(GameStateSchema.safeParse(r.state).success).toBe(true);
      turns += r.events.filter((e) => e.type === 'turnStarted').length;
      real += r.decisions - r.forcedDecisions;
      demonFights += r.events.filter((e) => e.type === 'fightStarted' && r.state.entities[e.defender]?.defId === 'enemy.demon' || e.type === 'fightStarted' && r.state.entities[e.attacker]?.defId === 'enemy.demon').length;
    }
    expect(real / turns).toBeGreaterThanOrEqual(1.5);
    expect(demonFights).toBeGreaterThan(0);
  });

  it('never mutates a committed state (every input state is frozen)', () => {
    const created = expectOk(createMatch(starter, { matchId: 'frozen', seed: 'frozen' }));
    let state: GameState = deepFreeze(created.state);
    let guard = 0;
    while (nextStepKind(state) !== 'gameOver' && guard++ < 3000) {
      const out =
        nextStepKind(state) === 'auto'
          ? advance(starter, state)
          : answerDecision(starter, state, { decisionId: state.pendingDecision?.id as string, optionId: state.pendingDecision?.options.filter((o) => o.kind !== 'trade' && o.id !== 'tr:counter').at(-1)?.id as string });
      state = deepFreeze(expectOk(out).state);
    }
    expect(state.phase).toBe('gameOver');
  });
});

describe('decisions', () => {
  it('rejects stale decision ids, unoffered options and wrong revisions without changing state', () => {
    const game = miniGame();
    const { state } = startMini(game);
    const d = state.pendingDecision;
    expect(d).not.toBeNull();
    const before = JSON.stringify(state);
    const stale = answerDecision(game, state, { decisionId: 'd999', optionId: d?.options[0]?.id as string });
    expect(stale.ok).toBe(false);
    const bogus = answerDecision(game, state, { decisionId: d?.id as string, optionId: 'mv:space.nowhere' });
    expect(bogus.ok).toBe(false);
    const oldRev = answerDecision(game, state, { decisionId: d?.id as string, optionId: d?.options[0]?.id as string, rev: state.rev - 1 });
    expect(oldRev.ok).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('GM edits re-issue the pending decision under a new id', () => {
    const game = miniGame();
    const { state } = startMini(game);
    const oldId = state.pendingDecision?.id as string;
    const actor = state.pendingDecision?.actor as string;
    const edited = expectOk(applyGmCommand(game, state, GmCommandSchema.parse({ type: 'adjustResource', entity: actor, resource: 'res.gold', delta: 5 })));
    expect(edited.state.pendingDecision?.id).not.toBe(oldId);
    expect(answerDecision(game, edited.state, { decisionId: oldId, optionId: 'pass' }).ok).toBe(false);
  });

  it('a contestant knocked out by the GM mid-decision ends its turn', () => {
    const game = miniGame();
    const { state } = startMini(game);
    const actor = state.pendingDecision?.actor as string;
    const out = expectOk(applyGmCommand(game, state, GmCommandSchema.parse({ type: 'setResource', entity: actor, resource: 'res.hp', value: 0 })));
    expect(out.state.pendingDecision).toBeNull();
    expect(out.state.phase).toBe('turnEnd');
    expect(out.events.some((e) => e.type === 'knockedOut')).toBe(true);
  });

  it('buying from a shop pays the price first and grants the item, raising effective Power', () => {
    const game = miniGame();
    let { state } = startMini(game);
    const actor = state.pendingDecision?.actor as string;
    state = expectOk(applyGmCommand(game, state, GmCommandSchema.parse({ type: 'teleport', entity: actor, space: 'space.s1', asLanding: false }))).state;
    state = choose(game, state, 'mv:space.s1').state;
    const shop = entityByName(state, 'Shop');
    const out = choose(game, state, `buy:${shop}:entry.sword`);
    const types = out.events.map((e) => e.type);
    expect(types.indexOf('resourceChanged')).toBeLessThan(types.indexOf('itemGained'));
    expect(out.state.entities[actor]?.resources['res.gold']).toBe(5);
    expect(out.state.entities[actor]?.resources['res.power']).toBe(80);
    expect(out.state.entities[actor]?.items).toHaveLength(1);
  });
});

describe('victory', () => {
  it('checks the threshold at the end of the round and breaks ties by ranking', () => {
    const game = miniGame();
    let { state } = startMini(game);
    const ann = entityByName(state, 'Ann');
    const bob = entityByName(state, 'Bob');
    for (const [entity, value] of [[ann, 3], [bob, 3]] as const) {
      state = expectOk(applyGmCommand(game, state, GmCommandSchema.parse({ type: 'setResource', entity, resource: 'res.stars', value, silent: true }))).state;
    }
    state = expectOk(applyGmCommand(game, state, GmCommandSchema.parse({ type: 'setResource', entity: bob, resource: 'res.gold', value: 50, silent: true }))).state;
    let guard = 0;
    while (nextStepKind(state) !== 'gameOver' && guard++ < 100) {
      if (nextStepKind(state) === 'auto') state = expectOk(advance(game, state)).state;
      else state = choose(game, state, state.pendingDecision?.options.find((o) => o.kind === 'pass' || (o.kind === 'move' && o.steps === 0))?.id as string).state;
    }
    expect(state.round).toBe(1);
    expect(state.winners).toEqual([bob]);
  });
});
