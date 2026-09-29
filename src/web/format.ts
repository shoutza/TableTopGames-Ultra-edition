import type { GameDefinition } from '../schema/definition.ts';
import type { Entity, GameState } from '../schema/state.ts';

/** Small display helpers derived from the definition (the web app never runs engine code). */

export function tagColor(def: GameDefinition, spaceTags: string[]): string {
  for (const t of spaceTags) {
    const color = def.tags.find((x) => x.id === t)?.color;
    if (color) return color;
  }
  return '#bdc3c7';
}

export function resourceName(def: GameDefinition, id: string): string {
  return def.resources.find((r) => r.id === id)?.name ?? id;
}

export function spaceName(def: GameDefinition, id: string | null): string {
  if (id === null) return '—';
  return def.spaces.find((s) => s.id === id)?.name ?? id;
}

export function entityIcon(def: GameDefinition, e: Entity): string {
  if (e.kind === 'contestant') return def.cast.find((c) => c.id === e.defId)?.icon ?? e.name.slice(0, 1);
  if (e.kind === 'enemy') return def.enemies.find((x) => x.id === e.defId)?.icon ?? '👾';
  return def.fixtures.find((x) => x.id === e.defId)?.icon ?? '🏷️';
}

export function entityColor(def: GameDefinition, e: Entity): string {
  if (e.kind === 'contestant') return def.cast.find((c) => c.id === e.defId)?.color ?? '#555';
  if (e.kind === 'enemy') return '#8e1b1b';
  return '#7d6608';
}

export function activeId(state: GameState): string | null {
  return state.turnOrder[state.turn.index] ?? null;
}

export function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

export function formatUsd(v: number | null): string {
  if (v === null) return 'n/a';
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}
