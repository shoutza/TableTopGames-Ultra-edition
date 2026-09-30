import { describe, expect, it } from 'vitest';
import { answerDecision, applyGmCommand, compileGame, effectiveValue, type CompiledGame } from '../src/engine/index.ts';
import { applyDefinitionChange, planMigration } from '../src/engine/migrate.ts';
import { bagSpacesUsed } from '../src/engine/inventory.ts';
import { GmCommandSchema } from '../src/schema/commands.ts';
import { GameDefinitionSchema, type GameDefinitionInput } from '../src/schema/definition.ts';
import type { GameState } from '../src/schema/state.ts';
import { chooseHeuristic } from '../src/contestants/heuristic.ts';
import { publicInfo } from '../src/visibility/public-info.ts';
import { buildContestantView } from '../src/visibility/view.ts';
import { choose, expectOk, miniDefinition, startMini } from './helpers/mini.ts';

/** The inventory system: bag spaces and stacks, equipment slots, discarding, targeted and limited item uses. */

const NEUTRAL = { voice: 'x', traits: { risk: 5, aggression: 5, greed: 5, loyalty: 5, vindictiveness: 5, sociability: 5 }, behaviors: [] };

function inventoryGame(mutate?: (d: GameDefinitionInput) => void): CompiledGame {
  return compileGame(
    GameDefinitionSchema.parse(
      miniDefinition({
        mutate: (d) => {
          d.settings.inventoryCapacity = 2;
          d.settings.equipment = [{ id: 'slot.weapon', name: 'Weapon', count: 1 }];
          d.items = [
            { id: 'item.sword', name: 'Sword', slot: 'slot.weapon', modifiers: [{ resource: 'res.power', add: 100 }] },
            { id: 'item.axe', name: 'Axe', slot: 'slot.weapon', modifiers: [{ resource: 'res.power', add: 150 }] },
            { id: 'item.potion', name: 'Potion', stackSize: 3, use: { effects: [{ op: 'changeResource', target: '$actor', resource: 'res.hp', amount: 20 }] } },
            { id: 'item.rock', name: 'Rock', value: 1 },
            { id: 'item.bomb', name: 'Bomb', use: { target: { kind: 'contestant', range: 'here' }, effects: [{ op: 'damage', target: '$target', amount: 15 }] } },
            { id: 'item.wand', name: 'Wand', use: { consumed: true, charges: 3, cooldownRounds: 1, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.gold', amount: 1 }] } },
            { id: 'item.snack', name: 'Snack', stackSize: 5, use: { free: true, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.hp', amount: 5 }] } },
            { id: 'item.fishbait', name: 'Fish Bait', use: { requires: { op: 'hasTag', entity: '$actor', tag: 'tag.fish' }, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.bananas', amount: 2 }] } },
          ];
          d.shops = [{ id: 'shop.s', name: 'Shop', entries: [{ id: 'entry.axe', grants: { item: 'item.axe' }, price: { resource: 'res.gold', amount: 2 } }] }];
          mutate?.(d);
        },
      }),
    ),
  );
}

function gm(g: CompiledGame, state: GameState, cmd: Record<string, unknown>): GameState {
  return expectOk(applyGmCommand(g, state, GmCommandSchema.parse(cmd))).state;
}

/** The first contestant, standing at the shop (s1) with a main decision waiting. */
function atMain(g: CompiledGame, items: string[] = []): { state: GameState; ann: string; bob: string } {
  let { state } = startMini(g);
  const ann = state.turnOrder[0] as string;
  const bob = state.turnOrder[1] as string;
  for (const item of items) state = gm(g, state, { type: 'grantItem', entity: ann, item });
  state = gm(g, state, { type: 'teleport', entity: ann, space: 'space.s1', asLanding: false });
  state = choose(g, state, 'mv:space.s1').state;
  expect(state.pendingDecision?.kind).toBe('main');
  return { state, ann, bob };
}

const optionIds = (s: GameState) => s.pendingDecision?.options.map((o) => o.id) ?? [];
const power = (g: CompiledGame, s: GameState, id: string) => effectiveValue(g, s, s.entities[id] as GameState['entities'][string], 'res.power');

describe('equipment slots', () => {
  it('wears received gear in a free slot, keeps a second weapon in the bag without its bonus, and swaps on equip', () => {
    const g = inventoryGame();
    const { state, ann } = atMain(g, ['item.sword']);
    const sword = state.entities[ann]?.items[0] as string;
    expect(state.items[sword]?.equipped).toBe(true);
    expect(power(g, state, ann)).toBe(180);
    expect(bagSpacesUsed(g, state, state.entities[ann] as never)).toBe(0);
    // Buying an axe: the slot is full, so it goes into the bag and gives nothing yet.
    const bought = choose(g, state, `buy:${Object.values(state.entities).find((e) => e.kind === 'fixture')?.id}:entry.axe`).state;
    expect(power(g, bought, ann)).toBe(180);
    expect(bagSpacesUsed(g, bought, bought.entities[ann] as never)).toBe(1);
  });

  it('equip is a free action that swaps the worn item into the bag', () => {
    const g = inventoryGame();
    let { state, ann } = atMain(g, ['item.sword', 'item.axe']);
    const axe = state.entities[ann]?.items.find((id) => state.items[id]?.defId === 'item.axe') as string;
    expect(optionIds(state)).toContain(`equip:${axe}`);
    const opt = state.pendingDecision?.options.find((o) => o.id === `equip:${axe}`);
    expect(opt).toMatchObject({ kind: 'equip', replaces: state.entities[ann]?.items[0] });
    const out = choose(g, state, `equip:${axe}`);
    state = out.state;
    expect(state.phase).toBe('main');
    expect(state.pendingDecision?.actor).toBe(ann);
    expect(power(g, state, ann)).toBe(230);
    expect(out.events.filter((e) => e.type === 'itemEquipped').map((e) => (e.type === 'itemEquipped' ? e.equipped : null))).toEqual([false, true]);
    // The GM can take it off (room in the bag) or put it back on.
    state = gm(g, state, { type: 'equipItem', entity: ann, item: axe, equipped: false });
    expect(power(g, state, ann)).toBe(80);
  });

  it('attached rules and "holds … equipped" count gear only while worn', () => {
    const g = inventoryGame((d) => {
      d.items?.[0] && (d.items[0].rules = [{ id: 'rule.sword_gold', name: 'Sword Gold', trigger: { event: 'turnEnded' }, effects: [{ op: 'changeResource', target: '$holder', resource: 'res.gold', amount: 1 }] }] as never);
      d.actions = [{ id: 'action.duel', name: 'Duel', requires: { op: 'holds', entity: '$actor', item: 'item.sword', equipped: true }, effects: [{ op: 'announce', text: 'En garde!' }] }];
    });
    let { state, ann } = atMain(g, ['item.sword']);
    expect(optionIds(state)).toContain('act:action.duel');
    const sword = state.entities[ann]?.items[0] as string;
    state = gm(g, state, { type: 'equipItem', entity: ann, item: sword, equipped: false });
    expect(optionIds(state)).not.toContain('act:action.duel');
    const gold = state.entities[ann]?.resources['res.gold'] ?? 0;
    const passed = choose(g, state, 'pass').state;
    expect(passed.entities[ann]?.resources['res.gold']).toBe(gold);
  });
});

describe('bag spaces, stacks and discarding', () => {
  it('stacks copies in one space, hides purchases that do not fit, and offers discarding when full', () => {
    const g = inventoryGame();
    let { state, ann } = atMain(g, ['item.potion', 'item.potion', 'item.potion', 'item.rock']);
    expect(bagSpacesUsed(g, state, state.entities[ann] as never)).toBe(2);
    // A fourth potion needs a new space: none left.
    state = gm(g, state, { type: 'grantItem', entity: ann, item: 'item.potion' });
    expect(state.entities[ann]?.items.filter((i) => state.items[i]?.defId === 'item.potion')).toHaveLength(3);
    // The axe (weapon slot free) still fits; with the slot taken it would not.
    expect(optionIds(state).some((o) => o.endsWith(':entry.axe'))).toBe(true);
    const rock = state.entities[ann]?.items.find((i) => state.items[i]?.defId === 'item.rock') as string;
    expect(optionIds(state)).toContain(`drop:${rock}`);
    const dropped = choose(g, state, `drop:${rock}`);
    expect(dropped.state.phase).toBe('main');
    expect(dropped.events.find((e) => e.type === 'itemLost')).toMatchObject({ reason: 'discarded' });
    expect(bagSpacesUsed(g, dropped.state, dropped.state.entities[ann] as never)).toBe(1);
  });
});

describe('item uses', () => {
  it('targeted items are offered per target on the same space and hit the target', () => {
    const g = inventoryGame();
    let { state, ann, bob } = atMain(g, ['item.bomb']);
    const bomb = state.entities[ann]?.items[0] as string;
    expect(optionIds(state).some((o) => o.startsWith(`use:${bomb}`))).toBe(false);
    state = gm(g, state, { type: 'teleport', entity: bob, space: 'space.s1', asLanding: false });
    expect(optionIds(state)).toContain(`use:${bomb}:${bob}`);
    const out = choose(g, state, `use:${bomb}:${bob}`);
    expect(out.state.entities[bob]?.resources['res.hp']).toBe(85);
    expect(out.state.entities[ann]?.items).toEqual([]);
    expect(out.state.phase).toBe('turnEnd');
  });

  it('charges run down one per use, and a cooldown keeps the item for the next round', () => {
    const g = inventoryGame();
    let { state, ann } = atMain(g, ['item.wand']);
    const wand = state.entities[ann]?.items[0] as string;
    expect(state.items[wand]?.charges).toBe(3);
    expect(state.pendingDecision?.options.find((o) => o.id === `use:${wand}`)?.label).toContain('3 uses left');
    state = choose(g, state, `use:${wand}`).state;
    expect(state.items[wand]?.charges).toBe(2);
    expect(state.cooldowns[`item:${wand}`]).toBe(state.round + 1);
  });

  it('free uses keep the main action (at most four free item actions a turn)', () => {
    const g = inventoryGame();
    let { state, ann } = atMain(g, ['item.snack', 'item.snack', 'item.snack', 'item.snack', 'item.snack']);
    state = gm(g, state, { type: 'adjustResource', entity: ann, resource: 'res.hp', delta: -50 });
    for (let i = 0; i < 4; i++) {
      const snack = state.pendingDecision?.options.find((o) => o.kind === 'use');
      expect(snack).toMatchObject({ free: true });
      state = choose(g, state, snack?.id as string).state;
      expect(state.phase).toBe('main');
    }
    expect(state.pendingDecision?.options.some((o) => o.kind === 'use')).toBe(false);
    expect(state.entities[ann]?.resources['res.hp']).toBe(70);
    expect(state.turn.itemActions).toBe(4);
  });

  it('requirements decide when an item can be used', () => {
    const g = inventoryGame();
    let { state, ann } = atMain(g, ['item.fishbait']);
    const bait = state.entities[ann]?.items[0] as string;
    expect(optionIds(state)).not.toContain(`use:${bait}`);
    state = gm(g, state, { type: 'addTag', entity: ann, tag: 'tag.fish' });
    expect(optionIds(state)).toContain(`use:${bait}`);
    expect(answerDecision(g, state, { decisionId: state.pendingDecision?.id as string, optionId: `use:${bait}` }).ok).toBe(true);
  });
});

describe('mid-match changes to inventories', () => {
  it('a removed slot sends worn gear to the bag, and a smaller bag drops the newest items once confirmed', () => {
    const g = inventoryGame();
    const { state, ann } = atMain(g, ['item.sword', 'item.rock', 'item.potion']);
    const next = inventoryGame((d) => {
      d.settings.equipment = [];
      d.settings.inventoryCapacity = 2;
      d.items = (d.items ?? []).map((i) => ({ ...i, slot: undefined }));
    });
    const plan = planMigration(g, next, state);
    expect(plan.issues.map((i) => i.id)).toEqual(expect.arrayContaining(['equipment.changed', 'inventory.capacity']));
    const out = expectOk(applyDefinitionChange(g, next, state, { answers: { 'inventory.capacity': 'drop' }, version: 2, summary: ['x'] }));
    const e = out.state.entities[ann] as GameState['entities'][string];
    expect(bagSpacesUsed(next, out.state, e)).toBeLessThanOrEqual(2);
    expect(e.items.every((id) => out.state.items[id]?.equipped === false)).toBe(true);
  });
});

describe('the offline player and items', () => {
  it('equips an upgrade and throws away junk to buy something better here', () => {
    const g = inventoryGame();
    const info = publicInfo(g);
    let { state, ann } = atMain(g, ['item.sword', 'item.axe']);
    const view = buildContestantView(g, state, ann, []);
    expect(view.inventory).toMatchObject({ bagUsed: 1, bagCapacity: 2 });
    const pick = chooseHeuristic(view, info, NEUTRAL, 'gearUp');
    expect(pick.optionId).toMatch(/^equip:/);

    // Sword worn, bag full of rocks, a better axe for sale here: it cannot be bought until a rock goes.
    ({ state } = atMain(g, ['item.sword', 'item.rock', 'item.rock']));
    const full = buildContestantView(g, state, ann, []);
    expect(full.inventory.bagUsed).toBe(2);
    expect(full.decision?.options.some((o) => o.kind === 'buy')).toBe(false);
    const drop = chooseHeuristic(full, info, NEUTRAL, 'gearUp');
    expect(drop.optionId).toMatch(/^drop:/);
    expect(state.items[drop.optionId.slice('drop:'.length)]?.defId).toBe('item.rock');
    state = choose(g, state, drop.optionId).state;
    expect(state.pendingDecision?.options.some((o) => o.kind === 'buy')).toBe(true);
  });

  it('values targeted and healing items from what they do', () => {
    const info = publicInfo(inventoryGame());
    expect(info.items.find((i) => i.id === 'item.bomb')?.useEstimate).toMatchObject({ other: { 'res.hp': -15 }, targeted: true });
    expect(info.items.find((i) => i.id === 'item.potion')?.useEstimate).toMatchObject({ self: { 'res.hp': 20 }, uses: 1 });
    expect(info.items.find((i) => i.id === 'item.wand')?.useEstimate?.uses).toBe(3);
  });
});
