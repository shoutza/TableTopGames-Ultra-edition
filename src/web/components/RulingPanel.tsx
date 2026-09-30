import { useEffect, useState } from 'react';
import { api, type MatchData } from '../api.ts';

/**
 * A GM ruling is waiting (a rule asked, or a contestant attempted something freeform): the question,
 * the options, and the time left before it resolves to "No effect". The GM tools stay usable, so
 * the GM can shape the result (grant, teleport, adjust) before ruling.
 */
export function RulingPanel({ data }: { data: MatchData }) {
  const ruling = data.status.ruling;
  const decision = data.state.pendingDecision;
  const [received, setReceived] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setReceived(Date.now()), [ruling?.decisionId, ruling?.timeLeftMs]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  if (!ruling || !decision || decision.actor !== 'gm') return null;
  const attempt = [...data.events].reverse().find((e) => e.type === 'attempted');
  const asked = [...data.events].reverse().find((e) => e.type === 'gmAsked');
  const left = ruling.timeLeftMs === null ? null : Math.max(0, ruling.timeLeftMs - (data.status.running ? now - received : 0));
  const answer = (optionId: string) => {
    setBusy(true);
    setError(null);
    api
      .ruling(data.matchId, optionId)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="ruling">
      <div className="ruling-head">
        <strong>⚖ Your ruling</strong>
        {left !== null && data.status.running ? (
          <span className={left < 10_000 ? 'error' : 'muted'}>{Math.ceil(left / 1000)} s left, then “No effect”</span>
        ) : (
          <span className="muted">no clock while paused: take your time</span>
        )}
      </div>
      <p className="ruling-q">{decision.prompt ?? (asked?.type === 'gmAsked' ? asked.question : 'The GM decides.')}</p>
      {attempt?.type === 'attempted' && asked?.seq !== undefined && attempt.seq >= asked.seq - 1 && <p className="muted small">They attempt: “{attempt.text}”. Use the GM tools to apply any result first, then rule.</p>}
      <div className="ruling-options">
        {decision.options.map((o) => (
          <button key={o.id} disabled={busy} className={o.id === 'ch:none' ? '' : 'primary'} onClick={() => answer(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
