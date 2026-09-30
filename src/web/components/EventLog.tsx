import { useEffect, useMemo, useRef, useState } from 'react';
import type { EventDto } from '../../shared/api.ts';
import type { MatchData } from '../api.ts';

/** The readable history, plus a "why did this happen?" trace for any event. */

const NOISE = new Set(['left', 'entered', 'turnStarted', 'turnEnded', 'spin', 'rolled', 'passed']);

function causeLabel(data: MatchData, e: EventDto): string {
  const c = e.cause;
  const ruleName = (id: string) => data.definition.rules.find((r) => r.id === id)?.name ?? id;
  const hidden = (id: string) => data.definition.rules.find((r) => r.id === id)?.visibility === 'hidden';
  switch (c.kind) {
    case 'rule':
      return c.rule ? `rule “${ruleName(c.rule)}”${hidden(c.rule) ? ' 🔒 hidden' : ''}` : 'a rule';
    case 'action':
      return `action by ${c.entity ? (data.state.entities[c.entity]?.name ?? c.entity) : 'a contestant'}`;
    case 'gm':
      return 'GM intervention';
    case 'reward':
      return `reward for defeating ${c.entity ? (data.state.entities[c.entity]?.name ?? c.entity) : 'an enemy'}`;
    case 'card': {
      const card = data.definition.decks.flatMap((d) => d.cards).find((x) => x.id === c.card);
      return `card “${card?.name ?? c.card ?? '?'}” drawn by ${c.entity ? (data.state.entities[c.entity]?.name ?? c.entity) : 'someone'}`;
    }
    case 'choice':
      return `choice made by ${c.entity ? (data.state.entities[c.entity]?.name ?? c.entity) : 'a contestant'}${c.rule ? ` (offered by rule “${ruleName(c.rule)}”${hidden(c.rule) ? ' 🔒 hidden' : ''})` : ''}`;
    case 'objective': {
      const inst = data.state.objectives.find((o) => o.owner === c.entity && o.done);
      const def = data.definition.objectives.find((o) => o.id === inst?.defId);
      return `secret objective${def ? ` “${def.name}”` : ''} completed by ${c.entity ? (data.state.entities[c.entity]?.name ?? c.entity) : 'a contestant'}`;
    }
    case 'system':
      return 'game system';
  }
}

export function WhyPanel({ data, seq, onPick }: { data: MatchData; seq: number; onPick: (seq: number) => void }) {
  const chain: EventDto[] = [];
  let cur = data.bySeq.get(seq);
  const seen = new Set<number>();
  while (cur && !seen.has(cur.seq) && chain.length < 20) {
    seen.add(cur.seq);
    chain.push(cur);
    cur = cur.cause.parent !== undefined ? data.bySeq.get(cur.cause.parent) : undefined;
  }
  const first = chain[0];
  if (!first) return null;
  const firing = first.cause.firing !== undefined ? data.firings.get(first.cause.firing) : undefined;
  return (
    <div className="why">
      <h4>Why did this happen?</h4>
      <ol>
        {chain.map((e, i) => (
          <li key={e.seq}>
            <button className="link" onClick={() => onPick(e.seq)}>
              {e.text}
            </button>
            <span className="muted"> — {i === chain.length - 1 && e.cause.parent === undefined ? `caused by ${causeLabel(data, e)}` : `via ${causeLabel(data, e)}`}</span>
          </li>
        ))}
      </ol>
      {firing && (
        <div>
          <p className="muted">Conditions checked when the rule ran:</p>
          <ul>
            {firing.checks.map((c, i) => (
              <li key={i}>
                {c.ok ? '✔' : '✘'} {c.text}
              </li>
            ))}
            {firing.checks.length === 0 && <li className="muted">(no conditions)</li>}
          </ul>
        </div>
      )}
      {first.cause.rule && (
        <p className="muted">
          Rule text: {data.definition.rules.find((r) => r.id === first.cause.rule)?.provenance?.sourceText ?? data.definition.rules.find((r) => r.id === first.cause.rule)?.description ?? '(see definition)'}
        </p>
      )}
    </div>
  );
}

export function EventLog({ data, selected, onSelect, holdAfter }: { data: MatchData; selected: number | null; onSelect: (seq: number) => void; holdAfter: number | null }) {
  const [all, setAll] = useState(false);
  const [follow, setFollow] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);
  // While the wheel replays a fight, later lines wait so the log does not spoil the result.
  const events = useMemo(
    // "X chose: …" repeats the result line that follows; it stays only when the contestant said something.
    () => (all ? data.events : data.events.filter((e) => !NOISE.has(e.type) && !(e.type === 'decided' && !e.say))).filter((e) => holdAfter === null || e.seq <= holdAfter).slice(-600),
    [data.events, all, holdAfter],
  );
  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ block: 'end' });
  }, [events.length, follow]);
  let lastRound = -1;
  return (
    <div className="log">
      <div className="log-toolbar">
        <label className="check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show every event
        </label>
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
      </div>
      <div className="log-lines">
        {events.map((e) => {
          const header = e.round !== lastRound ? <div className="round-sep">Round {e.round}</div> : null;
          lastRound = e.round;
          const hidden = e.cause.rule !== undefined && data.definition.rules.find((r) => r.id === e.cause.rule)?.visibility === 'hidden';
          return (
            <div key={e.seq}>
              {header}
              <button className={`log-line ${e.type} ${selected === e.seq ? 'selected' : ''}`} onClick={() => onSelect(e.seq)}>
                {hidden ? '🔒 ' : ''}
                {e.text}
              </button>
            </div>
          );
        })}
        {holdAfter !== null && <div className="muted">⚔ the wheel is spinning…</div>}
        <div ref={bottom} />
      </div>
    </div>
  );
}
