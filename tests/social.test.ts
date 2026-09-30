import { describe, expect, it } from 'vitest';
import { advance, answerDecision, applyGmCommand, CompileError, createMatch, nextStepKind, type CompiledGame, type DecisionAnswer, type TradeOfferInput } from '../src/engine/index.ts';
import { GmCommandSchema, type GmCommandInput } from '../src/schema/commands.ts';
import type { GameDefinitionInput } from '../src/schema/definition.ts';
import type { GameEvent, GameState } from '../src/schema/state.ts';
import { buildContestantView } from '../src/visibility/view.ts';
import { choose, entityByName, expectOk, miniGame, startMini, type TestRule } from './helpers/mini.ts';

/** Engine scenarios for the social layer: secret objectives, trades and promises. */

type Mutate = (d: GameDefinitionInput) => void;

function game(rules: TestRule[] = [], ...mutations: Mutate[]): CompiledGame {
  return miniGame({ rules, mutate: (d) => mutations.forEach((m) => m(d)) });
}

function gm(g: CompiledGame, state: GameState, cmd: GmCommandInput) {
  return expectOk(applyGmCommand(g, state, GmCommandSchema.parse(cmd)));
}

function answer(g: CompiledGame, state: GameState, optionId: string, extra: Partial<DecisionAnswer> = {}) {
  const d = state.pendingDecision;
  if (!d) throw new Error('no pending decision');
  return answerDecision(g, state, { decisionId: d.id, optionId, ...extra });
}

function idle(g: CompiledGame, state: GameState, until: (s: GameState) => boolean, max = 400): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  for (let i = 0; i < max && !until(state) && nextStepKind(state) !== 'gameOver'; i++) {
    const d = state.pendingDecision;
    const out = !d
      ? advance(g, state)
      : answerDecision(g, state, {
          decisionId: d.id,
          optionId: (d.options.find((o) => o.kind === 'pass' || o.kind === 'tradeAnswer' && o.answer === 'reject' || (o.kind === 'move' && o.steps === 0)) ?? d.options.find((o) => o.kind === 'choose') ?? d.options[0])?.id as string,
        });
    state = expectOk(out).state;
    events.push(...expectOk(out).events);
  }
  return { state, events };
}

const tradeable: Mutate = (d) => {
  for (const r of d.resources) if (r.id === 'res.gold' || r.id === 'res.bananas') r.tradeable = true;
};
const potion = { id: 'item.potion', name: 'Potion', use: { effects: [{ op: 'changeResource' as const, target: '$actor' as const, resource: 'res.hp', amount: 30 }] } };
const withItems: Mutate = (d) => {
  d.items = [...(d.items ?? []), potion, { id: 'item.coin', name: 'Coin', concealed: true }, { id: 'item.relic', name: 'Relic', tradeable: false }];
};

const OBJECTIVES: NonNullable<GameDefinitionInput['objectives']> = [
  { id: 'obj.blue', name: 'Blue Lover', goal: { kind: 'count', trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } }, times: 2 }, reward: [{ op: 'changeResource', target: '$actor', resource: 'res.stars', amount: 1 }] },
  { id: 'obj.rich', name: 'Rich', goal: { kind: 'reach', resource: 'res.gold', atLeast: 30 }, reward: [{ op: 'changeResource', target: '$actor', resource: 'res.stars', amount: 1 }] },
  { id: 'obj.ogre', name: 'Ogre Slayer', goal: { kind: 'count', trigger: { event: 'defeated', where: { targetTag: 'tag.ogre' } }, times: 1 }, reward: [{ op: 'changeResource', target: '$actor', resource: 'res.gold', amount: 7 }] },
];
const objectives = (list = OBJECTIVES, per = 1): Mutate => (d) => {
  d.objectives = list;
  d.settings.objectives = { perContestant: per };
};

/** A copy of the state in which the contestant holds exactly the given objective (test setup). */
function onlyObjective(_g: CompiledGame, state: GameState, entity: string, objective: string): GameState {
  const s = structuredClone(state);
  s.objectives = [...s.objectives.filter((o) => o.owner !== entity), { id: 'o99', defId: objective, owner: entity, progress: 0, done: false }];
  return s;
}

describe('objectives', () => {
  it('are dealt from the match seed, different per contestant, and private to their owner', () => {
    const g = game([], objectives(OBJECTIVES, 2));
    const a = startMini(g, 'seed-1');
    const b = startMini(g, 'seed-1');
    expect(a.state.objectives).toEqual(b.state.objectives);
    expect(a.state.objectives).toHaveLength(4);
    for (const owner of a.state.turnOrder) {
      const defs = a.state.objectives.filter((o) => o.owner === owner).map((o) => o.defId);
      expect(new Set(defs).size).toBe(2);
    }
    const assigned = a.events.filter((e) => e.type === 'objectiveAssigned');
    expect(assigned).toHaveLength(4);
    for (const e of assigned) expect(e.audience).toEqual([e.type === 'objectiveAssigned' ? e.entity : '']);
    const ann = entityByName(a.state, 'Ann');
    const bob = entityByName(a.state, 'Bob');
    const view = buildContestantView(g, a.state, ann, a.events);
    expect(view.objectives.every((o) => o.mine)).toBe(true);
    expect(view.objectives).toHaveLength(2);
    expect(view.entities.find((e) => e.id === bob)?.secretObjectives).toBe(2);
  });

  it('count goals progress on matching events; completion reveals the objective and grants the reward', () => {
    const g = game([], objectives());
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    const bob = entityByName(state, 'Bob');
    state = onlyObjective(g, state, ann, 'obj.blue');
    state = gm(g, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true }).state;
    expect(state.objectives.find((o) => o.owner === ann)?.progress).toBe(1);
    state = gm(g, state, { type: 'teleport', entity: ann, space: 'space.s3', asLanding: true }).state;
    const out = gm(g, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true });
    const done = out.events.find((e) => e.type === 'objectiveCompleted');
    expect(done).toMatchObject({ entity: ann, def: 'obj.blue', audience: 'all' });
    expect(out.state.entities[ann]?.resources['res.stars']).toBe(1);
    expect(out.events.find((e) => e.type === 'resourceChanged' && e.resource === 'res.stars')?.cause).toMatchObject({ kind: 'objective', entity: ann });
    // Revealed: Bob now sees it, done.
    const bobView = buildContestantView(g, out.state, bob, out.events);
    expect(bobView.objectives.find((o) => o.owner === ann)).toMatchObject({ name: 'Blue Lover', done: true, goal: 'Land on a Blue space twice' });
    // Landing again changes nothing.
    const again = gm(g, out.state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true });
    expect(again.state.entities[ann]?.resources['res.stars']).toBe(1);
  });

  it('reach goals complete at the end of the operation that reaches them; defeat goals count the victor', () => {
    const g = game([], objectives());
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    state = onlyObjective(g, state, actor, 'obj.ogre');
    state = gm(g, state, { type: 'setResource', entity: actor, resource: 'res.power', value: 100000, silent: true }).state;
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s4', asLanding: false }).state;
    state = choose(g, state, 'mv:space.s4').state;
    const ogre = entityByName(state, 'Ogre');
    const fought = choose(g, state, `atk:${ogre}`);
    expect(fought.events.some((e) => e.type === 'objectiveCompleted' && e.def === 'obj.ogre')).toBe(true);
    // The Ogre's reward (+1 star) and the objective's reward (+7 gold) both arrive.
    expect(fought.state.entities[actor]?.resources['res.stars']).toBe(1);
    expect(fought.state.entities[actor]?.resources['res.gold']).toBe(17);

    let s2 = onlyObjective(g, startMini(g).state, actor, 'obj.rich');
    s2 = gm(g, s2, { type: 'adjustResource', entity: actor, resource: 'res.gold', delta: 19 }).state;
    expect(s2.objectives.find((o) => o.owner === actor)?.done).toBe(false);
    const rich = gm(g, s2, { type: 'adjustResource', entity: actor, resource: 'res.gold', delta: 1 });
    expect(rich.state.objectives.find((o) => o.owner === actor)?.done).toBe(true);
    expect(rich.state.entities[actor]?.resources['res.stars']).toBe(1);
  });

  it('an objective reward can win the game at the next checkpoint', () => {
    const g = game([], objectives());
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    state = onlyObjective(g, state, ann, 'obj.rich');
    state = gm(g, state, { type: 'setResource', entity: ann, resource: 'res.stars', value: 2 }).state;
    state = gm(g, state, { type: 'adjustResource', entity: ann, resource: 'res.gold', delta: 25 }).state;
    const r = idle(g, state, (s) => s.phase === 'gameOver');
    expect(r.state.winners).toEqual([ann]);
  });

  it('the GM cannot deal a contestant an objective it is already working on', () => {
    const g = game([], objectives());
    const { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    const held = state.objectives.find((o) => o.owner === ann)?.defId as string;
    const out = applyGmCommand(g, state, GmCommandSchema.parse({ type: 'assignObjective', entity: ann, objective: held }));
    expect(out.ok === false && out.message).toBe('Ann already has that objective');
  });

  it('the compiler checks objectives', () => {
    expect(() => game([], objectives([{ id: 'obj.x', name: 'X', goal: { kind: 'count', trigger: { event: 'roundEnded' }, times: 2 }, reward: [{ op: 'announce', text: 'x' }] }]))).toThrow(/no acting contestant/);
    expect(() => game([], objectives([{ id: 'obj.y', name: 'Y', goal: { kind: 'reach', resource: 'res.nope', atLeast: 2 }, reward: [{ op: 'announce', text: 'x' }] }]))).toThrow(CompileError);
    expect(() => game([], objectives([{ id: 'obj.z', name: 'Z', goal: { kind: 'count', trigger: { event: 'landed', where: { spaceTag: 'tag.nope' } }, times: 2 }, reward: [{ op: 'announce', text: 'x' }] }]))).toThrow(/unknown tag/);
  });
});

/** Starts a match, gives both contestants goods, and returns the state at the actor's main decision. */
function atMain(g: CompiledGame, setup: (s: GameState, actor: string, other: string) => GameState = (s) => s) {
  let { state } = startMini(g);
  const actor = state.pendingDecision?.actor as string;
  const other = state.turnOrder.find((id) => id !== actor) as string;
  state = gm(g, state, { type: 'setResource', entity: other, resource: 'res.bananas', value: 6, silent: true }).state;
  state = setup(state, actor, other);
  state = choose(g, state, `mv:${state.entities[actor]?.spaceId}`).state;
  expect(state.pendingDecision?.kind).toBe('main');
  return { state, actor, other };
}

function propose(g: CompiledGame, state: GameState, offer: TradeOfferInput) {
  return answer(g, state, 'trade', { trade: offer });
}

describe('trading', () => {
  const g = game([], tradeable, withItems);

  it('offer → accept swaps goods atomically; the proposer then gets its main decision back, without trading', () => {
    const { state, actor, other } = atMain(g);
    expect(state.pendingDecision?.options.some((o) => o.id === 'trade')).toBe(true);
    const offered = expectOk(propose(g, state, { with: other, give: { resources: { 'res.gold': 4 } }, get: { resources: { 'res.bananas': 3 } }, message: 'Bananas for gold?' }));
    const proposal = offered.events.find((e) => e.type === 'tradeProposed');
    expect(proposal?.audience).toEqual([actor, other]);
    expect(offered.events.find((e) => e.type === 'decided')?.audience).toEqual([actor, other]);
    expect(offered.state.pendingDecision).toMatchObject({ actor: other, kind: 'trade' });
    expect(offered.state.pendingDecision?.options.map((o) => o.id)).toEqual(['tr:accept', 'tr:reject', 'tr:counter']);
    const view = buildContestantView(g, offered.state, other, offered.events);
    expect(view.negotiation).toMatchObject({ partner: actor, proposedByYou: false, youGive: { resources: { 'res.bananas': 3 } }, youGet: { resources: { 'res.gold': 4 } }, message: 'Bananas for gold?' });
    const accepted = expectOk(answer(g, offered.state, 'tr:accept'));
    expect(accepted.events.find((e) => e.type === 'tradeCompleted')?.audience).toBe('all');
    expect(accepted.state.entities[actor]?.resources).toMatchObject({ 'res.gold': 6, 'res.bananas': 3 });
    expect(accepted.state.entities[other]?.resources).toMatchObject({ 'res.gold': 14, 'res.bananas': 3 });
    expect(accepted.state.negotiation).toBeNull();
    expect(accepted.state.pendingDecision).toMatchObject({ actor, kind: 'main' });
    expect(accepted.state.pendingDecision?.options.some((o) => o.id === 'trade')).toBe(false);
  });

  it('reject leaves everything as it was; the negotiation is private to the two parties', () => {
    const { state, actor, other } = atMain(g);
    const offered = expectOk(propose(g, state, { with: other, give: { resources: { 'res.gold': 1 } }, get: { resources: { 'res.bananas': 6 } } }));
    const rejected = expectOk(answer(g, offered.state, 'tr:reject', { say: 'Not a chance.' }));
    expect(rejected.events.find((e) => e.type === 'tradeRejected')).toMatchObject({ by: other, automatic: false, audience: [actor, other] });
    expect(rejected.state.entities[actor]?.resources['res.gold']).toBe(10);
    expect(rejected.state.pendingDecision).toMatchObject({ actor, kind: 'main' });
  });

  it('one counteroffer, then the proposer decides; items and promises can be part of it', () => {
    const { state, actor, other } = atMain(g, (s, _a, o) => gm(g, s, { type: 'grantItem', entity: o, item: 'item.potion' }).state);
    const offered = expectOk(propose(g, state, { with: other, give: { resources: { 'res.gold': 2 } }, get: { items: ['item.potion'] } }));
    const countered = expectOk(answer(g, offered.state, 'tr:counter', { trade: { give: { items: ['item.potion'] }, get: { resources: { 'res.gold': 5 } }, promises: [{ by: 'them', kind: 'noAttack', rounds: 2 }], message: 'Five, and I will not attack you.' } }));
    expect(countered.events.find((e) => e.type === 'tradeCountered')?.audience).toEqual([actor, other]);
    expect(countered.state.pendingDecision).toMatchObject({ actor, kind: 'trade' });
    expect(countered.state.pendingDecision?.options.map((o) => o.id)).toEqual(['tr:accept', 'tr:reject']);
    // "them" in the counter was the proposer: the proposer promises not to attack.
    const actorView = buildContestantView(g, countered.state, actor, countered.events);
    expect(actorView.negotiation?.promises).toEqual([expect.objectContaining({ byYou: true, kind: 'noAttack', rounds: 2, text: expect.stringContaining('you will not attack') })]);
    const done = expectOk(answer(g, countered.state, 'tr:accept'));
    expect(done.state.entities[actor]?.items.map((i) => done.state.items[i]?.defId)).toEqual(['item.potion']);
    expect(done.state.entities[actor]?.resources['res.gold']).toBe(5);
    expect(done.state.commitments).toEqual([expect.objectContaining({ by: actor, to: other, kind: 'noAttack', status: 'open', dueRound: state.round + 2 })]);
    expect(done.events.some((e) => e.type === 'promiseMade')).toBe(true);
    // No second counteroffer.
    const again = answer(g, countered.state, 'tr:counter', { trade: { give: {}, get: {} } });
    expect(again.ok).toBe(false);
  });

  it('refuses bad terms with messages that reveal nothing hidden', () => {
    const { state, other } = atMain(g, (s, a, o) => {
      let t = gm(g, s, { type: 'grantItem', entity: o, item: 'item.coin' }).state;
      t = gm(g, t, { type: 'grantItem', entity: a, item: 'item.relic' }).state;
      return gm(g, t, { type: 'setResource', entity: o, resource: 'res.stash', value: 5, silent: true }).state;
    });
    const fail = (offer: TradeOfferInput) => {
      const out = propose(g, state, offer);
      expect(out.ok).toBe(false);
      return out.ok ? '' : out.message;
    };
    expect(fail({ with: other, give: { resources: { 'res.gold': 50 } }, get: {} })).toBe('you have only 10 Gold');
    expect(fail({ with: other, give: {}, get: { resources: { 'res.bananas': 7 } } })).toBe('Bob has only 6 Bananas'.replace('Bob', state.entities[other]?.name ?? ''));
    expect(fail({ with: other, give: {}, get: { resources: { 'res.stash': 1 } } })).toBe('Stash cannot be traded');
    expect(fail({ with: other, give: {}, get: { items: ['item.coin'] } })).toBe('Coin cannot be traded');
    expect(fail({ with: other, give: { items: ['item.relic'] }, get: {} })).toBe('Relic cannot be traded');
    expect(fail({ with: other, give: {}, get: {} })).toBe('a trade needs something to change hands');
    expect(fail({ with: other, give: {}, get: {}, promises: [{ by: 'me', kind: 'noAttack', rounds: 9 }] })).toBe('a promise lasts 1 to 5 rounds');
    expect(fail({ give: { resources: { 'res.gold': 1 } }, get: {} })).toBe('choose another contestant in play to trade with');
    expect(propose(g, state, undefined as never).ok).toBe(false);
  });

  it('a full inventory blocks receiving items; acceptance re-checks that both sides can deliver', () => {
    const { state, actor, other } = atMain(g, (s, a) => {
      let t = gm(g, s, { type: 'grantItem', entity: a, item: 'item.sword' }).state;
      t = gm(g, t, { type: 'grantItem', entity: a, item: 'item.sword' }).state;
      return t;
    });
    const full = propose(g, state, { with: other, give: {}, get: { resources: { 'res.bananas': 1 } } });
    expect(full.ok).toBe(true);
    const potionOther = gm(g, state, { type: 'grantItem', entity: other, item: 'item.potion' }).state;
    const blocked = propose(g, potionOther, { with: other, give: {}, get: { items: ['item.potion'] } });
    expect(blocked.ok === false && blocked.message).toBe('you cannot carry that many items');
    // A swap (one out, one in) fits.
    expect(propose(g, potionOther, { with: other, give: { items: ['item.sword'] }, get: { items: ['item.potion'] } }).ok).toBe(true);
    // Holdings change before acceptance (GM edit): accept is no longer offered.
    const offered = expectOk(propose(g, state, { with: other, give: { resources: { 'res.gold': 8 } }, get: { resources: { 'res.bananas': 2 } } })).state;
    const poorer = gm(g, offered, { type: 'setResource', entity: actor, resource: 'res.gold', value: 3 }).state;
    expect(poorer.pendingDecision?.options.map((o) => o.id)).toEqual(['tr:reject', 'tr:counter']);
  });

  it('an offer lapses when the partner can no longer answer', () => {
    const g2 = game([], tradeable, (d) => {
      d.statuses = [{ id: 'status.mute', name: 'Mute', duration: 2, suppress: ['trades'] }];
    });
    const { state, actor, other } = atMain(g2);
    const offered = expectOk(propose(g2, state, { with: other, give: { resources: { 'res.gold': 1 } }, get: {} })).state;
    const muted = gm(g2, offered, { type: 'applyStatus', entity: other, status: 'status.mute' }).state;
    expect(muted.pendingDecision).toBeNull();
    const lapsed = expectOk(advance(g2, muted));
    expect(lapsed.events.find((e) => e.type === 'tradeRejected')).toMatchObject({ automatic: true, by: other });
    expect(lapsed.state.pendingDecision).toMatchObject({ actor, kind: 'main' });
  });

  it('is off when disabled, when nothing is tradeable, or once per turn', () => {
    const off = game([], tradeable, (d) => {
      d.settings.trading = { enabled: false, maxPromiseRounds: 5 };
    });
    expect(atMain(off).state.pendingDecision?.options.some((o) => o.kind === 'trade')).toBe(false);
    const nothing = game([], (d) => {
      for (const i of d.items ?? []) i.tradeable = false;
    });
    expect(atMain(nothing).state.pendingDecision?.options.some((o) => o.kind === 'trade')).toBe(false);
    // Once per turn: after a rejected offer the option is gone until the next turn.
    const { state, actor, other } = atMain(g);
    const rejected = expectOk(answer(g, expectOk(propose(g, state, { with: other, give: { resources: { 'res.gold': 1 } }, get: {} })).state, 'tr:reject')).state;
    expect(rejected.pendingDecision?.options.some((o) => o.kind === 'trade')).toBe(false);
    const next = idle(g, rejected, (s) => s.pendingDecision?.actor === actor && s.pendingDecision.kind === 'main' && s.round > state.round).state;
    expect(next.pendingDecision?.options.some((o) => o.kind === 'trade')).toBe(true);
  });

  it('tradeable resources must be public pools of contestants', () => {
    expect(() =>
      game([], (d) => {
        for (const r of d.resources) if (r.id === 'res.stash') r.tradeable = true;
      }),
    ).toThrow(/must be a public pool/);
  });
});

describe('promises', () => {
  const g = game([], tradeable);

  function withPromise(promise: TradeOfferInput['promises'], give: TradeOfferInput['give'] = { resources: { 'res.gold': 1 } }) {
    const { state, actor, other } = atMain(g);
    const offered = expectOk(propose(g, state, { with: other, give, get: {}, promises: promise })).state;
    return { state: expectOk(answer(g, offered, 'tr:accept')).state, actor, other };
  }

  it('attacking despite a no-attack promise breaks it (publicly); otherwise it is kept when due', () => {
    let { state, actor, other } = withPromise([{ by: 'me', kind: 'noAttack', rounds: 1 }]);
    const due = state.commitments[0]?.dueRound as number;
    // Kept: wait until the end of the due round.
    const kept = idle(g, state, (s) => s.round > due);
    expect(kept.events.find((e) => e.type === 'promiseKept')).toMatchObject({ by: actor, to: other, audience: 'all' });
    // Broken: attack the partner on the same space.
    state = gm(g, state, { type: 'teleport', entity: other, space: state.entities[actor]?.spaceId as string, asLanding: false }).state;
    const attack = state.pendingDecision?.options.find((o) => o.id === `atk:${other}`);
    expect(attack).toBeDefined();
    const out = expectOk(answer(g, state, `atk:${other}`));
    const broken = out.events.findIndex((e) => e.type === 'promiseBroken');
    const fight = out.events.findIndex((e) => e.type === 'fightStarted');
    expect(broken).toBeGreaterThanOrEqual(0);
    expect(broken).toBeLessThan(fight);
    expect(out.state.commitments[0]?.status).toBe('broken');
  });

  it('a payment promise is kept by paying (a free action) or broken when the deadline passes', () => {
    let { state, actor, other } = withPromise([{ by: 'me', kind: 'pay', resource: 'res.gold', amount: 3, rounds: 1 }]);
    const pay = state.pendingDecision?.options.find((o) => o.kind === 'pay');
    expect(pay?.label).toBe(`Pay ${state.entities[other]?.name} 3 Gold (as promised)`);
    const paid = expectOk(answer(g, state, pay?.id as string));
    expect(paid.state.entities[actor]?.resources['res.gold']).toBe(6);
    expect(paid.state.entities[other]?.resources['res.gold']).toBe(14);
    expect(paid.state.commitments[0]?.status).toBe('kept');
    expect(paid.state.pendingDecision).toMatchObject({ actor, kind: 'main' });
    // Unpaid until the end of the due round: broken.
    const due = state.commitments[0]?.dueRound as number;
    const r = idle(g, state, (s) => s.round > due);
    expect(r.events.find((e) => e.type === 'promiseBroken')).toMatchObject({ by: actor, kind: 'pay' });
    expect(r.state.commitments[0]?.status).toBe('broken');
    state = r.state;
  });

  it('promises everyone can see, and they lapse if a party is eliminated', () => {
    const g2 = game([], tradeable, (d) => {
      d.settings.ko.mode = 'eliminate';
      d.cast.push({ id: 'cast.cy', name: 'Cy', color: '#0f0', persona: { voice: 'c', traits: { risk: 5, aggression: 5, greed: 5, loyalty: 5, vindictiveness: 5, sociability: 5 }, behaviors: [] } });
    });
    const { state, actor, other } = atMain(g2);
    const offered = expectOk(propose(g2, state, { with: other, give: { resources: { 'res.gold': 1 } }, get: {}, promises: [{ by: 'them', kind: 'pay', resource: 'res.gold', amount: 2, rounds: 2 }] })).state;
    const done = expectOk(answer(g2, offered, 'tr:accept')).state;
    const third = done.turnOrder.find((id) => id !== actor && id !== other) as string;
    const thirdView = buildContestantView(g2, done, third, []);
    expect(thirdView.commitments).toEqual([expect.objectContaining({ by: other, to: actor, kind: 'pay', amount: 2 })]);
    const gone = gm(g2, done, { type: 'setResource', entity: other, resource: 'res.hp', value: 0 }).state;
    const r = idle(g2, gone, (s) => s.round > done.round);
    expect(r.state.commitments[0]?.status).toBe('void');
  });
});

describe('determinism with trades', () => {
  it('a match with trades replays to the same state', () => {
    const g = game([], tradeable);
    const run = () => {
      let state = expectOk(createMatch(g, { matchId: 'm', seed: 'trade' })).state;
      for (let i = 0; i < 300 && nextStepKind(state) !== 'gameOver'; i++) {
        const d = state.pendingDecision;
        if (!d) state = expectOk(advance(g, state)).state;
        else if (d.kind === 'main' && d.options.some((o) => o.kind === 'trade')) {
          const other = state.turnOrder.find((id) => id !== d.actor) as string;
          const out = answerDecision(g, state, { decisionId: d.id, optionId: 'trade', trade: { with: other, give: { resources: { 'res.gold': 1 } }, get: {} } });
          state = out.ok ? out.state : expectOk(answerDecision(g, state, { decisionId: d.id, optionId: 'pass' })).state;
        } else state = expectOk(answerDecision(g, state, { decisionId: d.id, optionId: d.options.find((o) => o.id === 'tr:accept')?.id ?? d.options[0]?.id as string })).state;
      }
      return state;
    };
    expect(run()).toEqual(run());
  });
});

describe('packets', () => {
  it('a trade offer reads from the answering contestant’s side, with promises, message and answer options', async () => {
    const { buildDecisionPacket } = await import('../src/contestants/packet.ts');
    const { newMind } = await import('../src/contestants/mind.ts');
    const { publicInfo } = await import('../src/visibility/public-info.ts');
    const g = game([], tradeable, withItems);
    const { state, actor, other } = atMain(g, (s, _a, o) => gm(g, s, { type: 'grantItem', entity: o, item: 'item.potion' }).state);
    const offered = expectOk(propose(g, state, { with: other, give: { resources: { 'res.gold': 4 } }, get: { items: ['item.potion'] }, promises: [{ by: 'me', kind: 'noAttack', rounds: 2 }], message: 'Deal?' }));
    const view = buildContestantView(g, offered.state, other, offered.events);
    const persona = g.cast.get(offered.state.entities[other]?.defId as string)?.persona;
    if (!persona) throw new Error('persona');
    const packet = buildDecisionPacket(publicInfo(g), view, newMind(other, 'cast.bob', ['opportunist'], 'llm'), persona);
    const name = offered.state.entities[actor]?.name as string;
    expect(packet.input).toContain(`TRADE — ${name} offers you a trade: you give Potion; you get 4 Gold; ${name} will not attack you for 2 rounds. Message: “Deal?”`);
    expect(packet.input).toContain('[tr:accept] Accept');
    expect(packet.input).toContain('[tr:counter] Counteroffer');
    expect(packet.instructions).toContain('Trading: once per turn');
  });

  it('the trade option lists partners with their ids and what they hold', async () => {
    const { buildDecisionPacket } = await import('../src/contestants/packet.ts');
    const { newMind } = await import('../src/contestants/mind.ts');
    const { publicInfo } = await import('../src/visibility/public-info.ts');
    const g = game([], tradeable, withItems);
    const { state, actor, other } = atMain(g, (s, a) => gm(g, s, { type: 'grantItem', entity: a, item: 'item.potion' }).state);
    const view = buildContestantView(g, state, actor, []);
    const persona = g.cast.get(state.entities[actor]?.defId as string)?.persona;
    if (!persona) throw new Error('persona');
    const packet = buildDecisionPacket(publicInfo(g), view, newMind(actor, 'cast.ann', ['opportunist'], 'llm'), persona);
    expect(packet.input).toContain(`[trade] Propose a trade (free action; you still act afterwards). You hold 10 Gold, Potion (item.potion). Partners: ${state.entities[other]?.name} [${other}]: 10 Gold, 6 Bananas`);
  });
});
