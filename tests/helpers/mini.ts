import { advance, answerDecision, compileGame, createMatch, nextStepKind, type CompiledGame, type OpOutcome } from '../../src/engine/index.ts';
import { GameDefinitionSchema, type GameDefinitionInput } from '../../src/schema/definition.ts';
import type { RuleDef } from '../../src/schema/rules.ts';
import type { GameEvent, GameState } from '../../src/schema/state.ts';

/**
 * A tiny line board for rule tests: s0 (start) — s1 — s2 (blue) — s3 — s4 (lair) — s5.
 * Two contestants (Ann, Bob), one enemy "Ogre" at s4 (Power 100, HP 50), a shop at s1.
 */
export function miniDefinition(overrides: { rules?: Array<Partial<RuleDef> & Pick<RuleDef, 'id' | 'trigger' | 'effects'>>; mutate?: (d: GameDefinitionInput) => void } = {}): GameDefinitionInput {
  const spaces = ['s0', 's1', 's2', 's3', 's4', 's5'];
  const def: GameDefinitionInput = {
    id: 'mini',
    name: 'Mini',
    rulesLanguageVersion: 1,
    settings: {
      core: { hp: 'res.hp', maxHp: 'res.max_hp', power: 'res.power', gold: 'res.gold' },
      startSpace: 'space.s0',
      movement: { die: 3 },
      inventoryCapacity: 2,
      rest: { heal: 20 },
      combat: { damage: { base: 25, ratioExponent: 1, min: 1, max: 100 }, maxSpinsPerFight: 8 },
      ko: { goldLossPercent: 50, skipTurns: 1 },
      victory: { resource: 'res.stars', threshold: 3, roundLimit: 10, ranking: ['res.stars', 'res.gold'] },
    },
    resources: [
      { id: 'res.hp', name: 'HP', role: 'pool', appliesTo: ['contestant', 'enemy'], default: 100, min: 0, max: null, maxFrom: 'res.max_hp' },
      { id: 'res.max_hp', name: 'Max HP', role: 'stat', appliesTo: ['contestant', 'enemy'], default: 100, min: 1, max: 100000 },
      { id: 'res.power', name: 'Power', role: 'stat', appliesTo: ['contestant', 'enemy'], default: 80, min: 1, max: 1000000 },
      { id: 'res.gold', name: 'Gold', role: 'pool', appliesTo: ['contestant'], default: 10, min: 0, max: 999 },
      { id: 'res.stars', name: 'Stars', role: 'pool', appliesTo: ['contestant'], default: 0, min: 0, max: 99 },
      { id: 'res.bananas', name: 'Bananas', role: 'pool', appliesTo: ['contestant'], default: 0, min: 0, max: 99 },
      { id: 'res.stash', name: 'Stash', role: 'pool', appliesTo: ['contestant'], default: 0, min: 0, max: 99, visibility: 'owner' },
    ],
    tags: [
      { id: 'tag.blue', name: 'Blue', appliesTo: 'space' },
      { id: 'tag.lair', name: 'Lair', appliesTo: 'space' },
      { id: 'tag.fish', name: 'Fish', appliesTo: 'entity' },
      { id: 'tag.cursed', name: 'Cursed', appliesTo: 'entity' },
      { id: 'tag.ogre', name: 'Ogre', appliesTo: 'entity' },
    ],
    spaces: spaces.map((s) => ({ id: `space.${s}`, name: s.toUpperCase(), tags: s === 's2' ? ['tag.blue'] : s === 's4' ? ['tag.lair'] : [] })),
    connections: spaces.slice(1).map((s, i) => ({ a: `space.${spaces[i]}`, b: `space.${s}` })),
    layout: { width: 600, height: 200, positions: Object.fromEntries(spaces.map((s, i) => [`space.${s}`, { x: 50 + i * 100, y: 100 }])) },
    items: [{ id: 'item.sword', name: 'Sword', modifiers: [{ resource: 'res.power', add: 100 }] }],
    shops: [
      {
        id: 'shop.s',
        name: 'Shop',
        entries: [
          { id: 'entry.sword', grants: { item: 'item.sword' }, price: { resource: 'res.gold', amount: 5 } },
          { id: 'entry.star', grants: { resource: 'res.stars', amount: 1 }, price: { resource: 'res.gold', amount: 10 } },
        ],
      },
    ],
    enemies: [
      {
        id: 'enemy.ogre',
        name: 'Ogre',
        tags: ['tag.ogre'],
        power: 100,
        maxHp: 50,
        regenPerRound: 5,
        respawnAfterRounds: 2,
        rewards: [{ op: 'changeResource', target: '$actor', resource: 'res.stars', amount: 1 }],
        spawns: ['space.s4'],
      },
    ],
    fixtures: [{ id: 'fixture.shop', name: 'Shop', shop: 'shop.s', start: { space: 'space.s1' } }],
    cast: [
      { id: 'cast.ann', name: 'Ann', color: '#f00', persona: { voice: 'a', traits: { risk: 5, aggression: 5, greed: 5, loyalty: 5, vindictiveness: 5, sociability: 5 }, behaviors: [] } },
      { id: 'cast.bob', name: 'Bob', color: '#00f', persona: { voice: 'b', traits: { risk: 5, aggression: 5, greed: 5, loyalty: 5, vindictiveness: 5, sociability: 5 }, behaviors: [] } },
    ],
    rules: (overrides.rules ?? []).map((r) => ({ name: r.id, ...r })) as GameDefinitionInput['rules'],
  };
  overrides.mutate?.(def);
  return def;
}

export function miniGame(overrides: Parameters<typeof miniDefinition>[0] = {}): CompiledGame {
  return compileGame(GameDefinitionSchema.parse(miniDefinition(overrides)));
}

export function expectOk(out: OpOutcome): Extract<OpOutcome, { ok: true }> {
  if (!out.ok) throw new Error(`operation failed: ${out.kind}: ${out.message}`);
  return out;
}

/** Starts a match and advances automatic steps until the first decision. */
export function startMini(game: CompiledGame, seed = 'mini'): { state: GameState; events: GameEvent[] } {
  let r = expectOk(createMatch(game, { matchId: 'm', seed }));
  const events = [...r.events];
  let state = r.state;
  while (nextStepKind(state) === 'auto') {
    r = expectOk(advance(game, state));
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

export function entityByName(state: GameState, name: string): string {
  const found = Object.values(state.entities).find((e) => e.name === name);
  if (!found) throw new Error(`no entity named ${name}`);
  return found.id;
}

/** Answers the pending decision with the option whose id matches, then returns the outcome. */
export function choose(game: CompiledGame, state: GameState, optionId: string): Extract<OpOutcome, { ok: true }> {
  const d = state.pendingDecision;
  if (!d) throw new Error('no pending decision');
  return expectOk(answerDecision(game, state, { decisionId: d.id, optionId }));
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}
