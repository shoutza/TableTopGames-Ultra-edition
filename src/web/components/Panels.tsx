import { useState } from 'react';
import type { GameDefinition } from '../../schema/definition.ts';
import type { ContestantViewResponse, MindDto } from '../../shared/api.ts';
import { api, type MatchData } from '../api.ts';
import { activeId, entityColor, entityIcon, formatMs, formatUsd, resourceName, spaceName } from '../format.ts';
import { EmptyState, Icon, PieceSymbol, playerStyle } from './Ui.tsx';

/** Standings, entity inspector and the AI panel. */

export function Standings({
  data,
  onSelect,
  selected,
}: {
  data: MatchData;
  onSelect: (id: string) => void;
  selected: string | null;
}) {
  const { definition: def, state, effective, minds } = data;
  const core = def.settings.core;
  const victory = def.settings.victory.resource;
  const active = state.round > 0 && state.phase !== 'gameOver' ? activeId(state) : null;
  return (
    <div className="standings">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">THE CAST · TURN ORDER</p>
          <h2>The contestants</h2>
        </div>
        <span className="count">{state.turnOrder.length}</span>
      </div>
      <p className="panel-intro">
        First to {def.settings.victory.threshold} {resourceName(def, victory).toLowerCase()}. Select a player to take a
        closer look.
      </p>
      <div className="player-list">
        {state.turnOrder.map((id, index) => {
          const e = state.entities[id];
          if (!e) return null;
          const v = effective[id] ?? {};
          const mind = minds.find((m) => m.entityId === id);
          const hpPercent = v[core.maxHp]
            ? Math.max(0, Math.min(100, ((v[core.hp] ?? 0) / (v[core.maxHp] ?? 1)) * 100))
            : 0;
          const winner = state.winners?.includes(id);
          return (
            <button
              key={id}
              className={`player-card${selected === id ? ' selected' : ''}${active === id ? ' current' : ''}${winner ? ' winner' : ''}`}
              style={playerStyle(entityColor(def, e))}
              onClick={() => onSelect(id)}
              aria-label={`Inspect ${e.name}`}
              aria-pressed={selected === id}
            >
              <span className="player-card-header">
                <span className="player-avatar">
                  <PieceSymbol icon={entityIcon(def, e)} />
                </span>
                <span className="player-identity">
                  <strong>{e.name}</strong>
                  <span>{spaceName(def, e.spaceId)}</span>
                </span>
                <span className="player-order">
                  {winner ? <Icon name="star" size={17} /> : String(index + 1).padStart(2, '0')}
                </span>
              </span>
              <span className="player-stats">
                <span>
                  <span className="stat-icon gold">★</span>
                  <b>{v[victory] ?? 0}</b>
                  <small>{resourceName(def, victory)}</small>
                </span>
                <span>
                  <span className="stat-icon coin">●</span>
                  <b>{v[core.gold] ?? 0}</b>
                  <small>{resourceName(def, core.gold)}</small>
                </span>
                <span>
                  <span className="stat-icon power">ϟ</span>
                  <b>{v[core.power] ?? 0}</b>
                  <small>{resourceName(def, core.power)}</small>
                </span>
                <span>
                  <span className="stat-icon health">♡</span>
                  <b>
                    {v[core.hp] ?? 0}
                    <small>/{v[core.maxHp] ?? 0}</small>
                  </b>
                  <small>HP</small>
                </span>
              </span>
              <span className="player-health">
                <span style={{ width: `${hpPercent}%` }} />
              </span>
              <span className="player-card-footer">
                <span className="strategy-pill" title={mind?.plan ?? ''}>
                  {mind?.strategy?.archetype?.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2') ??
                    'Finding a strategy'}
                </span>
                <span className={active === id ? 'current-turn' : 'player-items'}>
                  {active === id
                    ? '● Playing'
                    : e.koTurns > 0
                      ? 'Knocked out'
                      : e.items
                          .map((i) => def.items.find((x) => x.id === state.items[i]?.defId)?.icon ?? '•')
                          .join(' ') || 'No items yet'}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="panel-tip">
        <Icon name="sliders" size={17} />
        <p>
          Plot twist in mind?
          <br />
          <span>Choose a player, then open GM tools.</span>
        </p>
      </div>
    </div>
  );
}

function StrategyBlock({ mind }: { mind: MindDto }) {
  return (
    <div className="block">
      <h4>Strategy {mind.strategy ? `· ${mind.strategy.archetype} (round ${mind.strategy.adoptedAtRound})` : ''}</h4>
      {mind.strategy ? (
        <>
          <p>{mind.strategy.summary}</p>
          <p className="muted">Priorities: {mind.strategy.priorities.join('; ')}</p>
          {mind.strategy.avoid.length > 0 && <p className="muted">Avoid: {mind.strategy.avoid.join('; ')}</p>}
        </>
      ) : (
        <p className="muted">No strategy yet.</p>
      )}
      <p>
        <b>Plan:</b> {mind.plan || '—'}
      </p>
      {mind.reconsider && <p className="warn">Reconsider flag: {mind.reconsider}</p>}
      {mind.strategyHistory.length > 0 && (
        <details>
          <summary>
            {mind.strategyHistory.length} earlier strateg
            {mind.strategyHistory.length === 1 ? 'y' : 'ies'}
          </summary>
          {mind.strategyHistory.map((s, i) => (
            <p key={i} className="muted">
              Round {s.adoptedAtRound}: {s.archetype} — {s.summary}
            </p>
          ))}
        </details>
      )}
      <details>
        <summary>Strategy details</summary>
        <p className="muted">
          Candidates offered: {mind.candidates.join(', ')} · controller: {mind.controller}
        </p>
      </details>
    </div>
  );
}

export function Inspector({ data, entityId }: { data: MatchData; entityId: string | null }) {
  const [view, setView] = useState<ContestantViewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const def: GameDefinition = data.definition;
  if (!entityId)
    return (
      <EmptyState icon="search" title="Meet your contestants">
        Select a piece on the board or a player card to explore their stats and strategy.
      </EmptyState>
    );
  const e = data.state.entities[entityId];
  if (!e) return <p className="muted">Unknown entity.</p>;
  const v = data.effective[entityId] ?? {};
  const mind = data.minds.find((m) => m.entityId === entityId);
  const cast = def.cast.find((c) => c.id === e.defId);
  const enemy = def.enemies.find((x) => x.id === e.defId);
  const fixture = def.fixtures.find((x) => x.id === e.defId);
  const shop = fixture?.shop ? def.shops.find((s) => s.id === fixture.shop) : undefined;
  return (
    <div className="inspector">
      <div className="inspector-heading" style={playerStyle(entityColor(def, e))}>
        <span className="player-avatar">
          <PieceSymbol icon={entityIcon(def, e)} />
        </span>
        <div>
          <p className="eyebrow">{e.kind}</p>
          <h2 title={e.id}>{e.name}</h2>
        </div>
      </div>
      <p>
        At <b>{spaceName(def, e.spaceId)}</b>
        {e.status === 'defeated'
          ? ` · defeated${e.respawnRound !== null ? `, returns round ${e.respawnRound}` : ''}`
          : ''}
        {e.koTurns > 0 ? ` · knocked out (${e.koTurns} turn to skip)` : ''}
      </p>
      {Object.keys(e.resources).length > 0 && (
        <table className="kv">
          <tbody>
            {Object.keys(e.resources).map((r) => (
              <tr key={r}>
                <td>{resourceName(def, r)}</td>
                <td>
                  {v[r] ?? e.resources[r]}
                  {v[r] !== undefined && v[r] !== e.resources[r] ? (
                    <span className="muted"> (base {e.resources[r]})</span>
                  ) : null}
                  {def.resources.find((x) => x.id === r)?.visibility === 'owner' ? (
                    <span className="muted"> · secret</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {e.items.length > 0 && (
        <p>
          Items:{' '}
          {e.items
            .map((i) => {
              const d = def.items.find((x) => x.id === data.state.items[i]?.defId);
              return `${d?.icon ?? ''} ${d?.name ?? i} (${d?.modifiers.map((m) => `+${m.add} ${resourceName(def, m.resource)}`).join(', ') ?? ''})`;
            })
            .join(' · ')}
        </p>
      )}
      {e.tags.length > 0 && <p>Tags: {e.tags.map((t) => def.tags.find((x) => x.id === t)?.name ?? t).join(', ')}</p>}
      {cast && (
        <div className="block">
          <h4>Personality</h4>
          <p>{cast.persona.voice}</p>
          <div className="trait-list">
            {Object.entries(cast.persona.traits).map(([k, val]) => (
              <div key={k}>
                <span>{k}</span>
                <div className="trait-track">
                  <span style={{ width: `${val * 10}%` }} />
                </div>
                <strong>{val}</strong>
              </div>
            ))}
          </div>
          {cast.persona.behaviors.length > 0 && <p className="muted">{cast.persona.behaviors.join(' ')}</p>}
        </div>
      )}
      {mind && <StrategyBlock mind={mind} />}
      {enemy && (
        <div className="block">
          <h4>Enemy</h4>
          <p>
            Regenerates {enemy.regenPerRound} HP/round ·{' '}
            {enemy.respawnAfterRounds ? `returns ${enemy.respawnAfterRounds} round(s) after defeat` : 'does not return'}
          </p>
          {enemy.description && <p className="muted">{enemy.description}</p>}
        </div>
      )}
      {shop && (
        <div className="block">
          <h4>{shop.name}</h4>
          <ul>
            {shop.entries.map((en) => (
              <li key={en.id}>
                {'item' in en.grants
                  ? def.items.find((i) => i.id === (en.grants as { item: string }).item)?.name
                  : `${en.grants.amount} ${resourceName(def, en.grants.resource)}`}{' '}
                — {en.price.amount} {resourceName(def, en.price.resource)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {e.kind === 'contestant' && (
        <div className="block">
          <button
            onClick={() => {
              setError(null);
              api
                .view(data.matchId, entityId)
                .then(setView)
                .catch((err: unknown) => setError(String(err)));
            }}
          >
            View as {e.name}
          </button>
          {error && <p className="error">{error}</p>}
          {view && view.entityId === entityId && (
            <div className="packet">
              <p className="muted">
                What {e.name} knows right now (hidden values removed) and the last packet sent to its model.
              </p>
              {view.lastPacket ? (
                <>
                  <details>
                    <summary>Instructions (stable part)</summary>
                    <pre>{view.lastPacket.instructions}</pre>
                  </details>
                  <pre>{view.lastPacket.input}</pre>
                </>
              ) : (
                <p className="muted">No model packet yet (offline controller or no decision so far).</p>
              )}
              <details>
                <summary>Contestant view (JSON)</summary>
                <pre>{JSON.stringify(view.view, null, 1)}</pre>
              </details>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AiPanel({ data }: { data: MatchData }) {
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setError(null);
    setRetrying(true);
    try {
      await api.control(data.matchId, { action: 'resetProvider' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  };
  const m = data.metrics;
  const calls = [...data.aiCalls].reverse().slice(0, 60);
  return (
    <div className="ai-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">BEHIND THE MOVES</p>
          <h2>Contestant intelligence</h2>
        </div>
        <Icon name="sparkles" />
      </div>
      <div className="ai-metrics">
        <div>
          <span>Decisions</span>
          <strong>{m.decisions}</strong>
        </div>
        <div>
          <span>Est. cost</span>
          <strong>{formatUsd(m.costUsd)}</strong>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <table className="kv">
        <tbody>
          <tr>
            <td>Contestant model</td>
            <td>
              {data.status.provider} · {data.status.model}
            </td>
          </tr>
          <tr>
            <td>Match time (running)</td>
            <td>{formatMs(m.matchDurationMs)}</td>
          </tr>
          <tr>
            <td>Decisions</td>
            <td>
              {m.decisions} (
              {Object.entries(m.bySource)
                .map(([k, n]) => `${k} ${n}`)
                .join(', ')}
              )
            </td>
          </tr>
          <tr>
            <td>Model requests</td>
            <td>
              {m.modelRequests} · fallback {(m.fallbackRate * 100).toFixed(1)}% · stale {m.obsolete}
            </td>
          </tr>
          <tr>
            <td>Tokens</td>
            <td>
              in {m.usage.inputTokens} (cached {m.usage.cachedInputTokens}) · out {m.usage.outputTokens} (reasoning{' '}
              {m.usage.reasoningTokens})
            </td>
          </tr>
          <tr>
            <td>Est. cost</td>
            <td>{formatUsd(m.costUsd)}</td>
          </tr>
          <tr>
            <td>Latency</td>
            <td>
              p50 {m.latencyMs.p50} ms · p95 {m.latencyMs.p95} ms
            </td>
          </tr>
          <tr>
            <td>Packet size (est.)</td>
            <td>
              p50 {m.packetTokens.p50} · p95 {m.packetTokens.p95} tokens
            </td>
          </tr>
        </tbody>
      </table>
      {m.providerTripped && (
        <p className="warn">
          Provider failed repeatedly; contestants are using the offline controller.{' '}
          <button disabled={retrying} onClick={() => void retry()}>
            {retrying ? 'Retrying…' : 'Retry provider'}
          </button>
        </p>
      )}
      <h4>Recent AI calls</h4>
      {calls.length === 0 && (
        <p className="muted">
          {data.status.provider === 'offline'
            ? 'Offline contestants use local strategies. No model calls or API costs.'
            : 'Decisions will appear here as the match unfolds.'}
        </p>
      )}
      <ul className="calls">
        {calls.map((c, i) => (
          <li key={`${c.at}-${i}`} className={c.source === 'fallback' || c.obsolete ? 'warn' : ''}>
            <b>{c.contestantName}</b> r{c.round} · {c.purpose} · {c.source}
            {c.obsolete ? ' · stale (discarded)' : ''}
            {c.optionId ? ` → ${c.optionId}` : ''}
            {c.say ? ` — “${c.say}”` : ''}
            <div className="muted">
              {c.reason}
              {c.attempts > 0 ? ` · ${c.usage.inputTokens}+${c.usage.outputTokens} tok · ${c.latencyMs} ms` : ''}
              {c.errors.length > 0 ? ` · ${c.errors.join(' | ')}` : ''}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
