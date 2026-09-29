import type { GameDefinition } from '../../schema/definition.ts';
import type { Entity, GameState } from '../../schema/state.ts';
import { activeId, entityColor, entityIcon, tagColor } from '../format.ts';

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

const R = 24;

/** SVG board: connectivity comes from the definition, positions from the separate layout. */
export function Board({ def, state, effective, selectedEntity, selectedSpace, thinking, onSelectEntity, onSelectSpace }: Props) {
  const pos = def.layout.positions;
  const active = activeId(state);
  const hp = def.settings.core.hp;
  const maxHp = def.settings.core.maxHp;
  const bySpace = new Map<string, Entity[]>();
  for (const e of Object.values(state.entities)) {
    if (e.spaceId === null) continue;
    const list = bySpace.get(e.spaceId) ?? [];
    list.push(e);
    bySpace.set(e.spaceId, list);
  }
  return (
    <svg className="board" viewBox={`0 0 ${def.layout.width} ${def.layout.height}`} role="img" aria-label="Game board">
      <g className="connections">
        {def.connections.map((c, i) => {
          const a = pos[c.a];
          const b = pos[c.b];
          if (!a || !b) return null;
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
        })}
      </g>
      {def.spaces.map((s) => {
        const p = pos[s.id];
        if (!p) return null;
        const tags = s.tags.map((t) => def.tags.find((x) => x.id === t)?.name ?? t).join(', ');
        return (
          <g key={s.id} className={`space${selectedSpace === s.id ? ' selected' : ''}`} onClick={() => onSelectSpace(s.id)}>
            <title>{`${s.name}${tags ? ` (${tags})` : ''}${s.description ? `\n${s.description}` : ''}`}</title>
            <circle cx={p.x} cy={p.y} r={R} fill={tagColor(def, s.tags)} />
            <text className="space-label" x={p.x} y={p.y + R + 13} textAnchor="middle">
              {s.name}
            </text>
          </g>
        );
      })}
      {[...bySpace.entries()].map(([spaceId, list]) => {
        const p = pos[spaceId];
        if (!p) return null;
        return list.map((e, i) => {
          const angle = (i / Math.max(1, list.length)) * Math.PI * 2 - Math.PI / 2;
          const spread = list.length > 1 ? 17 : 0;
          const x = p.x + Math.cos(angle) * spread;
          const y = p.y + Math.sin(angle) * spread;
          const defeated = e.status === 'defeated';
          const vals = effective[e.id] ?? {};
          const hpFrac = e.kind !== 'fixture' && vals[maxHp] ? Math.max(0, Math.min(1, (vals[hp] ?? 0) / (vals[maxHp] ?? 1))) : null;
          const classes = ['token', e.kind, e.id === selectedEntity ? 'selected' : '', e.id === active ? 'active' : '', e.id === thinking ? 'thinking' : '', defeated ? 'defeated' : '']
            .filter(Boolean)
            .join(' ');
          return (
            <g
              key={e.id}
              className={classes}
              transform={`translate(${x} ${y})`}
              onClick={(ev) => {
                ev.stopPropagation();
                onSelectEntity(e.id);
              }}
            >
              <title>{`${e.name}${defeated ? ' (defeated)' : ''}${e.tags.length ? `\nTags: ${e.tags.join(', ')}` : ''}`}</title>
              <circle r={13} fill={e.kind === 'contestant' ? entityColor(def, e) : 'var(--token-bg)'} stroke={entityColor(def, e)} />
              <text className="token-icon" textAnchor="middle" dy="0.35em">
                {entityIcon(def, e)}
              </text>
              {e.tags.includes('tag.fish') && (
                <text className="token-badge" x={10} y={-9}>
                  🐟
                </text>
              )}
              {hpFrac !== null && !defeated && (
                <g className="hpbar" transform="translate(-13 16)">
                  <rect width={26} height={4} className="hp-bg" />
                  <rect width={26 * hpFrac} height={4} className="hp-fg" />
                </g>
              )}
            </g>
          );
        });
      })}
    </svg>
  );
}
