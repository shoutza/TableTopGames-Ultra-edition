import { describe, expect, it } from 'vitest';
import { advance, answerDecision, applyGmCommand, CompileError, effectiveValue, hasCapability, nextStepKind, type CompiledGame } from '../src/engine/index.ts';
import { GmCommandSchema, type GmCommandInput } from '../src/schema/commands.ts';
import type { GameDefinitionInput } from '../src/schema/definition.ts';
import type { GameEvent, GameState } from '../src/schema/state.ts';
import { buildContestantView } from '../src/visibility/view.ts';
import { choose, deepFreeze, entityByName, expectOk, miniGame, startMini, type TestRule } from './helpers/mini.ts';

/**
 * Rule-interaction scenarios for the M4 mechanics: statuses, modifiers, continuous and attached
 * rules, decks and choices, custom actions, usable and concealed items, PvP, elimination, bosses,
 * spawning and rule limits. Each builds a small definition on the mini board and checks the
 * resulting events, state and (where relevant) the contestant's view.
 */

type Mutate = (d: GameDefinitionInput) => void;

function game(rules: TestRule[] = [], ...mutations: Mutate[]): CompiledGame {
  return miniGame({ rules, mutate: (d) => mutations.forEach((m) => m(d)) });
}

function gm(g: CompiledGame, state: GameState, cmd: GmCommandInput) {
  return expectOk(applyGmCommand(g, state, GmCommandSchema.parse(cmd)));
}

function gmFail(g: CompiledGame, state: GameState, cmd: GmCommandInput) {
  const out = applyGmCommand(g, state, GmCommandSchema.parse(cmd));
  expect(out.ok).toBe(false);
  return out;
}

const power = (g: CompiledGame, s: GameState, id: string) => effectiveValue(g, s, s.entities[id] as never, 'res.power');

/** Answers decisions with "stay" / "pass" (or the first choice option) until `until` holds. */
function idleUntil(g: CompiledGame, state: GameState, until: (s: GameState) => boolean, max = 400): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  for (let i = 0; i < max && !until(state) && nextStepKind(state) !== 'gameOver'; i++) {
    const out = nextStepKind(state) === 'auto' ? advance(g, state) : answerDecision(g, state, { decisionId: state.pendingDecision?.id as string, optionId: idleOption(state) });
    state = expectOk(out).state;
    events.push(...expectOk(out).events);
  }
  return { state, events };
}

function idleOption(state: GameState): string {
  const d = state.pendingDecision;
  if (!d) throw new Error('no decision');
  const o = d.options.find((x) => x.kind === 'pass' || (x.kind === 'move' && x.steps === 0)) ?? d.options.find((x) => x.kind === 'choose') ?? d.options[0];
  return o?.id as string;
}

const statuses = (list: NonNullable<GameDefinitionInput['statuses']>): Mutate => (d) => {
  d.statuses = [...(d.statuses ?? []), ...list];
};
const items = (list: NonNullable<GameDefinitionInput['items']>): Mutate => (d) => {
  d.items = [...(d.items ?? []), ...list];
};
const withMove: Mutate = (d) => {
  d.resources.push({ id: 'res.move', name: 'Move', role: 'stat', appliesTo: ['contestant'], default: 0, min: -3, max: 3 });
  d.settings.movement = { die: 3, bonus: 'res.move' };
};

const BLESSED = { id: 'status.blessed', name: 'Blessed', duration: 2, stacking: 'refresh' as const, modifiers: [{ resource: 'res.power', add: 100 }] };
const RAGE = { id: 'status.rage', name: 'Rage', duration: 3, stacking: 'stack' as const, maxStacks: 3, modifiers: [{ resource: 'res.power', add: 10 }] };
const SLOW = { id: 'status.slow', name: 'Slow', duration: 2, stacking: 'extend' as const };
const ONCE = { id: 'status.once', name: 'Once', duration: 2, stacking: 'ignore' as const };
const FISH_FORM = {
  id: 'status.fish_form',
  name: 'Fish Form',
  transformation: true,
  duration: 3,
  grantsTags: ['tag.fish'],
  modifiers: [{ resource: 'res.move', add: -1 }],
  suppress: ['shops' as const],
};

describe('statuses', () => {
  it('apply adds modifiers to effective values and records an event', () => {
    const g = game([], statuses([BLESSED]));
    const { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    const out = gm(g, state, { type: 'applyStatus', entity: ann, status: 'status.blessed' });
    expect(power(g, out.state, ann)).toBe(180);
    expect(out.events.some((e) => e.type === 'statusApplied' && e.status === 'status.blessed' && e.remaining === 2)).toBe(true);
  });

  it('stack: stacks add up to the maximum and multiply modifiers', () => {
    const g = game([], statuses([RAGE]));
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    for (let i = 0; i < 5; i++) state = gm(g, state, { type: 'applyStatus', entity: ann, status: 'status.rage' }).state;
    expect(state.entities[ann]?.statuses[0]?.stacks).toBe(3);
    expect(power(g, state, ann)).toBe(110);
  });

  it('refresh resets the duration; extend adds to it; ignore changes nothing', () => {
    const g = game([], statuses([BLESSED, SLOW, ONCE]));
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    for (const s of ['status.blessed', 'status.slow', 'status.once']) state = gm(g, state, { type: 'applyStatus', entity: ann, status: s }).state;
    const again = (s: string) => gm(g, state, { type: 'applyStatus', entity: ann, status: s });
    state.entities[ann]?.statuses.forEach((s) => (s.remaining = 1));
    const refreshed = again('status.blessed');
    expect(refreshed.state.entities[ann]?.statuses.find((s) => s.defId === 'status.blessed')?.remaining).toBe(2);
    const extended = again('status.slow');
    expect(extended.state.entities[ann]?.statuses.find((s) => s.defId === 'status.slow')?.remaining).toBe(3);
    const ignored = again('status.once');
    expect(ignored.state.entities[ann]?.statuses.find((s) => s.defId === 'status.once')?.remaining).toBe(1);
    expect(ignored.events.some((e) => e.type === 'statusApplied')).toBe(false);
  });

  it('counts down at the end of the holder’s turns, skipping the turn in which it was applied', () => {
    const g = game([], statuses([BLESSED]));
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    state = gm(g, state, { type: 'applyStatus', entity: actor, status: 'status.blessed' }).state;
    expect(state.entities[actor]?.statuses[0]?.fresh).toBe(true);
    // End of this turn: no countdown. End of the next two turns: expires.
    const turnEnds = (s: GameState) => s.phase === 'turnStart' && s.turnOrder[s.turn.index] === actor;
    let r = idleUntil(g, state, (s) => s.phase === 'turnStart' && s.turnOrder[s.turn.index] !== actor);
    expect(r.state.entities[actor]?.statuses[0]?.remaining).toBe(2);
    r = idleUntil(g, r.state, turnEnds);
    r = idleUntil(g, r.state, (s) => s.phase === 'turnStart' && s.turnOrder[s.turn.index] !== actor);
    expect(r.state.entities[actor]?.statuses[0]?.remaining).toBe(1);
    r = idleUntil(g, r.state, turnEnds);
    r = idleUntil(g, r.state, (s) => s.phase === 'turnStart' && s.turnOrder[s.turn.index] !== actor);
    expect(r.state.entities[actor]?.statuses).toHaveLength(0);
    expect(r.events.some((e) => e.type === 'statusRemoved' && e.reason === 'expired')).toBe(true);
    expect(power(g, r.state, actor)).toBe(80);
  });

  it('granted tags count for conditions (a Fish Form holder gets the Fishy Blue Bonus)', () => {
    const fishRule: TestRule = {
      id: 'rule.fish_bananas',
      trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } },
      conditions: { op: 'hasTag', entity: '$actor', tag: 'tag.fish' },
      effects: [{ op: 'changeResource', target: '$actor', resource: 'res.bananas', amount: 2 }],
    };
    const g = game([fishRule], withMove, statuses([FISH_FORM]));
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    state = gm(g, state, { type: 'applyStatus', entity: ann, status: 'status.fish_form' }).state;
    expect(state.entities[ann]?.tags).toEqual([]);
    const landed = gm(g, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true });
    expect(landed.state.entities[ann]?.resources['res.bananas']).toBe(2);
  });

  it('Fish Form preview: −1 Move on the roll and no shop access', () => {
    const g = game([], withMove, statuses([FISH_FORM]));
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    // Put the actor on the shop space, transform it, and let a fresh turn begin.
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s1', asLanding: false }).state;
    state = gm(g, state, { type: 'setResource', entity: actor, resource: 'res.gold', value: 50, silent: true }).state;
    state = gm(g, state, { type: 'applyStatus', entity: actor, status: 'status.fish_form' }).state;
    state = choose(g, state, 'mv:space.s1').state;
    const main = state.pendingDecision;
    expect(main?.kind).toBe('main');
    expect(main?.options.some((o) => o.kind === 'buy')).toBe(false);
    const view = buildContestantView(g, state, actor, []);
    const me = view.entities.find((e) => e.isSelf);
    expect(me?.suppressed).toEqual([{ capability: 'shops', by: 'Fish Form' }]);
    expect(me?.stats['res.move']).toBe(-1);
    // Next own turn: the roll includes −1.
    const r = idleUntil(g, state, (s) => s.phase === 'move' && s.pendingDecision?.actor === actor);
    const rolled = [...r.events].reverse().find((e) => e.type === 'rolled' && e.entity === actor);
    expect(rolled?.type === 'rolled' && rolled.bonus).toBe(-1);
    expect(rolled?.type === 'rolled' && rolled.total).toBe(Math.max(0, (rolled?.type === 'rolled' ? rolled.value : 0) - 1));
  });

  it('suppressed moves leave only "stay"; suppressed turns are skipped', () => {
    const g = game([], statuses([
      { id: 'status.rooted', name: 'Rooted', duration: 2, suppress: ['moves'] },
      { id: 'status.stunned', name: 'Stunned', duration: 1, stacking: 'ignore', suppress: ['takesTurns'] },
    ]));
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    const other = state.turnOrder.find((id) => id !== actor) as string;
    const rooted = gm(g, state, { type: 'applyStatus', entity: actor, status: 'status.rooted' });
    expect(rooted.state.pendingDecision?.options.map((o) => o.id)).toEqual([`mv:${state.entities[actor]?.spaceId}`]);
    state = gm(g, state, { type: 'applyStatus', entity: other, status: 'status.stunned' }).state;
    const r = idleUntil(g, state, (s) => s.phase === 'turnEnd' && s.turnOrder[s.turn.index] === other);
    expect(r.events.some((e) => e.type === 'turnSkipped' && e.entity === other && e.reason.includes('Stunned'))).toBe(true);
  });

  it('a hidden status is invisible to contestants, including its modifier', () => {
    const g = game([], statuses([{ id: 'status.hex', name: 'Hex', duration: null, visibility: 'hidden', modifiers: [{ resource: 'res.power', add: -50 }] }]));
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    const bob = entityByName(state, 'Bob');
    const out = gm(g, state, { type: 'applyStatus', entity: ann, status: 'status.hex' });
    state = out.state;
    expect(power(g, state, ann)).toBe(30);
    expect(out.events.find((e) => e.type === 'statusApplied')?.audience).toBe('gm');
    for (const viewer of [ann, bob]) {
      const view = buildContestantView(g, state, viewer, out.events);
      const annView = view.entities.find((e) => e.id === ann);
      expect(annView?.statuses).toEqual([]);
      expect(annView?.stats['res.power']).toBe(80);
      expect(view.recentEvents.some((e) => e.type === 'statusApplied')).toBe(false);
    }
  });

  it('statuses on enemies count down at the end of each round', () => {
    const g = game([], statuses([BLESSED]));
    let { state } = startMini(g);
    const ogre = entityByName(state, 'Ogre');
    state = gm(g, state, { type: 'applyStatus', entity: ogre, status: 'status.blessed' }).state;
    const r1 = idleUntil(g, state, (s) => s.round === 2);
    expect(r1.state.entities[ogre]?.statuses[0]?.remaining).toBe(2);
    const r2 = idleUntil(g, r1.state, (s) => s.round === 4);
    expect(r2.state.entities[ogre]?.statuses).toHaveLength(0);
  });

  it('a respawning enemy returns at its current max HP (lowered by the GM), not its definition’s', () => {
    const g = game();
    let { state } = startMini(g);
    const ogre = entityByName(state, 'Ogre');
    state = gm(g, state, { type: 'setResource', entity: ogre, resource: 'res.max_hp', value: 20 }).state;
    state = gm(g, state, { type: 'setResource', entity: ogre, resource: 'res.hp', value: 0 }).state;
    expect(state.entities[ogre]?.status).toBe('defeated');
    const r = idleUntil(g, state, (s) => s.entities[ogre]?.status === 'active');
    expect(r.state.entities[ogre]?.resources['res.hp']).toBe(20);
  });

  it('removing a max-HP status re-clamps HP', () => {
    const g = game([], statuses([{ id: 'status.vigor', name: 'Vigor', duration: null, modifiers: [{ resource: 'res.max_hp', add: 50 }] }]));
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    state = gm(g, state, { type: 'applyStatus', entity: ann, status: 'status.vigor' }).state;
    state = gm(g, state, { type: 'setResource', entity: ann, resource: 'res.hp', value: 150 }).state;
    expect(state.entities[ann]?.resources['res.hp']).toBe(150);
    const out = gm(g, state, { type: 'removeStatus', entity: ann, status: 'status.vigor' });
    expect(out.state.entities[ann]?.resources['res.hp']).toBe(100);
  });

  it('a status-attached reaction ticks at the end of the holder’s turn and scales with stacks', () => {
    const poison = {
      id: 'status.poison',
      name: 'Poison',
      duration: 3,
      stacking: 'stack' as const,
      maxStacks: 3,
      rules: [
        {
          id: 'rule.poison_tick',
          name: 'Poison',
          trigger: { event: 'turnEnded' as const },
          conditions: { op: 'same' as const, a: '$actor' as const, b: '$holder' as const },
          effects: [{ op: 'damage' as const, target: '$holder' as const, amount: { op: 'mul' as const, args: [5, { op: 'stacks' as const, of: '$holder' as const, status: 'status.poison' }] } }],
        },
      ],
    };
    const g = game([], statuses([poison]));
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    state = gm(g, state, { type: 'applyStatus', entity: actor, status: 'status.poison' }).state;
    state = gm(g, state, { type: 'applyStatus', entity: actor, status: 'status.poison' }).state;
    const r = idleUntil(g, state, (s) => s.phase === 'turnStart' && s.turnOrder[s.turn.index] !== actor);
    expect(r.state.entities[actor]?.resources['res.hp']).toBe(90);
    expect(r.events.some((e) => e.type === 'damaged' && e.entity === actor && e.amount === 10)).toBe(true);
  });
});

const SHIELD = {
  id: 'status.shield',
  name: 'Shield',
  duration: 5,
  stacking: 'stack' as const,
  maxStacks: 3,
  rules: [
    {
      id: 'rule.shield',
      name: 'Shield',
      kind: 'modifier' as const,
      on: 'damage' as const,
      conditions: { op: 'same' as const, a: '$target' as const, b: '$holder' as const },
      modify: { op: 'prevent' as const },
      consume: { status: 'status.shield' },
    },
  ],
};

describe('modifiers', () => {
  it('a shield absorbs whole hits, one stack each, in fights and from damage effects', () => {
    const hazard: TestRule = { id: 'rule.hazard', trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } }, effects: [{ op: 'damage', target: '$actor', amount: 30 }] };
    const g = game([hazard], statuses([SHIELD]));
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    state = gm(g, state, { type: 'applyStatus', entity: ann, status: 'status.shield', stacks: 1 }).state;
    const out = gm(g, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true });
    expect(out.state.entities[ann]?.resources['res.hp']).toBe(100);
    expect(out.state.entities[ann]?.statuses).toHaveLength(0);
    const hit = out.events.find((e) => e.type === 'damaged');
    expect(hit?.type === 'damaged' && hit.amount).toBe(0);
    expect(hit?.type === 'damaged' && hit.mods?.[0]?.rule).toBe('rule.shield');
    // Second landing: no shield left.
    const again = gm(g, out.state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true });
    expect(again.state.entities[ann]?.resources['res.hp']).toBe(70);
  });

  it('shields change the fight odds shown to contestants', () => {
    const g = game([], statuses([SHIELD]));
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    const ogre = entityByName(state, 'Ogre');
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s4', asLanding: false }).state;
    state = choose(g, state, 'mv:space.s4').state;
    const plain = buildContestantView(g, state, actor, []).decision?.previews.find((p) => p.kind === 'attack');
    state = gm(g, state, { type: 'applyStatus', entity: actor, status: 'status.shield', stacks: 3 }).state;
    const shielded = buildContestantView(g, state, actor, []).decision?.previews.find((p) => p.kind === 'attack');
    if (plain?.kind !== 'attack' || shielded?.kind !== 'attack') throw new Error('no attack preview');
    expect(shielded.target).toBe(ogre);
    expect(shielded.fight.odds.modified).toBe(true);
    expect(shielded.fight.odds.pDefenderWins).toBeLessThan(plain.fight.odds.pDefenderWins);
  });

  it('resource-change modifiers apply to rule effects but not to payments or GM edits', () => {
    const lucky: TestRule = {
      id: 'rule.lucky',
      kind: 'modifier',
      on: 'resourceChange',
      where: { resource: 'res.gold', direction: 'gain' },
      modify: { op: 'add', amount: 1 },
    };
    const coin: TestRule = { id: 'rule.coin', trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } }, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.gold', amount: 3 }] };
    const g = game([lucky, coin]);
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    const landed = gm(g, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true });
    expect(landed.state.entities[ann]?.resources['res.gold']).toBe(14);
    const ev = landed.events.find((e) => e.type === 'resourceChanged' && e.resource === 'res.gold');
    expect(ev?.type === 'resourceChanged' && ev.requested).toBe(3);
    expect(ev?.type === 'resourceChanged' && ev.mods?.[0]).toEqual({ rule: 'rule.lucky', from: 3, to: 4 });
    state = gm(g, landed.state, { type: 'adjustResource', entity: ann, resource: 'res.gold', delta: 5 }).state;
    expect(state.entities[ann]?.resources['res.gold']).toBe(19);
  });

  it('price modifiers change the offered price and the price paid', () => {
    const discount: TestRule = { id: 'rule.discount', kind: 'modifier', on: 'price', where: { shopEntry: 'entry.star' }, modify: { op: 'add', amount: -3 } };
    const g = game([discount]);
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s1', asLanding: false }).state;
    state = choose(g, state, 'mv:space.s1').state;
    const buy = state.pendingDecision?.options.find((o) => o.kind === 'buy' && o.entry === 'entry.star');
    expect(buy?.kind === 'buy' && buy.price).toBe(7);
    expect(buy?.label).toContain('for 7 Gold');
    const out = choose(g, state, buy?.id as string);
    expect(out.state.entities[actor]?.resources['res.gold']).toBe(3);
    expect(out.state.entities[actor]?.resources['res.stars']).toBe(1);
  });

  it('hidden price or roll modifiers are rejected by the compiler', () => {
    expect(() => game([{ id: 'rule.secret_tax', kind: 'modifier', on: 'price', visibility: 'hidden', modify: { op: 'add', amount: 2 } }])).toThrow(/must be public/);
    expect(() => game([{ id: 'rule.free', kind: 'modifier', on: 'price', modify: { op: 'prevent' } }])).toThrow(/cannot be prevented|not prevented/);
  });

  it('movement-roll modifiers change the roll total', () => {
    const boost: TestRule = { id: 'rule.boost', kind: 'modifier', on: 'moveRoll', modify: { op: 'add', amount: 2 } };
    const g = game([boost]);
    const { events } = startMini(g);
    const rolled = events.find((e) => e.type === 'rolled');
    if (rolled?.type !== 'rolled') throw new Error('no roll');
    expect(rolled.total).toBe(rolled.value + 2);
  });

  it('modifiers apply in priority order and "prevent" ends the chain', () => {
    const rules: TestRule[] = [
      { id: 'rule.half', kind: 'modifier', on: 'damage', priority: 1, modify: { op: 'scale', num: 1, den: 2, rounding: 'floor' } },
      { id: 'rule.plus', kind: 'modifier', on: 'damage', priority: 0, modify: { op: 'add', amount: 5 } },
      { id: 'rule.hazard', trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } }, effects: [{ op: 'damage', target: '$actor', amount: 21 }] },
    ];
    const g = game(rules);
    const { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    const out = gm(g, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true });
    const hit = out.events.find((e) => e.type === 'damaged');
    expect(hit?.type === 'damaged' && hit.amount).toBe(13); // (21 + 5) / 2
    expect(hit?.type === 'damaged' && hit.mods?.map((m) => m.rule)).toEqual(['rule.plus', 'rule.half']);
    const g2 = game([{ id: 'rule.block', kind: 'modifier', on: 'damage', priority: -1, modify: { op: 'prevent' } }, ...rules]);
    const out2 = gm(g2, startMini(g2).state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true });
    const hit2 = out2.events.find((e) => e.type === 'damaged');
    expect(hit2?.type === 'damaged' && hit2.mods?.map((m) => m.rule)).toEqual(['rule.block']);
  });

  it('clampTo and per-turn limits on modifiers', () => {
    const rules: TestRule[] = [
      { id: 'rule.cap', kind: 'modifier', on: 'damage', modify: { op: 'clampTo', max: 10 }, limits: { maxPerTurn: 1 } },
      { id: 'rule.hazard', trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } }, effects: [{ op: 'damage', target: '$actor', amount: 30 }, { op: 'damage', target: '$actor', amount: 30 }] },
    ];
    const g = game(rules);
    const { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    const out = gm(g, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true });
    expect(out.events.filter((e) => e.type === 'damaged').map((e) => (e.type === 'damaged' ? e.amount : 0))).toEqual([10, 30]);
  });

  it('status-application modifiers can grant immunity', () => {
    const immune: TestRule = {
      id: 'rule.immune',
      kind: 'modifier',
      on: 'statusApply',
      where: { status: 'status.blessed', targetKind: 'enemy' },
      modify: { op: 'prevent' },
    };
    const g = game([immune], statuses([BLESSED]));
    const { state } = startMini(g);
    const out = gm(g, state, { type: 'applyStatus', entity: entityByName(state, 'Ogre'), status: 'status.blessed' });
    expect(out.state.entities[entityByName(state, 'Ogre')]?.statuses).toHaveLength(0);
    expect(out.events.some((e) => e.type === 'statusPrevented')).toBe(true);
  });
});

describe('continuous rules', () => {
  const outOfWater: TestRule = {
    id: 'rule.out_of_water',
    kind: 'continuous',
    applies: { op: 'withTag', tag: 'tag.fish', kind: 'contestant' },
    when: { op: 'not', cond: { op: 'spaceHasTag', space: { op: 'spaceOf', entity: '$it' }, tag: 'tag.blue' } },
    modifiers: [{ resource: 'res.power', add: -40 }],
  };

  it('apply while their condition holds and stop when it does not', () => {
    const g = game([outOfWater]);
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    state = gm(g, state, { type: 'addTag', entity: ann, tag: 'tag.fish' }).state;
    expect(power(g, state, ann)).toBe(40);
    state = gm(g, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: false }).state;
    expect(power(g, state, ann)).toBe(80);
  });

  it('can suppress capabilities (a sanctuary where nobody can be attacked)', () => {
    const sanctuary: TestRule = {
      id: 'rule.sanctuary',
      kind: 'continuous',
      applies: { op: 'all', kind: 'enemy' },
      when: { op: 'spaceHasTag', space: { op: 'spaceOf', entity: '$it' }, tag: 'tag.lair' },
      suppress: ['attackable'],
    };
    const g = game([sanctuary]);
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    expect(hasCapability(g, state, state.entities[entityByName(state, 'Ogre')] as never, 'attackable')).toBe(false);
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s4', asLanding: false }).state;
    state = choose(g, state, 'mv:space.s4').state;
    expect(state.pendingDecision?.options.some((o) => o.kind === 'attack')).toBe(false);
  });

  it('may not read effective stats or use randomness', () => {
    expect(() => game([{ ...outOfWater, id: 'rule.bad', modifiers: [{ resource: 'res.power', add: { op: 'stat', of: '$it', resource: 'res.power' } }] } as TestRule])).toThrow(/effective stats/);
    expect(() => game([{ ...outOfWater, id: 'rule.bad2', modifiers: [{ resource: 'res.power', add: { op: 'roll', count: 1, sides: 6 } }] } as TestRule])).toThrow(/randomness/);
  });

  it('hidden continuous rules never reach a contestant’s view', () => {
    const g = game([{ ...outOfWater, id: 'rule.secret', visibility: 'hidden', applies: { op: 'all', kind: 'contestant' }, when: undefined } as TestRule]);
    const { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    expect(power(g, state, ann)).toBe(40);
    expect(buildContestantView(g, state, ann, []).entities.find((e) => e.id === ann)?.stats['res.power']).toBe(80);
  });
});

describe('attached rules', () => {
  const amulet = {
    id: 'item.amulet',
    name: 'Amulet',
    rules: [
      {
        id: 'rule.amulet',
        name: 'Amulet',
        trigger: { event: 'landed' as const, where: { spaceTag: 'tag.blue' } },
        conditions: { op: 'same' as const, a: '$actor' as const, b: '$holder' as const },
        effects: [{ op: 'changeResource' as const, target: '$holder' as const, resource: 'res.stash', amount: 1 }],
        limits: { maxPerTurn: 1 },
      },
    ],
  };

  it('item rules fire only while the item is held, with $holder bound, limited per holder', () => {
    const g = game([], items([amulet]));
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    const bob = entityByName(state, 'Bob');
    const without = gm(g, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true });
    expect(without.state.entities[ann]?.resources['res.stash']).toBe(0);
    state = gm(g, state, { type: 'grantItem', entity: ann, item: 'item.amulet' }).state;
    state = gm(g, state, { type: 'grantItem', entity: bob, item: 'item.amulet' }).state;
    state = gm(g, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true }).state;
    state = gm(g, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true }).state;
    state = gm(g, state, { type: 'teleport', entity: bob, space: 'space.s2', asLanding: true }).state;
    expect(state.entities[ann]?.resources['res.stash']).toBe(1);
    expect(state.entities[bob]?.resources['res.stash']).toBe(1);
    expect(Object.keys(state.ruleCounters).filter((k) => k.startsWith('rule.amulet@'))).toHaveLength(2);
  });

  it('an item-attached modifier can consume its own item (a charm that breaks)', () => {
    const charm = {
      id: 'item.charm',
      name: 'Charm',
      rules: [{ id: 'rule.charm', name: 'Charm', kind: 'modifier' as const, on: 'damage' as const, conditions: { op: 'same' as const, a: '$target' as const, b: '$holder' as const }, modify: { op: 'prevent' as const }, consume: { item: true as const } }],
    };
    const hazard: TestRule = { id: 'rule.hazard', trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } }, effects: [{ op: 'damage', target: '$actor', amount: 30 }] };
    const g = game([hazard], items([charm]));
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    state = gm(g, state, { type: 'grantItem', entity: ann, item: 'item.charm' }).state;
    const out = gm(g, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true });
    expect(out.state.entities[ann]?.resources['res.hp']).toBe(100);
    expect(out.state.entities[ann]?.items).toHaveLength(0);
    expect(out.events.some((e) => e.type === 'itemLost' && e.reason === 'consumed')).toBe(true);
  });

  it('enemy rules act for the enemy (an ambush from wherever the enemy stands)', () => {
    const g = game([], (d) => {
      const ogre = d.enemies?.[0];
      if (ogre) {
        ogre.rules = [
          {
            id: 'rule.ogre_grab',
            name: 'Grab',
            trigger: { event: 'landed', where: { actorKind: 'contestant' } },
            conditions: { op: 'sameSpace', a: '$actor', b: '$holder' },
            effects: [{ op: 'fight', attacker: '$holder', defender: '$actor' }],
          },
        ];
      }
    });
    const { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    const out = gm(g, state, { type: 'teleport', entity: ann, space: 'space.s4', asLanding: true });
    expect(out.events.some((e) => e.type === 'fightStarted' && e.defender === ann)).toBe(true);
  });

  it('$holder is only available in attached rules', () => {
    expect(() => game([{ id: 'rule.bad', trigger: { event: 'landed' }, effects: [{ op: 'changeResource', target: '$holder', resource: 'res.gold', amount: 1 }] }])).toThrow(/\$holder/);
  });
});

const DECK = (cards: NonNullable<GameDefinitionInput['decks']>[number]['cards']): Mutate => (d) => {
  d.decks = [{ id: 'deck.test', name: 'Test Deck', cards }];
};

describe('decks and choices', () => {
  const draw: TestRule = { id: 'rule.draw', trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } }, effects: [{ op: 'drawCard', deck: 'deck.test', for: '$actor' }] };

  it('cards are drawn from a shuffled deck, reshuffled when empty; order is hidden, counts are public', () => {
    const g = game([draw], DECK([
      { id: 'card.gold', name: 'Gold', count: 2, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.gold', amount: 1 }] },
      { id: 'card.stash', name: 'Stash', count: 1, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.stash', amount: 1 }] },
    ]));
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    expect(state.decks['deck.test']?.draw).toHaveLength(3);
    const view = buildContestantView(g, state, ann, []);
    expect(view.decks[0]).toEqual({ id: 'deck.test', name: 'Test Deck', drawCount: 3, discardCount: 0 });
    const allEvents: GameEvent[] = [];
    for (let i = 0; i < 4; i++) {
      const out = gm(g, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true });
      state = out.state;
      allEvents.push(...out.events);
    }
    expect(allEvents.filter((e) => e.type === 'cardDrawn')).toHaveLength(4);
    expect(allEvents.some((e) => e.type === 'deckShuffled')).toBe(true);
    const e = state.entities[ann];
    expect((e?.resources['res.gold'] ?? 0) - 10 + (e?.resources['res.stash'] ?? 0)).toBe(4);
  });

  const deal: NonNullable<GameDefinitionInput['decks']>[number]['cards'][number] = {
    id: 'card.deal',
    name: 'Deal',
    effects: [
      {
        op: 'offerChoice',
        to: '$actor',
        prompt: 'Pay 5 gold for a sword?',
        options: [
          { id: 'buy', label: 'Pay 5 gold', requires: { op: 'compare', left: { op: 'res', of: '$actor', resource: 'res.gold' }, cmp: '>=', right: 5 }, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.gold', amount: -5 }, { op: 'grantItem', target: '$actor', item: 'item.sword' }] },
          { id: 'no', label: 'Decline', effects: [] },
        ],
        default: 'no',
      },
    ],
  };

  it('a choice waits for its own operation; the main decision comes after it', () => {
    const g = game([draw], DECK([deal]));
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s2', asLanding: false }).state;
    const moved = choose(g, state, 'mv:space.s2');
    expect(moved.state.queue).toHaveLength(0);
    // Staying is not a landing; walk instead.
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s1', asLanding: false }).state;
    const walked = choose(g, state, 'mv:space.s2');
    expect(walked.state.pendingDecision?.kind).toBe('choice');
    expect(walked.state.pendingDecision?.prompt).toBe('Pay 5 gold for a sword?');
    expect(walked.events.find((e) => e.type === 'choiceOffered')?.audience).toEqual([actor]);
    const picked = choose(g, walked.state, 'ch:buy');
    expect(picked.state.entities[actor]?.items).toHaveLength(1);
    expect(picked.state.entities[actor]?.resources['res.gold']).toBe(5);
    expect(picked.state.pendingDecision?.kind).toBe('main');
    expect(picked.events.find((e) => e.type === 'choiceMade')?.cause.kind).toBe('choice');
  });

  it('requirements filter choice options; a choice nobody can answer resolves to its default', () => {
    const g = game([draw], DECK([deal]));
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    state = gm(g, state, { type: 'setResource', entity: actor, resource: 'res.gold', value: 2, silent: true }).state;
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s1', asLanding: false }).state;
    const walked = choose(g, state, 'mv:space.s2');
    expect(walked.state.pendingDecision?.options.map((o) => o.id)).toEqual(['ch:no']);
  });

  it('choices can be offered to someone other than the active contestant', () => {
    const everyone: TestRule = {
      id: 'rule.vote',
      trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } },
      effects: [{ op: 'forEach', of: { op: 'all', kind: 'contestant' }, do: [{ op: 'offerChoice', to: '$it', prompt: 'Take 1 gold?', options: [{ id: 'yes', label: 'Yes', effects: [{ op: 'changeResource', target: '$actor', resource: 'res.gold', amount: 1 }] }, { id: 'no', label: 'No', effects: [] }], default: 'no' }] }],
    };
    const g = game([everyone]);
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    const other = state.turnOrder.find((id) => id !== actor) as string;
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s1', asLanding: false }).state;
    state = choose(g, state, 'mv:space.s2').state;
    expect(state.queue).toHaveLength(2);
    expect(state.pendingDecision?.actor).toBe(actor);
    state = choose(g, state, 'ch:yes').state;
    expect(state.pendingDecision?.actor).toBe(other);
    state = choose(g, state, 'ch:yes').state;
    expect(state.entities[other]?.resources['res.gold']).toBe(11);
    expect(state.pendingDecision?.kind).toBe('main');
  });

  it('offering too many choices in one operation aborts it', () => {
    const flood: TestRule = {
      id: 'rule.flood',
      trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } },
      effects: [1, 2, 3].map(() => ({ op: 'forEach' as const, of: { op: 'all' as const, kind: 'contestant' as const }, do: [{ op: 'offerChoice' as const, to: '$it' as const, prompt: 'x', options: [{ id: 'a', label: 'A', effects: [] }, { id: 'b', label: 'B', effects: [] }], default: 'a' }] })),
    };
    const g = game([flood]);
    const { state } = startMini(g);
    const out = applyGmCommand(g, state, GmCommandSchema.parse({ type: 'teleport', entity: entityByName(state, 'Ann'), space: 'space.s2', asLanding: true }));
    expect(out.ok === false && out.kind).toBe('aborted');
  });

  it('options of a choice offered by a hidden rule show labels, not effects', () => {
    const trap: TestRule = {
      id: 'rule.trap',
      visibility: 'hidden',
      trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } },
      effects: [{ op: 'offerChoice', to: '$actor', prompt: 'A friendly offer', options: [{ id: 'take', label: 'Take the gift', effects: [{ op: 'changeResource', target: '$actor', resource: 'res.hp', amount: -50 }] }, { id: 'leave', label: 'Leave it', effects: [] }], default: 'leave' }],
    };
    const g = game([trap]);
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s1', asLanding: false }).state;
    state = choose(g, state, 'mv:space.s2').state;
    const view = buildContestantView(g, state, actor, []);
    const take = view.decision?.previews.find((p) => p.kind === 'choose' && p.option === 'take');
    expect(take?.kind === 'choose' && take.unknown).toBe(true);
    expect(take?.kind === 'choose' && take.hints).toEqual([]);
  });

  it('the GM can make a contestant draw a card', () => {
    const g = game([], DECK([{ id: 'card.gold', name: 'Gold', effects: [{ op: 'changeResource', target: '$actor', resource: 'res.gold', amount: 4 }] }]));
    const { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    const out = gm(g, state, { type: 'drawCard', entity: ann, deck: 'deck.test' });
    expect(out.state.entities[ann]?.resources['res.gold']).toBe(14);
    expect(out.events.find((e) => e.type === 'resourceChanged')?.cause).toMatchObject({ kind: 'card', card: 'card.gold' });
  });
});

describe('custom actions and usable items', () => {
  const pray = (d: GameDefinitionInput) => {
    d.actions = [
      { id: 'action.pray', name: 'Pray', where: { spaceTag: 'tag.blue' }, cost: { resource: 'res.gold', amount: 4 }, cooldownRounds: 2, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.stash', amount: 1 }] },
      { id: 'action.poke', name: 'Poke', target: { kind: 'contestant', range: 'anywhere' }, effects: [{ op: 'changeResource', target: '$target', resource: 'res.bananas', amount: 1 }] },
    ];
  };

  it('actions respect location, cost and cooldown; targets become $target', () => {
    const g = game([], pray);
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    const other = state.turnOrder.find((id) => id !== actor) as string;
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s1', asLanding: false }).state;
    state = choose(g, state, 'mv:space.s2').state;
    const ids = state.pendingDecision?.options.map((o) => o.id);
    expect(ids).toContain('act:action.pray');
    expect(ids).toContain(`act:action.poke:${other}`);
    const prayed = choose(g, state, 'act:action.pray');
    expect(prayed.state.entities[actor]?.resources['res.gold']).toBe(6);
    expect(prayed.state.entities[actor]?.resources['res.stash']).toBe(1);
    expect(prayed.state.cooldowns[`action.pray:${actor}`]).toBe(state.round + 2);
    const poked = choose(g, state, `act:action.poke:${other}`);
    expect(poked.state.entities[other]?.resources['res.bananas']).toBe(1);
    // Next round the action is still cooling down.
    const next = idleUntil(g, prayed.state, (s) => s.round === state.round + 1 && s.phase === 'main' && s.pendingDecision?.actor === actor);
    const r = idleUntil(g, gm(g, next.state, { type: 'teleport', entity: actor, space: 'space.s2', asLanding: false }).state, () => false, 0);
    expect(r.state.pendingDecision?.options.some((o) => o.id === 'act:action.pray')).toBe(false);
  });

  it('action requirements must be view-safe', () => {
    expect(() =>
      game([], (d) => {
        d.actions = [{ id: 'action.peek', name: 'Peek', requires: { op: 'compare', left: { op: 'res', of: { op: 'entity', id: 'e2' }, resource: 'res.stash' }, cmp: '>', right: 0 }, effects: [{ op: 'announce', text: 'x' }] }];
      }),
    ).toThrow(/may not see/);
  });

  it('usable items appear as main actions and are consumed', () => {
    const potion = { id: 'item.potion', name: 'Potion', use: { effects: [{ op: 'changeResource' as const, target: '$actor' as const, resource: 'res.hp', amount: 30 }] } };
    const g = game([], items([potion]));
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    state = gm(g, state, { type: 'grantItem', entity: actor, item: 'item.potion' }).state;
    state = gm(g, state, { type: 'setResource', entity: actor, resource: 'res.hp', value: 50 }).state;
    state = choose(g, state, `mv:${state.entities[actor]?.spaceId}`).state;
    const use = state.pendingDecision?.options.find((o) => o.kind === 'use');
    expect(use?.label).toBe('Use Potion');
    const out = choose(g, state, use?.id as string);
    expect(out.state.entities[actor]?.resources['res.hp']).toBe(80);
    expect(out.state.entities[actor]?.items).toHaveLength(0);
    expect(out.events.map((e) => e.type)).toEqual(expect.arrayContaining(['itemUsed', 'itemLost']));
  });

  it('concealed items: others see only "a concealed item", without its bonus', () => {
    const dagger = { id: 'item.dagger', name: 'Hidden Dagger', concealed: true, modifiers: [{ resource: 'res.power', add: 70 }] };
    const g = game([], items([dagger]));
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    const bob = entityByName(state, 'Bob');
    const out = gm(g, state, { type: 'grantItem', entity: ann, item: 'item.dagger' });
    state = out.state;
    const bobView = buildContestantView(g, state, bob, out.events);
    const annSeenByBob = bobView.entities.find((e) => e.id === ann);
    expect(annSeenByBob?.items).toEqual([expect.objectContaining({ concealed: true, name: 'a concealed item' })]);
    expect(annSeenByBob?.stats['res.power']).toBe(80);
    expect(JSON.stringify(bobView)).not.toContain('item.dagger');
    const annView = buildContestantView(g, state, ann, out.events);
    expect(annView.entities.find((e) => e.id === ann)?.stats['res.power']).toBe(150);
  });

  it('items change hands; a full inventory refuses them', () => {
    const steal: TestRule = { id: 'rule.steal', trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } }, effects: [{ op: 'transferItem', from: { op: 'entity', id: 'e2' }, to: '$actor', item: 'item.sword' }] };
    const g = game([steal]);
    let { state } = startMini(g);
    state = gm(g, state, { type: 'grantItem', entity: 'e2', item: 'item.sword' }).state;
    const moved = gm(g, state, { type: 'teleport', entity: 'e1', space: 'space.s2', asLanding: true });
    expect(moved.state.entities['e1']?.items).toHaveLength(1);
    expect(moved.state.entities['e2']?.items).toHaveLength(0);
    // Full inventory: nothing moves.
    let full = gm(g, state, { type: 'grantItem', entity: 'e1', item: 'item.sword' }).state;
    full = gm(g, full, { type: 'grantItem', entity: 'e1', item: 'item.sword' }).state;
    const refused = gm(g, full, { type: 'teleport', entity: 'e1', space: 'space.s2', asLanding: true });
    expect(refused.state.entities['e2']?.items).toHaveLength(1);
  });
});

describe('contestant combat, knockouts, elimination', () => {
  it('contestants on the same space can attack each other; the victor takes the lost gold', () => {
    const g = game();
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    const other = state.turnOrder.find((id) => id !== actor) as string;
    state = gm(g, state, { type: 'setResource', entity: actor, resource: 'res.power', value: 100000, silent: true }).state;
    state = gm(g, state, { type: 'setResource', entity: other, resource: 'res.gold', value: 30, silent: true }).state;
    state = gm(g, state, { type: 'teleport', entity: other, space: 'space.s3', asLanding: false }).state;
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s3', asLanding: false }).state;
    state = choose(g, state, 'mv:space.s3').state;
    expect(state.pendingDecision?.options.map((o) => o.id)).toContain(`atk:${other}`);
    const out = choose(g, state, `atk:${other}`);
    const ko = out.events.find((e) => e.type === 'knockedOut');
    expect(ko?.type === 'knockedOut' && ko.lootTo).toBe(actor);
    expect(out.state.entities[actor]?.resources['res.gold']).toBe(25);
    expect(out.state.entities[other]?.resources['res.gold']).toBe(15);
  });

  it('without PvP, or against a recovering contestant, no attack is offered', () => {
    const g = game([], (d) => {
      d.settings.combat.pvp = false;
    });
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    const other = state.turnOrder.find((id) => id !== actor) as string;
    state = gm(g, state, { type: 'teleport', entity: other, space: state.entities[actor]?.spaceId as string, asLanding: false }).state;
    state = choose(g, state, `mv:${state.entities[actor]?.spaceId}`).state;
    expect(state.pendingDecision?.options.some((o) => o.kind === 'attack')).toBe(false);
  });

  it('elimination mode removes a defeated contestant for good; the last one standing wins', () => {
    const g = game([], (d) => {
      d.settings.ko.mode = 'eliminate';
    });
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    const bob = entityByName(state, 'Bob');
    state = gm(g, state, { type: 'setResource', entity: ann, resource: 'res.hp', value: 0 }).state;
    expect(state.entities[ann]?.status).toBe('eliminated');
    expect(state.entities[ann]?.spaceId).toBeNull();
    const r = idleUntil(g, state, (s) => s.phase === 'gameOver');
    expect(r.state.winners).toEqual([bob]);
    expect(r.state.endReason).toBe('last contestant standing');
  });

  it('a GM-spawned boss rages via its own rule after being wounded, grants rewards and never returns', () => {
    const g = game([], statuses([{ id: 'status.enraged', name: 'Enraged', duration: null, stacking: 'ignore', modifiers: [{ resource: 'res.power', add: 50 }] }]), (d) => {
      d.enemies?.push({
        id: 'enemy.boss',
        name: 'Boss',
        boss: true,
        power: 200,
        maxHp: 300,
        respawnAfterRounds: null,
        spawns: [],
        rewards: [{ op: 'changeResource', target: '$actor', resource: 'res.stars', amount: 2 }],
        rules: [
          {
            id: 'rule.boss_rage',
            name: 'Rage',
            trigger: { event: 'damaged' },
            conditions: { op: 'all', conds: [{ op: 'same', a: '$target', b: '$holder' }, { op: 'compare', left: { op: 'res', of: '$holder', resource: 'res.hp' }, cmp: '<=', right: 280 }] },
            effects: [{ op: 'applyStatus', target: '$holder', status: 'status.enraged' }],
            limits: { maxPerGame: 1 },
          },
        ],
      });
    });
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    const spawned = gm(g, state, { type: 'spawnEnemy', enemy: 'enemy.boss', space: 'space.s3' });
    const spawnEvent = spawned.events.find((e): e is Extract<GameEvent, { type: 'spawned' }> => e.type === 'spawned');
    expect(spawnEvent).toMatchObject({ boss: true, space: 'space.s3' });
    const bossId = spawnEvent?.entity as string;
    state = spawned.state;
    for (const [resource, value] of [['res.power', 200], ['res.max_hp', 5000], ['res.hp', 5000]] as const) state = gm(g, state, { type: 'setResource', entity: actor, resource, value, silent: true }).state;
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s3', asLanding: false }).state;
    state = choose(g, state, 'mv:space.s3').state;
    // Round one: 8 spins cannot kill a 300-HP boss at 25 per hit; wounded, it becomes Enraged.
    const first = choose(g, state, `atk:${bossId}`);
    expect(first.state.entities[bossId]?.status).toBe('active');
    expect(first.events.some((e) => e.type === 'statusApplied' && e.entity === bossId && e.status === 'status.enraged')).toBe(true);
    expect(power(g, first.state, bossId)).toBe(250);
    // Next turn: overwhelming power finishes it.
    let next = idleUntil(g, first.state, (s) => s.phase === 'main' && s.pendingDecision?.actor === actor).state;
    next = gm(g, next, { type: 'setResource', entity: actor, resource: 'res.power', value: 100000, silent: true }).state;
    const second = choose(g, next, `atk:${bossId}`);
    expect(second.state.entities[bossId]?.status).toBe('defeated');
    expect(second.state.entities[bossId]?.respawnRound).toBeNull();
    expect(second.state.entities[actor]?.resources['res.stars']).toBe(2);
    const later = idleUntil(g, second.state, (s) => s.round >= next.round + 3);
    expect(later.state.entities[bossId]?.status).toBe('defeated');
  });

  it('spawning more than the budget allows aborts the operation', () => {
    const g = game([{ id: 'rule.swarm', trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } }, effects: [1, 2, 3, 4].map(() => ({ op: 'spawn' as const, enemy: 'enemy.ogre', at: '$space' as const, count: 3 })) }]);
    const { state } = startMini(g);
    const out = applyGmCommand(g, state, GmCommandSchema.parse({ type: 'teleport', entity: 'e1', space: 'space.s2', asLanding: true }));
    expect(out.ok === false && out.kind).toBe('aborted');
  });

  it('removing a fixture takes its shop off the board; contestants cannot be removed', () => {
    const g = game();
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    const shop = entityByName(state, 'Shop');
    state = gm(g, state, { type: 'removeEntity', entity: shop }).state;
    expect(state.entities[shop]?.status).toBe('removed');
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s1', asLanding: false }).state;
    state = choose(g, state, 'mv:space.s1').state;
    expect(state.pendingDecision?.options.some((o) => o.kind === 'buy')).toBe(false);
    gmFail(g, state, { type: 'removeEntity', entity: actor });
  });
});

describe('rule limits', () => {
  const tick = (limits: TestRule['limits']): TestRule => ({ id: 'rule.tick', trigger: { event: 'landed' }, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.stash', amount: 1 }], limits });

  it('maxPerRound and maxPerGame', () => {
    for (const [limits, expected] of [
      [{ maxPerRound: 2 }, 2],
      [{ maxPerGame: 1 }, 1],
    ] as const) {
      const g = game([tick(limits)]);
      let { state } = startMini(g);
      for (let i = 0; i < 4; i++) state = gm(g, state, { type: 'teleport', entity: 'e1', space: 'space.s3', asLanding: true }).state;
      expect(state.entities['e1']?.resources['res.stash']).toBe(expected);
    }
  });

  it('cooldownRounds keeps a rule resting for whole rounds', () => {
    const g = game([tick({ cooldownRounds: 2 })]);
    let { state } = startMini(g);
    state = gm(g, state, { type: 'teleport', entity: 'e1', space: 'space.s3', asLanding: true }).state;
    state = gm(g, state, { type: 'teleport', entity: 'e1', space: 'space.s3', asLanding: true }).state;
    expect(state.entities['e1']?.resources['res.stash']).toBe(1);
    const later = idleUntil(g, state, (s) => s.round === 3).state;
    const fired = gm(g, later, { type: 'teleport', entity: 'e1', space: 'space.s3', asLanding: true }).state;
    expect(fired.entities['e1']?.resources['res.stash']).toBe(2);
  });

  it('the compiler reports new reference errors (unknown status, deck, enemy, bad choice default)', () => {
    expect(() => game([{ id: 'r1', trigger: { event: 'landed' }, effects: [{ op: 'applyStatus', target: '$actor', status: 'status.nope' }] }])).toThrow(CompileError);
    expect(() => game([{ id: 'r2', trigger: { event: 'landed' }, effects: [{ op: 'drawCard', deck: 'deck.nope', for: '$actor' }] }])).toThrow(/unknown deck/);
    expect(() => game([{ id: 'r3', trigger: { event: 'landed' }, effects: [{ op: 'spawn', enemy: 'enemy.nope', at: '$space' }] }])).toThrow(/unknown enemy/);
    expect(() => game([{ id: 'r4', trigger: { event: 'landed' }, effects: [{ op: 'offerChoice', to: '$actor', prompt: 'p', options: [{ id: 'a', label: 'A', effects: [] }, { id: 'b', label: 'B', effects: [] }], default: 'c' }] }])).toThrow(/default "c"/);
  });

  it('frozen committed states are never mutated by M4 operations', () => {
    const g = game([], statuses([SHIELD, BLESSED]), DECK([deal2()]));
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    for (const cmd of [
      { type: 'applyStatus', entity: ann, status: 'status.shield', stacks: 2 },
      { type: 'applyStatus', entity: ann, status: 'status.blessed' },
      { type: 'drawCard', entity: ann, deck: 'deck.test' },
      { type: 'spawnEnemy', enemy: 'enemy.ogre', space: 'space.s2' },
    ] as GmCommandInput[]) {
      deepFreeze(state);
      state = gm(g, state, cmd).state;
    }
    deepFreeze(state);
    const r = idleUntil(g, state, (s) => s.round >= 3);
    expect(r.state.round).toBeGreaterThanOrEqual(3);
  });
});

function deal2(): NonNullable<GameDefinitionInput['decks']>[number]['cards'][number] {
  return { id: 'card.bless', name: 'Bless', effects: [{ op: 'applyStatus', target: '$actor', status: 'status.blessed' }] };
}

describe('interactions', () => {
  const POISON = {
    id: 'status.poison',
    name: 'Poison',
    duration: 3,
    stacking: 'stack' as const,
    maxStacks: 3,
    rules: [
      {
        id: 'rule.poison_tick',
        name: 'Poison',
        trigger: { event: 'turnEnded' as const },
        conditions: { op: 'same' as const, a: '$actor' as const, b: '$holder' as const },
        effects: [{ op: 'damage' as const, target: '$holder' as const, amount: 5 }],
      },
    ],
  };
  const STUN = { id: 'status.stunned', name: 'Stunned', duration: 1, stacking: 'ignore' as const, suppress: ['takesTurns' as const] };
  const FROG_FORM = { id: 'status.frog_form', name: 'Frog Form', transformation: true, duration: null, grantsTags: ['tag.cursed'] };

  it('a knockout ends the contestant’s statuses, unless the scenario keeps them', () => {
    for (const clearStatuses of [true, false]) {
      const g = game([], statuses([POISON, BLESSED, FISH_FORM]), withMove, (d) => {
        d.settings.ko.clearStatuses = clearStatuses;
      });
      let { state } = startMini(g);
      const ann = entityByName(state, 'Ann');
      for (const status of ['status.poison', 'status.blessed', 'status.fish_form']) state = gm(g, state, { type: 'applyStatus', entity: ann, status }).state;
      const out = gm(g, state, { type: 'setResource', entity: ann, resource: 'res.hp', value: 0 });
      expect(out.events.some((e) => e.type === 'knockedOut' && e.entity === ann)).toBe(true);
      expect(out.state.entities[ann]?.statuses.map((s) => s.defId)).toEqual(clearStatuses ? [] : ['status.poison', 'status.blessed', 'status.fish_form']);
      expect(out.events.filter((e) => e.type === 'statusRemoved' && e.entity === ann)).toHaveLength(clearStatuses ? 3 : 0);
      expect(out.state.entities[ann]?.resources['res.hp']).toBe(100);
    }
  });

  it('transformations replace each other; ordinary statuses stay', () => {
    const g = game([], statuses([FISH_FORM, FROG_FORM, BLESSED]), withMove);
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    state = gm(g, state, { type: 'applyStatus', entity: ann, status: 'status.fish_form' }).state;
    state = gm(g, state, { type: 'applyStatus', entity: ann, status: 'status.blessed' }).state;
    const out = gm(g, state, { type: 'applyStatus', entity: ann, status: 'status.frog_form' });
    expect(out.state.entities[ann]?.statuses.map((s) => s.defId)).toEqual(['status.blessed', 'status.frog_form']);
    expect(out.events.find((e) => e.type === 'statusRemoved')).toMatchObject({ status: 'status.fish_form', reason: 'removed' });
    // Fish Form's −1 Move and shop ban are gone; Frog Form's granted tag applies.
    expect(effectiveValue(g, out.state, out.state.entities[ann] as never, 'res.move')).toBe(0);
    expect(hasCapability(g, out.state, out.state.entities[ann] as never, 'shops')).toBe(true);
    // Re-applying the current transformation does not remove it.
    const again = gm(g, out.state, { type: 'applyStatus', entity: ann, status: 'status.frog_form' });
    expect(again.state.entities[ann]?.statuses.map((s) => s.defId)).toEqual(['status.blessed', 'status.frog_form']);
  });

  it('eliminated contestants are passed over without turn events, and their statuses end', () => {
    const g = game([], statuses([POISON]), (d) => {
      d.settings.ko.mode = 'eliminate';
      d.cast.push({ id: 'cast.cy', name: 'Cy', color: '#0f0', persona: { voice: 'c', traits: { risk: 5, aggression: 5, greed: 5, loyalty: 5, vindictiveness: 5, sociability: 5 }, behaviors: [] } });
    });
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    state = gm(g, state, { type: 'applyStatus', entity: ann, status: 'status.poison' }).state;
    state = gm(g, state, { type: 'setResource', entity: ann, resource: 'res.hp', value: 0 }).state;
    expect(state.entities[ann]?.status).toBe('eliminated');
    expect(state.entities[ann]?.statuses).toEqual([]);
    const r = idleUntil(g, state, (s) => s.round >= 4);
    const aboutAnn = r.events.filter((e) => 'entity' in e && e.entity === ann);
    expect(aboutAnn).toEqual([]);
    expect(r.state.phase).not.toBe('gameOver');
  });

  it('a stun costs exactly one turn, whether applied in the holder’s own turn or someone else’s', () => {
    const g = game([], statuses([STUN]));
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    const other = state.turnOrder.find((id) => id !== actor) as string;
    state = gm(g, state, { type: 'applyStatus', entity: actor, status: 'status.stunned' }).state;
    state = gm(g, state, { type: 'applyStatus', entity: other, status: 'status.stunned' }).state;
    // The actor finishes this turn (it had already started).
    expect(state.pendingDecision?.actor).toBe(actor);
    // Round 1: the other contestant is skipped. Round 2: the actor is skipped. Round 3: both play.
    const r = idleUntil(g, state, (s) => s.round === 4);
    const skipped = (id: string) => r.events.filter((e) => e.type === 'turnSkipped' && e.entity === id).length;
    const started = (id: string) => r.events.filter((e) => e.type === 'turnStarted' && e.entity === id).length;
    expect(skipped(actor)).toBe(1);
    expect(skipped(other)).toBe(1);
    expect(started(actor)).toBe(1);
    expect(started(other)).toBe(2);
    expect(r.state.entities[actor]?.statuses).toEqual([]);
    expect(r.state.entities[other]?.statuses).toEqual([]);
  });

  it('poison keeps ticking through a stunned turn', () => {
    const g = game([], statuses([POISON, STUN]));
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    const other = state.turnOrder.find((id) => id !== actor) as string;
    state = gm(g, state, { type: 'applyStatus', entity: other, status: 'status.poison' }).state;
    state = gm(g, state, { type: 'applyStatus', entity: other, status: 'status.stunned' }).state;
    const r = idleUntil(g, state, (s) => s.phase === 'turnStart' && s.turnOrder[s.turn.index] === actor && s.round > state.round);
    expect(r.events.some((e) => e.type === 'turnSkipped' && e.entity === other)).toBe(true);
    expect(r.state.entities[other]?.resources['res.hp']).toBe(95);
  });

  it('a pending choice survives a save/load round trip through the state schema', async () => {
    const { GameStateSchema } = await import('../src/schema/state.ts');
    const offer: TestRule = {
      id: 'rule.offer',
      trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } },
      effects: [{ op: 'offerChoice', to: '$actor', prompt: 'Bless yourself?', options: [{ id: 'yes', label: 'Yes', effects: [{ op: 'applyStatus', target: '$actor', status: 'status.blessed' }] }, { id: 'no', label: 'No', effects: [] }], default: 'no' }],
    };
    const g = game([offer], statuses([BLESSED, RAGE]), DECK([deal2()]), (d) => {
      d.actions = [{ id: 'action.pray', name: 'Pray', cooldownRounds: 3, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.stash', amount: 1 }] }];
    });
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    state = gm(g, state, { type: 'applyStatus', entity: actor, status: 'status.rage', stacks: 2 }).state;
    state = gm(g, state, { type: 'drawCard', entity: actor, deck: 'deck.test' }).state;
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s1', asLanding: false }).state;
    state = choose(g, state, 'mv:space.s2').state;
    expect(state.pendingDecision?.kind).toBe('choice');
    const reloaded = GameStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(reloaded).toEqual(state);
    const a = choose(g, state, 'ch:yes');
    const b = choose(g, reloaded, 'ch:yes');
    expect(b.state).toEqual(a.state);
    expect(b.events).toEqual(a.events);
  });

  it('a GM edit while a choice is pending re-issues it under a new id; the old id is refused', () => {
    const g = game([{ id: 'rule.offer', trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } }, effects: [{ op: 'offerChoice', to: '$actor', prompt: 'Gold?', options: [{ id: 'yes', label: 'Yes', effects: [{ op: 'changeResource', target: '$actor', resource: 'res.gold', amount: 1 }] }, { id: 'no', label: 'No', effects: [] }], default: 'no' }] }]);
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s1', asLanding: false }).state;
    state = choose(g, state, 'mv:space.s2').state;
    const before = state.pendingDecision;
    const edited = gm(g, state, { type: 'adjustResource', entity: actor, resource: 'res.gold', delta: 5 }).state;
    expect(edited.pendingDecision?.kind).toBe('choice');
    expect(edited.pendingDecision?.id).not.toBe(before?.id);
    expect(edited.pendingDecision?.choice).toBe(before?.choice);
    expect(answerDecision(g, edited, { decisionId: before?.id as string, optionId: 'ch:yes' }).ok).toBe(false);
    expect(choose(g, edited, 'ch:yes').state.entities[actor]?.resources['res.gold']).toBe(16);
  });

  it('a choice whose chooser is eliminated before answering resolves to its default, without effects', () => {
    const vote: TestRule = {
      id: 'rule.vote',
      trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } },
      effects: [{ op: 'forEach', of: { op: 'all', kind: 'contestant' }, do: [{ op: 'offerChoice', to: '$it', prompt: 'Take 1 gold?', options: [{ id: 'yes', label: 'Yes', effects: [{ op: 'changeResource', target: '$actor', resource: 'res.gold', amount: 1 }] }, { id: 'no', label: 'No', effects: [] }], default: 'yes' }] }],
    };
    const g = game([vote], (d) => {
      d.settings.ko.mode = 'eliminate';
      d.cast.push({ id: 'cast.cy', name: 'Cy', color: '#0f0', persona: { voice: 'c', traits: { risk: 5, aggression: 5, greed: 5, loyalty: 5, vindictiveness: 5, sociability: 5 }, behaviors: [] } });
    });
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s1', asLanding: false }).state;
    state = choose(g, state, 'mv:space.s2').state;
    expect(state.queue).toHaveLength(3);
    const victim = state.queue[1]?.chooser as string;
    state = gm(g, state, { type: 'setResource', entity: victim, resource: 'res.hp', value: 0 }).state;
    expect(state.entities[victim]?.status).toBe('eliminated');
    // The actor answers; the victim's choice resolves automatically; the third contestant answers.
    state = choose(g, state, 'ch:no').state;
    const auto = expectOk(advance(g, state));
    expect(auto.events.find((e) => e.type === 'choiceMade')).toMatchObject({ entity: victim, option: 'yes', automatic: true });
    expect(auto.state.entities[victim]?.resources['res.gold']).toBe(10);
    expect(auto.state.pendingDecision?.kind).toBe('choice');
    const last = choose(g, auto.state, 'ch:yes');
    expect(last.state.pendingDecision?.kind).toBe('main');
  });

  it('a coupon: an item-attached price modifier is quoted, paid, and breaks after one purchase', () => {
    const coupon = {
      id: 'item.coupon',
      name: 'Coupon',
      rules: [{ id: 'rule.coupon', name: 'Coupon', kind: 'modifier' as const, on: 'price' as const, conditions: { op: 'same' as const, a: '$actor' as const, b: '$holder' as const }, modify: { op: 'add' as const, amount: -3 }, consume: { item: true as const } }],
    };
    const g = game([], items([coupon]));
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    state = gm(g, state, { type: 'grantItem', entity: actor, item: 'item.coupon' }).state;
    state = gm(g, state, { type: 'setResource', entity: actor, resource: 'res.gold', value: 20, silent: true }).state;
    state = gm(g, state, { type: 'teleport', entity: actor, space: 'space.s1', asLanding: false }).state;
    state = choose(g, state, 'mv:space.s1').state;
    const buy = state.pendingDecision?.options.find((o) => o.kind === 'buy' && o.entry === 'entry.sword');
    expect(buy?.kind === 'buy' && buy.price).toBe(2);
    const preview = buildContestantView(g, state, actor, []).decision?.previews.find((p) => p.optionId === buy?.id);
    expect(preview).toMatchObject({ kind: 'buy', price: 2, basePrice: 5 });
    const out = choose(g, state, buy?.id as string);
    expect(out.state.entities[actor]?.resources['res.gold']).toBe(18);
    expect(out.state.entities[actor]?.items.map((i) => out.state.items[i]?.defId)).toEqual(['item.sword']);
    expect(out.events.find((e) => e.type === 'purchased')).toMatchObject({ price: 2 });
  });

  it('a continuous rule can depend on a status and ends with it', () => {
    const blessedOnBlue: TestRule = {
      id: 'rule.blessed_blue',
      kind: 'continuous',
      applies: { op: 'all', kind: 'contestant' },
      when: { op: 'all', conds: [{ op: 'hasStatus', entity: '$it', status: 'status.rage', minStacks: 2 }, { op: 'spaceHasTag', space: { op: 'spaceOf', entity: '$it' }, tag: 'tag.blue' }] },
      modifiers: [{ resource: 'res.power', add: 50 }],
    };
    const g = game([blessedOnBlue], statuses([RAGE]));
    let { state } = startMini(g);
    const ann = entityByName(state, 'Ann');
    state = gm(g, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: false }).state;
    state = gm(g, state, { type: 'applyStatus', entity: ann, status: 'status.rage' }).state;
    expect(power(g, state, ann)).toBe(90);
    state = gm(g, state, { type: 'applyStatus', entity: ann, status: 'status.rage' }).state;
    expect(power(g, state, ann)).toBe(150);
    state = gm(g, state, { type: 'removeStatus', entity: ann, status: 'status.rage' }).state;
    expect(power(g, state, ann)).toBe(80);
  });

  it('a card’s choice can draw another card; each choice is answered in its own operation', () => {
    const chain = (i: number): NonNullable<GameDefinitionInput['decks']>[number]['cards'][number] => ({
      id: `card.chain${i}`,
      name: `Chain ${i}`,
      effects: [{ op: 'offerChoice', to: '$actor', prompt: `Draw again (${i})?`, options: [{ id: 'draw', label: 'Draw', effects: [{ op: 'changeResource', target: '$actor', resource: 'res.stash', amount: 1 }, { op: 'drawCard', deck: 'deck.test', for: '$actor' }] }, { id: 'stop', label: 'Stop', effects: [] }], default: 'stop' }],
    });
    const g = game([], DECK([1, 2, 3, 4, 5, 6].map(chain)));
    let { state } = startMini(g);
    const actor = state.pendingDecision?.actor as string;
    state = gm(g, state, { type: 'drawCard', entity: actor, deck: 'deck.test' }).state;
    // More choices than one operation's budget (4), but each is answered in its own operation.
    for (let i = 0; i < 6; i++) {
      expect(state.pendingDecision?.kind).toBe('choice');
      state = choose(g, state, 'ch:draw').state;
    }
    expect(state.entities[actor]?.resources['res.stash']).toBe(6);
    state = choose(g, state, 'ch:stop').state;
    expect(state.pendingDecision?.kind).toBe('move');
  });

  it('a reaction to a status expiring fires once, as it expires', () => {
    const afterglow: TestRule = { id: 'rule.afterglow', trigger: { event: 'statusRemoved', where: { status: 'status.blessed' } }, effects: [{ op: 'changeResource', target: '$target', resource: 'res.stash', amount: 1 }] };
    const g = game([afterglow], statuses([BLESSED]));
    let { state } = startMini(g);
    const ogre = entityByName(state, 'Ogre');
    state = gm(g, state, { type: 'applyStatus', entity: entityByName(state, 'Ann'), status: 'status.blessed' }).state;
    state = gm(g, state, { type: 'applyStatus', entity: ogre, status: 'status.blessed' }).state;
    const r = idleUntil(g, state, (s) => s.round >= 5);
    const ann = entityByName(state, 'Ann');
    expect(r.state.entities[ann]?.resources['res.stash']).toBe(1);
    expect(r.events.filter((e) => e.type === 'statusRemoved' && e.reason === 'expired')).toHaveLength(2);
  });
});
