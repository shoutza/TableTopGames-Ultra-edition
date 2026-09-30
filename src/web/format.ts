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

/** A transformation status changes how the token looks (e.g. 🐟 while in Fish Form). */
export function transformationOf(def: GameDefinition, e: Entity): { name: string; icon: string } | null {
  for (const s of e.statuses) {
    const d = def.statuses.find((x) => x.id === s.defId);
    if (d?.transformation) return { name: d.name, icon: d.icon ?? '✨' };
  }
  return null;
}

export function statusLabel(def: GameDefinition, s: Entity['statuses'][number]): string {
  const d = def.statuses.find((x) => x.id === s.defId);
  return `${d?.icon ?? '•'} ${d?.name ?? s.defId}${s.stacks > 1 ? ` ×${s.stacks}` : ''}${s.remaining !== null ? ` (${s.remaining})` : ''}`;
}

export function entityIcon(def: GameDefinition, e: Entity): string {
  const t = transformationOf(def, e);
  if (t) return t.icon;
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
