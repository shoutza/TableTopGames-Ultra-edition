import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { generateBoard, uniqueId, type BoardShape } from '../../shared/templates.ts';
import { autoDecorate, BoardBackground, BoardDefs, Decor, layoutOf, Road, roadPath, SpaceShape, spaceIcon, THEMES, type Theme } from '../boardArt.tsx';
import { allIds, countRefs, renameId, type Json } from './model.ts';
import { Checkbox, EnumSelect, IconPicker, IntInput, IssueBadges, PLACE_ICONS, RefMulti, RefSelect, Row, TextInput, useEnv } from './fields.tsx';

/**
 * Visual board editor: add, drag, connect, tag and delete spaces on the canvas; generate whole
 * boards (ring, grid, line, figure eight, spokes); edit the selected space's details; choose the
 * board's look (theme, roads, space shapes) and place scenery. Connectivity lives in
 * `connections`, positions and the look only in `layout`.
 */

type Tool = 'select' | 'add' | 'connect' | 'paint' | 'decor' | 'delete';

interface Props {
  def: Json;
  edit: (next: Json, coalesce?: string) => void;
}

interface Space {
  id: string;
  name: string;
  icon?: string;
  tags: string[];
  description?: string;
}
interface Conn {
  a: string;
  b: string;
  directed?: boolean;
}
/** The stored layout; other keys (the look, scenery) are kept as they are by spreading it. */
interface Layout {
  width: number;
  height: number;
  positions: Record<string, { x: number; y: number }>;
  decor?: Array<{ icon: string; x: number; y: number; size?: number }>;
}

const R = 22;
/** Keeps a drag going when the pointer leaves the element (synthetic events have no pointer to capture). */
function capture(ev: ReactPointerEvent): void {
  try {
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
  } catch {
    // not a live pointer
  }
}

const TOOLS: Array<{ id: Tool; label: string; help: string }> = [
  { id: 'select', label: '↖ Select / move', help: 'Click to select, drag to move. Delete key removes the selection.' },
  { id: 'add', label: '＋ Add spaces', help: 'Click empty board to add a space. With "chain" on, each new space connects to the previous one.' },
  { id: 'connect', label: '⤳ Connect', help: 'Click one space, then another, to add (or remove) a connection.' },
  { id: 'paint', label: '🖌 Paint tag', help: 'Click spaces to add or remove the chosen tag.' },
  { id: 'decor', label: '🌴 Scenery', help: 'Click the board to place the chosen scenery; drag a piece to move it, click it to change or delete it.' },
  { id: 'delete', label: '✕ Delete', help: 'Click a space or connection to delete it.' },
];

export function BoardEditor({ def, edit }: Props) {
  const env = useEnv();
  const spaces = (def['spaces'] ?? []) as Space[];
  const connections = (def['connections'] ?? []) as Conn[];
  const layout = (def['layout'] ?? { width: 800, height: 600, positions: {} }) as Layout;
  const settings = (def['settings'] ?? {}) as Json;
  const start = settings['startSpace'] as string | undefined;
  const tags = (def['tags'] ?? []) as Array<{ id: string; name: string; color?: string; icon?: string; appliesTo: string }>;
  const look = layoutOf(layout);
  const decor = layout.decor ?? [];
  const [tool, setTool] = useState<Tool>('select');
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedConn, setSelectedConn] = useState<number | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [paintTag, setPaintTag] = useState<string | undefined>(tags.find((t) => t.appliesTo === 'space')?.id);
  const [chain, setChain] = useState(true);
  const [directed, setDirected] = useState(false);
  const [snap, setSnap] = useState(true);
  const [decorIcon, setDecorIcon] = useState<string>(THEMES[look.theme].decor[0] ?? '🌳');
  const [decorSize, setDecorSize] = useState(32);
  const [selectedDecor, setSelectedDecor] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ kind: 'space'; id: string; dx: number; dy: number } | { kind: 'decor'; index: number; dx: number; dy: number } | null>(null);

  const color = (s: Space) => {
    for (const t of s.tags) {
      const c = tags.find((x) => x.id === t)?.color;
      if (c) return c;
    }
    return '#bdc3c7';
  };

  const toBoard = (ev: { clientX: number; clientY: number }) => {
    const el = svg.current;
    if (!el) return { x: 0, y: 0 };
    const pt = el.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const p = pt.matrixTransform(el.getScreenCTM()?.inverse());
    const g = snap ? 10 : 1;
    return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
  };

  const setDecor = (next: Layout['decor'], coalesce?: string) => edit({ ...def, layout: { ...layout, decor: next } }, coalesce);
  const selectOnly = (what: { space?: string; conn?: number; decor?: number }) => {
    setSelected(what.space ?? null);
    setSelectedConn(what.conn ?? null);
    setSelectedDecor(what.decor ?? null);
  };

  const onDecorDown = (i: number, ev: ReactPointerEvent) => {
    ev.stopPropagation();
    if (env.readOnly) return;
    if (tool === 'delete') {
      setDecor(decor.filter((_, j) => j !== i));
      setSelectedDecor(null);
      return;
    }
    selectOnly({ decor: i });
    const p = toBoard(ev);
    const d = decor[i];
    if (d) drag.current = { kind: 'decor', index: i, dx: d.x - p.x, dy: d.y - p.y };
    capture(ev);
  };

  const withSpaces = (nextSpaces: Space[], nextConns: Conn[], nextLayout: Layout, extra: Json = {}) => ({ ...def, ...extra, spaces: nextSpaces, connections: nextConns, layout: nextLayout });

  const addSpace = (at: { x: number; y: number }) => {
    const name = `Space ${spaces.length + 1}`;
    const id = uniqueId('space', name, allIds(def));
    const nextConns = chain && selected && spaces.some((s) => s.id === selected) ? [...connections, { a: selected, b: id, ...(directed ? { directed: true } : {}) }] : connections;
    edit(withSpaces([...spaces, { id, name, tags: [] }], nextConns, { ...layout, positions: { ...layout.positions, [id]: at } }));
    selectOnly({ space: id });
  };

  const deleteSpace = (id: string) => {
    const refs = countRefs({ ...def, spaces: [], connections: [], layout: {} }, id);
    if (refs > 0 && !window.confirm(`${spaces.find((s) => s.id === id)?.name ?? id} is used in ${refs} other place(s) (start space, spawns, rules…). Delete it anyway?`)) return;
    const positions = { ...layout.positions };
    delete positions[id];
    edit(
      withSpaces(
        spaces.filter((s) => s.id !== id),
        connections.filter((c) => c.a !== id && c.b !== id),
        { ...layout, positions },
      ),
    );
    if (selected === id) setSelected(null);
  };

  const toggleConnection = (a: string, b: string) => {
    if (a === b) return;
    // An existing connection between the two (either way) is removed; otherwise one is added.
    const i = connections.findIndex((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a));
    if (i >= 0) edit({ ...def, connections: connections.filter((_, j) => j !== i) });
    else edit({ ...def, connections: [...connections, { a, b, ...(directed ? { directed: true } : {}) }] });
  };

  const onSpaceDown = (ev: ReactPointerEvent, s: Space) => {
    ev.stopPropagation();
    if (env.readOnly) {
      setSelected(s.id);
      return;
    }
    switch (tool) {
      case 'select':
      case 'decor': {
        selectOnly({ space: s.id });
        const p = toBoard(ev);
        const pos = layout.positions[s.id] ?? p;
        drag.current = { kind: 'space', id: s.id, dx: pos.x - p.x, dy: pos.y - p.y };
        capture(ev);
        break;
      }
      case 'add':
        setSelected(s.id);
        break;
      case 'connect':
        if (connectFrom === null) setConnectFrom(s.id);
        else {
          toggleConnection(connectFrom, s.id);
          setConnectFrom(chain ? s.id : null);
        }
        break;
      case 'paint':
        if (paintTag) edit({ ...def, spaces: spaces.map((x) => (x.id === s.id ? { ...x, tags: x.tags.includes(paintTag) ? x.tags.filter((t) => t !== paintTag) : [...x.tags, paintTag] } : x)) });
        break;
      case 'delete':
        deleteSpace(s.id);
        break;
    }
  };

  const onMove = (ev: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toBoard(ev);
    if (d.kind === 'decor') {
      const cur = decor[d.index];
      if (!cur) return;
      const x = Math.max(0, Math.min(layout.width, p.x + d.dx));
      const y = Math.max(0, Math.min(layout.height, p.y + d.dy));
      if (cur.x !== x || cur.y !== y) setDecor(decor.map((x0, j) => (j === d.index ? { ...x0, x, y } : x0)), `decor:${d.index}`);
      return;
    }
    const x = Math.max(R, Math.min(layout.width - R, p.x + d.dx));
    const y = Math.max(R, Math.min(layout.height - R, p.y + d.dy));
    const cur = layout.positions[d.id];
    if (cur && cur.x === x && cur.y === y) return;
    edit({ ...def, layout: { ...layout, positions: { ...layout.positions, [d.id]: { x, y } } } }, `drag:${d.id}`);
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (env.readOnly || (ev.target as HTMLElement | null)?.closest('input, textarea, select')) return;
      if (ev.key === 'Escape') {
        selectOnly({});
        setConnectFrom(null);
      }
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        if (selectedDecor !== null) {
          setDecor(decor.filter((_, j) => j !== selectedDecor));
          setSelectedDecor(null);
        } else if (selected) deleteSpace(selected);
        else if (selectedConn !== null) {
          edit({ ...def, connections: connections.filter((_, j) => j !== selectedConn) });
          setSelectedConn(null);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const space = spaces.find((s) => s.id === selected);
  const spaceIndex = spaces.findIndex((s) => s.id === selected);
  const conn = selectedConn !== null ? connections[selectedConn] : undefined;
  const piece = selectedDecor !== null ? decor[selectedDecor] : undefined;
  const nameOf = (id: string) => spaces.find((s) => s.id === id)?.name ?? id;

  return (
    <div className="board-editor">
      <div className="toolbar">
        {TOOLS.map((t) => (
          <button key={t.id} className={tool === t.id ? 'active' : ''} title={t.help} disabled={env.readOnly && t.id !== 'select'} onClick={() => (setTool(t.id), setConnectFrom(null))}>
            {t.label}
          </button>
        ))}
        {tool === 'paint' && <RefSelect section="spaceTags" value={paintTag} onChange={setPaintTag} />}
        {(tool === 'add' || tool === 'connect') && <Checkbox label="chain" value={chain} onChange={setChain} />}
        {(tool === 'add' || tool === 'connect') && <Checkbox label="one-way" value={directed} onChange={setDirected} />}
        {tool === 'decor' && (
          <span className="decor-palette" title="Scenery to place">
            {[...new Set([...THEMES[look.theme].decor, ...(THEMES[look.theme].decor.includes(decorIcon) ? [] : [decorIcon])])].map((i) => (
              <button key={i} className={i === decorIcon ? 'active' : ''} onClick={() => setDecorIcon(i)}>
                {i}
              </button>
            ))}
            <input className="decor-custom" value={decorIcon} maxLength={8} title="Any emoji" onChange={(e) => e.target.value && setDecorIcon(e.target.value)} />
            <span className="ed-label">size</span>
            <IntInput value={decorSize} min={8} max={240} onChange={(v) => setDecorSize(Math.max(8, Math.min(240, v ?? 32)))} />
          </span>
        )}
        <Checkbox label="snap" value={snap} onChange={setSnap} />
        <span className="muted small">
          {spaces.length} spaces · {connections.length} connections
          {decor.length > 0 ? ` · ${decor.length} scenery` : ''}
          {connectFrom ? ` · connecting from ${nameOf(connectFrom)} (Esc to stop)` : ''}
        </span>
      </div>
      <div className="board-editor-main">
        <div className="board-canvas">
          <svg
            ref={svg}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            style={THEMES[look.theme].edge ? { background: THEMES[look.theme].edge as string } : undefined}
            onPointerMove={onMove}
            onPointerUp={() => (drag.current = null)}
            onPointerDown={(ev) => {
              if (env.readOnly) return;
              if (tool === 'add') addSpace(toBoard(ev));
              else if (tool === 'decor') {
                const p = toBoard(ev);
                if (decor.length >= 400) return window.alert('A board holds at most 400 pieces of scenery.');
                setDecor([...decor, { icon: decorIcon, x: p.x, y: p.y, size: decorSize }]);
                selectOnly({ decor: decor.length });
              } else selectOnly({});
            }}
          >
            <BoardDefs theme={look.theme} id="eb" />
            <BoardBackground layout={look} id="eb" connections={connections} spaces={spaces.map((s) => s.id)} />
            {connections.map((c, i) => {
              const a = layout.positions[c.a];
              const b = layout.positions[c.b];
              if (!a || !b) return null;
              return (
                <g
                  key={i}
                  className={`ed-conn${selectedConn === i ? ' selected' : ''}`}
                  onPointerDown={(ev) => {
                    ev.stopPropagation();
                    if (tool === 'delete' && !env.readOnly) edit({ ...def, connections: connections.filter((_, j) => j !== i) });
                    else selectOnly({ conn: i });
                  }}
                >
                  <path className="hit" d={roadPath(a, b, look.curved, i)} />
                  {selectedConn === i && <path className="sel" d={roadPath(a, b, look.curved, i)} />}
                  <Road a={a} b={b} directed={c.directed === true} layout={look} id="eb" seed={i} />
                </g>
              );
            })}
            <Decor items={look.decor} selected={selectedDecor} onPick={tool === 'decor' || tool === 'delete' ? onDecorDown : undefined} />
            {spaces.map((s) => {
              const p = layout.positions[s.id];
              if (!p) return null;
              return (
                <g key={s.id} className={`ed-space${selected === s.id ? ' selected' : ''}${connectFrom === s.id ? ' from' : ''}`} onPointerDown={(ev) => onSpaceDown(ev, s)}>
                  <SpaceShape x={p.x} y={p.y} r={R} color={color(s)} icon={spaceIcon(s, tags)} name={s.name} layout={look} id="eb">
                    {s.id === start && (
                      <text x={p.x + R * 0.8} y={p.y - R * 0.65} textAnchor="middle" className="start-mark">
                        ★
                      </text>
                    )}
                  </SpaceShape>
                </g>
              );
            })}
            {spaces
              .filter((s) => !layout.positions[s.id])
              .map((s, i) => (
                <text key={s.id} x={10} y={20 + i * 16} className="error small">
                  ⚠ {s.name} has no position (select it and set x/y)
                </text>
              ))}
          </svg>
        </div>
        <aside className="board-side">
          {space && spaceIndex >= 0 && <SpacePanel def={def} edit={edit} space={space} index={spaceIndex} start={start} onRenamed={setSelected} />}
          {piece && selectedDecor !== null && (
            <div className="card">
              <h3>Scenery</h3>
              <Row label="Icon">
                <IconPicker icons={THEMES[look.theme].decor} value={piece.icon} onChange={(v) => v && setDecor(decor.map((d, j) => (j === selectedDecor ? { ...d, icon: v } : d)))} />
              </Row>
              <Row label="Size">
                <IntInput value={piece.size ?? 30} min={8} max={240} onChange={(v) => setDecor(decor.map((d, j) => (j === selectedDecor ? { ...d, size: Math.max(8, Math.min(240, v ?? 30)) } : d)), `decor-size:${selectedDecor}`)} />
              </Row>
              {!env.readOnly && (
                <button
                  className="danger"
                  onClick={() => {
                    setDecor(decor.filter((_, j) => j !== selectedDecor));
                    setSelectedDecor(null);
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          )}
          {conn && selectedConn !== null && (
            <div className="card">
              <h3>Connection</h3>
              <p>
                {nameOf(conn.a)} {conn.directed ? '→' : '—'} {nameOf(conn.b)}
              </p>
              <Checkbox label="one-way (only from the first to the second)" value={conn.directed === true} onChange={(v) => edit({ ...def, connections: connections.map((c, j) => (j === selectedConn ? { a: c.a, b: c.b, ...(v ? { directed: true } : {}) } : c)) })} />
              {conn.directed && !env.readOnly && (
                <button onClick={() => edit({ ...def, connections: connections.map((c, j) => (j === selectedConn ? { ...c, a: c.b, b: c.a } : c)) })}>Reverse direction</button>
              )}{' '}
              {!env.readOnly && (
                <button
                  className="danger"
                  onClick={() => {
                    edit({ ...def, connections: connections.filter((_, j) => j !== selectedConn) });
                    setSelectedConn(null);
                  }}
                >
                  Delete connection
                </button>
              )}
            </div>
          )}
          {!space && !conn && !piece && <p className="muted">Select a space or a connection to edit it. {TOOLS.find((t) => t.id === tool)?.help}</p>}
          <BoardSettings def={def} edit={edit} />
          {!env.readOnly && <Generator def={def} edit={edit} onDone={() => setSelected(null)} />}
          <IssueBadges path={['spaces']} />
          <IssueBadges path={['connections']} />
        </aside>
      </div>
    </div>
  );
}

function SpacePanel({ def, edit, space, index, start, onRenamed }: { def: Json; edit: (d: Json) => void; space: Space; index: number; start: string | undefined; onRenamed: (id: string) => void }) {
  const env = useEnv();
  const spaces = (def['spaces'] ?? []) as Space[];
  const layout = (def['layout'] ?? { positions: {} }) as Layout;
  const connections = (def['connections'] ?? []) as Conn[];
  const [newId, setNewId] = useState(space.id);
  useEffect(() => setNewId(space.id), [space.id]);
  const set = (key: keyof Space, v: unknown) => edit({ ...def, spaces: spaces.map((s, j) => (j === index ? { ...s, [key]: v } : s)) });
  const pos = layout.positions[space.id];
  const links = connections.map((c, i) => ({ c, i })).filter(({ c }) => c.a === space.id || c.b === space.id);
  const nameOf = (id: string) => spaces.find((s) => s.id === id)?.name ?? id;
  return (
    <div className="card">
      <h3>Space</h3>
      <Row label="Name">
        <TextInput value={space.name} max={80} onChange={(v) => set('name', v)} />
      </Row>
      <Row label="Id">
        <span className="ed-inline">
          <input value={newId} disabled={env.readOnly} onChange={(e) => setNewId(e.target.value)} />
          {newId !== space.id && (
            <button
              onClick={() => {
                if (!/^[a-z][a-z0-9_.-]*$/.test(newId)) return window.alert('Ids are lowercase slugs like space.lagoon');
                if (allIds(def).has(newId)) return window.alert(`${newId} is already used`);
                edit(renameId(def, space.id, newId) as Json);
                onRenamed(newId);
              }}
            >
              Rename everywhere
            </button>
          )}
        </span>
      </Row>
      <Row label="Tags">
        <RefMulti section="spaceTags" value={space.tags} max={8} onChange={(v) => set('tags', v)} />
      </Row>
      <Row label="Icon" help="Drawn on the space; without one, the first icon among its tags is used.">
        <IconPicker icons={PLACE_ICONS} value={space.icon} onChange={(v) => set('icon', v)} />
      </Row>
      <Row label="Description">
        <TextInput multiline max={300} value={space.description} onChange={(v) => set('description', v || undefined)} />
      </Row>
      <Row label="Position">
        <span className="ed-inline">
          x <IntInput value={pos?.x} onChange={(x) => edit({ ...def, layout: { ...layout, positions: { ...layout.positions, [space.id]: { x: x ?? 0, y: pos?.y ?? 0 } } } })} />
          y <IntInput value={pos?.y} onChange={(y) => edit({ ...def, layout: { ...layout, positions: { ...layout.positions, [space.id]: { x: pos?.x ?? 0, y: y ?? 0 } } } })} />
        </span>
      </Row>
      <p>
        {space.id === start ? (
          <strong>★ Start space</strong>
        ) : (
          !env.readOnly && <button onClick={() => edit({ ...def, settings: { ...(def['settings'] as Json), startSpace: space.id } })}>Make this the start space</button>
        )}
      </p>
      <div className="small">
        <strong>Connections</strong>
        <ul className="plain">
          {links.map(({ c, i }) => (
            <li key={i}>
              {c.a === space.id ? (c.directed ? '→ ' : '— ') : c.directed ? '← ' : '— '}
              {nameOf(c.a === space.id ? c.b : c.a)}{' '}
              {!env.readOnly && (
                <button className="icon danger" onClick={() => edit({ ...def, connections: connections.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              )}
            </li>
          ))}
          {links.length === 0 && <li className="warn">not connected to anything</li>}
        </ul>
      </div>
      <IssueBadges path={['spaces', index]} />
    </div>
  );
}

function BoardSettings({ def, edit }: { def: Json; edit: (d: Json) => void }) {
  const env = useEnv();
  const layout = (def['layout'] ?? { width: 800, height: 600, positions: {} }) as Layout;
  const fit = () => {
    const pts = Object.values(layout.positions);
    if (pts.length === 0) return;
    const minX = Math.min(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxX = Math.max(...pts.map((p) => p.x));
    const maxY = Math.max(...pts.map((p) => p.y));
    const m = 60;
    const positions = Object.fromEntries(Object.entries(layout.positions).map(([id, p]) => [id, { x: p.x - minX + m, y: p.y - minY + m }]));
    const width = Math.max(100, maxX - minX + 2 * m);
    const height = Math.max(100, maxY - minY + 2 * m);
    // Scenery moves with the spaces; pieces that end up off the board are dropped.
    const decor = (layout.decor ?? []).map((d) => ({ ...d, x: d.x - minX + m, y: d.y - minY + m })).filter((d) => d.x >= 0 && d.y >= 0 && d.x <= width && d.y <= height);
    edit({ ...def, layout: { ...layout, width, height, positions, decor } });
  };
  const look = layoutOf(layout);
  const setLook = (patch: Json) => edit({ ...def, layout: { ...layout, ...patch } });
  const [density, setDensity] = useState('1');
  const decorate = () => {
    if ((layout.decor ?? []).length > 0 && !window.confirm(`Replace the ${(layout.decor ?? []).length} pieces of scenery?`)) return;
    setLook({ decor: autoDecorate(look, (def['connections'] ?? []) as Conn[], Number(density)) });
  };
  return (
    <div className="card">
      <h3>Board</h3>
      <Row label="Size">
        <span className="ed-inline">
          <IntInput value={layout.width} min={100} max={10000} onChange={(w) => edit({ ...def, layout: { ...layout, width: Math.max(100, w ?? 800) } })} />×
          <IntInput value={layout.height} min={100} max={10000} onChange={(h) => edit({ ...def, layout: { ...layout, height: Math.max(100, h ?? 600) } })} />
        </span>
      </Row>
      {!env.readOnly && <button onClick={fit}>Fit board to spaces</button>}
      <Row label="Theme">
        <EnumSelect values={Object.keys(THEMES)} labels={Object.fromEntries(Object.entries(THEMES).map(([k, t]) => [k, t.label]))} value={look.theme} onChange={(v) => setLook({ theme: (v ?? 'plain') as Theme })} />
      </Row>
      <Row label="Connections">
        <span className="ed-inline">
          <EnumSelect values={['line', 'road', 'trail']} labels={{ line: 'lines', road: 'roads', trail: 'dotted trails' }} value={look.roads} onChange={(v) => setLook({ roads: v ?? 'line' })} />
          <Checkbox label="curved" value={look.curved} onChange={(v) => setLook({ curved: v })} />
        </span>
      </Row>
      <Row label="Spaces">
        <EnumSelect values={['circle', 'tile', 'hex']} labels={{ circle: 'circles', tile: 'rounded tiles', hex: 'hexagons' }} value={look.spaceStyle} onChange={(v) => setLook({ spaceStyle: v ?? 'circle' })} />
      </Row>
      <Row label="Scenery" help="Emoji scattered over empty parts of the board, from the theme's set. Use the Scenery tool to place, move or delete pieces.">
        <span className="ed-inline">
          <span className="muted small">{look.decor.length} pieces</span>
          {!env.readOnly && (
            <>
              <EnumSelect values={['0.5', '1', '2']} labels={{ '0.5': 'sparse', '1': 'some', '2': 'lots' }} value={density} onChange={(v) => setDensity(v ?? '1')} />
              <button onClick={decorate}>Decorate</button>
              {look.decor.length > 0 && (
                <button className="danger" onClick={() => setLook({ decor: [] })}>
                  Clear
                </button>
              )}
            </>
          )}
        </span>
      </Row>
      <Row label="Start space">
        <RefSelect section="spaces" value={(def['settings'] as Json | undefined)?.['startSpace'] as string | undefined} onChange={(v) => edit({ ...def, settings: { ...(def['settings'] as Json), startSpace: v ?? '' } })} />
      </Row>
    </div>
  );
}

function Generator({ def, edit, onDone }: { def: Json; edit: (d: Json) => void; onDone: () => void }) {
  const [shape, setShape] = useState<BoardShape>('ring');
  const [count, setCount] = useState(30);
  const [pattern, setPattern] = useState<string[]>([]);
  const [oneWay, setOneWay] = useState(false);
  const [mode, setMode] = useState<'replace' | 'append'>('replace');
  const tags = ((def['tags'] ?? []) as Array<{ id: string; name: string; appliesTo: string }>).filter((t) => t.appliesTo === 'space');
  const run = () => {
    const spaces = (def['spaces'] ?? []) as Space[];
    const layout = (def['layout'] ?? { width: 800, height: 600, positions: {} }) as Layout;
    if (mode === 'replace') {
      if (spaces.length > 0 && !window.confirm(`Replace the ${spaces.length} current spaces with a new ${count}-space ${shape}? References to deleted spaces will show up as problems to fix.`)) return;
      const b = generateBoard(shape, count, { pattern, oneWay });
      const settings = { ...(def['settings'] as Json), startSpace: b.spaces[0]?.id ?? '' };
      // Keep the look; the old scenery would sit on top of the new spaces.
      edit({ ...def, spaces: b.spaces, connections: b.connections, layout: { ...layout, ...b.layout, decor: [] }, settings });
    } else {
      const taken = allIds(def);
      let prefixNum = 1;
      while ([...taken].some((id) => id.startsWith(`space.g${prefixNum}.`))) prefixNum++;
      const b = generateBoard(shape, count, { pattern, oneWay, prefix: `space.g${prefixNum}` });
      const offsetX = layout.width;
      const positions = { ...layout.positions };
      for (const [id, p] of Object.entries(b.layout.positions)) positions[id] = { x: p.x + offsetX, y: p.y };
      b.spaces.forEach((s, i) => (s.name = `${shape} ${i + 1}`));
      edit({ ...def, spaces: [...spaces, ...b.spaces], connections: [...((def['connections'] ?? []) as Conn[]), ...b.connections], layout: { ...layout, width: layout.width + b.layout.width, height: Math.max(layout.height, b.layout.height), positions } });
    }
    onDone();
  };
  return (
    <div className="card">
      <h3>Generate</h3>
      <Row label="Shape">
        <EnumSelect values={['ring', 'grid', 'line', 'figure8', 'spokes']} labels={{ ring: 'ring (loop)', grid: 'grid', line: 'winding line', figure8: 'figure eight', spokes: 'hub and spokes' }} value={shape} onChange={(v) => setShape((v ?? 'ring') as BoardShape)} />
      </Row>
      <Row label="Spaces">
        <IntInput value={count} min={2} max={400} onChange={(v) => setCount(v ?? 30)} />
      </Row>
      <Row label="Tag pattern" help="Tags painted in rotation: space 1 gets the first, space 2 the second, … (“none” leaves a space untagged).">
        <span className="ed-chips">
          {pattern.map((t, i) => (
            <span key={i} className="chip">
              {tags.find((x) => x.id === t)?.name ?? 'none'}
              <button className="chip-x" onClick={() => setPattern(pattern.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          ))}
          <select value="" onChange={(e) => e.target.value && setPattern([...pattern, e.target.value === '-' ? '' : e.target.value])}>
            <option value="">+ add</option>
            <option value="-">none</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </span>
      </Row>
      <Checkbox label="one-way track" value={oneWay} onChange={setOneWay} />
      <Row label="Mode">
        <EnumSelect values={['replace', 'append']} labels={{ replace: 'replace the board', append: 'add beside it' }} value={mode} onChange={(v) => setMode((v ?? 'replace') as 'replace' | 'append')} />
      </Row>
      <button onClick={run}>Generate</button>
    </div>
  );
}
