import { describe, expect, it } from 'vitest';
import { applyGmCommand, CompileError } from '../src/engine/index.ts';
import { GmCommandSchema, type GmCommandInput } from '../src/schema/commands.ts';
import type { GameState } from '../src/schema/state.ts';
import { divide } from '../src/engine/util.ts';
import { choose, deepFreeze, entityByName, expectOk, miniGame, startMini } from './helpers/mini.ts';

const fishRule = {
  id: 'rule.fish_blue_bananas',
  trigger: { event: 'landed' as const, where: { spaceTag: 'tag.blue' } },
  conditions: {
    op: 'all' as const,
    conds: [
      { op: 'isKind' as const, entity: '$actor' as const, kind: 'contestant' as const },
      { op: 'hasTag' as const, entity: '$actor' as const, tag: 'tag.fish' },
      { op: 'not' as const, cond: { op: 'hasTag' as const, entity: '$actor' as const, tag: 'tag.cursed' } },
    ],
  },
  effects: [{ op: 'changeResource' as const, target: '$actor' as const, resource: 'res.bananas', amount: 2 }],
  limits: { maxPerTurn: 1 },
};

function gm(game: ReturnType<typeof miniGame>, state: GameState, cmd: GmCommandInput) {
  return expectOk(applyGmCommand(game, state, GmCommandSchema.parse(cmd)));
}

describe('landing semantics', () => {
  it('teleport counts as landing only when asked; the fish rule checks tags and curses', () => {
    const game = miniGame({ rules: [fishRule] });
    let { state } = startMini(game);
    const ann = entityByName(state, 'Ann');
    state = gm(game, state, { type: 'addTag', entity: ann, tag: 'tag.fish' }).state;

    state = gm(game, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: false }).state;
    expect(state.entities[ann]?.resources['res.bananas']).toBe(0);

    const landed = gm(game, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true });
    expect(landed.state.entities[ann]?.resources['res.bananas']).toBe(2);
    const firing = landed.firings.find((f) => f.rule === 'rule.fish_blue_bananas');
    expect(firing?.checks.map((c) => c.ok)).toEqual([true, true, true]);
    expect(firing?.checks[1]?.text).toBe('Ann is tagged Fish');

    // A cursed fish gets nothing (fresh turn so maxPerTurn does not interfere).
    const cursed = gm(game, state, { type: 'addTag', entity: ann, tag: 'tag.cursed' }).state;
    expect(gm(game, cursed, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true }).state.entities[ann]?.resources['res.bananas']).toBe(0);
  });

  it('staying put is not a landing; walking one or more steps is', () => {
    const game = miniGame({ rules: [{ id: 'rule.any_land', trigger: { event: 'landed' }, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.gold', amount: 1 }] }] });
    const { state } = startMini(game);
    const actor = state.pendingDecision?.actor as string;
    const stay = choose(game, state, `mv:${state.entities[actor]?.spaceId}`);
    expect(stay.events.some((e) => e.type === 'landed')).toBe(false);
    expect(stay.state.entities[actor]?.resources['res.gold']).toBe(10);

    const walkOption = state.pendingDecision?.options.find((o) => o.kind === 'move' && o.steps > 0);
    const walked = choose(game, state, walkOption?.id as string);
    expect(walked.events.map((e) => e.type)).toEqual(expect.arrayContaining(['left', 'moved', 'entered', 'landed']));
    expect(walked.state.entities[actor]?.resources['res.gold']).toBe(11);
  });

  it('maxPerTurn limits firings within one turn', () => {
    const game = miniGame({ rules: [fishRule] });
    let { state } = startMini(game);
    const ann = entityByName(state, 'Ann');
    state = gm(game, state, { type: 'addTag', entity: ann, tag: 'tag.fish' }).state;
    state = gm(game, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true }).state;
    state = gm(game, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true }).state;
    expect(state.entities[ann]?.resources['res.bananas']).toBe(2);
  });
});

describe('resolution order', () => {
  it('runs reactions depth-first after the firing completes, ordered by priority then position', () => {
    const game = miniGame({
      rules: [
        { id: 'rule.a', trigger: { event: 'landed' }, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.gold', amount: 1 }] },
        { id: 'rule.b', trigger: { event: 'resourceChanged', where: { resource: 'res.gold', direction: 'gain' } }, effects: [{ op: 'changeResource', target: '$target', resource: 'res.bananas', amount: 1 }] },
        { id: 'rule.c', trigger: { event: 'landed' }, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.stash', amount: 1 }] },
        { id: 'rule.first', priority: -1, trigger: { event: 'landed' }, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.stars', amount: 1 }] },
      ],
    });
    const { state } = startMini(game);
    const ann = entityByName(state, 'Ann');
    const out = gm(game, state, { type: 'teleport', entity: ann, space: 'space.s3', asLanding: true });
    const order = out.events.filter((e) => e.type === 'resourceChanged').map((e) => (e.type === 'resourceChanged' ? e.resource : ''));
    expect(order).toEqual(['res.stars', 'res.gold', 'res.bananas', 'res.stash']);
  });

  it('evaluates conditions when the rule runs, after earlier rules changed state', () => {
    const game = miniGame({
      rules: [
        { id: 'rule.unfish', priority: -1, trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } }, effects: [{ op: 'removeTag', target: '$actor', tag: 'tag.fish' }] },
        fishRule,
      ],
    });
    let { state } = startMini(game);
    const ann = entityByName(state, 'Ann');
    state = gm(game, state, { type: 'addTag', entity: ann, tag: 'tag.fish' }).state;
    const out = gm(game, state, { type: 'teleport', entity: ann, space: 'space.s2', asLanding: true });
    expect(out.state.entities[ann]?.tags).not.toContain('tag.fish');
    expect(out.state.entities[ann]?.resources['res.bananas']).toBe(0);
  });
});

describe('failures and budgets', () => {
  it('rolls back a faulting firing without undoing other rules; missing values are never zero', () => {
    const game = miniGame({
      rules: [
        {
          id: 'rule.faulty',
          trigger: { event: 'landed' },
          effects: [
            { op: 'changeResource', target: '$actor', resource: 'res.gold', amount: 5 },
            // The Ogre (e3) has no gold: reading it without ifMissing is a fault, not 0.
            { op: 'changeResource', target: '$actor', resource: 'res.bananas', amount: { op: 'res', of: { op: 'entity', id: 'e3' }, resource: 'res.gold' } },
          ],
        },
        { id: 'rule.fine', trigger: { event: 'landed' }, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.stash', amount: 1 }] },
        {
          id: 'rule.defaulted',
          trigger: { event: 'landed' },
          effects: [{ op: 'changeResource', target: '$actor', resource: 'res.stars', amount: { op: 'res', of: { op: 'entity', id: 'e3' }, resource: 'res.gold', ifMissing: 1 } }],
        },
      ],
    });
    const { state } = startMini(game);
    const ann = entityByName(state, 'Ann');
    const out = gm(game, state, { type: 'teleport', entity: ann, space: 'space.s3', asLanding: true });
    const after = out.state.entities[ann];
    expect(after?.resources['res.gold']).toBe(10);
    expect(after?.resources['res.stash']).toBe(1);
    expect(after?.resources['res.stars']).toBe(1);
    expect(out.faults.map((f) => f.rule)).toEqual(['rule.faulty']);
    expect(out.events.some((e) => e.type === 'ruleFault')).toBe(true);
  });

  it('aborts a runaway loop, leaves the committed state untouched and warns at compile time', () => {
    const game = miniGame({
      rules: [
        { id: 'rule.loop', trigger: { event: 'resourceChanged', where: { resource: 'res.gold', direction: 'gain' } }, effects: [{ op: 'changeResource', target: '$target', resource: 'res.gold', amount: 1 }] },
      ],
    });
    expect(game.diagnostics.some((d) => d.code === 'rule-cycle' && d.severity === 'warning')).toBe(true);
    const { state } = startMini(game);
    deepFreeze(state);
    const before = JSON.stringify(state);
    const out = applyGmCommand(game, state, GmCommandSchema.parse({ type: 'adjustResource', entity: entityByName(state, 'Ann'), resource: 'res.gold', delta: 1 }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe('aborted');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('bounded cycles are reported as info, not warnings', () => {
    const game = miniGame({
      rules: [
        {
          id: 'rule.loop',
          limits: { maxPerTurn: 3 },
          trigger: { event: 'resourceChanged', where: { resource: 'res.gold', direction: 'gain' } },
          effects: [{ op: 'changeResource', target: '$target', resource: 'res.gold', amount: 1 }],
        },
      ],
    });
    expect(game.diagnostics.find((d) => d.code === 'rule-cycle')?.severity).toBe('info');
    const { state } = startMini(game);
    const ann = entityByName(state, 'Ann');
    const out = gm(game, state, { type: 'adjustResource', entity: ann, resource: 'res.gold', delta: 1 });
    expect(out.state.entities[ann]?.resources['res.gold']).toBe(14);
  });

  it('rejects definitions with unknown references or unbound bindings', () => {
    expect(() => miniGame({ rules: [{ id: 'rule.bad', trigger: { event: 'landed' }, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.nope', amount: 1 }] }] })).toThrow(CompileError);
    expect(() => miniGame({ rules: [{ id: 'rule.bad', trigger: { event: 'turnStarted' }, effects: [{ op: 'teleport', target: '$actor', to: '$space' }] }] })).toThrow(/binding \$space/);
  });
});

describe('numbers', () => {
  it('requires explicit rounding for division', () => {
    expect(divide(7, 2, 'floor')).toBe(3);
    expect(divide(7, 2, 'ceil')).toBe(4);
    expect(divide(7, 2, 'halfUp')).toBe(4);
    expect(divide(-7, 2, 'towardZero')).toBe(-3);
    expect(divide(-7, 2, 'floor')).toBe(-4);
  });

  it('transfer with ifShort skip moves nothing when the giver is short; partial moves what exists', () => {
    const transfer = (ifShort: 'skip' | 'partial') =>
      miniGame({
        rules: [{ id: 'rule.tax', trigger: { event: 'landed' }, effects: [{ op: 'transfer', from: '$actor', to: { op: 'entity', id: 'e2' }, resource: 'res.gold', amount: 25, ifShort }] }],
      });
    for (const mode of ['skip', 'partial'] as const) {
      const game = transfer(mode);
      const { state } = startMini(game);
      const out = gm(game, state, { type: 'teleport', entity: 'e1', space: 'space.s3', asLanding: true });
      expect(out.state.entities['e1']?.resources['res.gold']).toBe(mode === 'skip' ? 10 : 0);
      expect(out.state.entities['e2']?.resources['res.gold']).toBe(mode === 'skip' ? 10 : 20);
    }
  });
});
