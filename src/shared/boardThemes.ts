import { BOARD_THEMES, type Layout } from '../schema/definition.ts';

/**
 * Board themes (colours and scenery sets), filling in a layout's look, and scattering scenery.
 * Plain TypeScript (no JSX), so scripts can use it too.
 */

export type Theme = Layout['theme'];

interface ThemeLook {
  label: string;
  /** Road colours (edge and surface) and label ink. */
  road: string;
  roadEdge: string;
  ink: string;
  halo: string;
  /** Land drawn under roads and spaces (islands in the sea, clearings in the forest …), with its shore. */
  land: string | null;
  shore: string | null;
  /** Colour around the board when it does not fill its frame. */
  edge: string | null;
  /** Scenery offered in the editor and scattered by "decorate"… */
  decor: string[];
  /** …and, for themes with land, what "decorate" puts on the land's edge and further out. */
  near?: string[];
  far?: string[];
}

export const THEMES: Record<Theme, ThemeLook> = {
  plain: { label: 'Plain', road: '#b3b8bf', roadEdge: '#7b8189', ink: 'var(--text)', halo: 'var(--panel)', land: null, shore: null, edge: null, decor: ['🌳', '🪨', '🌸', '🏠', '⛲', '🚩'] },
  island: { label: 'Tropical island', road: '#f7e7bf', roadEdge: '#c9a66b', ink: '#0e2f44', halo: '#f4fbff', land: '#f0d595', shore: '#9ee2f4', edge: '#1f5f8b', decor: ['🌴', '🌊', '🐚', '🪨', '🦀', '⛵', '🐠', '🌺', '🏝️', '🐬', '🐙'], near: ['🌴', '🌴', '🌺', '🐚', '🦀', '🪨'], far: ['🌊', '🌊', '⛵', '🐠', '🐬', '🏝️', '🐙'] },
  forest: { label: 'Enchanted forest', road: '#d9b98a', roadEdge: '#7a5a34', ink: '#13301a', halo: '#eef7e6', land: '#8cc26b', shore: '#5f9a49', edge: '#23502a', decor: ['🌲', '🌳', '🍄', '🪨', '🌿', '🦌', '🌼', '🪵', '🦉', '🏡'], near: ['🍄', '🌼', '🌿', '🪵', '🦌', '🌳'], far: ['🌲', '🌲', '🌳', '🌲', '🦉'] },
  desert: { label: 'Desert', road: '#fff1cf', roadEdge: '#c79a52', ink: '#4a2e0c', halo: '#fff8e6', land: null, shore: null, edge: '#e0a85a', decor: ['🌵', '🐪', '🪨', '🦂', '☀️', '🌴', '🏺', '🦎'] },
  snow: { label: 'Snowy peaks', road: '#ffffff', roadEdge: '#9fb8cf', ink: '#1d3550', halo: '#ffffff', land: '#eef5fb', shore: null, edge: '#a9c8e2', decor: ['🌲', '⛄', '❄️', '🏔️', '🐧', '🧊', '🦌', '🛷'], near: ['⛄', '🛷', '🐧', '🦌', '🌲'], far: ['🏔️', '🌲', '❄️', '🏔️', '🧊'] },
  space: { label: 'Outer space', road: '#7f8cff', roadEdge: '#2b2f6b', ink: '#e8ecff', halo: '#0b0f2a', land: null, shore: null, edge: '#070a1f', decor: ['⭐', '🌙', '🪐', '☄️', '🛸', '✨', '🚀', '🌟'] },
  dungeon: { label: 'Dungeon', road: '#8a8f98', roadEdge: '#3d4047', ink: '#f0e6d2', halo: '#23252b', land: '#4a4d55', shore: '#2a2c32', edge: '#1d1e23', decor: ['🕯️', '💀', '🦴', '🪨', '🕸️', '⛓️', '🗝️', '🐀', '🪦'], near: ['🕯️', '💀', '🦴', '🗝️', '🐀'], far: ['🪨', '🕸️', '⛓️', '🪦', '🪨'] },
  candy: { label: 'Candy land', road: '#ffffff', roadEdge: '#f28dbb', ink: '#5a1e3c', halo: '#fff0f7', land: '#ffd6ea', shore: '#ffffff', edge: '#e6ddf5', decor: ['🍭', '🍬', '🧁', '🍩', '🍫', '🍓', '🌈', '🍦'] },
};

type Point = { x: number; y: number };

/** Control point of a gently curved connection (the bend side depends on the pair, so rings look organic). */
export function bendPoint(a: Point, b: Point, seed: number): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const bend = (seed % 2 === 0 ? 1 : -1) * Math.min(40, len * 0.14);
  return { x: (a.x + b.x) / 2 - (dy / len) * bend, y: (a.y + b.y) / 2 + (dx / len) * bend };
}

/** SVG path of a connection: straight, or gently curved. */
export function roadPath(a: Point, b: Point, curved: boolean, seed: number): string {
  if (!curved) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  const c = bendPoint(a, b, seed);
  return `M ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`;
}

/** Points along a connection as drawn (the curve sampled), for keeping scenery off it. */
function roadPoints(a: Point, b: Point, curved: boolean, seed: number): Point[] {
  if (!curved) return [a, b];
  const c = bendPoint(a, b, seed);
  return Array.from({ length: 9 }, (_, k) => {
    const t = k / 8;
    const u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
  });
}

function distSeg(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Scatters scenery over empty parts of the board (away from spaces and roads), deterministically.
 * Themes with land put land pieces near the roads and water or wilderness pieces further out.
 */
export function autoDecorate(layout: Layout, connections: Array<{ a: string; b: string }>, density = 1): Layout['decor'] {
  const look = THEMES[layout.theme];
  const pos = Object.values(layout.positions);
  const lines = connections.flatMap((c, i) => {
    const a = layout.positions[c.a];
    const b = layout.positions[c.b];
    return a && b ? [roadPoints(a, b, layout.curved, i)] : [];
  });
  const roadDist = (p: Point) => {
    let best = Infinity;
    for (const pts of lines) for (let k = 1; k < pts.length; k++) best = Math.min(best, distSeg(p, pts[k - 1] as Point, pts[k] as Point));
    return best;
  };
  let seed = 1234567;
  const rand = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
  const pick = (pool: string[]) => pool[Math.floor(rand() * pool.length)] as string;
  const out: Layout['decor'] = [];
  const step = Math.max(50, 90 / Math.sqrt(density));
  for (let y = step / 2; y < layout.height; y += step) {
    for (let x = step / 2; x < layout.width; x += step) {
      const p = { x: x + (rand() - 0.5) * step * 0.7, y: y + (rand() - 0.5) * step * 0.7 };
      if (rand() > 0.55) continue;
      if (p.x < 14 || p.y < 14 || p.x > layout.width - 14 || p.y > layout.height - 14) continue;
      const spaceDist = Math.min(Infinity, ...pos.map((s) => Math.hypot(s.x - p.x, s.y - p.y)));
      const road = roadDist(p);
      if (spaceDist < 64 || road < 38) continue;
      const near = road < 62 || spaceDist < 90;
      const pool = look.near && look.far ? (near ? look.near : look.far) : look.decor;
      out.push({ icon: pick(pool), x: Math.round(p.x), y: Math.round(p.y), size: Math.round((near ? 22 : 26) + rand() * 16) });
      if (out.length >= 300) return out;
    }
  }
  return out;
}

/** A layout as stored in an edited (not yet validated) definition, with the look's defaults filled in. */
export function layoutOf(raw: unknown): Layout {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Layout, unknown>>;
  const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
  return {
    width: typeof r.width === 'number' ? r.width : 800,
    height: typeof r.height === 'number' ? r.height : 600,
    positions: (r.positions && typeof r.positions === 'object' ? r.positions : {}) as Layout['positions'],
    theme: pick(r.theme, BOARD_THEMES, 'plain'),
    roads: pick(r.roads, ['line', 'road', 'trail'] as const, 'line'),
    curved: r.curved === true,
    spaceStyle: pick(r.spaceStyle, ['circle', 'tile', 'hex'] as const, 'circle'),
    decor: Array.isArray(r.decor) ? (r.decor as Array<Partial<Layout['decor'][number]>>).filter((d) => typeof d?.x === 'number' && typeof d.y === 'number' && typeof d.icon === 'string').map((d) => ({ icon: d.icon as string, x: d.x as number, y: d.y as number, size: d.size ?? 30 })) : [],
  };
}
