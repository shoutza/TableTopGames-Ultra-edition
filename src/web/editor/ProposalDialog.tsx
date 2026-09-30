import { useMemo, useState } from 'react';
import type { DiffEntry, DryRun, Proposal, ProposalAnswers } from '../../schema/proposal.ts';

/**
 * Review of a proposed definition change before it is saved or applied: what changes (by level),
 * what contestants will be told, what happens to the running match (automatic steps, choices to
 * confirm, blocked changes with the reason), code-generated questions about ambiguous rules, and
 * dry runs showing where changed rules fire and where they do not.
 */

interface Props {
  proposal: Proposal;
  mode: 'scenario' | 'match';
  /** Match mode: mechanical changes wait for a pause. */
  needsPause?: boolean;
  paused?: boolean;
  onPause?: () => void;
  busy: boolean;
  error: string | null;
  confirmLabel: string;
  onConfirm: (answers: ProposalAnswers) => void;
  onCancel: () => void;
}

const LEVEL_TEXT: Record<string, string> = {
  none: 'No changes',
  cosmetic: 'Cosmetic (names, looks, layout): applied at once, nothing is interrupted',
  ai: 'Personality only: changes how contestants play, not the rules',
  mechanical: 'Rules change: applied as one step; the waiting decision is withdrawn and asked again',
};

const SCENARIO_LEVEL_TEXT: Record<string, string> = {
  none: 'No changes',
  cosmetic: 'Cosmetic changes only (names, looks, layout)',
  ai: 'Personality changes only',
  mechanical: 'Rule changes (matches already running keep their own copy of the rules)',
};

export function ProposalDialog({ proposal, mode, needsPause, paused, onPause, busy, error, confirmLabel, onConfirm, onCancel }: Props) {
  const [questions, setQuestions] = useState<Record<string, string>>({});
  const [migration, setMigration] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const i of proposal.migration?.issues ?? []) if (i.severity === 'confirm' && i.options?.[0]) out[i.id] = i.options[0].id;
    return out;
  });
  const errors = proposal.check.issues.filter((i) => i.severity === 'error');
  const warnings = proposal.check.issues.filter((i) => i.severity === 'warning');
  const blocked = proposal.migration?.issues.filter((i) => i.severity === 'blocked') ?? [];
  const confirms = proposal.migration?.issues.filter((i) => i.severity === 'confirm') ?? [];
  const autos = proposal.migration?.issues.filter((i) => i.severity === 'auto') ?? [];
  const unanswered = confirms.filter((i) => !migration[i.id]);
  const waitingForPause = mode === 'match' && needsPause === true && paused !== true;
  const canApply = proposal.ok && proposal.level !== 'none' && blocked.length === 0 && unanswered.length === 0 && !waitingForPause && !busy;
  const bySection = useMemo(() => {
    const map = new Map<string, DiffEntry[]>();
    for (const c of proposal.changes) map.set(c.section, [...(map.get(c.section) ?? []), c]);
    return [...map.entries()];
  }, [proposal.changes]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal proposal">
        <header>
          <h2>Review {mode === 'match' ? 'the rule change' : 'the changes'}</h2>
          <button className="icon" onClick={onCancel} title="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">
          {!proposal.ok && (
            <section className="card bad">
              <h3>⛔ The definition has problems</h3>
              <ul>
                {errors.slice(0, 20).map((e, i) => (
                  <li key={i}>{e.message}</li>
                ))}
              </ul>
            </section>
          )}
          {proposal.ok && (
            <>
              <p className={`level level-${proposal.level}`}>{mode === 'match' ? LEVEL_TEXT[proposal.level] : SCENARIO_LEVEL_TEXT[proposal.level]}</p>
              {blocked.length > 0 && (
                <section className="card bad">
                  <h3>⛔ Cannot be applied to this match</h3>
                  {blocked.map((b) => (
                    <p key={b.id}>
                      <strong>{b.title}.</strong> {b.detail}
                    </p>
                  ))}
                </section>
              )}
              {waitingForPause && (
                <section className="card warnbox">
                  <strong>Pause the match to apply rule changes.</strong> Cosmetic changes apply while it plays; rules change only between steps.{' '}
                  {onPause && <button onClick={onPause}>Pause now</button>}
                </section>
              )}
              {confirms.length > 0 && (
                <section className="card">
                  <h3>Confirm what happens to the match</h3>
                  {confirms.map((c) => (
                    <div key={c.id} className="question">
                      <div>
                        <strong>{c.title}</strong> <span className="muted">{c.detail}</span>
                      </div>
                      {(c.options ?? []).map((o) => (
                        <label key={o.id} className="radio">
                          <input type="radio" name={c.id} checked={migration[c.id] === o.id} onChange={() => setMigration({ ...migration, [c.id]: o.id })} /> {o.label}
                        </label>
                      ))}
                    </div>
                  ))}
                </section>
              )}
              {autos.length > 0 && (
                <section className="card">
                  <h3>Happens automatically</h3>
                  <ul>
                    {autos.map((a) => (
                      <li key={a.id}>
                        <strong>{a.title}.</strong> {a.detail}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {proposal.questions.length > 0 && (
                <section className="card">
                  <h3>Questions</h3>
                  <p className="muted small">These are easy to get subtly wrong. The preselected answer keeps what you wrote.</p>
                  {proposal.questions.map((q) => (
                    <div key={q.id} className="question">
                      <div>
                        <span className="muted small">{q.where}: </span>
                        {q.text}
                      </div>
                      {q.options.map((o) => (
                        <label key={o.id} className="radio">
                          <input type="radio" name={q.id} checked={(questions[q.id] ?? q.default) === o.id} onChange={() => setQuestions({ ...questions, [q.id]: o.id })} /> {o.label}
                          {o.id === q.default && <span className="muted small"> (as written)</span>}
                        </label>
                      ))}
                    </div>
                  ))}
                </section>
              )}
              {mode === 'match' && proposal.level === 'mechanical' && (
                <section className="card">
                  <h3>What contestants are told</h3>
                  {proposal.summary.length > 0 ? (
                    <ul>
                      {proposal.summary.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">Nothing (only hidden rules change).</p>
                  )}
                </section>
              )}
              <section className="card">
                <h3>Changes ({proposal.changes.length})</h3>
                {bySection.map(([section, list]) => (
                  <details key={section} open={list.length <= 12}>
                    <summary>
                      {section} ({list.length})
                    </summary>
                    <ul className="changes">
                      {list.map((c) => (
                        <li key={`${c.section}:${c.id}`}>
                          <span className={`chip change-${c.change}`}>{c.change}</span> <span className={`chip lvl-${c.level}`}>{c.level}</span> <strong>{c.name}</strong>
                          {c.hidden && <span className="muted"> (hidden)</span>}
                          {c.before && c.change !== 'added' && <div className="before">before: {c.before}</div>}
                          {c.after && c.change !== 'removed' && <div className="after">now: {c.after}</div>}
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
              </section>
              {proposal.dryRuns.length > 0 && (
                <section className="card">
                  <h3>Dry runs</h3>
                  <p className="muted small">Each new or changed rule, tried on a copy of the {mode === 'match' ? 'match' : 'scenario'}: examples where it fires and where it does not.</p>
                  {proposal.dryRuns.map((d) => (
                    <DryRunView key={d.rule} run={d} />
                  ))}
                </section>
              )}
              {warnings.length > 0 && (
                <section className="card">
                  <h3>⚠ Warnings</h3>
                  <ul>
                    {warnings.map((w, i) => (
                      <li key={i}>{w.message}</li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
        <footer>
          {error && <span className="error">{error}</span>}
          <span className="grow" />
          <button onClick={onCancel}>Keep editing</button>
          <button className="primary" disabled={!canApply} onClick={() => onConfirm({ questions, migration })}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

function DryRunView({ run }: { run: DryRun }) {
  return (
    <details className="dryrun" open>
      <summary>
        <strong>{run.name}</strong> — {run.fired.length > 0 ? `fired in ${run.fired.length} example(s)` : 'did not fire'}
      </summary>
      <p className="generated">{run.text}</p>
      {run.fired.map((ex, i) => (
        <div key={`f${i}`} className="example fired">
          <div>✅ {ex.trigger}</div>
          {ex.checks.length > 0 && <div className="checks">{ex.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.text}`).join(' · ')}</div>}
          <ul>
            {ex.results.map((r, j) => (
              <li key={j}>{r}</li>
            ))}
          </ul>
        </div>
      ))}
      {run.notFired.map((ex, i) => (
        <div key={`n${i}`} className="example missed">
          <div>⏸ {ex.trigger}</div>
          {ex.checks.length > 0 && <div className="checks">{ex.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.text}`).join(' · ')}</div>}
          <div className="muted small">{ex.results.join(', ')}</div>
        </div>
      ))}
      {run.notes.map((n, i) => (
        <p key={i} className="muted small">
          {n}
        </p>
      ))}
    </details>
  );
}
