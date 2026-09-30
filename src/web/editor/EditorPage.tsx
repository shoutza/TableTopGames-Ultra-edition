import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CheckIssue, CheckResult, Proposal, ProposalAnswers } from '../../schema/proposal.ts';
import type { ChangeLogEntry, RulesVersion } from '../../shared/api.ts';
import { blankScenario } from '../../shared/templates.ts';
import { api } from '../api.ts';
import { BoardEditor } from './BoardEditor.tsx';
import { EditorContext, JsonBox, type EditorEnv } from './fields.tsx';
import { catalogOf, sectionOf, type Json } from './model.ts';
import { ProposalDialog } from './ProposalDialog.tsx';
import { ListSection, RulesSection, SECTION_FORMS } from './Sections.tsx';
import { SettingsEditor } from './SettingsEditor.tsx';

/**
 * The scenario editor. Everything is editable through forms (and a JSON tab everywhere); every
 * change is checked live by the server, and saving (or applying to a running match) goes through
 * the proposal review: changes, questions, dry runs and, mid-match, what happens to the match.
 */

export type EditorTarget =
  | { kind: 'scenario'; id: string | null; copyFrom?: string | undefined }
  | { kind: 'match'; matchId: string; paused: boolean; onPause: () => void };

const SECTIONS: Array<{ id: string; label: string }> = [
  { id: 'overview', label: 'Overview & settings' },
  { id: 'board', label: 'Board' },
  { id: 'resources', label: 'Resources' },
  { id: 'tags', label: 'Tags' },
  { id: 'items', label: 'Items' },
  { id: 'statuses', label: 'Statuses' },
  { id: 'shops', label: 'Shops' },
  { id: 'fixtures', label: 'Fixtures' },
  { id: 'enemies', label: 'Enemies' },
  { id: 'decks', label: 'Decks & cards' },
  { id: 'actions', label: 'Actions' },
  { id: 'objectives', label: 'Objectives' },
  { id: 'cast', label: 'Cast' },
  { id: 'rules', label: 'Rules' },
  { id: 'json', label: 'JSON (whole scenario)' },
];

/** Which editor section an issue path belongs to. */
function sectionFor(path: Array<string | number> | null): string {
  const s = sectionOf(path);
  if (!s) return 'overview';
  if (s.section === 'spaces' || s.section === 'connections' || s.section === 'layout') return 'board';
  if (s.section === 'settings' || s.section === 'id' || s.section === 'name') return 'overview';
  return SECTIONS.some((x) => x.id === s.section) ? s.section : 'json';
}

interface History {
  past: Json[];
  future: Json[];
  lastKey: string | null;
  lastAt: number;
}

function storageKey(target: EditorTarget): string {
  return target.kind === 'match' ? `ttg-draft:match:${target.matchId}` : `ttg-draft:scenario:${target.id ?? 'new'}`;
}

function readStored(key: string): Json | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Json) : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: Json | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be unavailable (private windows); drafts then live only in memory.
  }
}

export function EditorPage({ target, onClose, onPlay }: { target: EditorTarget; onClose: () => void; onPlay?: (matchId: string) => void }) {
  const [draft, setDraft] = useState<Json | null>(null);
  const [saved, setSaved] = useState<Json | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  /** The saved scenario this draft started from (itself, or the one it copies): reviews compare against it. */
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [builtIn, setBuiltIn] = useState(false);
  const [baseVersion, setBaseVersion] = useState<RulesVersion | null>(null);
  const [changes, setChanges] = useState<ChangeLogEntry[]>([]);
  const [section, setSection] = useState('overview');
  const [focus, setFocus] = useState<number | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<{ proposal: Proposal; needsPause: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [restorable, setRestorable] = useState<Json | null>(null);
  const history = useRef<History>({ past: [], future: [], lastKey: null, lastAt: 0 });
  const [, bump] = useState(0);
  const key = storageKey(target);

  // --- loading -------------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        let def: Json;
        if (target.kind === 'match') {
          const r = await api.matchDefinition(target.matchId);
          def = r.definition as unknown as Json;
          setBaseVersion(r.rulesVersion);
          setChanges(r.changes);
          setSavedId(null);
        } else if (target.id) {
          const r = await api.scenario(target.id);
          def = r.definition as Json;
          setBuiltIn(r.builtIn);
          setSavedId(r.builtIn ? null : r.id);
          setSourceId(r.id);
        } else if (target.copyFrom) {
          const r = await api.scenario(target.copyFrom);
          const list = await api.scenarios();
          let id = `${r.id}-copy`;
          for (let i = 2; list.some((s) => s.id === id); i++) id = `${r.id}-copy${i}`;
          def = { ...(r.definition as Json), id, name: `${String((r.definition as Json)['name'])} (copy)`.slice(0, 80) };
          setSourceId(r.id);
        } else {
          const list = await api.scenarios();
          let id = 'my-scenario';
          for (let i = 2; list.some((s) => s.id === id); i++) id = `my-scenario-${i}`;
          def = blankScenario(id, 'My Scenario') as unknown as Json;
        }
        if (cancelled) return;
        setDraft(def);
        setSaved(target.kind === 'scenario' && !target.id ? null : def);
        const stored = readStored(key);
        if (stored && JSON.stringify(stored) !== JSON.stringify(def)) setRestorable(stored);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.kind === 'match' ? target.matchId : `${target.id}:${target.copyFrom}`]);

  // --- editing and undo ----------------------------------------------------------------------
  const edit = useCallback((next: Json, coalesce?: string) => {
    setDraft((prev) => {
      if (prev === null || prev === next) return next;
      const h = history.current;
      const now = Date.now();
      const merge = coalesce !== undefined && h.lastKey === coalesce && now - h.lastAt < 1500;
      if (!merge) {
        h.past.push(prev);
        if (h.past.length > 200) h.past.shift();
      }
      h.future = [];
      h.lastKey = coalesce ?? null;
      h.lastAt = now;
      return next;
    });
    bump((n) => n + 1);
  }, []);
  const undo = useCallback(() => {
    const h = history.current;
    const prev = h.past.pop();
    if (prev === undefined) return;
    setDraft((cur) => {
      if (cur) h.future.push(cur);
      return prev;
    });
    h.lastKey = null;
    bump((n) => n + 1);
  }, []);
  const redo = useCallback(() => {
    const h = history.current;
    const next = h.future.pop();
    if (next === undefined) return;
    setDraft((cur) => {
      if (cur) h.past.push(cur);
      return next;
    });
    h.lastKey = null;
    bump((n) => n + 1);
  }, []);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      if ((ev.target as HTMLElement | null)?.closest('input, textarea')) return;
      if (ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
        ev.preventDefault();
        undo();
      } else if (ev.key.toLowerCase() === 'y' || (ev.key.toLowerCase() === 'z' && ev.shiftKey)) {
        ev.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // --- live check and local draft --------------------------------------------------------------
  const seq = useRef(0);
  useEffect(() => {
    if (!draft) return;
    const n = ++seq.current;
    setChecking(true);
    const timer = setTimeout(() => {
      api
        .checkDefinition(draft)
        .then((r) => {
          if (n === seq.current) setCheck(r);
        })
        .catch((err: unknown) => n === seq.current && setError(err instanceof Error ? err.message : String(err)))
        .finally(() => n === seq.current && setChecking(false));
    }, 350);
    const store = setTimeout(() => {
      if (saved && JSON.stringify(saved) === JSON.stringify(draft)) writeStored(key, null);
      else writeStored(key, draft);
    }, 800);
    return () => {
      clearTimeout(timer);
      clearTimeout(store);
    };
  }, [draft, saved, key]);

  const dirty = useMemo(() => draft !== null && (saved === null || JSON.stringify(saved) !== JSON.stringify(draft)), [draft, saved]);
  useEffect(() => {
    const warn = (ev: BeforeUnloadEvent) => {
      if (dirty) ev.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const env: EditorEnv = useMemo(() => ({ catalog: catalogOf(draft ?? {}), texts: check?.texts ?? {}, issues: check?.issues ?? [], readOnly: false }), [draft, check]);
  const counts = useMemo(() => {
    const out: Record<string, { errors: number; warnings: number }> = {};
    for (const i of check?.issues ?? []) {
      const s = sectionFor(i.path);
      const c = out[s] ?? { errors: 0, warnings: 0 };
      if (i.severity === 'error') c.errors++;
      else if (i.severity === 'warning') c.warnings++;
      out[s] = c;
    }
    return out;
  }, [check]);

  const goTo = (issue: CheckIssue) => {
    setSection(sectionFor(issue.path));
    const s = sectionOf(issue.path);
    setFocus(s?.index ?? null);
  };

  // --- review, save and apply -------------------------------------------------------------------
  const startReview = async () => {
    if (!draft) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (target.kind === 'match') {
        const r = await api.proposeMatch(target.matchId, draft);
        setBaseVersion(r.baseVersion);
        setReview({ proposal: r.proposal, needsPause: r.needsPause });
      } else {
        let def = draft;
        if (builtIn && String(draft['id']) === target.id) {
          const answer = window.prompt('Save your copy under which id? (lowercase letters, digits, . _ -)', `${String(draft['id'])}-copy`);
          if (!answer) return;
          def = { ...draft, id: answer.toLowerCase().replace(/[^a-z0-9_.-]/g, ''), name: `${String(draft['name'])} (copy)`.slice(0, 80) };
          edit(def);
        }
        const id = String(def['id'] ?? '');
        if (savedId !== id) {
          const list = await api.scenarios();
          const existing = list.find((s) => s.id === id);
          if (existing?.builtIn) throw new Error(`“${id}” is a built-in scenario; give your copy another id (Overview).`);
          if (existing && !window.confirm(`A scenario with the id “${id}” already exists (${existing.name}). Replace it?`)) return;
        }
        const base = savedId === id ? savedId : sourceId;
        setReview({ proposal: await api.proposeScenario(def, base), needsPause: false });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (answers: ProposalAnswers) => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      if (target.kind === 'match') {
        if (!baseVersion) throw new Error('reload the rules first');
        const r = await api.applyMatch(target.matchId, draft, answers, baseVersion);
        const fresh = await api.matchDefinition(target.matchId);
        setDraft(fresh.definition as unknown as Json);
        setSaved(fresh.definition as unknown as Json);
        setBaseVersion(fresh.rulesVersion);
        setChanges(fresh.changes);
        writeStored(key, null);
        setReview(null);
        setNotice(r.level === 'mechanical' ? `Rules changed (version ${r.rulesVersion.mechanical}).${r.invalidated ? ` The waiting decision ${r.invalidated} was withdrawn and asked again.` : ''}` : 'Applied.');
      } else {
        const id = String(draft['id'] ?? '');
        const r = await api.saveScenario(id, draft, { questions: answers.questions }, savedId === id ? savedId : sourceId);
        const def = r.definition as Json;
        setDraft(def);
        setSaved(def);
        setSavedId(id);
        setSourceId(id);
        setBuiltIn(false);
        writeStored(key, null);
        writeStored(storageKey({ kind: 'scenario', id }), null);
        setReview(null);
        setNotice(`Saved “${String(def['name'])}”.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const exportJson = () => {
    if (!draft) return;
    const blob = new Blob([`${JSON.stringify(draft, null, 2)}\n`], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${String(draft['id'] ?? 'scenario')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const importJson = (file: File) => {
    file
      .text()
      .then((text) => {
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a scenario (expected a JSON object)');
        edit(parsed as Json);
        setNotice(`Imported ${file.name}. Review the problems list, then save.`);
      })
      .catch((err: unknown) => setError(`Import failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  const play = async () => {
    if (!savedId || !onPlay) return;
    setBusy(true);
    try {
      const { matchId } = await api.createMatch(savedId);
      onPlay(matchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!draft) return <main className="loading">{error ?? 'Loading…'}</main>;
  const errors = check?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = check?.issues.filter((i) => i.severity !== 'error') ?? [];
  const title = target.kind === 'match' ? `Rules of match ${target.matchId}` : String(draft['name'] ?? 'Scenario');
  const props = { def: draft, edit, focus };

  return (
    <EditorContext.Provider value={env}>
      <div className="editor">
        <header className="topbar">
          <button onClick={() => (dirty && !window.confirm('Leave with unsaved changes? (A draft is kept in this browser.)') ? undefined : onClose())}>← {target.kind === 'match' ? 'Back to the match' : 'Library'}</button>
          <strong>{title}</strong>
          {builtIn && <span className="chip">built-in (save as a copy)</span>}
          {target.kind === 'match' && baseVersion && <span className="chip">rules v{baseVersion.mechanical}.{baseVersion.cosmetic}</span>}
          <span className={errors.length > 0 ? 'error' : 'ok'}>{checking ? 'checking…' : errors.length > 0 ? `⛔ ${errors.length} problem${errors.length === 1 ? '' : 's'}` : '✓ valid'}</span>
          {warnings.length > 0 && <span className="warn">⚠ {warnings.length}</span>}
          {dirty && <span className="muted">unsaved changes</span>}
          <span className="grow" />
          <button disabled={history.current.past.length === 0} onClick={undo} title="Undo (Ctrl+Z)">
            ↶ Undo
          </button>
          <button disabled={history.current.future.length === 0} onClick={redo} title="Redo (Ctrl+Y)">
            ↷ Redo
          </button>
          <label className="button">
            Import
            <input type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
          </label>
          <button onClick={exportJson}>Export</button>
          {target.kind === 'scenario' && onPlay && (
            <button disabled={!savedId || dirty || busy} title={savedId ? (dirty ? 'Save first' : 'Start a match of this scenario') : 'Save first'} onClick={() => void play()}>
              ▶ Play
            </button>
          )}
          <button className="primary" disabled={busy || !dirty} onClick={() => void startReview()}>
            {target.kind === 'match' ? 'Review & apply…' : builtIn ? 'Save as copy…' : 'Review & save…'}
          </button>
        </header>
        {restorable && (
          <div className="banner warnbox">
            An unsaved draft from earlier is stored in this browser.{' '}
            <button
              onClick={() => {
                edit(restorable);
                setRestorable(null);
              }}
            >
              Restore it
            </button>{' '}
            <button
              onClick={() => {
                writeStored(key, null);
                setRestorable(null);
              }}
            >
              Discard
            </button>
          </div>
        )}
        {(error || notice) && (
          <div className={`banner ${error ? 'error' : 'ok'}`}>
            {error ?? notice}{' '}
            <button className="link" onClick={() => (setError(null), setNotice(null))}>
              dismiss
            </button>
          </div>
        )}
        {builtIn && section === 'overview' && <div className="banner">This is a built-in scenario. Change its id and name here, then save it as your own copy.</div>}
        <div className="editor-body">
          <nav className="editor-nav">
            {SECTIONS.map((s) => (
              <button key={s.id} className={section === s.id ? 'active' : ''} onClick={() => (setSection(s.id), setFocus(null))}>
                <span>{s.label}</span>
                <span className="count">
                  {s.id !== 'overview' && s.id !== 'board' && s.id !== 'json' && Array.isArray(draft[s.id]) ? (draft[s.id] as unknown[]).length : s.id === 'board' ? ((draft['spaces'] as unknown[] | undefined)?.length ?? 0) : ''}
                  {counts[s.id]?.errors ? <span className="dot error"> ●</span> : counts[s.id]?.warnings ? <span className="dot warn"> ●</span> : null}
                </span>
              </button>
            ))}
            {target.kind === 'match' && (
              <button className={section === 'history' ? 'active' : ''} onClick={() => setSection('history')}>
                <span>Change log</span>
                <span className="count">{changes.length}</span>
              </button>
            )}
          </nav>
          <main className="editor-main">
            {section === 'overview' && <SettingsEditor def={draft} edit={edit} check={check} idLocked={target.kind === 'match' || savedId !== null} />}
            {section === 'board' && <BoardEditor def={draft} edit={edit} />}
            {section === 'rules' && <RulesSection {...props} />}
            {SECTION_FORMS[section] && <ListSection key={section} {...props} section={section} title={SECTION_FORMS[section].title} form={SECTION_FORMS[section].form} />}
            {section === 'json' && (
              <div>
                <p className="muted small">The whole scenario as JSON. Edits apply as soon as the text parses; the problems list shows what the engine thinks of them.</p>
                <JsonBox value={draft} onChange={(v) => v && typeof v === 'object' && !Array.isArray(v) && edit(v as Json, 'json')} rows={40} />
              </div>
            )}
            {section === 'history' && <ChangeLog changes={changes} />}
          </main>
          <aside className="editor-issues">
            <h3>Problems</h3>
            {check === null && <p className="muted">Checking…</p>}
            {check && check.issues.length === 0 && <p className="ok">No problems found.</p>}
            <ul>
              {check?.issues.slice(0, 100).map((i, k) => (
                <li key={k} className={i.severity === 'error' ? 'error' : 'warn'}>
                  <button className="link" onClick={() => goTo(i)}>
                    {i.severity === 'error' ? '⛔' : i.severity === 'warning' ? '⚠' : 'ℹ'} {i.message}
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        </div>
        {review && (
          <ProposalDialog
            proposal={review.proposal}
            mode={target.kind}
            needsPause={review.needsPause}
            paused={target.kind === 'match' ? target.paused : true}
            {...(target.kind === 'match' ? { onPause: target.onPause } : {})}
            busy={busy}
            error={error}
            confirmLabel={target.kind === 'match' ? 'Apply to the match' : 'Save scenario'}
            onConfirm={(a) => void confirm(a)}
            onCancel={() => setReview(null)}
          />
        )}
      </div>
    </EditorContext.Provider>
  );
}

function ChangeLog({ changes }: { changes: ChangeLogEntry[] }) {
  if (changes.length === 0) return <p className="muted">No changes yet in this match.</p>;
  return (
    <ul className="changelog">
      {[...changes].reverse().map((c, i) => (
        <li key={i} className="card">
          <strong>
            v{c.rulesVersion.mechanical}.{c.rulesVersion.cosmetic}
          </strong>{' '}
          · round {c.round} · <span className={`chip lvl-${c.level}`}>{c.level}</span>
          <ul>
            {c.changes.slice(0, 20).map((d, j) => (
              <li key={j}>
                {d.change} {d.section.replace(/s$/, '')} <strong>{d.name}</strong>
                {d.after ? `: ${d.after}` : ''}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
