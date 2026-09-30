import type { KeyboardEvent } from 'react';
import type { GameDefinition } from '../../schema/definition.ts';
import type { Entity, GameState } from '../../schema/state.ts';
import { activeId, entityColor, entityIcon, tagColor } from '../format.ts';
import { PieceSymbol } from './Ui.tsx';

interface Props {
  def: GameDefinition;
  state: GameState;
  effective: Record<string, Record<string, number>>;
  selectedEntity: string | null;
  selectedSpace: string | null;
  thinking: string | null;
  onSelectEntity: (id: string) => void;
  onSelectSpace: (id: string) => void;
}

const GLYPHS: Record<string, string> = {
  'tag.start': '⚑',
  'tag.coin': '◆',
  'tag.rich_coin': '◆',
  'tag.blue': '≈',
  'tag.dojo': '⚔',
  'tag.shrine': '✦',
  'tag.hazard': '!',
  'tag.den': '◈',
  'tag.lair': '♜',
  'tag.shop': '▤',
  'tag.well': '≋',
  'tag.idol': '✧',
  'tag.star_spot': '★',
};
function activate(event: KeyboardEvent<SVGGElement>, action: () => void) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    action();
  }
}

/** Flat, stable token keys let CSS interpolate movement instead of remounting pieces. */
export function Board({
  def,
  state,
  effective,
  selectedEntity,
  selectedSpace,
  thinking,
  onSelectEntity,
  onSelectSpace,
}: Props) {
  const pos = def.layout.positions;
  const active = state.round > 0 && state.phase !== 'gameOver' ? activeId(state) : null;
  const hp = def.settings.core.hp;
  const maxHp = def.settings.core.maxHp;
  const entities = Object.values(state.entities);
  const bySpace = new Map<string, Entity[]>();
  for (const e of entities) {
    if (e.spaceId === null) continue;
    const list = bySpace.get(e.spaceId) ?? [];
    list.push(e);
    bySpace.set(e.spaceId, list);
  }
  return (
    <svg
      className="board"
      viewBox={`0 0 ${def.layout.width} ${def.layout.height}`}
      role="group"
      aria-label="Game board"
    >
      <g className="connections">
        {def.connections.map((c, i) => {
          const a = pos[c.a];
          const b = pos[c.b];
          if (!a || !b) return null;
          return (
            <g key={i}>
              <line className="path-base" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
              <line className="path-dashes" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            </g>
          );
        })}
      </g>
      {def.id === 'star-chase' && (
        <g className="board-lettering" aria-hidden="true">
          <text x="500" y="245" textAnchor="middle" className="map-eyebrow">
            THE ISLAND OF OPPORTUNITY
          </text>
          <text x="500" y="292" textAnchor="middle" className="map-title">
            Star Chase
          </text>
          <path d="M440 314h45m30 0h45" />
          <text x="500" y="320" textAnchor="middle" className="map-star">
            ✦
          </text>
          <text x="500" y="518" textAnchor="middle" className="map-caption">
            FORTUNE FAVORS THE BOLD
          </text>
          <text x="500" y="543" textAnchor="middle" className="map-subtitle">
            Collect. Explore. Outwit.
          </text>
        </g>
      )}
      {def.spaces.map((s) => {
        const p = pos[s.id];
        if (!p) return null;
        const tags = s.tags.map((t) => def.tags.find((x) => x.id === t)?.name ?? t).join(', ');
        const color = tagColor(def, s.tags);
        return (
          <g
            key={s.id}
            className={`space${selectedSpace === s.id ? ' selected' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={`Space: ${s.name}${tags ? `, ${tags}` : ''}`}
            aria-pressed={selectedSpace === s.id}
            onKeyDown={(e) => activate(e, () => onSelectSpace(s.id))}
            onClick={() => onSelectSpace(s.id)}
          >
            <title>{`${s.name}${tags ? ` (${tags})` : ''}${s.description ? `\n${s.description}` : ''}`}</title>
            <circle className="space-shadow" cx={p.x} cy={p.y + 4} r={28} />
            <circle className="space-halo" cx={p.x} cy={p.y} r={34} fill={color} />
            <circle className="space-face" cx={p.x} cy={p.y} r={26} fill="var(--space-bg)" stroke={color} />
            <circle className="space-tint" cx={p.x} cy={p.y} r={22} fill={color} opacity=".16" />
            <text className="space-glyph" x={p.x} y={p.y + 7} textAnchor="middle" fill={color} aria-hidden="true">
              {s.tags.map((t) => GLYPHS[t]).find(Boolean) ?? '•'}
            </text>
            <text className="space-label" x={p.x} y={p.y + 48} textAnchor="middle" aria-hidden="true">
              {s.name}
            </text>
          </g>
        );
      })}
      {entities.map((e) => {
        if (!e.spaceId) return null;
        const p = pos[e.spaceId];
        if (!p) return null;
        const list = bySpace.get(e.spaceId) ?? [];
        const i = list.findIndex((entity) => entity.id === e.id);
        const angle = (i / Math.max(1, list.length)) * Math.PI * 2 - Math.PI / 2;
        const spread = list.length > 1 ? 21 : 0;
        const x = p.x + Math.cos(angle) * spread;
        const y = p.y + Math.sin(angle) * spread;
        const defeated = e.status === 'defeated';
        const vals = effective[e.id] ?? {};
        const hpFrac =
          e.kind !== 'fixture' && vals[maxHp] ? Math.max(0, Math.min(1, (vals[hp] ?? 0) / (vals[maxHp] ?? 1))) : null;
        const color = entityColor(def, e);
        const classes = [
          'token',
          e.kind,
          e.id === selectedEntity ? 'selected' : '',
          e.id === active ? 'active' : '',
          e.id === thinking ? 'thinking' : '',
          defeated ? 'defeated' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <g
            key={e.id}
            className={classes}
            style={{ transform: `translate(${x}px, ${y}px)` }}
            role="button"
            tabIndex={0}
            aria-label={`Inspect ${e.name}${defeated ? ', defeated' : ''}`}
            aria-pressed={selectedEntity === e.id}
            onKeyDown={(ev) => activate(ev, () => onSelectEntity(e.id))}
            onClick={(ev) => {
              ev.stopPropagation();
              onSelectEntity(e.id);
            }}
          >
            <title>{`${e.name}${defeated ? ' (defeated)' : ''}${e.tags.length ? `\nTags: ${e.tags.join(', ')}` : ''}`}</title>
            <circle className="token-shadow" cy={4} r={18} />
            <circle className="token-ring" r={23} fill="none" stroke={color} />
            <circle
              className="token-face"
              r={17}
              fill={e.kind === 'contestant' ? color : 'var(--token-bg)'}
              stroke={e.kind === 'contestant' ? '#fff4df' : color}
            />
            <foreignObject x={-12} y={-12} width={24} height={24} className="token-symbol">
              <div className="token-symbol-inner">
                <PieceSymbol icon={entityIcon(def, e)} size={24} />
              </div>
            </foreignObject>
            {e.tags.includes('tag.fish') && (
              <text className="token-badge" x={12} y={-12} aria-hidden="true">
                🐟
              </text>
            )}
            {hpFrac !== null && !defeated && (
              <g className="hpbar" transform="translate(-16 22)" aria-hidden="true">
                <rect width={32} height={4} rx={2} className="hp-bg" />
                <rect width={32 * hpFrac} height={4} rx={2} className="hp-fg" />
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
