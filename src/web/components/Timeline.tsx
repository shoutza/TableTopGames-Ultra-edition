import { useEffect, useState } from 'react';
import type { CheckpointDto } from '../../shared/api.ts';
import { api, type MatchData } from '../api.ts';

/**
 * Rewind: go back to the start of any earlier round. The server replays the recorded inputs (no
 * model calls), keeps a backup of the cut history, and contestants remember only what they had
 * seen by then. Also shows the ruleset version and the rule-change history.
 */
export function Timeline({ data, onEditRules }: { data: MatchData; onEditRules: () => void }) {
  const [checkpoints, setCheckpoints] = useState<CheckpointDto[] | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { rulesVersion, running } = data.status;
  useEffect(() => {
    api
      .checkpoints(data.matchId)
      .then(setCheckpoints)
      .catch((err: unknown) => setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) }));
  }, [data.matchId, data.state.round, rulesVersion.mechanical]);
  const rewind = (c: CheckpointDto) => {
    if (!window.confirm(`Rewind to the start of ${c.round === 0 ? 'the match' : `round ${c.round}`}? Everything after it is undone (a backup of the history is kept on disk).`)) return;
    setBusy(true);
    setMessage(null);
    api
      .rewind(data.matchId, c.rev)
      .then((r) => setMessage({ ok: true, text: `Rewound to round ${r.round} (revision ${r.rev}). Backup: ${r.backup}` }))
      .catch((err: unknown) => setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) }))
      .finally(() => setBusy(false));
  };
  const changes = data.events.filter((e) => e.type === 'rulesChanged');
  return (
    <div className="timeline">
      <div className="tool">
        <h4>Rules</h4>
        <p>
          Version {rulesVersion.mechanical}
          {rulesVersion.cosmetic > 0 ? ` (+${rulesVersion.cosmetic} cosmetic)` : ''}. <button onClick={onEditRules}>✏️ Edit rules…</button>
        </p>
        {changes.length > 0 && (
          <ul className="plain small">
            {changes.map((e) => (
              <li key={e.seq}>
                Round {e.round}: {e.text}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="tool">
        <h4>Rewind</h4>
        {running && <p className="warn small">Pause the match to rewind.</p>}
        {checkpoints === null && <p className="muted">Loading…</p>}
        <div className="checkpoints">
          {checkpoints?.map((c) => (
            <button key={c.rev} disabled={running || busy || c.rev >= data.state.rev} onClick={() => rewind(c)} title={`revision ${c.rev}`}>
              {c.round === 0 ? 'Setup' : `Round ${c.round}`}
            </button>
          ))}
        </div>
        {message && <p className={message.ok ? 'ok small' : 'error small'}>{message.text}</p>}
      </div>
    </div>
  );
}
