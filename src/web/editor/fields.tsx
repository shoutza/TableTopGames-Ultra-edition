import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { CheckIssue } from '../../schema/proposal.ts';
import type { Catalog, Path } from './model.ts';
import type { RefSection } from './spec.ts';

/** Shared editor context: reference catalog, generated texts and located issues. */
export interface EditorEnv {
  catalog: Catalog;
  texts: Record<string, string>;
  issues: CheckIssue[];
  readOnly: boolean;
}

export const EditorContext = createContext<EditorEnv>({
  catalog: { resources: [], tags: [], spaceTags: [], entityTags: [], spaces: [], items: [], statuses: [], enemies: [], decks: [], cards: [], actions: [], shopEntries: [], shops: [] },
  texts: {},
  issues: [],
  readOnly: false,
});

export function useEnv(): EditorEnv {
  return useContext(EditorContext);
}

/** Issues located at or under `path`. */
export function issuesUnder(issues: CheckIssue[], path: Path): CheckIssue[] {
  return issues.filter((i) => i.path !== null && path.every((p, k) => i.path?.[k] === p));
}

export function Row({ label, help, children }: { label: string; help?: string | undefined; children: ReactNode }) {
  return (
    <label className="ed-row" title={help}>
      <span className="ed-label">{label}</span>
      {children}
    </label>
  );
}

export function TextInput({ value, onChange, placeholder, multiline, max, wide }: { value: string | undefined; onChange: (v: string) => void; placeholder?: string; multiline?: boolean; max?: number; wide?: boolean }) {
  const { readOnly } = useEnv();
  if (multiline) return <textarea className="ed-text" disabled={readOnly} value={value ?? ''} maxLength={max} placeholder={placeholder} rows={2} onChange={(e) => onChange(e.target.value)} />;
  return <input className={wide ? 'ed-wide' : undefined} disabled={readOnly} value={value ?? ''} maxLength={max} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

/** Integer input; while typing, partial input is kept locally until it parses. */
export function IntInput({ value, onChange, min, max, optional, placeholder }: { value: number | undefined | null; onChange: (v: number | undefined) => void; min?: number | undefined; max?: number | undefined; optional?: boolean; placeholder?: string }) {
  const { readOnly } = useEnv();
  const [text, setText] = useState(value === undefined || value === null ? '' : String(value));
  useEffect(() => setText(value === undefined || value === null ? '' : String(value)), [value]);
  return (
    <input
      className="ed-int"
      type="number"
      disabled={readOnly}
      value={text}
      min={min}
      max={max}
      placeholder={placeholder ?? (optional ? '—' : '')}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value.trim() === '') {
          if (optional) onChange(undefined);
          return;
        }
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(Math.trunc(n));
      }}
    />
  );
}

export function Checkbox({ value, onChange, label }: { value: boolean | undefined; onChange: (v: boolean) => void; label: string }) {
  const { readOnly } = useEnv();
  return (
    <label className="check">
      <input type="checkbox" disabled={readOnly} checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

export function EnumSelect({ values, value, onChange, optional, labels }: { values: readonly string[]; value: string | undefined; onChange: (v: string | undefined) => void; optional?: boolean; labels?: Record<string, string> | undefined }) {
  const { readOnly } = useEnv();
  return (
    <select disabled={readOnly} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}>
      {(optional || value === undefined) && <option value="">{optional ? 'any' : '—'}</option>}
      {values.map((v) => (
        <option key={v} value={v}>
          {labels?.[v] ?? v}
        </option>
      ))}
    </select>
  );
}

export function RefSelect({ section, value, onChange, optional }: { section: RefSection; value: string | undefined; onChange: (v: string | undefined) => void; optional?: boolean }) {
  const { catalog, readOnly } = useEnv();
  const entries = catalog[section];
  const known = value === undefined || entries.some((e) => e.id === value);
  return (
    <select className={known ? undefined : 'ed-bad'} disabled={readOnly} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}>
      {(optional || value === undefined) && <option value="">{optional ? 'any' : '— choose —'}</option>}
      {!known && <option value={value}>⚠ {value} (does not exist)</option>}
      {entries.map((e) => (
        <option key={e.id} value={e.id}>
          {e.name} ({e.id})
        </option>
      ))}
    </select>
  );
}

/** A list of references shown as chips. */
export function RefMulti({ section, value, onChange, max }: { section: RefSection; value: string[] | undefined; onChange: (v: string[]) => void; max?: number }) {
  const { catalog, readOnly } = useEnv();
  const list = value ?? [];
  const name = (id: string) => catalog[section].find((e) => e.id === id)?.name;
  const free = catalog[section].filter((e) => !list.includes(e.id));
  return (
    <span className="ed-chips">
      {list.map((id) => (
        <span key={id} className={`chip${name(id) ? '' : ' ed-bad'}`}>
          {name(id) ?? `⚠ ${id}`}
          {!readOnly && (
            <button className="chip-x" title="Remove" onClick={() => onChange(list.filter((x) => x !== id))}>
              ×
            </button>
          )}
        </span>
      ))}
      {!readOnly && free.length > 0 && (max === undefined || list.length < max) && (
        <select value="" onChange={(e) => e.target.value && onChange([...list, e.target.value])}>
          <option value="">+ add</option>
          {free.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

/** Raw JSON editing of any value; applied when it parses. */
export function JsonBox({ value, onChange, rows = 8 }: { value: unknown; onChange: (v: unknown) => void; rows?: number }) {
  const { readOnly } = useEnv();
  const pretty = JSON.stringify(value, null, 2) ?? '';
  const [text, setText] = useState(pretty);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(pretty);
    setError(null);
  }, [pretty]);
  return (
    <div className="ed-json">
      <textarea
        spellCheck={false}
        disabled={readOnly}
        rows={Math.min(30, Math.max(rows, pretty.split('\n').length))}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed: unknown = JSON.parse(e.target.value);
            setError(null);
            onChange(parsed);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'invalid JSON');
          }
        }}
      />
      {error && <div className="error small">JSON: {error} (not applied yet)</div>}
    </div>
  );
}

/** Up / down / duplicate / delete buttons for list entries. */
export function ListButtons({ index, length, onMove, onDuplicate, onDelete }: { index: number; length: number; onMove: (to: number) => void; onDuplicate?: () => void; onDelete: () => void }) {
  const { readOnly } = useEnv();
  if (readOnly) return null;
  return (
    <span className="ed-listbtns">
      <button className="icon" title="Move up" disabled={index === 0} onClick={() => onMove(index - 1)}>
        ↑
      </button>
      <button className="icon" title="Move down" disabled={index === length - 1} onClick={() => onMove(index + 1)}>
        ↓
      </button>
      {onDuplicate && (
        <button className="icon" title="Duplicate" onClick={onDuplicate}>
          ⧉
        </button>
      )}
      <button className="icon danger" title="Delete" onClick={onDelete}>
        ✕
      </button>
    </span>
  );
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const copy = list.slice();
  const [x] = copy.splice(from, 1);
  if (x !== undefined) copy.splice(to, 0, x);
  return copy;
}

export function IssueBadges({ path }: { path: Path }) {
  const { issues } = useEnv();
  const here = issuesUnder(issues, path);
  if (here.length === 0) return null;
  return (
    <ul className="ed-issues">
      {here.slice(0, 5).map((i, k) => (
        <li key={k} className={i.severity === 'error' ? 'error' : 'warn'}>
          {i.severity === 'error' ? '⛔' : '⚠'} {i.message}
        </li>
      ))}
    </ul>
  );
}
