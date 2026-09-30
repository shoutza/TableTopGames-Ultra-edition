import type { GameDefinitionInput } from '../schema/definition.ts';

/**
 * Starting points for the editor: a blank (but playable) scenario, board generators and fresh
 * entries for every definition section. Everything here is plain data the GM then edits.
 */

type Json = Record<string, unknown>;

/** A lowercase slug from a display name ("Blue Lagoon" → "blue_lagoon"). */
export function slug(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return /^[a-z]/.test(s) ? s : `x${s || '1'}`;
}

/** `prefix.slug`, made unique against `taken` with a numeric suffix. */
export function uniqueId(prefix: string, name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `${prefix}.${slug(name)}`;
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
}

export type BoardShape = 'ring' | 'grid' | 'line' | 'figure8' | 'spokes';

export interface GeneratedBoard {
  spaces: Array<{ id: string; name: string; tags: string[] }>;
  connections: Array<{ a: string; b: string; directed?: boolean }>;
  layout: { width: number; height: number; positions: Record<string, { x: number; y: number }> };
}

/**
 * A board of `count` spaces in a simple shape. Tags from `pattern` are painted in rotation (every
 * space gets `pattern[i % pattern.length]`, an empty entry means no tag). `oneWay` makes a ring
 * (or figure eight) directed, like a classic party-game track.
 */
export function generateBoard(shape: BoardShape, count: number, options: { pattern?: string[]; oneWay?: boolean; prefix?: string } = {}): GeneratedBoard {
  const n = Math.max(2, Math.min(400, Math.floor(count)));
  const prefix = options.prefix ?? 'space';
  const pattern = options.pattern ?? [];
  const ids = Array.from({ length: n }, (_, i) => `${prefix}.${i + 1}`);
  const spaces = ids.map((id, i) => {
    const tag = pattern.length > 0 ? pattern[i % pattern.length] : undefined;
    return { id, name: i === 0 ? 'Start' : `Space ${i + 1}`, tags: tag ? [tag] : [] };
  });
  const positions: Record<string, { x: number; y: number }> = {};
  const connections: GeneratedBoard['connections'] = [];
  const link = (a: number, b: number) => connections.push({ a: ids[a] as string, b: ids[b] as string, ...(options.oneWay ? { directed: true } : {}) });
  const step = 90;
  let width = 800;
  let height = 600;
  switch (shape) {
    case 'ring': {
      const r = Math.max(180, (n * step) / (2 * Math.PI));
      width = Math.ceil(2 * r + 160);
      height = width;
      ids.forEach((id, i) => {
        const a = (i / n) * 2 * Math.PI - Math.PI / 2;
        positions[id] = { x: Math.round(width / 2 + r * Math.cos(a)), y: Math.round(height / 2 + r * Math.sin(a)) };
      });
      for (let i = 0; i < n; i++) link(i, (i + 1) % n);
      break;
    }
    case 'line': {
      const perRow = Math.min(n, 10);
      const rows = Math.ceil(n / perRow);
      width = perRow * step + 80;
      height = rows * step + 80;
      ids.forEach((id, i) => {
        const row = Math.floor(i / perRow);
        const col = row % 2 === 0 ? i % perRow : perRow - 1 - (i % perRow);
        positions[id] = { x: 60 + col * step, y: 60 + row * step };
      });
      for (let i = 0; i + 1 < n; i++) link(i, i + 1);
      break;
    }
    case 'grid': {
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      width = cols * step + 80;
      height = rows * step + 80;
      ids.forEach((id, i) => {
        positions[id] = { x: 60 + (i % cols) * step, y: 60 + Math.floor(i / cols) * step };
      });
      for (let i = 0; i < n; i++) {
        if ((i + 1) % cols !== 0 && i + 1 < n) link(i, i + 1);
        if (i + cols < n) link(i, i + cols);
      }
      break;
    }
    case 'figure8': {
      // Two loops sharing the start space.
      const half = Math.ceil((n - 1) / 2);
      const r = Math.max(140, ((half + 1) * step) / (2 * Math.PI));
      width = Math.ceil(4 * r + 200);
      height = Math.ceil(2 * r + 160);
      const cx = width / 2;
      const cy = height / 2;
      positions[ids[0] as string] = { x: Math.round(cx), y: Math.round(cy) };
      const loops = [ids.slice(1, 1 + half), ids.slice(1 + half)];
      loops.forEach((loop, side) => {
        const center = side === 0 ? cx - r : cx + r;
        const m = loop.length + 1;
        loop.forEach((id, j) => {
          const a = side === 0 ? ((j + 1) / m) * 2 * Math.PI : Math.PI - ((j + 1) / m) * 2 * Math.PI;
          positions[id] = { x: Math.round(center + r * Math.cos(a)), y: Math.round(cy + r * Math.sin(a)) };
        });
        const indices = [0, ...loop.map((id) => ids.indexOf(id)), 0];
        for (let j = 0; j + 1 < indices.length; j++) if (indices[j] !== indices[j + 1] && loop.length > 0) link(indices[j] as number, indices[j + 1] as number);
      });
      break;
    }
    case 'spokes': {
      // A hub with spokes, and the spoke ends joined in an outer ring.
      const arms = Math.max(3, Math.min(8, Math.round(Math.sqrt(n - 1))));
      const perArm = Math.max(1, Math.floor((n - 1) / arms));
      width = Math.ceil(2 * (perArm * step + 60) + 120);
      height = width;
      const cx = width / 2;
      const cy = height / 2;
      positions[ids[0] as string] = { x: Math.round(cx), y: Math.round(cy) };
      let k = 1;
      const ends: number[] = [];
      for (let a = 0; a < arms && k < n; a++) {
        const angle = (a / arms) * 2 * Math.PI - Math.PI / 2;
        let prev = 0;
        const len = a === arms - 1 ? n - k : perArm;
        for (let j = 0; j < len && k < n; j++, k++) {
          const dist = (j + 1) * step;
          positions[ids[k] as string] = { x: Math.round(cx + dist * Math.cos(angle)), y: Math.round(cy + dist * Math.sin(angle)) };
          link(prev, k);
          prev = k;
        }
        ends.push(prev);
      }
      for (let a = 0; a < ends.length; a++) {
        const x = ends[a] as number;
        const y = ends[(a + 1) % ends.length] as number;
        if (x !== 0 && y !== 0 && x !== y) link(x, y);
      }
      break;
    }
  }
  return { spaces, connections, layout: { width, height, positions } };
}

const PERSONAS = [
  { name: 'Ada', color: '#c0392b', icon: '🦊', voice: 'Quick-witted and a little smug.', traits: { risk: 7, aggression: 5, greed: 6, loyalty: 4, vindictiveness: 5, sociability: 6 } },
  { name: 'Bram', color: '#2471a3', icon: '🐻', voice: 'Slow, steady and stubborn.', traits: { risk: 3, aggression: 6, greed: 4, loyalty: 7, vindictiveness: 6, sociability: 4 } },
  { name: 'Cleo', color: '#229954', icon: '🦉', voice: 'Calm, precise and curious.', traits: { risk: 4, aggression: 3, greed: 7, loyalty: 6, vindictiveness: 3, sociability: 7 } },
  { name: 'Dax', color: '#b7950b', icon: '🐺', voice: 'Loud, bold and always hungry for a fight.', traits: { risk: 8, aggression: 8, greed: 5, loyalty: 3, vindictiveness: 7, sociability: 5 } },
];

export function newCastMember(index: number, taken: Iterable<string>): Json {
  const p = PERSONAS[index % PERSONAS.length] as (typeof PERSONAS)[number];
  const name = index < PERSONAS.length ? p.name : `${p.name} ${Math.floor(index / PERSONAS.length) + 1}`;
  return { id: uniqueId('cast', name, taken), name, icon: p.icon, color: p.color, persona: { voice: p.voice, traits: { ...p.traits }, behaviors: [] } };
}

/** A small, playable scenario: a 30-space ring with coins, hazards, a shop and one monster. */
export function blankScenario(id = 'my-scenario', name = 'My Scenario'): GameDefinitionInput {
  const board = generateBoard('ring', 30, { pattern: ['', 'tag.coin', '', 'tag.hazard', '', 'tag.coin'] });
  const start = board.spaces[0];
  if (start) start.tags = [];
  const lair = board.spaces[15];
  if (lair) {
    lair.name = 'Lair';
    lair.tags = ['tag.lair'];
  }
  const cast: Json[] = [];
  for (let i = 0; i < 3; i++) cast.push(newCastMember(i, cast.map((c) => c['id'] as string)));
  return {
    id,
    name,
    description: '',
    rulesLanguageVersion: 3,
    settings: {
      core: { hp: 'res.hp', maxHp: 'res.max_hp', power: 'res.power', gold: 'res.gold' },
      startSpace: board.spaces[0]?.id ?? 'space.1',
      movement: { die: 6 },
      inventoryCapacity: 3,
      rest: { heal: 30 },
      combat: { damage: { base: 25, ratioExponent: 1, min: 5, max: 60 }, maxSpinsPerFight: 8, pvp: true },
      ko: { goldLossPercent: 50, skipTurns: 1 },
      victory: { resource: 'res.stars', threshold: 5, roundLimit: 20, ranking: ['res.stars', 'res.gold'] },
    },
    resources: [
      { id: 'res.hp', name: 'HP', icon: '❤️', role: 'pool', appliesTo: ['contestant', 'enemy'], default: 100, min: 0, max: null, maxFrom: 'res.max_hp' },
      { id: 'res.max_hp', name: 'Max HP', role: 'stat', appliesTo: ['contestant', 'enemy'], default: 100, min: 1, max: 10000 },
      { id: 'res.power', name: 'Power', icon: '💪', role: 'stat', appliesTo: ['contestant', 'enemy'], default: 100, min: 1, max: 100000 },
      { id: 'res.gold', name: 'Gold', icon: '🪙', role: 'pool', appliesTo: ['contestant'], default: 10, min: 0, max: 999, tradeable: true },
      { id: 'res.stars', name: 'Stars', icon: '⭐', role: 'pool', appliesTo: ['contestant'], default: 0, min: 0, max: 99 },
    ],
    tags: [
      { id: 'tag.coin', name: 'Coin', appliesTo: 'space', color: '#5dade2' },
      { id: 'tag.hazard', name: 'Hazard', appliesTo: 'space', color: '#e74c3c' },
      { id: 'tag.lair', name: 'Lair', appliesTo: 'space', color: '#6c3483' },
    ],
    spaces: board.spaces,
    connections: board.connections,
    layout: board.layout,
    items: [{ id: 'item.sword', name: 'Sword', icon: '🗡️', modifiers: [{ resource: 'res.power', add: 50 }] }],
    statuses: [],
    shops: [
      {
        id: 'shop.market',
        name: 'Market',
        entries: [
          { id: 'entry.sword', grants: { item: 'item.sword' }, price: { resource: 'res.gold', amount: 12 } },
          { id: 'entry.star', grants: { resource: 'res.stars', amount: 1 }, price: { resource: 'res.gold', amount: 20 } },
        ],
      },
    ],
    enemies: [
      {
        id: 'enemy.troll',
        name: 'Troll',
        icon: '👹',
        power: 150,
        maxHp: 80,
        regenPerRound: 5,
        respawnAfterRounds: 3,
        rewards: [
          { op: 'changeResource', target: '$actor', resource: 'res.stars', amount: 1 },
          { op: 'changeResource', target: '$actor', resource: 'res.gold', amount: 10 },
        ],
        spawns: lair ? [lair.id] : [],
      },
    ],
    fixtures: [{ id: 'fixture.market', name: 'Market', icon: '🏪', shop: 'shop.market', start: { space: board.spaces[10]?.id ?? 'space.11' } }],
    decks: [],
    actions: [],
    objectives: [],
    cast: cast as GameDefinitionInput['cast'],
    rules: [
      { id: 'rule.coin', name: 'Coin Space', trigger: { event: 'landed', where: { spaceTag: 'tag.coin' } }, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.gold', amount: 3 }] },
      { id: 'rule.hazard', name: 'Hazard Space', trigger: { event: 'landed', where: { spaceTag: 'tag.hazard' } }, effects: [{ op: 'damage', target: '$actor', amount: { op: 'roll', count: 2, sides: 6 } }] },
    ],
  };
}

/** Fresh entries for each list section (the editor fills in a unique id). */
export function newEntry(section: string, name: string, id: string, def: Json): Json {
  const firstOf = (key: string, fallback = '') => (((def[key] ?? []) as Json[])[0]?.['id'] as string | undefined) ?? fallback;
  const settings = (def['settings'] ?? {}) as { core?: { gold?: string }; startSpace?: string };
  const gold = settings.core?.gold ?? firstOf('resources');
  switch (section) {
    case 'resources':
      return { id, name, role: 'pool', appliesTo: ['contestant'], default: 0, min: 0, max: 99 };
    case 'tags':
      return { id, name, appliesTo: 'space', color: '#95a5a6' };
    case 'spaces':
      return { id, name, tags: [] };
    case 'items':
      return { id, name, icon: '🎁', modifiers: [] };
    case 'statuses':
      return { id, name, icon: '✨', duration: 3, stacking: 'refresh', maxStacks: 1 };
    case 'shops':
      return { id, name, entries: [{ id: `entry.${slug(name)}_1`, grants: { resource: gold, amount: 1 }, price: { resource: gold, amount: 5 } }] };
    case 'fixtures':
      return { id, name, icon: '🏷️', start: { space: settings.startSpace ?? firstOf('spaces') } };
    case 'enemies':
      return { id, name, icon: '👾', power: 100, maxHp: 50, regenPerRound: 0, respawnAfterRounds: 3, rewards: [{ op: 'changeResource', target: '$actor', resource: gold, amount: 5 }], spawns: [] };
    case 'decks':
      return { id, name, cards: [{ id: `card.${slug(name)}_1`, name: 'Lucky Find', count: 2, effects: [{ op: 'changeResource', target: '$actor', resource: gold, amount: 5 }] }] };
    case 'actions':
      return { id, name, icon: '⚡', effects: [{ op: 'changeResource', target: '$actor', resource: gold, amount: 1 }] };
    case 'objectives':
      return { id, name, icon: '🎯', goal: { kind: 'reach', resource: gold, atLeast: 30 }, reward: [{ op: 'changeResource', target: '$actor', resource: gold, amount: 10 }] };
    case 'rules':
      return { id, name, kind: 'reaction', trigger: { event: 'landed' }, effects: [{ op: 'changeResource', target: '$actor', resource: gold, amount: 1 }] };
    default:
      return { id, name };
  }
}

/** Id prefixes per section. */
export const ID_PREFIX: Record<string, string> = {
  resources: 'res',
  tags: 'tag',
  spaces: 'space',
  items: 'item',
  statuses: 'status',
  shops: 'shop',
  fixtures: 'fixture',
  enemies: 'enemy',
  decks: 'deck',
  actions: 'action',
  objectives: 'objective',
  cast: 'cast',
  rules: 'rule',
};
