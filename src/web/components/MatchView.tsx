import { useCallback, useRef, useState } from 'react';
import type { EventDto, Speed } from '../../shared/api.ts';
import { api, useMatch, type MatchData } from '../api.ts';
import { frameAt } from '../display.ts';
import { activeId, entityColor, formatMs, formatUsd } from '../format.ts';
import { Board } from './Board.tsx';
import { CombatWheel, fightsFrom, type FightAnimation } from './CombatWheel.tsx';
import { EventLog, WhyPanel } from './EventLog.tsx';
import { GmTools } from './GmTools.tsx';
import { AiPanel, Inspector, Standings } from './Panels.tsx';

type Tab = 'standings' | 'inspector' | 'gm' | 'ai';

const SPIN_MS: Record<Speed, number> = { fast: 150, normal: 750, slow: 1200 };

/** A fight waiting to be replayed, with the match data as it was just before the fight. */
interface QueuedFight {
  anim: FightAnimation;
  before: MatchData;
}

export function MatchView({ matchId, onExit }: { matchId: string; onExit: () => void }) {
  const [fights, setFights] = useState<QueuedFight[]>([]);
  const [animate, setAnimate] = useState(true);
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [selectedSpace, setSelectedSpace] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('standings');
  const [error, setError] = useState<string | null>(null);

  const namesRef = useRef(new Map<string, { name: string; color: string }>());
  const { data: latest, connected } = useMatch(
    matchId,
    useCallback(
      (events: EventDto[], before: MatchData) => {
        if (!animate) return;
        const found = fightsFrom(
          events,
          (id) => namesRef.current.get(id)?.name ?? id,
          (id) => namesRef.current.get(id)?.color ?? '#888',
        );
        if (found.length > 0) setFights((q) => [...q, ...found.map((anim) => ({ anim, before: frameAt(before, events, anim.startSeq) }))].slice(-6));
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [animate],
    ),
  );
  const done = useCallback(() => setFights((q) => q.slice(1)), []);

  if (!latest) return <main className="loading">{connected ? 'Loading match…' : 'Connecting…'}</main>;
  const queued = animate ? fights[0] : undefined;
  const current = queued?.anim;
  // While the wheel replays a fight, the board, standings and inspector keep showing the values
  // from before it, so neither HP bars nor Power totals spoil the result.
  const data = queued ? queued.before : latest;
  const { definition: def, state, status, metrics } = latest;
  for (const e of Object.values(state.entities)) namesRef.current.set(e.id, { name: e.name, color: e.kind === 'contestant' ? entityColor(def, e) : e.kind === 'enemy' ? '#922b21' : '#7d6608' });
  const active = activeId(state);
  const control = (action: 'start' | 'pause' | 'step' | 'save', speed?: Speed) => {
    setError(null);
    api.control(matchId, speed ? { action, speed } : { action }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  const setSpeed = (speed: Speed) => {
    api.control(matchId, { action: 'speed', speed }).catch((err: unknown) => setError(String(err)));
  };
  const selectEntity = (id: string) => {
    setSelectedEntity(id);
    if (tab === 'standings') setTab('inspector');
  };
  const pending = state.pendingDecision;
  const shown = data.state;
  const thinkingName = status.thinking ? state.entities[status.thinking]?.name : null;

  return (
    <main className="match">
      <header className="topbar">
        <button className="link" onClick={onExit}>
          ← Matches
        </button>
        <div className="title">
          <b>{def.name}</b> <span className="muted">{matchId}</span>
        </div>
        <div className="round">
          Round {state.round}/{def.settings.victory.roundLimit} · {state.phase}
          {active && state.phase !== 'gameOver' ? ` · ${state.entities[active]?.name}` : ''}
          {thinkingName ? ` · 🤔 ${thinkingName} is thinking…` : pending ? ` · awaiting ${state.entities[pending.actor]?.name} (${pending.kind})` : ''}
        </div>
        <div className="controls">
          {status.running ? (
            <button onClick={() => control('pause')}>⏸ Pause</button>
          ) : (
            <button disabled={status.over} onClick={() => control('start')}>
              ▶ {state.round === 0 ? 'Start' : 'Resume'}
            </button>
          )}
          <button disabled={status.running || status.over} onClick={() => control('step')}>
            Step
          </button>
          <button onClick={() => control('save')}>💾 Save</button>
          <select value={status.speed} onChange={(e) => setSpeed(e.target.value as Speed)} aria-label="Speed">
            <option value="slow">Slow</option>
            <option value="normal">Normal</option>
            <option value="fast">Fast</option>
          </select>
          <label className="check">
            <input
              type="checkbox"
              checked={animate}
              onChange={(e) => {
                setAnimate(e.target.checked);
                if (!e.target.checked) setFights([]);
              }}
            />{' '}
            Wheel
          </label>
        </div>
        <div className="meta muted">
          {status.provider === 'openai' ? '🤖' : status.provider === 'mock' ? '🧪' : '📴'} {status.model} · {formatMs(metrics.matchDurationMs)} · {formatUsd(metrics.costUsd)} · state {status.stateHash}
          {status.savedAt ? ` · saved ${new Date(status.savedAt).toLocaleTimeString()}` : ''}
          {!connected ? ' · ⚠ disconnected' : ''}
        </div>
      </header>
      {status.abortedMessage && <div className="banner error">An operation was stopped and rolled back: {status.abortedMessage}. The game is paused; fix or disable the rule, then resume.</div>}
      {error && <div className="banner error">{error}</div>}
      {shown.phase === 'gameOver' && (
        <div className="banner ok">
          🏆 {(shown.winners ?? []).map((w) => shown.entities[w]?.name).join(' & ')} win — {shown.endReason}
        </div>
      )}
      <section className="layout">
        <div className="board-wrap">
          <Board
            def={def}
            state={shown}
            effective={data.effective}
            selectedEntity={selectedEntity}
            selectedSpace={selectedSpace}
            thinking={status.thinking}
            onSelectEntity={selectEntity}
            onSelectSpace={(id) => {
              setSelectedSpace(id);
              if (selectedEntity) setTab('gm');
            }}
          />
          {current && <CombatWheel fight={current} spinMs={SPIN_MS[status.speed]} onDone={done} />}
        </div>
        <aside className="side">
          <nav className="tabs">
            {(['standings', 'inspector', 'gm', 'ai'] as const).map((t) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t === 'standings' ? 'Standings' : t === 'inspector' ? 'Inspector' : t === 'gm' ? 'GM tools' : 'AI'}
              </button>
            ))}
          </nav>
          <div className="tab-body">
            {tab === 'standings' && <Standings data={data} selected={selectedEntity} onSelect={selectEntity} />}
            {tab === 'inspector' && <Inspector data={data} entityId={selectedEntity} />}
            {tab === 'gm' && <GmTools data={latest} entityId={selectedEntity} teleportTarget={selectedSpace} />}
            {tab === 'ai' && <AiPanel data={latest} />}
          </div>
        </aside>
      </section>
      <section className="bottom">
        <EventLog data={latest} selected={selectedEvent} onSelect={setSelectedEvent} holdAfter={current ? current.startSeq : null} />
        <div className="why-wrap">{selectedEvent !== null ? <WhyPanel data={latest} seq={selectedEvent} onPick={setSelectedEvent} /> : <p className="muted">Click any event to see why it happened.</p>}</div>
      </section>
    </main>
  );
}
