import { describe, expect, it } from 'vitest';
import { applyGmCommand, damageFor, fightOdds, spinChance } from '../src/engine/index.ts';
import { GmCommandSchema, type GmCommandInput } from '../src/schema/commands.ts';
import type { GameEvent, GameState } from '../src/schema/state.ts';
import { choose, entityByName, expectOk, miniGame, startMini } from './helpers/mini.ts';
import { advance, nextStepKind } from '../src/engine/index.ts';

const DAMAGE = { base: 25, ratioExponent: 1 as const, min: 1, max: 100 };

describe('combat math', () => {
  it('wheel shares match the design examples', () => {
    expect(spinChance(500, 80)).toBeCloseTo(0.862, 3);
    expect(spinChance(80, 500)).toBeCloseTo(0.138, 3);
    expect(spinChance(250, 500)).toBeCloseTo(1 / 3, 6);
    expect(spinChance(500, 500)).toBe(0.5);
    expect(spinChance(1000, 500)).toBeCloseTo(2 / 3, 6);
  });

  it('damage scales with the Power ratio and respects min/max', () => {
    expect(damageFor(80, 500, DAMAGE)).toBe(4);
    expect(damageFor(500, 80, DAMAGE)).toBe(100); // 156 capped
    expect(damageFor(250, 500, DAMAGE)).toBe(13);
    expect(damageFor(500, 500, DAMAGE)).toBe(25);
    expect(damageFor(750, 500, DAMAGE)).toBe(38);
    expect(damageFor(1000, 500, DAMAGE)).toBe(50);
    expect(damageFor(500, 1000, DAMAGE)).toBe(13);
    expect(damageFor(1, 100000, DAMAGE)).toBe(1);
    expect(damageFor(500, 1000, { ...DAMAGE, ratioExponent: 0.5 })).toBe(18);
    expect(damageFor(500, 1000, { ...DAMAGE, ratioExponent: 0 })).toBe(25);
  });

  it('fight odds match the documented table (Demon 500 Power / 300 HP, 8 spins)', () => {
    const vsDemon = (power: number) =>
      fightOdds({ attackerPower: power, attackerHp: 100, defenderPower: 500, defenderHp: 300, maxSpins: 8, damage: DAMAGE });
    expect(vsDemon(80).pDefenderWins).toBeCloseTo(1, 6);
    expect(vsDemon(250).pDefenderWins).toBeCloseTo(0.997, 3);
    expect(vsDemon(500).pDefenderWins).toBeCloseTo(0.637, 3);
    expect(vsDemon(750).pAttackerWins).toBeCloseTo(0.017, 3);
    expect(vsDemon(1000).pAttackerWins).toBeCloseTo(0.468, 3);
    expect(vsDemon(1500).pAttackerWins).toBeCloseTo(0.973, 3);
    for (const p of [80, 250, 500, 750, 1000, 1500]) {
      const o = vsDemon(p);
      expect(o.pAttackerWins + o.pDefenderWins + o.pBothStand).toBeCloseTo(1, 9);
    }
  });
});

function gm(game: ReturnType<typeof miniGame>, state: GameState, cmd: GmCommandInput) {
  return expectOk(applyGmCommand(game, state, GmCommandSchema.parse(cmd)));
}

const ambush = {
  id: 'rule.ambush',
  trigger: { event: 'landed' as const, where: { spaceTag: 'tag.lair' } },
  effects: [
    {
      op: 'fight' as const,
      attacker: { op: 'filter' as const, from: { op: 'at' as const, space: '$space' as const, kind: 'enemy' as const }, where: { op: 'hasTag' as const, entity: '$it' as const, tag: 'tag.ogre' } },
      defender: '$actor' as const,
    },
  ],
};

describe('combat in the engine', () => {
  it('spin outcomes follow the wheel shares and every spin is recorded', () => {
    const game = miniGame({ rules: [ambush] });
    let { state } = startMini(game, 'wheel');
    const ann = entityByName(state, 'Ann');
    const ogre = entityByName(state, 'Ogre');
    for (const [entity, resource, value] of [
      [ann, 'res.power', 400],
      [ann, 'res.max_hp', 100000],
      [ann, 'res.hp', 100000],
      [ogre, 'res.max_hp', 100000],
      [ogre, 'res.hp', 100000],
    ] as const) state = gm(game, state, { type: 'setResource', entity, resource, value, silent: true }).state;

    let spins = 0;
    let ogreWins = 0;
    for (let i = 0; i < 300; i++) {
      state = gm(game, state, { type: 'setResource', entity: ogre, resource: 'res.hp', value: 100000, silent: true }).state;
      const out = gm(game, state, { type: 'teleport', entity: ann, space: 'space.s4', asLanding: true });
      state = out.state;
      const started = out.events.find((e): e is Extract<GameEvent, { type: 'fightStarted' }> => e.type === 'fightStarted');
      expect(started?.attackerPower).toBe(100);
      expect(started?.defenderPower).toBe(400);
      expect(started?.attackerDamage).toBe(damageFor(100, 400, DAMAGE));
      for (const e of out.events) {
        if (e.type !== 'spin') continue;
        spins++;
        expect(e.total).toBe(500);
        expect(e.winner === ogre).toBe(e.roll < 100);
        if (e.winner === ogre) ogreWins++;
      }
    }
    expect(spins).toBe(2400);
    // Expected 20%; with 2400 spins a 3-sigma band is about ±2.5%.
    expect(Math.abs(ogreWins / spins - 0.2)).toBeLessThan(0.025);
  });

  it('a knocked-out contestant loses half its gold, returns to start, is healed and skips a turn', () => {
    const game = miniGame({ rules: [ambush] });
    let { state } = startMini(game, 'ko');
    const ann = entityByName(state, 'Ann');
    state = gm(game, state, { type: 'setResource', entity: ann, resource: 'res.gold', value: 11, silent: true }).state;
    state = gm(game, state, { type: 'setResource', entity: ann, resource: 'res.power', value: 1, silent: true }).state;
    state = gm(game, state, { type: 'setResource', entity: ann, resource: 'res.hp', value: 1, silent: true }).state;
    const out = gm(game, state, { type: 'teleport', entity: ann, space: 'space.s4', asLanding: true });
    const e = out.state.entities[ann];
    expect(e?.resources['res.gold']).toBe(6);
    expect(e?.spaceId).toBe('space.s0');
    expect(e?.resources['res.hp']).toBe(100);
    expect(e?.koTurns).toBe(1);
    expect(out.events.map((x) => x.type)).toEqual(expect.arrayContaining(['fightStarted', 'spin', 'fightEnded', 'defeated', 'knockedOut']));
    const ko = out.events.find((x) => x.type === 'defeated');
    expect(ko?.type === 'defeated' && ko.by).toBe(entityByName(state, 'Ogre'));
  });

  it('defeated enemies grant rewards, keep their space, and respawn at full HP; survivors keep their HP', () => {
    const game = miniGame();
    let { state } = startMini(game, 'reward');
    const actor = state.pendingDecision?.actor as string;
    const ogre = entityByName(state, 'Ogre');
    // Make the actor overwhelming and put it next to the Ogre.
    state = gm(game, state, { type: 'setResource', entity: actor, resource: 'res.power', value: 100000, silent: true }).state;
    state = gm(game, state, { type: 'teleport', entity: actor, space: 'space.s4', asLanding: false }).state;
    state = choose(game, state, 'mv:space.s4').state;
    const attack = choose(game, state, `atk:${ogre}`);
    state = attack.state;
    expect(state.entities[actor]?.resources['res.stars']).toBe(1);
    expect(state.entities[ogre]?.status).toBe('defeated');
    expect(state.entities[ogre]?.respawnRound).toBe(state.round + 2);
    const respawnAt = state.entities[ogre]?.respawnRound as number;
    let guard = 0;
    while (state.round < respawnAt && guard++ < 200) {
      if (nextStepKind(state) === 'auto') state = expectOk(advance(game, state)).state;
      else state = choose(game, state, state.pendingDecision?.options.find((o) => o.kind === 'pass' || (o.kind === 'move' && o.steps === 0))?.id as string).state;
    }
    expect(state.entities[ogre]?.status).toBe('active');
    expect(state.entities[ogre]?.resources['res.hp']).toBe(50);
  });

  it('enemies regenerate at round end but never above max HP', () => {
    const game = miniGame();
    let { state } = startMini(game, 'regen');
    const ogre = entityByName(state, 'Ogre');
    state = gm(game, state, { type: 'setResource', entity: ogre, resource: 'res.hp', value: 30, silent: true }).state;
    let guard = 0;
    const round = state.round;
    while (state.round === round && guard++ < 50) {
      if (nextStepKind(state) === 'auto') state = expectOk(advance(game, state)).state;
      else state = choose(game, state, state.pendingDecision?.options.find((o) => o.kind === 'pass' || (o.kind === 'move' && o.steps === 0))?.id as string).state;
    }
    expect(state.entities[ogre]?.resources['res.hp']).toBe(35);
  });
});
