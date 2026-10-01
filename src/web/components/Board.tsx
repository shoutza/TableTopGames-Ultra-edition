import type { GameDefinition } from '../../schema/definition.ts';
import type { Entity, GameState } from '../../schema/state.ts';
import { BoardBackground, BoardDefs, Decor, Road, SpaceShape, spaceIcon, THEMES } from '../boardArt.tsx';
import { activeId, entityColor, entityIcon, statusLabel, tagColor, transformationOf } from '../format.ts';

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
const ID = 'mb';

/**
 * SVG board: connectivity comes from the definition, positions and the look (theme, roads, space
 * shapes, scenery) from the separate layout. Tokens glide between spaces; the active one pulses.
 */
export function Board({ def, state, effective, selectedEntity, selectedSpace, thinking, onSelectEntity, onSelectSpace }: Props) {
  const pos = def.layout.positions;
  const active = activeId(state);
  const hp = def.settings.core.hp;
  const maxHp = def.settings.core.maxHp;
  const bySpace = new Map<string, Entity[]>();
  for (const e of Object.values(state.entities)) {
    if (e.spaceId === null || e.status === 'removed' || e.status === 'eliminated') continue;
    const list = bySpace.get(e.spaceId) ?? [];
    list.push(e);
    bySpace.set(e.spaceId, list);
  }
  const layout = def.layout;
  const edge = THEMES[layout.theme].edge;
  return (
    <svg className="board" viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="Game board" style={edge ? { background: edge } : undefined}>
      <BoardDefs theme={layout.theme} id={ID} />
      <BoardBackground layout={layout} id={ID} connections={def.connections} spaces={def.spaces.map((s) => s.id)} />
      <g className="connections">
        {def.connections.map((c, i) => {
          const a = pos[c.a];
          const b = pos[c.b];
          if (!a || !b) return null;
          return <Road key={i} a={a} b={b} directed={c.directed === true} layout={layout} id={ID} seed={i} />;
        })}
      </g>
      <Decor items={layout.decor} />
      {def.spaces.map((s) => {
        const p = pos[s.id];
        if (!p) return null;
        const tags = s.tags.map((t) => def.tags.find((x) => x.id === t)?.name ?? t).join(', ');
        return (
          <g key={s.id} className={`space${selectedSpace === s.id ? ' selected' : ''}`} onClick={() => onSelectSpace(s.id)}>
            <title>{`${s.name}${tags ? ` (${tags})` : ''}${s.description ? `\n${s.description}` : ''}`}</title>
            <SpaceShape x={p.x} y={p.y} r={R} color={tagColor(def, s.tags)} icon={spaceIcon(s, def.tags)} name={s.name} layout={layout} id={ID} />
          </g>
        );
      })}
      <g className="tokens">{tokens()}</g>
    </svg>
  );

  /** One flat, id-ordered list, so a token keeps its element when it moves and its move animates. */
  function tokens() {
    const out: Array<{ e: Entity; x: number; y: number }> = [];
    for (const [spaceId, list] of bySpace) {
      const p = pos[spaceId];
      if (!p) continue;
      list.forEach((e, i) => {
        const angle = (i / Math.max(1, list.length)) * Math.PI * 2 - Math.PI / 2;
        const spread = list.length > 1 ? 17 : 0;
        out.push({
          e,
          x: p.x + Math.cos(angle) * spread,
          y: p.y + Math.sin(angle) * spread,
        });
      });
    }
    out.sort((a, b) => (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0));
    return out.map(({ e, x, y }) => {
      const defeated = e.status === 'defeated';
      const boss = e.kind === 'enemy' && def.enemies.find((x) => x.id === e.defId)?.boss === true;
      // Badges for up to three non-transformation statuses.
      const badges = e.statuses
        .map((st) => def.statuses.find((x) => x.id === st.defId))
        .filter((d) => d !== undefined && !d.transformation)
        .slice(0, 3)
        .map((d) => d?.icon ?? '•');
      const vals = effective[e.id] ?? {};
      const hpFrac = e.kind !== 'fixture' && vals[maxHp] ? Math.max(0, Math.min(1, (vals[hp] ?? 0) / (vals[maxHp] ?? 1))) : null;
      const classes = ['token', e.kind, e.id === selectedEntity ? 'selected' : '', e.id === active ? 'active' : '', e.id === thinking ? 'thinking' : '', defeated ? 'defeated' : '']
        .filter(Boolean)
        .join(' ');
      return (
        <g
          key={e.id}
          className={classes}
          style={{ transform: `translate(${x}px, ${y}px)` }}
          onClick={(ev) => {
            ev.stopPropagation();
            onSelectEntity(e.id);
          }}
        >
          <title>{`${e.name}${defeated ? ' (defeated)' : ''}${transformationOf(def, e) ? ` — ${transformationOf(def, e)?.name}` : ''}${e.statuses.length ? `\n${e.statuses.map((st) => statusLabel(def, st)).join(', ')}` : ''}${e.tags.length ? `\nTags: ${e.tags.join(', ')}` : ''}`}</title>
          {e.id === active && <circle className="active-ring" r={boss ? 20 : 17} />}
          <circle className="token-body" r={boss ? 16 : 13} fill={e.kind === 'contestant' ? entityColor(def, e) : 'var(--token-bg)'} stroke={entityColor(def, e)} />
          <text className="token-icon" textAnchor="middle" dy="0.35em">
            {entityIcon(def, e)}
          </text>
          {boss && (
            <text className="token-badge" x={-6} y={-15}>
              👑
            </text>
          )}
          {badges.map((icon, bi) => (
            <text key={bi} className="token-badge" x={10} y={-9 + bi * 9}>
              {icon}
            </text>
          ))}
          {hpFrac !== null && !defeated && (
            <g className="hpbar" transform="translate(-13 16)">
              <rect width={26} height={4} className="hp-bg" />
              <rect width={26 * hpFrac} height={4} className="hp-fg" />
            </g>
          )}
        </g>
      );
    });
  }
}
