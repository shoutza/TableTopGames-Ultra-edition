import { useCallback, useEffect, useRef, useState } from 'react';
import type { EventDto, Speed } from '../../shared/api.ts';
import { api, useMatch } from '../api.ts';
import { activeId, entityColor, entityIcon, formatMs, formatUsd, phaseName } from '../format.ts';
import { Board } from './Board.tsx';
import { CombatWheel, fightsFrom, type FightAnimation } from './CombatWheel.tsx';
import { EventLog, WhyPanel } from './EventLog.tsx';
import { GmTools } from './GmTools.tsx';
import { AiPanel, Inspector, Standings } from './Panels.tsx';
import { EmptyState, Icon, PieceSymbol, Rail, useReducedMotion, type IconName } from './Ui.tsx';

type Tab = 'standings' | 'inspector' | 'gm' | 'ai';
const TABS: Array<{ id: Tab; name: string; icon: IconName }> = [
  { id: 'standings', name: 'Players', icon: 'users' },
  { id: 'inspector', name: 'Inspect', icon: 'search' },
  { id: 'gm', name: 'GM tools', icon: 'sliders' },
  { id: 'ai', name: 'AI', icon: 'sparkles' },
];
const SPIN_MS: Record<Speed, number> = { fast: 150, normal: 750, slow: 1200 };

export function MatchView({ matchId, onExit }: { matchId: string; onExit: () => void }) {
  const reducedMotion = useReducedMotion();
  const [fights, setFights] = useState<FightAnimation[]>([]);
  const [animate, setAnimate] = useState(!reducedMotion);
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [selectedSpace, setSelectedSpace] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('standings');
  const [error, setError] = useState<string | null>(null);
  const [pendingControl, setPendingControl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    if (reducedMotion) {
      setAnimate(false);
      setFights([]);
    }
  }, [reducedMotion]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  const namesRef = useRef(new Map<string, { name: string; color: string }>());
  const {
    data,
    connected,
    error: connectionError,
  } = useMatch(
    matchId,
    useCallback(
      (events: EventDto[]) => {
        if (!animate) return;
        const found = fightsFrom(
          events,
          (id) => namesRef.current.get(id)?.name ?? id,
          (id) => namesRef.current.get(id)?.color ?? '#888',
        );
        if (found.length > 0) setFights((q) => [...q, ...found].slice(-6));
      },
      [animate],
    ),
  );
  const done = useCallback(() => setFights((q) => q.slice(1)), []);
  const openPanel = (next: Tab) => {
    setTab(next);
    document.getElementById('match-panels')?.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'nearest',
    });
  };

  if (!data)
    return (
      <main className="loading">
        <span className="brand-mark">
          <Icon name="dice" size={28} />
        </span>
        <h2>{connectionError ? 'Could not open this table' : 'Setting the table…'}</h2>
        <p className="muted">{connectionError ?? 'Connecting to your live match.'}</p>
        {!connectionError && <span className="spinner" />}
        <button onClick={onExit}>
          <Icon name="back" size={16} /> Back to tables
        </button>
      </main>
    );
  const { definition: def, state, status, metrics } = data;
  for (const e of Object.values(state.entities))
    namesRef.current.set(e.id, { name: e.name, color: entityColor(def, e) });
  const active = activeId(state);
  const actor = active && state.round > 0 ? state.entities[active] : undefined;
  const control = async (action: 'start' | 'pause' | 'step' | 'save') => {
    if (pendingControl) return;
    setPendingControl(action);
    setError(null);
    try {
      await api.control(matchId, { action });
      if (action === 'save') setNotice('Your table is saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingControl(null);
    }
  };
  const setSpeed = (speed: Speed) => {
    setError(null);
    api
      .control(matchId, { action: 'speed', speed })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  const selectEntity = (id: string) => {
    setSelectedEntity(id);
    if (tab === 'standings') setTab('inspector');
  };
  const current = fights[0];
  const pending = state.pendingDecision;
  const thinkingName = status.thinking ? state.entities[status.thinking]?.name : null;
  const space = def.spaces.find((s) => s.id === selectedSpace);
  const lifeLabel = status.over
    ? 'Finished'
    : status.running
      ? 'Live match'
      : state.round === 0
        ? 'Ready to play'
        : 'Paused';
  return (
    <div className="app-shell match-shell">
      <Rail
        items={[
          { icon: 'back', label: 'Tables', active: false, onClick: onExit },
          {
            icon: 'grid',
            label: 'Board',
            active: tab === 'standings' || tab === 'inspector',
            onClick: () => openPanel('standings'),
          },
          {
            icon: 'sliders',
            label: 'GM tools',
            active: tab === 'gm',
            onClick: () => openPanel('gm'),
          },
          {
            icon: 'sparkles',
            label: 'AI',
            active: tab === 'ai',
            onClick: () => openPanel('ai'),
          },
        ]}
      />
      <main className="match">
        <header className="topbar">
          <div className="match-title">
            <p className="eyebrow">YOUR GAME MASTER CONSOLE</p>
            <h1>
              {def.name}{' '}
              <span className={`phase-pill${status.running ? ' live' : ''}`}>
                <span className="status-dot" />
                {lifeLabel}
              </span>
            </h1>
          </div>
          <div className="controls">
            <label className="speed-control">
              <span>PACE</span>
              <select value={status.speed} onChange={(e) => setSpeed(e.target.value as Speed)} aria-label="Match speed">
                <option value="slow">Relaxed</option>
                <option value="normal">Normal</option>
                <option value="fast">Fast</option>
              </select>
            </label>
            <button
              className="icon-button"
              title="Advance one operation"
              aria-label="Step"
              disabled={status.running || status.over || pendingControl !== null || !connected}
              onClick={() => void control('step')}
            >
              <Icon name="step" size={19} />
            </button>
            <button
              className="save-button"
              disabled={pendingControl !== null || !connected}
              onClick={() => void control('save')}
            >
              <Icon name={notice ? 'check' : 'save'} size={17} />
              {pendingControl === 'save' ? 'Saving…' : notice ? 'Saved' : 'Save'}
            </button>
            <button
              className="primary"
              disabled={status.over || pendingControl !== null || !connected}
              onClick={() => void control(status.running ? 'pause' : 'start')}
            >
              <Icon name={status.running ? 'pause' : 'play'} size={17} />
              {status.running ? 'Pause' : state.round === 0 ? 'Start match' : 'Resume'}
            </button>
          </div>
        </header>
        <div className="match-status">
          <div className="round-stat">
            <Icon name="flag" size={17} />
            <strong>Round {state.round}</strong>
            <span>/ {def.settings.victory.roundLimit}</span>
            <div className="round-progress">
              <span
                style={{
                  width: `${Math.min(100, (state.round / def.settings.victory.roundLimit) * 100)}%`,
                }}
              />
            </div>
          </div>
          <span className="status-divider" />
          <div className="turn-status">
            {actor && state.phase !== 'gameOver' ? (
              <>
                <span className="mini-avatar" style={{ background: entityColor(def, actor) }}>
                  <PieceSymbol icon={entityIcon(def, actor)} size={16} />
                </span>
                <strong>{actor.name}</strong>
                <span>{thinkingName ? 'is thinking' : phaseName(state.phase)}</span>
                {thinkingName && <span className="thinking-dots">•••</span>}
              </>
            ) : (
              <>
                <Icon name="users" size={17} />
                <span>{state.phase === 'gameOver' ? 'The story is complete' : 'The contestants are ready'}</span>
              </>
            )}
          </div>
          <div className="match-status-right">
            <span>
              <Icon name="clock" size={15} />
              {formatMs(metrics.matchDurationMs)}
            </span>
            <span className={`connection-pill${connected ? '' : ' offline'}`}>
              <span className="status-dot" />
              {connected ? 'Connected' : 'Reconnecting…'}
            </span>
          </div>
        </div>
        {status.abortedMessage && (
          <div className="banner error" role="alert">
            An operation was stopped and rolled back: {status.abortedMessage}. The game is paused; fix or disable the
            rule, then resume.
          </div>
        )}
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="toast" role="status">
            <Icon name="check" size={17} />
            {notice}
          </div>
        )}
        {state.phase === 'gameOver' && (
          <div className="banner victory">
            <Icon name="star" />
            <strong>{(state.winners ?? []).map((w) => state.entities[w]?.name).join(' & ')} win!</strong>
            <span>{state.endReason}</span>
          </div>
        )}
        <section className="layout">
          <div className="board-wrap">
            <div className="board-heading">
              <div>
                <Icon name="grid" size={17} />
                <h2>The game board</h2>
                <span>
                  {def.spaces.length} spaces · {state.turnOrder.length} contestants
                </span>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={animate}
                  onChange={(e) => {
                    setAnimate(e.target.checked);
                    setFights([]);
                  }}
                />
                Combat replay
              </label>
            </div>
            <div className="board-stage">
              <div className="board-viewport">
                <div className="board-canvas" style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}>
                  <Board
                    def={def}
                    state={state}
                    effective={data.effective}
                    selectedEntity={selectedEntity}
                    selectedSpace={selectedSpace}
                    thinking={status.thinking}
                    onSelectEntity={selectEntity}
                    onSelectSpace={setSelectedSpace}
                  />
                </div>
              </div>
              <div className="board-zoom" aria-label="Board zoom controls">
                <button
                  aria-label="Zoom out"
                  disabled={zoom <= 1}
                  onClick={() => setZoom((n) => Math.max(1, n - 0.25))}
                >
                  −
                </button>
                <button aria-label="Reset board zoom" onClick={() => setZoom(1)}>
                  {zoom * 100}%
                </button>
                <button aria-label="Zoom in" disabled={zoom >= 2} onClick={() => setZoom((n) => Math.min(2, n + 0.25))}>
                  +
                </button>
              </div>
              {current && animate && (
                <CombatWheel
                  key={current.fight}
                  fight={current}
                  spinMs={reducedMotion ? 0 : SPIN_MS[status.speed]}
                  onDone={done}
                />
              )}
            </div>
            <div className="board-footer">
              {space ? (
                <div className="selected-space">
                  <strong>{space.name}</strong>
                  <span>
                    {space.description ||
                      space.tags.map((t) => def.tags.find((tag) => tag.id === t)?.name ?? t).join(' · ')}
                  </span>
                  {selectedEntity && (
                    <button className="link" onClick={() => openPanel('gm')}>
                      Use in GM tools <Icon name="arrow" size={14} />
                    </button>
                  )}
                </div>
              ) : (
                <span>
                  <Icon name="search" size={15} /> Select a piece to inspect it. Select a space to explore.
                </span>
              )}
              <span className="board-objective">
                <Icon name="star" size={15} /> {def.settings.victory.threshold}{' '}
                {def.resources.find((r) => r.id === def.settings.victory.resource)?.name ?? 'points'} to win
              </span>
            </div>
          </div>
          <aside id="match-panels" className="side">
            <nav className="tabs" aria-label="Match panels">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  className={tab === t.id ? 'active' : ''}
                  aria-pressed={tab === t.id}
                  onClick={() => setTab(t.id)}
                >
                  <Icon name={t.icon} size={16} />
                  {t.name}
                </button>
              ))}
            </nav>
            <div className="tab-body" key={tab}>
              {tab === 'standings' && <Standings data={data} selected={selectedEntity} onSelect={selectEntity} />}
              {tab === 'inspector' && <Inspector key={selectedEntity} data={data} entityId={selectedEntity} />}
              {tab === 'gm' && (
                <GmTools
                  data={data}
                  entityId={selectedEntity}
                  teleportTarget={selectedSpace}
                  onSelectEntity={setSelectedEntity}
                />
              )}
              {tab === 'ai' && <AiPanel data={data} />}
            </div>
          </aside>
        </section>
        <section className="bottom">
          <EventLog
            data={data}
            selected={selectedEvent}
            onSelect={setSelectedEvent}
            holdAfter={current && animate ? current.startSeq : null}
          />
          <div className="why-wrap">
            {selectedEvent !== null ? (
              <WhyPanel data={data} seq={selectedEvent} onPick={setSelectedEvent} />
            ) : (
              <EmptyState icon="activity" title="Every move has a story">
                Select an event to see the rule, action, or decision behind it.
              </EmptyState>
            )}
          </div>
        </section>
        <footer className="match-footer">
          <span>
            {status.provider === 'openai'
              ? 'AI contestants'
              : status.provider === 'mock'
                ? 'Scripted contestants'
                : 'Offline contestants'}
            <span className="footer-dot">·</span>
            {pending ? `Awaiting ${state.entities[pending.actor]?.name} (${pending.kind})` : 'You’re the Game Master'}
          </span>
          <details>
            <summary>Session details</summary>
            <p>
              {matchId} · {status.model} · {formatUsd(metrics.costUsd)} · state {status.stateHash}
              {status.savedAt ? ` · saved ${new Date(status.savedAt).toLocaleTimeString()}` : ''}
            </p>
          </details>
        </footer>
      </main>
    </div>
  );
}
