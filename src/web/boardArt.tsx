import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { Layout } from '../schema/definition.ts';
import { roadPath, THEMES, type Theme } from './boardThemes.ts';

export { autoDecorate, layoutOf, roadPath, THEMES, type Theme } from './boardThemes.ts';

/**
 * Board drawing shared by the match view and the board editor: themed backgrounds, roads between
 * spaces, space shapes with tag icons, and scenery. Everything here is cosmetic (layout data).
 */

/** SVG definitions: theme backgrounds, the space shine and shadow, the one-way arrow. */
export function BoardDefs({ theme, id }: { theme: Theme; id: string }) {
  return (
    <defs>
      <radialGradient id={`${id}-shine`} cx="35%" cy="30%" r="75%">
        <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
        <stop offset="55%" stopColor="#ffffff" stopOpacity="0.08" />
        <stop offset="100%" stopColor="#000000" stopOpacity="0.12" />
      </radialGradient>
      <filter id={`${id}-shadow`} x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="2" stdDeviation="2" floodOpacity="0.35" />
      </filter>
      <marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill={THEMES[theme].roadEdge} />
      </marker>
      {theme === 'island' && (
        <>
          <radialGradient id={`${id}-bg`} cx="50%" cy="45%" r="75%">
            <stop offset="0%" stopColor="#7fd3f0" />
            <stop offset="60%" stopColor="#3a9fd0" />
            <stop offset="100%" stopColor="#1f5f8b" />
          </radialGradient>
          <pattern id={`${id}-tex`} width="60" height="30" patternUnits="userSpaceOnUse">
            <path d="M0 20 q7.5 -8 15 0 t15 0 t15 0 t15 0" fill="none" stroke="#ffffff" strokeOpacity="0.18" strokeWidth="2" />
          </pattern>
        </>
      )}
      {theme === 'forest' && (
        <>
          <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3f7d3a" />
            <stop offset="100%" stopColor="#23502a" />
          </linearGradient>
          <pattern id={`${id}-tex`} width="40" height="40" patternUnits="userSpaceOnUse">
            <circle cx="8" cy="10" r="2" fill="#ffffff" fillOpacity="0.07" />
            <circle cx="28" cy="30" r="3" fill="#000000" fillOpacity="0.08" />
          </pattern>
        </>
      )}
      {theme === 'desert' && (
        <>
          <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f6d58e" />
            <stop offset="100%" stopColor="#e0a85a" />
          </linearGradient>
          <pattern id={`${id}-tex`} width="120" height="40" patternUnits="userSpaceOnUse">
            <path d="M0 30 q30 -18 60 0 t60 0" fill="none" stroke="#b9772e" strokeOpacity="0.25" strokeWidth="2" />
          </pattern>
        </>
      )}
      {theme === 'snow' && (
        <>
          <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#dcecf8" />
            <stop offset="100%" stopColor="#a9c8e2" />
          </linearGradient>
          <pattern id={`${id}-tex`} width="36" height="36" patternUnits="userSpaceOnUse">
            <circle cx="6" cy="8" r="1.6" fill="#ffffff" fillOpacity="0.9" />
            <circle cx="24" cy="26" r="1.2" fill="#ffffff" fillOpacity="0.8" />
          </pattern>
        </>
      )}
      {theme === 'space' && (
        <>
          <radialGradient id={`${id}-bg`} cx="50%" cy="50%" r="80%">
            <stop offset="0%" stopColor="#27205c" />
            <stop offset="100%" stopColor="#070a1f" />
          </radialGradient>
          <pattern id={`${id}-tex`} width="90" height="90" patternUnits="userSpaceOnUse">
            <circle cx="10" cy="14" r="1.2" fill="#ffffff" />
            <circle cx="55" cy="40" r="0.9" fill="#ffffff" fillOpacity="0.8" />
            <circle cx="72" cy="78" r="1.4" fill="#cfd6ff" />
            <circle cx="30" cy="66" r="0.7" fill="#ffffff" fillOpacity="0.6" />
          </pattern>
        </>
      )}
      {theme === 'dungeon' && (
        <>
          <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34363d" />
            <stop offset="100%" stopColor="#1d1e23" />
          </linearGradient>
          <pattern id={`${id}-tex`} width="60" height="30" patternUnits="userSpaceOnUse">
            <path d="M0 0 H60 M0 15 H60 M20 0 V15 M50 15 V30" fill="none" stroke="#000000" strokeOpacity="0.3" strokeWidth="1.5" />
          </pattern>
        </>
      )}
      {theme === 'candy' && (
        <>
          <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffd1e8" />
            <stop offset="100%" stopColor="#c9e7ff" />
          </linearGradient>
          <pattern id={`${id}-tex`} width="40" height="40" patternUnits="userSpaceOnUse">
            <circle cx="10" cy="10" r="4" fill="#ffffff" fillOpacity="0.45" />
            <circle cx="30" cy="30" r="3" fill="#ff8fc6" fillOpacity="0.25" />
          </pattern>
        </>
      )}
    </defs>
  );
}

/** The themed background (and the land under roads and spaces, for themes that have it). */
export function BoardBackground({ layout, id, connections, spaces }: { layout: Layout; id: string; connections: Array<{ a: string; b: string }>; spaces: string[] }) {
  const look = THEMES[layout.theme];
  const pos = layout.positions;
  // Land follows the roads (curved when they are) and widens around every space.
  const land = (color: string, extra: number) => (
    <g fill={color} stroke={color}>
      {connections.map((c, i) => {
        const a = pos[c.a];
        const b = pos[c.b];
        return a && b ? <path key={i} d={roadPath(a, b, layout.curved, i)} fill="none" strokeWidth={54 + extra * 2} strokeLinecap="round" /> : null;
      })}
      {spaces.map((s) => {
        const p = pos[s];
        return p ? <circle key={s} cx={p.x} cy={p.y} r={40 + extra} stroke="none" /> : null;
      })}
    </g>
  );
  return (
    <g className="board-background" pointerEvents="none">
      {layout.theme === 'plain' ? (
        <rect x={0} y={0} width={layout.width} height={layout.height} fill="transparent" />
      ) : (
        <>
          <rect x={0} y={0} width={layout.width} height={layout.height} fill={`url(#${id}-bg)`} />
          <rect x={0} y={0} width={layout.width} height={layout.height} fill={`url(#${id}-tex)`} />
        </>
      )}
      {look.land && (
        <>
          {look.shore && land(look.shore, 16)}
          {land(look.land, 0)}
        </>
      )}
    </g>
  );
}

/** Shortens a straight or curved path at the end so a one-way arrow stops at the space's edge. */
function trimEnd(a: { x: number; y: number }, b: { x: number; y: number }, r: number): { x: number; y: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: b.x - (dx / len) * r, y: b.y - (dy / len) * r };
}

export function Road({ a, b, directed, layout, id, seed, className }: { a: { x: number; y: number }; b: { x: number; y: number }; directed: boolean; layout: Layout; id: string; seed: number; className?: string }) {
  const look = THEMES[layout.theme];
  const end = directed ? trimEnd(a, b, 26) : b;
  const d = roadPath(a, end, layout.curved, seed);
  const marker = directed ? `url(#${id}-arrow)` : undefined;
  if (layout.roads === 'road') {
    return (
      <g className={className} pointerEvents="none">
        <path d={d} fill="none" stroke={look.roadEdge} strokeWidth={15} strokeLinecap="round" />
        <path d={d} fill="none" stroke={look.road} strokeWidth={10} strokeLinecap="round" markerEnd={marker} />
        <path d={d} fill="none" stroke={look.roadEdge} strokeOpacity={0.55} strokeWidth={1.4} strokeDasharray="7 8" />
      </g>
    );
  }
  if (layout.roads === 'trail') {
    return (
      <g className={className} pointerEvents="none">
        <path d={d} fill="none" stroke={look.roadEdge} strokeWidth={5} strokeLinecap="round" strokeDasharray="0.1 11" markerEnd={marker} />
      </g>
    );
  }
  return (
    <g className={className} pointerEvents="none">
      <path d={d} fill="none" stroke={layout.theme === 'plain' ? 'var(--board-line)' : look.roadEdge} strokeWidth={3} markerEnd={marker} />
    </g>
  );
}

/** A space's shape (circle, rounded tile or hexagon) with its colour, shine, icon and name. */
export function SpaceShape({ x, y, r, color, icon, name, layout, id, children, showName = true }: { x: number; y: number; r: number; color: string; icon: string | undefined; name: string; layout: Layout; id: string; children?: ReactNode; showName?: boolean }) {
  const look = THEMES[layout.theme];
  const shape = (fill: string, extra: Record<string, unknown> = {}) => {
    if (layout.spaceStyle === 'tile') return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={r * 0.35} fill={fill} {...extra} />;
    if (layout.spaceStyle === 'hex') {
      const pts = Array.from({ length: 6 }, (_, k) => {
        const ang = (Math.PI / 3) * k + Math.PI / 6;
        return `${x + r * 1.08 * Math.cos(ang)},${y + r * 1.08 * Math.sin(ang)}`;
      }).join(' ');
      return <polygon points={pts} fill={fill} {...extra} />;
    }
    return <circle cx={x} cy={y} r={r} fill={fill} {...extra} />;
  };
  return (
    <>
      <g filter={`url(#${id}-shadow)`}>{shape(color, { className: 'space-body' })}</g>
      {shape(`url(#${id}-shine)`, { pointerEvents: 'none' })}
      {icon && (
        <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={r * 0.95} pointerEvents="none">
          {icon}
        </text>
      )}
      {children}
      {showName && (
        <text className="space-name" x={x} y={y + r + 13} textAnchor="middle" fill={look.ink} stroke={look.halo} pointerEvents="none">
          {name}
        </text>
      )}
    </>
  );
}

/** Scenery (emoji) placed on the board. */
export function Decor({ items, onPick, selected = null }: { items: Layout['decor']; onPick?: ((index: number, ev: ReactPointerEvent) => void) | undefined; selected?: number | null }) {
  return (
    <g className="decor">
      {items.map((d, i) => (
        <text
          key={i}
          x={d.x}
          y={d.y}
          fontSize={d.size}
          textAnchor="middle"
          dominantBaseline="central"
          pointerEvents={onPick ? 'auto' : 'none'}
          onPointerDown={onPick ? (ev) => onPick(i, ev) : undefined}
          className={`decor-item${onPick ? ' editable' : ''}${selected === i ? ' selected' : ''}`}
        >
          {d.icon}
        </text>
      ))}
    </g>
  );
}

/** Icon of a space: its own, else the first icon among its tags. */
export function spaceIcon(space: { icon?: string | undefined; tags: string[] }, tags: Array<{ id: string; icon?: string | undefined }>): string | undefined {
  if (space.icon) return space.icon;
  for (const t of space.tags) {
    const icon = tags.find((x) => x.id === t)?.icon;
    if (icon) return icon;
  }
  return undefined;
}
