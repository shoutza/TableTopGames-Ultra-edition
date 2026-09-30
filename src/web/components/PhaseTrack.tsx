import type { GameDefinition } from '../../schema/definition.ts';
import type { GameState } from '../../schema/state.ts';
import { entityColor } from '../format.ts';

/**
 * Where the game stands: the round, the turn order (whose turn it is) and the phases of a turn,
 * with the current phase highlighted — so the GM can step through the game phase by phase.
 */

const PHASES: Array<{ id: GameState['phase']; label: string }> = [
  { id: 'roundStart', label: 'Round start' },
  { id: 'turnStart', label: 'Turn start' },
  { id: 'roll', label: 'Roll' },
  { id: 'move', label: 'Move' },
  { id: 'main', label: 'Action' },
  { id: 'turnEnd', label: 'Turn end' },
  { id: 'roundEnd', label: 'Round end' },
];

export function PhaseTrack({ def, state }: { def: GameDefinition; state: GameState }) {
  const active = state.turnOrder[state.turn.index];
  const inTurn = state.phase !== 'roundStart' && state.phase !== 'roundEnd' && state.phase !== 'gameOver';
  return (
    <div className="phase-track" aria-label="Turn progress">
      <span className="pt-round">
        {/* Before a round starts the counter still shows the previous one: name the round about to begin. */}
        Round {state.phase === 'roundStart' ? state.round + 1 : state.round}
        <span className="muted">/{def.settings.victory.roundLimit}</span>
        {state.phase === 'roundStart' ? <span className="muted small"> (starting)</span> : null}
      </span>
      <span className="pt-order">
        {state.turnOrder.map((id, i) => {
          const e = state.entities[id];
          if (!e) return null;
          const done = i < state.turn.index || state.phase === 'roundEnd';
          const now = i === state.turn.index && inTurn;
          return (
            <span key={id} className={`pt-who${now ? ' now' : ''}${done ? ' done' : ''}${e.status !== 'active' ? ' out' : ''}`} style={{ borderColor: entityColor(def, e) }} title={e.name}>
              {e.name.split(' ')[0]}
            </span>
          );
        })}
      </span>
      <span className="pt-phases">
        {state.phase === 'gameOver' ? (
          <span className="pt-phase now">Game over</span>
        ) : (
          PHASES.map((p, i) => (
            <span key={p.id} className={`pt-phase${p.id === state.phase ? ' now' : ''}`}>
              {i > 0 && <span className="pt-sep">›</span>}
              {p.label}
              {p.id === 'roll' && state.turn.roll !== null && state.phase !== 'roll' && inTurn ? ` (${state.turn.roll})` : ''}
            </span>
          ))
        )}
      </span>
      {inTurn && active && <span className="muted small">{state.entities[active]?.name}'s turn</span>}
    </div>
  );
}
