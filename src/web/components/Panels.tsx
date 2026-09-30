import { useState } from 'react';
import type { GameDefinition } from '../../schema/definition.ts';
import type { ContestantViewResponse, MindDto } from '../../shared/api.ts';
import { api, type MatchData } from '../api.ts';
import { activeId, entityColor, entityIcon, formatMs, formatUsd, resourceName, spaceName, statusLabel, transformationOf } from '../format.ts';

/** Standings, entity inspector and the AI panel. */

const CAPABILITY_TEXT: Record<string, string> = {
  takesTurns: 'take turns',
  moves: 'move',
  shops: 'shop',
  attacks: 'attack',
  attackable: 'be attacked',
  usesItems: 'use items',
  trades: 'trade',
};

function capabilityText(c: string): string {
  return CAPABILITY_TEXT[c] ?? c;
}

export function Standings({ data, onSelect, selected }: { data: MatchData; onSelect: (id: string) => void; selected: string | null }) {
  const { definition: def, state, effective, minds } = data;
  const core = def.settings.core;
  const victory = def.settings.victory.resource;
  const active = activeId(state);
  const mindOf = (id: string) => minds.find((m) => m.entityId === id);
  return (
    <table className="standings">
      <thead>
        <tr>
          <th>Contestant</th>
          <th title={resourceName(def, victory)}>⭐</th>
          <th title={resourceName(def, core.gold)}>🪙</th>
          <th title="Effective Power">⚡</th>
          <th>HP</th>
          <th>Items</th>
          <th>Status</th>
          <th>Strategy</th>
        </tr>
      </thead>
      <tbody>
        {state.turnOrder.map((id) => {
          const e = state.entities[id];
          if (!e) return null;
          const v = effective[id] ?? {};
          const mind = mindOf(id);
          return (
            <tr key={id} className={`${selected === id ? 'selected' : ''}${state.winners?.includes(id) ? ' winner' : ''}`} onClick={() => onSelect(id)}>
              <td>
                <span className="dot" style={{ background: entityColor(def, e) }} /> {entityIcon(def, e)} {e.name}
                {id === active && state.phase !== 'gameOver' ? ' ◀' : ''}
                {e.koTurns > 0 ? ' 💫' : ''}
                {e.status === 'eliminated' ? ' ☠️' : ''}
                {state.winners?.includes(id) ? ' 🏆' : ''}
              </td>
              <td>{v[victory] ?? 0}</td>
              <td>{v[core.gold] ?? 0}</td>
              <td>{v[core.power] ?? 0}</td>
              <td>
                {v[core.hp] ?? 0}/{v[core.maxHp] ?? 0}
              </td>
              <td>{e.items.map((i) => def.items.find((x) => x.id === state.items[i]?.defId)?.icon ?? '•').join('') || '—'}</td>
              <td title={e.statuses.map((st) => statusLabel(def, st)).join(', ')}>{e.statuses.map((st) => def.statuses.find((x) => x.id === st.defId)?.icon ?? '•').join('') || '—'}</td>
              <td title={mind?.plan ? `Plan: ${mind.plan}` : ''}>{mind?.strategy?.archetype ?? '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
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
          <summary>{mind.strategyHistory.length} earlier strateg{mind.strategyHistory.length === 1 ? 'y' : 'ies'}</summary>
          {mind.strategyHistory.map((s, i) => (
            <p key={i} className="muted">
              Round {s.adoptedAtRound}: {s.archetype} — {s.summary}
            </p>
          ))}
        </details>
      )}
      <p className="muted">Candidates offered: {mind.candidates.join(', ')} · controller: {mind.controller}</p>
    </div>
  );
}

export function Inspector({ data, entityId }: { data: MatchData; entityId: string | null }) {
  const [view, setView] = useState<ContestantViewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const def: GameDefinition = data.definition;
  if (!entityId) return <p className="muted">Select a token on the board or a row in the standings.</p>;
  const e = data.state.entities[entityId];
  if (!e) return <p className="muted">Unknown entity.</p>;
  const v = data.effective[entityId] ?? {};
  const derived = data.derived[entityId];
  const mind = data.minds.find((m) => m.entityId === entityId);
  const cast = def.cast.find((c) => c.id === e.defId);
  const enemy = def.enemies.find((x) => x.id === e.defId);
  const fixture = def.fixtures.find((x) => x.id === e.defId);
  const shop = fixture?.shop ? def.shops.find((s) => s.id === fixture.shop) : undefined;
  return (
    <div className="inspector">
      <h3>
        {entityIcon(def, e)} {e.name} <span className="muted">({e.kind}, {e.id})</span>
      </h3>
      <p>
        At <b>{spaceName(def, e.spaceId)}</b>
        {e.status === 'defeated' ? ` · defeated${e.respawnRound !== null ? `, returns round ${e.respawnRound}` : ''}` : ''}
        {e.status === 'eliminated' ? ' · eliminated' : ''}
        {e.status === 'removed' ? ' · removed from the board' : ''}
        {e.koTurns > 0 ? ` · knocked out (${e.koTurns} turn to skip)` : ''}
        {transformationOf(def, e) ? ` · transformed: ${transformationOf(def, e)?.name}` : ''}
      </p>
      {Object.keys(e.resources).length > 0 && (
        <table className="kv">
          <tbody>
            {Object.keys(e.resources).map((r) => (
              <tr key={r}>
                <td>{resourceName(def, r)}</td>
                <td>
                  {v[r] ?? e.resources[r]}
                  {v[r] !== undefined && v[r] !== e.resources[r] ? <span className="muted"> (base {e.resources[r]})</span> : null}
                  {def.resources.find((x) => x.id === r)?.visibility === 'owner' ? <span className="muted"> · secret</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {e.items.length > 0 && (
        <div className="block">
          <h4>Items</h4>
          <ul className="plain">
            {e.items.map((i) => {
              const d = def.items.find((x) => x.id === data.state.items[i]?.defId);
              return (
                <li key={i}>
                  {d?.icon ?? '•'} <b>{d?.name ?? i}</b>
                  {d?.concealed ? ' 🔒 concealed' : ''} <span className="muted">— {d ? data.rulebook.items[d.id] : ''}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {e.statuses.length > 0 && (
        <div className="block">
          <h4>Statuses</h4>
          <ul className="plain">
            {e.statuses.map((st) => (
              <li key={st.id}>
                {statusLabel(def, st)}
                {def.statuses.find((x) => x.id === st.defId)?.visibility === 'hidden' ? ' 🔒 hidden' : ''}
                {st.fresh ? <span className="muted"> · applied this turn</span> : null}
                <div className="muted">{data.rulebook.statuses[st.defId]}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(derived?.suppressed.length ?? 0) > 0 && <p className="warn">Cannot: {derived?.suppressed.map((x) => `${capabilityText(x.capability)} (${x.by})`).join('; ')}</p>}
      {(derived?.tags.length ?? 0) > 0 && <p>Tags: {derived?.tags.map((t) => `${def.tags.find((x) => x.id === t)?.name ?? t}${e.tags.includes(t) ? '' : ' (from status)'}`).join(', ')}</p>}
      {cast && (
        <div className="block">
          <h4>Personality</h4>
          <p>{cast.persona.voice}</p>
          <p className="muted">
            {Object.entries(cast.persona.traits)
              .map(([k, val]) => `${k} ${val}`)
              .join(' · ')}
          </p>
          {cast.persona.behaviors.length > 0 && <p className="muted">{cast.persona.behaviors.join(' ')}</p>}
        </div>
      )}
      {mind && <StrategyBlock mind={mind} />}
      {enemy && (
        <div className="block">
          <h4>{enemy.boss ? 'Boss 👑' : 'Enemy'}</h4>
          <p>
            Regenerates {enemy.regenPerRound} HP/round · {enemy.respawnAfterRounds ? `returns ${enemy.respawnAfterRounds} round(s) after defeat` : 'does not return'}
          </p>
          {enemy.rules.map((r) => (
            <p key={r.id} className="muted">
              <b>{r.name}</b>: {data.rulebook.rules[r.id]}
            </p>
          ))}
          {enemy.description && <p className="muted">{enemy.description}</p>}
        </div>
      )}
      {shop && (
        <div className="block">
          <h4>{shop.name}</h4>
          <ul>
            {shop.entries.map((en) => (
              <li key={en.id}>
                {'item' in en.grants ? def.items.find((i) => i.id === (en.grants as { item: string }).item)?.name : `${en.grants.amount} ${resourceName(def, en.grants.resource)}`} — {en.price.amount}{' '}
                {resourceName(def, en.price.resource)}
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
              <p className="muted">What {e.name} knows right now (hidden values removed) and the last packet sent to its model.</p>
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
  const m = data.metrics;
  const calls = [...data.aiCalls].reverse().slice(0, 60);
  return (
    <div className="ai-panel">
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
              {m.decisions} ({Object.entries(m.bySource)
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
              in {m.usage.inputTokens} (cached {m.usage.cachedInputTokens}) · out {m.usage.outputTokens} (reasoning {m.usage.reasoningTokens})
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
          <button onClick={() => void api.control(data.matchId, { action: 'resetProvider' })}>Retry provider</button>
        </p>
      )}
      <h4>Recent AI calls</h4>
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
