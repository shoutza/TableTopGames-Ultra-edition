import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadGame } from '../engine/index.ts';
import type { GameDefinitionInput } from '../schema/definition.ts';
import { autoDecorate, layoutOf } from '../shared/boardThemes.ts';

/**
 * npm run make:scale — writes content/starter/grand-archipelago.json, the M8 scale scenario:
 * eight contestants on eight island rings of 25 spaces (200 spaces, joined by bridges), with
 * Star Chase's items, enemies and cards, its rules, and twelve rules per island (110+ rules),
 * over 40 rounds (320 turns). Deterministic: running it again gives the same file.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
type Json = Record<string, unknown>;

const base = JSON.parse(readFileSync(path.join(repoRoot, 'content/starter/star-chase.json'), 'utf8')) as Json & {
  tags: Json[];
  rules: Json[];
  enemies: Json[];
  fixtures: Json[];
  cast: Json[];
  settings: Json & { victory: Json };
};

interface Isle {
  key: string;
  name: string;
  icon: string;
  /** Twelve rules' numbers, so islands differ. */
  toll: number;
  trap: number;
  spring: number;
  altar: 'status.blessed' | 'status.shielded';
  market: number;
  thieves: number;
  training: number;
  climate: { resource: string; add: number; text: string };
  guardian: number;
  festival: number;
}

const ISLES: Isle[] = [
  {
    key: 'harbor',
    name: 'Harbor',
    icon: '⚓',
    toll: 1,
    trap: 3,
    spring: 15,
    altar: 'status.shielded',
    market: 1,
    thieves: 2,
    training: 20,
    climate: { resource: 'res.move', add: 0, text: 'calm seas' },
    guardian: 0,
    festival: 1,
  },
  {
    key: 'jungle',
    name: 'Jungle',
    icon: '🌿',
    toll: 2,
    trap: 5,
    spring: 20,
    altar: 'status.blessed',
    market: 2,
    thieves: 3,
    training: 30,
    climate: { resource: 'res.power', add: -20, text: 'thick vines' },
    guardian: 20,
    festival: 1,
  },
  {
    key: 'volcano',
    name: 'Volcano',
    icon: '🌋',
    toll: 3,
    trap: 8,
    spring: 10,
    altar: 'status.blessed',
    market: 1,
    thieves: 4,
    training: 50,
    climate: { resource: 'res.power', add: 30, text: 'burning heat' },
    guardian: 60,
    festival: 2,
  },
  {
    key: 'glacier',
    name: 'Glacier',
    icon: '🧊',
    toll: 2,
    trap: 6,
    spring: 25,
    altar: 'status.shielded',
    market: 3,
    thieves: 2,
    training: 35,
    climate: { resource: 'res.move', add: -1, text: 'slippery ice' },
    guardian: 30,
    festival: 1,
  },
  {
    key: 'dunes',
    name: 'Dunes',
    icon: '🏜️',
    toll: 3,
    trap: 4,
    spring: 30,
    altar: 'status.blessed',
    market: 2,
    thieves: 5,
    training: 25,
    climate: { resource: 'res.move', add: 1, text: 'hard-packed sand' },
    guardian: 25,
    festival: 2,
  },
  {
    key: 'reef',
    name: 'Reef',
    icon: '🐠',
    toll: 1,
    trap: 5,
    spring: 20,
    altar: 'status.shielded',
    market: 2,
    thieves: 3,
    training: 30,
    climate: { resource: 'res.power', add: 10, text: 'sea spray' },
    guardian: 15,
    festival: 1,
  },
  {
    key: 'ruins',
    name: 'Ruins',
    icon: '🏛️',
    toll: 4,
    trap: 7,
    spring: 15,
    altar: 'status.blessed',
    market: 3,
    thieves: 6,
    training: 40,
    climate: { resource: 'res.power', add: -30, text: 'ancient curses' },
    guardian: 40,
    festival: 2,
  },
  {
    key: 'sky',
    name: 'Sky',
    icon: '☁️',
    toll: 2,
    trap: 9,
    spring: 35,
    altar: 'status.shielded',
    market: 4,
    thieves: 4,
    training: 45,
    climate: { resource: 'res.move', add: 1, text: 'tailwinds' },
    guardian: 50,
    festival: 3,
  },
];

/** The 25 spaces of every island: feature name and tags (`x_…` are the island's own tags). */
const RING: Array<{ name: string; tags: string[] }> = [
  { name: 'Gate', tags: ['tag.coin'] },
  { name: 'Coin Path', tags: ['tag.coin'] },
  { name: 'Shallows', tags: ['tag.blue'] },
  { name: 'Toll Post', tags: ['x_toll'] },
  { name: 'Crossroads', tags: ['tag.event'] },
  { name: 'Dojo', tags: ['tag.dojo'] },
  { name: 'Snare', tags: ['x_trap'] },
  { name: 'Lookout', tags: ['tag.star_spot', 'tag.coin'] },
  { name: 'Spring', tags: ['x_spring'] },
  { name: 'Lagoon', tags: ['tag.blue'] },
  { name: 'Den', tags: ['tag.den'] },
  { name: 'Altar', tags: ['x_altar'] },
  { name: 'Coin Steps', tags: ['tag.coin'] },
  { name: 'Market', tags: ['x_market'] },
  { name: 'Mystery Cove', tags: ['tag.star_spot', 'tag.event'] },
  { name: 'Hazard Pass', tags: ['tag.hazard'] },
  { name: 'Thieves Alley', tags: ['x_thieves'] },
  { name: 'Tide Pool', tags: ['tag.blue'] },
  { name: 'Training Yard', tags: ['x_training'] },
  { name: 'Ferry Dock', tags: ['x_ferry', 'tag.ferry'] },
  { name: 'Treasure Road', tags: ['tag.rich_coin'] },
  { name: 'Summit', tags: ['tag.star_spot', 'tag.coin'] },
  { name: 'Sanctuary', tags: ['x_sanctuary'] },
  { name: 'Bazaar', tags: ['tag.coin'] },
  { name: 'Blue Bay', tags: ['tag.blue'] },
];

/** Spaces that differ from the ring pattern: [island, index, name, tags]. */
const SPECIAL: Array<[string, number, string, string[]]> = [
  ['harbor', 0, 'Harbor Gate', ['tag.start']],
  ['harbor', 23, 'Gear Bazaar', ['tag.shop']],
  ['reef', 23, 'Banana Stand', ['tag.shop']],
  ['volcano', 23, 'Ember Forge', ['tag.shop']],
  ['glacier', 23, 'Ice Outpost', ['tag.shop']],
  ['sky', 23, 'Cloud Market', ['tag.shop']],
  ['volcano', 12, "Demon's Lair", ['tag.lair']],
  ['volcano', 5, 'Ash Shrine', ['tag.shrine']],
  ['ruins', 13, 'Gilded Idol', ['tag.idol']],
  ['dunes', 13, 'Old Well', ['tag.well']],
];

const SPAN = 760;
const RADIUS = 300;
const COLS = 4;
const spaceId = (isle: Isle, i: number) => `space.${isle.key}.${i}`;
const center = (k: number) => ({ x: SPAN / 2 + (k % COLS) * SPAN, y: SPAN / 2 + Math.floor(k / COLS) * SPAN });

/** The scale scenario's definition (plain JSON, as stored in content/starter). */
export function scaleScenario(): Json {
  const spaces: Json[] = [];
  const connections: Array<{ a: string; b: string }> = [];
  const positions: Record<string, { x: number; y: number }> = {};
  const tags: Json[] = [...base.tags, { id: 'tag.ferry', name: 'Ferry', appliesTo: 'space', color: '#5d6d7e', icon: '⛴️' }];
  const rules: Json[] = [...base.rules];

  ISLES.forEach((isle, k) => {
    const c = center(k);
    const local = (t: string) => (t.startsWith('x_') ? `tag.${isle.key}_${t.slice(2)}` : t);
    const isleTag = `tag.isle_${isle.key}`;
    tags.push({ id: isleTag, name: `${isle.name} Isle`, appliesTo: 'space', description: `Every space on the ${isle.name} island.` });
    const localTags: Array<[string, string, string, string]> = [
      ['toll', 'Toll', '#f5b041', '💰'],
      ['trap', 'Snare', '#7b7d7d', '🪤'],
      ['spring', 'Spring', '#48c9b0', '💧'],
      ['altar', 'Altar', '#bb8fce', '🕯️'],
      ['market', 'Market', '#dc7633', '🛍️'],
      ['thieves', 'Thieves', '#566573', '🦝'],
      ['training', 'Training', '#e59866', '🏋️'],
      ['ferry', 'Ferry', '#5d6d7e', '⛴️'],
      ['sanctuary', 'Sanctuary', '#d5f5e3', '🛡️'],
    ];
    for (const [key, name, color, icon] of localTags) tags.push({ id: `tag.${isle.key}_${key}`, name: `${isle.name} ${name}`, appliesTo: 'space', color, icon });

    RING.forEach((slot, i) => {
      const special = SPECIAL.find(([key, idx]) => key === isle.key && idx === i);
      const name = special ? special[2] : `${isle.name} ${slot.name}`;
      const own = special ? special[3] : slot.tags.map(local);
      spaces.push({ id: spaceId(isle, i), name, tags: [...own, isleTag] });
      const a = (i / RING.length) * 2 * Math.PI - Math.PI / 2;
      positions[spaceId(isle, i)] = { x: Math.round(c.x + RADIUS * Math.cos(a)), y: Math.round(c.y + RADIUS * Math.sin(a)) };
      connections.push({ a: spaceId(isle, i), b: spaceId(isle, (i + 1) % RING.length) });
    });

    const on = (entity: string) => ({ op: 'spaceHasTag', space: { op: 'spaceOf', entity }, tag: isleTag });
    const landed = (t: string) => ({ event: 'landed', where: { spaceTag: `tag.${isle.key}_${t}`, actorKind: 'contestant' } });
    const self = (resource: string, amount: unknown) => ({ op: 'changeResource', target: '$actor', resource, amount });
    rules.push(
      { id: `rule.${isle.key}.toll`, name: `${isle.name} Toll`, trigger: landed('toll'), effects: [self('res.gold', isle.toll + 2)] },
      {
        id: `rule.${isle.key}.trap`,
        name: `${isle.name} Snare`,
        trigger: landed('trap'),
        effects: [{ op: 'damage', target: '$actor', amount: { op: 'add', args: [{ op: 'roll', count: 1, sides: 6 }, isle.trap] } }],
      },
      { id: `rule.${isle.key}.spring`, name: `${isle.name} Spring`, trigger: landed('spring'), effects: [self('res.hp', isle.spring)] },
      { id: `rule.${isle.key}.altar`, name: `${isle.name} Altar`, trigger: landed('altar'), effects: [{ op: 'applyStatus', target: '$actor', status: isle.altar }] },
      { id: `rule.${isle.key}.market`, name: `${isle.name} Market`, trigger: landed('market'), effects: [self('res.stash', isle.market), self('res.gold', 1)] },
      { id: `rule.${isle.key}.thieves`, name: `${isle.name} Thieves`, trigger: landed('thieves'), effects: [self('res.gold', -isle.thieves)] },
      { id: `rule.${isle.key}.training`, name: `${isle.name} Training Yard`, trigger: landed('training'), effects: [self('res.power', isle.training)] },
      {
        id: `rule.${isle.key}.ferry`,
        name: `${isle.name} Ferry`,
        description: 'The ferry carries you to another island’s dock.',
        trigger: landed('ferry'),
        effects: [{ op: 'teleport', target: '$actor', to: { op: 'randomSpace', tag: 'tag.ferry', excludeSpaceOf: '$actor' } }],
      },
      {
        id: `rule.${isle.key}.sanctuary`,
        name: `${isle.name} Sanctuary`,
        kind: 'continuous',
        applies: { op: 'all', kind: 'contestant' },
        when: { op: 'spaceHasTag', space: { op: 'spaceOf', entity: '$it' }, tag: `tag.${isle.key}_sanctuary` },
        suppress: ['attackable'],
      },
      ...(isle.climate.add !== 0
        ? [
            {
              id: `rule.${isle.key}.climate`,
              name: `${isle.name} Climate`,
              description: `Everyone on the ${isle.name} island feels the ${isle.climate.text}.`,
              kind: 'continuous',
              applies: { op: 'all', kind: 'contestant' },
              when: on('$it'),
              modifiers: [{ resource: isle.climate.resource, add: isle.climate.add }],
            },
          ]
        : [
            {
              id: `rule.${isle.key}.climate`,
              name: `${isle.name} Breeze`,
              trigger: { event: 'turnStarted' },
              conditions: { op: 'all', conds: [{ op: 'isKind', entity: '$actor', kind: 'contestant' }, on('$actor')] },
              effects: [self('res.hp', 5)],
            },
          ]),
      ...(isle.guardian > 0
        ? [
            {
              id: `rule.${isle.key}.guardian`,
              name: `${isle.name} Guardians`,
              description: `Slimes on the ${isle.name} island are tougher.`,
              kind: 'continuous',
              applies: { op: 'withTag', tag: 'tag.slime', kind: 'enemy' },
              when: on('$it'),
              modifiers: [{ resource: 'res.power', add: isle.guardian }],
            },
          ]
        : [
            {
              id: `rule.${isle.key}.guardian`,
              name: `${isle.name} Watch`,
              trigger: { event: 'landed', where: { spaceTag: isleTag, actorKind: 'contestant' } },
              conditions: { op: 'compare', left: { op: 'res', of: '$actor', resource: 'res.hp' }, cmp: '<', right: 30 },
              effects: [self('res.hp', 10)],
              limits: { maxPerTurn: 1 },
            },
          ]),
      {
        id: `rule.${isle.key}.festival`,
        name: `${isle.name} Festival`,
        trigger: { event: 'turnStarted' },
        conditions: { op: 'all', conds: [{ op: 'isKind', entity: '$actor', kind: 'contestant' }, on('$actor')] },
        effects: [self('res.gold', isle.festival)],
      },
    );
  });

  // Bridges between neighbouring islands: the two spaces facing each other.
  const nearest = (from: number, toward: number): string => {
    const isle = ISLES[from] as Isle;
    const t = center(toward);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < RING.length; i++) {
      const p = positions[spaceId(isle, i)] as { x: number; y: number };
      const d = Math.hypot(p.x - t.x, p.y - t.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return spaceId(isle, best);
  };
  for (let k = 0; k < ISLES.length; k++) {
    if (k % COLS < COLS - 1) connections.push({ a: nearest(k, k + 1), b: nearest(k + 1, k) });
    if (k + COLS < ISLES.length) connections.push({ a: nearest(k, k + COLS), b: nearest(k + COLS, k) });
  }

  const ids = (pred: (s: Json) => boolean) => spaces.filter(pred).map((s) => s.id as string);
  const enemies = base.enemies.map((e) => {
    if (e['id'] === 'enemy.slime') return { ...e, spawns: ids((s) => (s['tags'] as string[]).includes('tag.den')) };
    if (e['id'] === 'enemy.demon') return { ...e, spawns: ids((s) => (s['tags'] as string[]).includes('tag.lair')) };
    return e;
  });
  const fixtures = [
    { id: 'fixture.bazaar', name: 'Gear Bazaar', icon: '🏪', shop: 'shop.bazaar', start: { space: 'space.harbor.23' } },
    { id: 'fixture.forge', name: 'Ember Forge', icon: '⚒️', shop: 'shop.bazaar', start: { space: 'space.volcano.23' } },
    { id: 'fixture.cloud_market', name: 'Cloud Market', icon: '🎈', shop: 'shop.bazaar', start: { space: 'space.sky.23' } },
    { id: 'fixture.banana_stand', name: 'Banana Stand', icon: '🍌', shop: 'shop.banana_stand', start: { space: 'space.reef.23' } },
    { id: 'fixture.ice_outpost', name: 'Ice Outpost', icon: '🏕️', shop: 'shop.banana_stand', start: { space: 'space.glacier.23' } },
    { id: 'fixture.star_vendor', name: 'Star Vendor', icon: '🌟', tags: ['tag.star_vendor'], shop: 'shop.stars', start: { randomSpaceTag: 'tag.star_spot' } },
    { id: 'fixture.star_vendor_2', name: 'Star Peddler', icon: '💫', tags: ['tag.star_vendor'], shop: 'shop.stars', start: { randomSpaceTag: 'tag.star_spot' } },
  ];
  const persona = (voice: string, risk: number, aggression: number, greed: number, loyalty: number, vindictiveness: number, sociability: number, behaviors: string[]) => ({
    voice,
    traits: { risk, aggression, greed, loyalty, vindictiveness, sociability },
    behaviors,
  });
  const cast = [
    ...base.cast,
    {
      id: 'cast.ember',
      name: 'Sister Ember',
      icon: '🔥',
      color: '#c0392b',
      persona: persona('Fiery monk who speaks in proverbs about patience and flame.', 5, 6, 4, 8, 4, 5, ['Trains at every dojo and shrine she passes.', 'Keeps her promises, and expects the same.']),
    },
    {
      id: 'cast.tock',
      name: 'Tock the Clockwork',
      icon: '🤖',
      color: '#7f8c8d',
      persona: persona('Polite clockwork automaton that reports probabilities to two decimals.', 3, 4, 6, 6, 2, 3, ['Takes the option with the best expected value.', 'Never wastes a turn.']),
    },
    {
      id: 'cast.marlo',
      name: 'Old Salt Marlo',
      icon: '🎣',
      color: '#16a085',
      persona: persona('Weathered fisherman, slow to anger, full of sea stories.', 2, 2, 6, 7, 3, 6, ['Prefers Blue spaces and quiet coves.', 'Trades generously with friends.']),
    },
    {
      id: 'cast.nyx',
      name: 'Nyx the Shade',
      icon: '🦇',
      color: '#2c3e50',
      persona: persona('Whispering thief who never says more than she must.', 8, 6, 9, 2, 6, 2, ['Pickpockets anyone who stands still.', 'Disappears when a fight turns against her.']),
    },
  ];

  const def = {
    ...base,
    id: 'grand-archipelago',
    name: 'Grand Archipelago',
    description:
      'Eight contestants race across eight islands: 200 spaces joined by bridges and ferries, each island with its own climate, tolls, traps, springs and festivals. Two star vendors wander the lookouts; the Demon guards the Volcano.',
    settings: { ...base.settings, startSpace: 'space.harbor.0', victory: { ...base.settings.victory, threshold: 8, roundLimit: 40 } },
    tags,
    spaces,
    connections,
    layout: { width: COLS * SPAN, height: Math.ceil(ISLES.length / COLS) * SPAN, positions, theme: 'island', roads: 'road', curved: false, spaceStyle: 'circle', decor: [] as unknown[] },
    enemies,
    fixtures,
    cast,
    rules,
  } as Json;
  (def['layout'] as Json)['decor'] = autoDecorate(layoutOf(def['layout']), connections, 0.6);
  return def;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const def = scaleScenario();
  const loaded = loadGame(def as GameDefinitionInput);
  if (!loaded.ok) {
    console.error(loaded.errors.join('\n'));
    process.exit(1);
  }
  const out = path.join(repoRoot, 'content/starter/grand-archipelago.json');
  writeFileSync(out, JSON.stringify(def, null, 2) + '\n');
  const g = loaded.game.def;
  console.log(
    `${out}: ${g.cast.length} contestants · ${g.spaces.length} spaces · ${g.connections.length} connections · ${g.rules.length} rules · ${g.tags.length} tags · ${g.settings.victory.roundLimit} rounds (${g.settings.victory.roundLimit * g.cast.length} turns) · ${g.layout.decor.length} scenery`,
  );
}
