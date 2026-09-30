import { describe, expect, it } from 'vitest';
import { answerDecision, applyGmCommand, compileGame, type CompiledGame } from '../src/engine/index.ts';
import { applyCosmeticChange, applyDefinitionChange, planMigration } from '../src/engine/migrate.ts';
import { checkDefinition, locate } from '../src/authoring/check.ts';
import { changeLevel, diffGames, publicSummary } from '../src/authoring/diff.ts';
import { dryRun } from '../src/authoring/dryrun.ts';
import { buildProposal, finalizeDefinition } from '../src/authoring/proposal.ts';
import { ambiguityQuestions, applyAnswers } from '../src/authoring/questions.ts';
import { GmCommandSchema } from '../src/schema/commands.ts';
import { GameDefinitionSchema, type GameDefinitionInput } from '../src/schema/definition.ts';
import type { GameState } from '../src/schema/state.ts';
import { choose, expectOk, miniDefinition, miniGame, startMini, type TestRule } from './helpers/mini.ts';

/** M6: definition changes — diffs, migrations, questions, dry runs and proposals. */

const bananaRule: TestRule = {
  id: 'rule.bananas',
  name: 'Blue Bananas',
  trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } },
  effects: [{ op: 'changeResource', target: '$actor', resource: 'res.bananas', amount: 2 }],
};

function compile(def: GameDefinitionInput): CompiledGame {
  return compileGame(GameDefinitionSchema.parse(def));
}

function edit(mutate: (d: GameDefinitionInput) => void, rules: TestRule[] = []): CompiledGame {
  return compile(miniDefinition({ rules, mutate }));
}

/** A match waiting for the first contestant's move decision. */
function waiting(g: CompiledGame): GameState {
  const { state } = startMini(g);
  expect(state.pendingDecision?.kind).toBe('move');
  return state;
}

describe('diff', () => {
  it('classifies cosmetic, AI and mechanical changes and keeps hidden rules out of the public summary', () => {
    const base = miniGame({ rules: [bananaRule] });
    const cosmetic = edit((d) => {
      d.name = 'Mini Deluxe';
      (d.items ?? [])[0]!.name = 'Great Sword';
      d.layout.positions['space.s0'] = { x: 10, y: 10 };
    }, [bananaRule]);
    const c = diffGames(base, cosmetic);
    expect(changeLevel(c)).toBe('cosmetic');
    expect(c.map((e) => `${e.section}:${e.change}`).sort()).toEqual(['game:changed', 'items:changed', 'layout:changed']);

    const ai = edit((d) => {
      d.cast[0]!.persona.traits.risk = 9;
    }, [bananaRule]);
    expect(changeLevel(diffGames(base, ai))).toBe('ai');

    const hidden: TestRule = { ...bananaRule, id: 'rule.trap', name: 'Trap', visibility: 'hidden' };
    const mech = edit(() => undefined, [{ ...bananaRule, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.bananas', amount: 3 }] }, hidden]);
    const m = diffGames(base, mech);
    expect(changeLevel(m)).toBe('mechanical');
    expect(m.find((e) => e.id === 'rule.bananas')).toMatchObject({ change: 'changed', level: 'mechanical' });
    expect(m.find((e) => e.id === 'rule.bananas')?.after).toContain('3 Bananas');
    const summary = publicSummary(m);
    expect(summary.join('\n')).toContain('Blue Bananas');
    expect(summary.join('\n')).not.toContain('Trap');
  });

  it('treats a brand-new scenario as all added', () => {
    const g = miniGame();
    const d = diffGames(null, g);
    expect(d.every((e) => e.change === 'added')).toBe(true);
    expect(d.filter((e) => e.section === 'spaces')).toHaveLength(6);
    expect(d.filter((e) => e.section === 'connections')).toHaveLength(5);
  });
});

describe('migrations', () => {
  it('a mechanical change withdraws the waiting decision and issues it again under the new rules', () => {
    const base = miniGame();
    const state = waiting(base);
    const next = edit((d) => {
      d.settings.movement = { die: 6 };
    });
    const plan = planMigration(base, next, state);
    expect(plan.blocked).toBe(false);
    const out = expectOk(applyDefinitionChange(base, next, state, { answers: {}, version: 2, summary: ['setting “movement” now: 6'] }));
    const changed = out.events.find((e) => e.type === 'rulesChanged');
    expect(changed).toMatchObject({ version: 2, invalidated: state.pendingDecision?.id, audience: 'all' });
    expect(out.state.pendingDecision?.id).not.toBe(state.pendingDecision?.id);
    expect(out.state.pendingDecision?.actor).toBe(state.pendingDecision?.actor);
    expect(out.state.rev).toBe(state.rev + 1);
    // An answer to the withdrawn decision is refused; the new one works under the new rules (a d6).
    const old = state.pendingDecision;
    const stale = answerDecision(next, out.state, { decisionId: old?.id as string, optionId: old?.options[0]?.id as string });
    expect(stale.ok).toBe(false);
    expect(out.state.pendingDecision?.options.length).toBeGreaterThanOrEqual(1);
  });

  it('blocks incompatible changes with an explanation', () => {
    const base = miniGame();
    const state = waiting(base);
    const noAnn = edit((d) => {
      d.cast = d.cast.filter((c) => c.id !== 'cast.ann');
      d.cast.push({ ...d.cast[0]!, id: 'cast.cid', name: 'Cid' });
    });
    const plan = planMigration(base, noAnn, state);
    expect(plan.blocked).toBe(true);
    expect(plan.issues.find((i) => i.severity === 'blocked')).toMatchObject({ id: 'cast.removed:cast.ann', title: 'Ann is playing in this match' });
    const refused = applyDefinitionChange(base, noAnn, state, { answers: {}, version: 2, summary: [] });
    expect(refused.ok === false && refused.message).toContain('Ann is playing in this match');

    const role = edit((d) => {
      d.resources!.find((r) => r.id === 'res.bananas')!.role = 'stat';
    });
    expect(planMigration(base, role, state).issues.find((i) => i.id === 'resource.role:res.bananas')?.severity).toBe('blocked');
  });

  it('needs the GM to confirm destructive steps, then applies them', () => {
    const base = miniGame();
    let state = waiting(base);
    const ann = state.turnOrder[0] as string;
    state = expectOk(applyGmCommand(base, state, GmCommandSchema.parse({ type: 'grantItem', entity: ann, item: 'item.sword' }))).state;
    state = expectOk(applyGmCommand(base, state, GmCommandSchema.parse({ type: 'adjustResource', entity: ann, resource: 'res.gold', delta: 40 }))).state;
    const next = edit((d) => {
      d.items = [];
      d.shops = [{ id: 'shop.s', name: 'Shop', entries: [{ id: 'entry.star', grants: { resource: 'res.stars', amount: 1 }, price: { resource: 'res.gold', amount: 10 } }] }];
      d.resources!.find((r) => r.id === 'res.gold')!.max = 20;
      d.resources!.push({ id: 'res.shells', name: 'Shells', role: 'pool', appliesTo: ['contestant'], default: 4, min: 0, max: 50 });
    });
    const plan = planMigration(base, next, state);
    expect(plan.issues.map((i) => `${i.id}/${i.severity}`)).toEqual(expect.arrayContaining(['resource.added:res.shells/auto', 'resource.bounds:res.gold/confirm', 'item.removed:item.sword/confirm']));
    const unconfirmed = applyDefinitionChange(base, next, state, { answers: {}, version: 2, summary: [] });
    expect(unconfirmed.ok === false && unconfirmed.message).toMatch(/^needs confirmation/);
    const out = expectOk(applyDefinitionChange(base, next, state, { answers: { 'resource.bounds:res.gold': 'clamp', 'item.removed:item.sword': 'remove' }, version: 2, summary: [] }));
    const e = out.state.entities[ann];
    expect(e?.resources['res.gold']).toBe(20);
    expect(e?.resources['res.shells']).toBe(4);
    expect(e?.items).toEqual([]);
    expect(out.events.some((ev) => ev.type === 'itemLost' && ev.entity === ann)).toBe(true);
  });

  it('removes spaces safely, spawns new enemies and keeps renames cosmetic', () => {
    const base = miniGame();
    let state = waiting(base);
    const ann = state.turnOrder[0] as string;
    state = expectOk(applyGmCommand(base, state, GmCommandSchema.parse({ type: 'teleport', entity: ann, space: 'space.s5', asLanding: false }))).state;
    const next = edit((d) => {
      d.spaces = d.spaces.filter((s) => s.id !== 'space.s5');
      d.connections = d.connections.filter((c) => c.b !== 'space.s5');
      delete d.layout.positions['space.s5'];
      d.enemies!.push({ id: 'enemy.crab', name: 'Crab', power: 50, maxHp: 20, respawnAfterRounds: null, spawns: ['space.s3'] });
    });
    const plan = planMigration(base, next, state);
    expect(plan.issues.find((i) => i.id === 'space.removed')?.detail).toContain('S5');
    const out = expectOk(applyDefinitionChange(base, next, state, { answers: { 'space.removed': 'move' }, version: 2, summary: [] }));
    expect(out.state.entities[ann]?.spaceId).toBe('space.s0');
    expect(Object.values(out.state.entities).some((e) => e.defId === 'enemy.crab' && e.spaceId === 'space.s3')).toBe(true);

    const renamed = edit((d) => {
      d.cast[0]!.name = 'Annie';
    });
    const cosmetic = applyCosmeticChange(renamed, state);
    expect(cosmetic.entities[ann]?.name).toBe('Annie');
    expect(cosmetic.rev).toBe(state.rev);
    expect(cosmetic.pendingDecision?.id).toBe(state.pendingDecision?.id);
  });

  it('withdraws choices queued by deleted rules and keeps the match playable', () => {
    const offer: TestRule = {
      id: 'rule.offer',
      trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } },
      effects: [{ op: 'offerChoice', to: '$actor', prompt: 'Take it?', options: [{ id: 'yes', label: 'Yes', effects: [{ op: 'changeResource', target: '$actor', resource: 'res.gold', amount: 1 }] }, { id: 'no', label: 'No', effects: [] }], default: 'no' }],
    };
    const base = miniGame({ rules: [offer] });
    let state = waiting(base);
    const ann = state.turnOrder[0] as string;
    state = expectOk(applyGmCommand(base, state, GmCommandSchema.parse({ type: 'teleport', entity: ann, space: 'space.s2', asLanding: true }))).state;
    expect(state.pendingDecision?.kind).toBe('choice');
    const next = miniGame();
    expect(planMigration(base, next, state).issues.map((i) => i.id)).toContain('queue.orphaned');
    const out = expectOk(applyDefinitionChange(base, next, state, { answers: {}, version: 2, summary: [] }));
    expect(out.state.queue).toEqual([]);
    expect(out.state.pendingDecision?.kind).toBe('move');
    choose(next, out.state, out.state.pendingDecision?.options[0]?.id as string);
  });
});

describe('ambiguity questions', () => {
  it('ask about teleport landing, rounding, “everyone” and new statuses; defaults keep the definition as written', () => {
    const tide: TestRule = {
      id: 'rule.tide',
      name: 'Tide',
      trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } },
      effects: [
        { op: 'teleport', target: '$actor', to: { op: 'space', id: 'space.s0' } },
        { op: 'changeResource', target: { op: 'all', kind: 'contestant' }, resource: 'res.gold', amount: { op: 'div', a: { op: 'res', of: '$actor', resource: 'res.gold' }, b: 2, rounding: 'floor' } },
      ],
    };
    const base = miniGame();
    const next = edit((d) => {
      d.statuses = [{ id: 'status.wet', name: 'Wet', duration: 2 }];
    }, [tide]);
    const qs = ambiguityQuestions(next.def, diffGames(base, next));
    expect(qs.map((q) => q.id.split(':')[0])).toEqual(expect.arrayContaining(['teleport', 'div', 'everyone', 'stacking']));
    const div = qs.find((q) => q.id.startsWith('div:'));
    expect(div?.default).toBe('floor');
    expect(div?.options.map((o) => o.label)).toContain('round up: 4 and -3');

    // Defaults change nothing.
    expect(applyAnswers(next.def, qs, {})).toEqual(JSON.parse(JSON.stringify(next.def)));
    // Answers patch the definition.
    const everyone = qs.find((q) => q.id.startsWith('everyone:')) as (typeof qs)[number];
    const teleport = qs.find((q) => q.id.startsWith('teleport:')) as (typeof qs)[number];
    const patched = GameDefinitionSchema.parse(applyAnswers(next.def, qs, { [everyone.id]: 'exclude', [teleport.id]: 'land', 'stacking:status.wet': 'stack' }));
    const rule = patched.rules[0];
    expect(rule?.kind === 'reaction' && rule.effects[0]).toMatchObject({ op: 'teleport', asLanding: true });
    expect(rule?.kind === 'reaction' && rule.effects[1]).toMatchObject({ target: { op: 'filter', where: { op: 'not' } } });
    expect(patched.statuses[0]).toMatchObject({ stacking: 'stack', maxStacks: 3 });
    compileGame(patched);
  });

  it('only asks about new or changed content', () => {
    const tide: TestRule = { id: 'rule.tide', trigger: { event: 'landed' }, effects: [{ op: 'teleport', target: '$actor', to: { op: 'space', id: 'space.s0' } }] };
    const base = miniGame({ rules: [tide] });
    const renamed = miniGame({ rules: [{ ...tide, name: 'Renamed' }] });
    expect(ambiguityQuestions(renamed.def, diffGames(base, renamed))).toEqual([]);
  });
});

describe('dry runs', () => {
  it('show examples where the rule fires and where it does not, with the checks', () => {
    const fishy: TestRule = {
      id: 'rule.fishy',
      name: 'Fishy',
      trigger: { event: 'landed', where: { spaceTag: 'tag.blue' } },
      conditions: { op: 'hasTag', entity: '$actor', tag: 'tag.fish' },
      effects: [{ op: 'changeResource', target: '$actor', resource: 'res.bananas', amount: 2 }],
    };
    const g = miniGame({ rules: [fishy] });
    let state = waiting(g);
    const ann = state.turnOrder[0] as string;
    state = expectOk(applyGmCommand(g, state, GmCommandSchema.parse({ type: 'addTag', entity: ann, tag: 'tag.fish' }))).state;
    const [run] = dryRun(g, state, ['rule.fishy'], { simulate: 50 });
    expect(run?.fired.length).toBeGreaterThan(0);
    expect(run?.fired[0]?.results.join(' ')).toContain('Bananas');
    expect(run?.fired[0]?.checks[0]).toMatchObject({ ok: true });
    expect(run?.notFired.length).toBeGreaterThan(0);
    expect(run?.notFired[0]?.checks.some((c) => !c.ok)).toBe(true);
    expect(run?.text).toContain('Fish');
  });

  it('probe modifiers and continuous rules', () => {
    const halve: TestRule = { id: 'rule.halve', kind: 'modifier', on: 'damage', modify: { op: 'scale', num: 1, den: 2, rounding: 'floor' } };
    const aura: TestRule = { id: 'rule.aura', kind: 'continuous', applies: { op: 'all', kind: 'contestant' }, when: { op: 'spaceHasTag', space: { op: 'spaceOf', entity: '$it' }, tag: 'tag.blue' }, modifiers: [{ resource: 'res.power', add: 10 }] };
    const g = miniGame({ rules: [halve, aura] });
    const state = waiting(g);
    const runs = dryRun(g, state, ['rule.halve', 'rule.aura'], { simulate: 0 });
    expect(runs.find((r) => r.rule === 'rule.halve')?.fired[0]?.results).toEqual(['20 → 10']);
    expect(runs.find((r) => r.rule === 'rule.aura')?.notFired.length).toBeGreaterThan(0);
  });
});

describe('proposals', () => {
  it('a mid-match proposal combines diff, migration plan, questions and dry runs; finalize applies the answers', () => {
    const base = miniGame();
    const state = waiting(base);
    const draft = miniDefinition({ rules: [{ ...bananaRule, effects: [...bananaRule.effects, { op: 'teleport', target: '$actor', to: { op: 'space', id: 'space.s0' } }] }] });
    const { proposal, game } = buildProposal(draft, { base, state, dryRun: { simulate: 50 } });
    expect(proposal.ok).toBe(true);
    expect(game).not.toBeNull();
    expect(proposal.level).toBe('mechanical');
    expect(proposal.summary[0]).toContain('new rule “Blue Bananas”');
    expect(proposal.migration?.blocked).toBe(false);
    expect(proposal.questions.map((q) => q.id)).toEqual([expect.stringMatching(/^teleport:/)]);
    expect(proposal.dryRuns[0]?.fired.length).toBeGreaterThan(0);

    const fin = finalizeDefinition(draft, base, { questions: { [proposal.questions[0]?.id as string]: 'land' } });
    expect(fin.ok).toBe(true);
    if (!fin.ok) return;
    const rule = fin.def.rules[0];
    expect(rule?.kind === 'reaction' && rule.effects[1]).toMatchObject({ asLanding: true });
    expect(finalizeDefinition(draft, base, { questions: { nope: 'x' } }).ok).toBe(false);
  });

  it('reports schema and compile problems with a location', () => {
    const draft = miniDefinition({ rules: [{ ...bananaRule, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.nope', amount: 1 }] }] });
    const { proposal } = buildProposal(draft, { base: miniGame(), state: null });
    expect(proposal.ok).toBe(false);
    expect(proposal.check.issues[0]).toMatchObject({ severity: 'error', code: 'unknown-resource', path: ['rules', 0] });

    const broken = miniDefinition();
    (broken.spaces[1] as { tags: unknown }).tags = 'blue';
    const check = checkDefinition(broken).result;
    expect(check.ok).toBe(false);
    expect(check.issues[0]?.path).toEqual(['spaces', 1, 'tags']);
  });

  it('a valid check describes every rule in plain language', () => {
    const { result } = checkDefinition(miniDefinition({ rules: [bananaRule] }));
    expect(result.ok).toBe(true);
    expect(result.texts['rules:rule.bananas']).toMatch(/lands on a Blue space.*2 Bananas/);
    expect(result.stats).toMatchObject({ spaces: 6, connections: 5, rules: 1 });
    expect(locate(miniDefinition(), 'entry.star')).toEqual(['shops', 0, 'entries', 1]);
  });
});
