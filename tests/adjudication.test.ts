import { describe, expect, it } from 'vitest';
import { answerDecision, applyGmCommand, CompileError, GM, type CompiledGame } from '../src/engine/index.ts';
import { GmCommandSchema } from '../src/schema/commands.ts';
import type { GameDefinitionInput } from '../src/schema/definition.ts';
import type { GameState } from '../src/schema/state.ts';
import { DEFAULT_CONTROLLER_CONFIG } from '../src/contestants/controller.ts';
import { MatchSession } from '../src/server/session.ts';
import { buildContestantView } from '../src/visibility/view.ts';
import { choose, expectOk, miniGame, startMini, type TestRule } from './helpers/mini.ts';

/** GM adjudication: rules that ask the GM (`askGm`) and contestants' freeform attempts. */

const bribe: TestRule = {
  id: 'rule.guard',
  trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } },
  effects: [
    {
      op: 'askGm',
      question: 'Does the guard let {actor} pass?',
      about: '$actor',
      options: [
        { id: 'pass', label: 'The guard waves them through', effects: [{ op: 'changeResource', target: '$actor', resource: 'res.stash', amount: 3 }] },
        { id: 'fine', label: 'The guard fines them', effects: [{ op: 'changeResource', target: '$actor', resource: 'res.gold', amount: -4 }] },
      ],
    },
  ],
};

const freeform = (d: GameDefinitionInput) => {
  d.settings.adjudication = { freeform: true, freeformCooldownRounds: 2, timeoutSeconds: 30 };
};

function landOnBlue(g: CompiledGame): { state: GameState; actor: string } {
  let { state } = startMini(g);
  const actor = state.pendingDecision?.actor as string;
  state = expectOk(applyGmCommand(g, state, GmCommandSchema.parse({ type: 'teleport', entity: actor, space: 'space.s1', asLanding: false }))).state;
  state = choose(g, state, 'mv:space.s2').state;
  return { state, actor };
}

describe('askGm', () => {
  it('waits for a GM ruling with the authored options plus “No effect”; contestants never see the decision', () => {
    const g = miniGame({ rules: [bribe] });
    const { state, actor } = landOnBlue(g);
    const d = state.pendingDecision;
    expect(d).toMatchObject({ actor: GM, kind: 'ruling', prompt: `Does the guard let ${state.entities[actor]?.name} pass?` });
    expect(d?.options.map((o) => o.id)).toEqual(['ch:pass', 'ch:fine', 'ch:none']);
    expect(buildContestantView(g, state, actor, []).decision).toBeNull();
    // The GM rules: the option's effects run for the rule's $actor, then play continues.
    const ruled = choose(g, state, 'ch:fine');
    expect(ruled.state.entities[actor]?.resources['res.gold']).toBe(6);
    expect(ruled.events.find((e) => e.type === 'choiceMade')).toMatchObject({ entity: GM, option: 'fine' });
    expect(ruled.state.pendingDecision).toMatchObject({ actor, kind: 'main' });
    const none = choose(g, state, 'ch:none');
    expect(none.state.entities[actor]?.resources['res.gold']).toBe(10);
  });

  it('the question is public (gmAsked), and GM tools can shape the result before the ruling', () => {
    const g = miniGame({ rules: [bribe] });
    const { state, actor } = landOnBlue(g);
    const asked = buildContestantView(g, state, actor, []);
    expect(asked.decision).toBeNull();
    const edited = expectOk(applyGmCommand(g, state, GmCommandSchema.parse({ type: 'adjustResource', entity: actor, resource: 'res.gold', delta: 5 }))).state;
    expect(edited.pendingDecision?.actor).toBe(GM);
    expect(edited.pendingDecision?.id).not.toBe(state.pendingDecision?.id);
  });

  it('"none" is reserved for the built-in ruling', () => {
    expect(() => miniGame({ rules: [{ id: 'rule.bad', trigger: { event: 'landed' }, effects: [{ op: 'askGm', question: 'q', options: [{ id: 'none', label: 'x', effects: [] }] }] }] })).toThrow(CompileError);
  });
});

describe('freeform attempts', () => {
  it('are offered when enabled, need a description, queue a ruling and then cool down', () => {
    const g = miniGame({ mutate: freeform });
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    state = choose(g, state, `mv:${state.entities[actor]?.spaceId}`).state;
    expect(state.pendingDecision?.options.some((o) => o.id === 'freeform')).toBe(true);
    const empty = answerDecision(g, state, { decisionId: state.pendingDecision?.id as string, optionId: 'freeform' });
    expect(empty.ok === false && empty.message).toBe('describe what you attempt');
    const tried = expectOk(answerDecision(g, state, { decisionId: state.pendingDecision?.id as string, optionId: 'freeform', attempt: 'I juggle three coconuts to distract the ogre' }));
    expect(tried.events.find((e) => e.type === 'attempted')).toMatchObject({ entity: actor, text: 'I juggle three coconuts to distract the ogre', audience: 'all' });
    expect(tried.state.pendingDecision).toMatchObject({ actor: GM, kind: 'ruling' });
    expect(tried.state.pendingDecision?.options.map((o) => o.id)).toEqual(['ch:success', 'ch:none']);
    // The attempt used the main action: after the ruling the turn ends.
    const ruled = choose(g, tried.state, 'ch:success');
    expect(ruled.state.phase).toBe('turnEnd');
    expect(ruled.state.cooldowns[`freeform:${actor}`]).toBe(state.round + 2);
  });

  it('are not offered by default', () => {
    const g = miniGame();
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    state = choose(g, state, `mv:${state.entities[actor]?.spaceId}`).state;
    expect(state.pendingDecision?.options.some((o) => o.id === 'freeform')).toBe(false);
  });
});

describe('rulings in a live match', () => {
  it('wait for the GM while playing, then resolve to “No effect” when the time runs out', async () => {
    let clock = 1_000_000;
    const g = miniGame({ rules: [bribe], mutate: freeform });
    const session = await MatchSession.create(g, { matchId: 'rule', seed: 'ruling' }, { provider: null, config: DEFAULT_CONTROLLER_CONFIG, price: null, now: () => clock });
    const actor = session.state.turnOrder[0] as string;
    while (session.state.pendingDecision?.kind !== 'move') await session.step();
    session.gm(GmCommandSchema.parse({ type: 'teleport', entity: actor, space: 'space.s2', asLanding: true }));
    expect(session.state.pendingDecision?.actor).toBe(GM);
    session.paused = false;
    expect(await session.step()).toBe('waiting');
    clock += 29_000;
    expect(await session.step()).toBe('waiting');
    expect(session.rulingTimeLeft()).toBe(1000);
    clock += 1_000;
    expect(await session.step()).toBe('progress');
    expect(session.history.find((e) => e.type === 'choiceMade' && e.entity === GM)).toMatchObject({ option: 'none' });
    expect(session.operations.at(-1)?.input).toMatchObject({ optionId: 'ch:none', source: 'timeout' });
  });

  it('the GM can answer at any time', async () => {
    const g = miniGame({ rules: [bribe] });
    const session = await MatchSession.create(g, { matchId: 'rule2', seed: 'ruling' }, { provider: null, config: DEFAULT_CONTROLLER_CONFIG, price: null });
    const actor = session.state.turnOrder[0] as string;
    while (session.state.pendingDecision?.kind !== 'move') await session.step();
    session.gm(GmCommandSchema.parse({ type: 'teleport', entity: actor, space: 'space.s2', asLanding: true }));
    expect(session.answerRuling('ch:pass')).toBe('progress');
    expect(session.state.entities[actor]?.resources['res.stash']).toBe(3);
    expect(session.operations.at(-1)?.input).toMatchObject({ optionId: 'ch:pass', source: 'gm' });
  });
});
