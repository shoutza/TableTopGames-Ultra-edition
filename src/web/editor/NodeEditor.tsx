import { useState } from 'react';
import { defaultFor, defaultNode, specFor, type Json } from './model.ts';
import { Checkbox, EnumSelect, IntInput, JsonBox, ListButtons, moveItem, RefSelect, TextInput, useEnv } from './fields.tsx';
import { ENTITY_BINDINGS, OPS, type FieldSpec, type NodeKind } from './spec.ts';

/**
 * A metadata-driven editor for any rule-language node: numbers, conditions, selectors, entity and
 * space references, and effects (with nested lists, choices and random outcomes). Every node has a
 * “{ }” switch to edit its JSON directly, so nothing the language allows is out of reach.
 */

/** A tiny clipboard for copying effects and conditions between rules. */
const clipboard: { kind: NodeKind | null; value: unknown } = { kind: null, value: null };

function opOf(kind: NodeKind, value: unknown): string {
  if (typeof value === 'number') return '#';
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return String((value as Json)['op'] ?? '?');
  return '?';
}

function choicesFor(kind: NodeKind): Array<{ id: string; label: string }> {
  const bindings = Object.entries(ENTITY_BINDINGS).map(([id, label]) => ({ id, label }));
  const ops = OPS[kind].map((s) => ({ id: s.op, label: s.label }));
  switch (kind) {
    case 'num':
      return [{ id: '#', label: 'number' }, ...ops];
    case 'entity':
      return [...bindings, { id: 'entity', label: 'a specific entity (by id)' }];
    case 'selector':
      return [...bindings, ...ops];
    case 'space':
      return [{ id: '$space', label: 'the space where it happened ($space)' }, ...ops];
    default:
      return ops;
  }
}

function switchTo(kind: NodeKind, op: string, previous: unknown, catalog: ReturnType<typeof useEnv>['catalog']): unknown {
  if (op === '#') return typeof previous === 'number' ? previous : 1;
  if (op.startsWith('$')) return op;
  if (kind === 'entity' && op === 'entity') return { op: 'entity', id: '' };
  return defaultNode(kind === 'entity' ? 'selector' : kind, op, catalog, previous);
}

/** Whether a node is small enough to sit inline. */
function simple(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return JSON.stringify(value).length < 60 && !Object.values(value as Json).some((v) => Array.isArray(v));
}

export function NodeEditor({ kind, value, onChange, label }: { kind: NodeKind; value: unknown; onChange: (v: unknown) => void; label?: string | undefined }) {
  const env = useEnv();
  const [raw, setRaw] = useState(false);
  const op = opOf(kind, value);
  const spec = typeof value === 'object' && value !== null ? specFor(kind === 'entity' ? 'selector' : kind, op) : undefined;
  const choices = choicesFor(kind);
  const known = choices.some((c) => c.id === op);
  return (
    <span className={`node node-${kind}${simple(value) ? ' inline' : ''}`}>
      {label && <span className="ed-label">{label}</span>}
      <select className="node-op" disabled={env.readOnly} value={known ? op : '?'} title={spec?.help} onChange={(e) => onChange(switchTo(kind, e.target.value, value, env.catalog))}>
        {!known && <option value="?">⚠ {op}</option>}
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      {typeof value === 'number' && <IntInput value={value} onChange={(v) => onChange(v ?? 0)} />}
      {kind === 'entity' && op === 'entity' && <TextInput value={String((value as Json)['id'] ?? '')} placeholder="e.g. e3" onChange={(id) => onChange({ op: 'entity', id })} />}
      {spec && !raw && <Fields kind={kind} spec={spec.fields} value={value as Json} onChange={onChange} />}
      {typeof value === 'object' && value !== null && (
        <button className="icon json-toggle" title={raw ? 'Back to the form' : 'Edit as JSON'} onClick={() => setRaw(!raw)}>
          {raw ? '☰' : '{ }'}
        </button>
      )}
      {raw && <JsonBox value={value} onChange={onChange} rows={4} />}
    </span>
  );
}

function Fields({ spec, value, onChange }: { kind: NodeKind; spec: FieldSpec[]; value: Json; onChange: (v: unknown) => void }) {
  const env = useEnv();
  const set = (key: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <>
      {spec.map((f) => {
        const v = value[f.key];
        if (v === undefined && f.optional) {
          if (env.readOnly) return null;
          return (
            <button key={f.key} className="add-opt" title={f.help} onClick={() => set(f.key, defaultFor(f.type, env.catalog))}>
              + {f.label}
            </button>
          );
        }
        return (
          <span key={f.key} className={`field field-${f.type.t}`}>
            <FieldEditor field={f} value={v} onChange={(x) => set(f.key, x)} />
            {f.optional && !env.readOnly && (
              <button className="icon opt-x" title={`Remove ${f.label}`} onClick={() => set(f.key, undefined)}>
                ×
              </button>
            )}
          </span>
        );
      })}
    </>
  );
}

export function FieldEditor({ field, value, onChange }: { field: FieldSpec; value: unknown; onChange: (v: unknown) => void }) {
  const t = field.type;
  switch (t.t) {
    case 'num':
    case 'cond':
    case 'selector':
    case 'entity':
    case 'space':
      return <NodeEditor kind={t.t} value={value} onChange={onChange} label={field.label} />;
    case 'effects':
      return <EffectList label={field.label} value={(value as unknown[] | undefined) ?? []} onChange={onChange} />;
    case 'conds':
      return <NodeList kind="cond" label={field.label} value={(value as unknown[] | undefined) ?? []} onChange={onChange} />;
    case 'nums':
      return <NodeList kind="num" label={field.label} value={(value as unknown[] | undefined) ?? []} onChange={onChange} />;
    case 'options':
      return <OptionsEditor label={field.label} value={(value as Json[] | undefined) ?? []} onChange={onChange} />;
    case 'branches':
      return <BranchesEditor value={(value as Json[] | undefined) ?? []} onChange={onChange} />;
    case 'ref':
      return (
        <span className="ed-inline">
          <span className="ed-label">{field.label}</span>
          <RefSelect section={t.section} value={value as string | undefined} onChange={(v) => onChange(v ?? '')} />
        </span>
      );
    case 'text':
      return (
        <span className="ed-inline grow">
          <span className="ed-label">{field.label}</span>
          <TextInput value={value as string | undefined} max={t.max} wide onChange={onChange} />
        </span>
      );
    case 'int':
      return (
        <span className="ed-inline">
          <span className="ed-label">{field.label}</span>
          <IntInput value={value as number | undefined} min={t.min} max={t.max} onChange={(v) => onChange(v ?? t.min ?? 0)} />
        </span>
      );
    case 'bool':
      return <Checkbox label={field.label} value={value as boolean | undefined} onChange={onChange} />;
    case 'enum':
      return (
        <span className="ed-inline">
          {field.label && <span className="ed-label">{field.label}</span>}
          <EnumSelect values={t.values} labels={t.labels} value={value as string | undefined} onChange={(v) => onChange(v ?? t.values[0])} />
        </span>
      );
  }
}

/** A list of numbers or conditions. */
function NodeList({ kind, label, value, onChange }: { kind: 'cond' | 'num'; label: string; value: unknown[]; onChange: (v: unknown) => void }) {
  const env = useEnv();
  return (
    <div className="node-list">
      <div className="ed-label">{label}</div>
      {value.map((v, i) => (
        <div key={i} className="node-list-item">
          <NodeEditor kind={kind} value={v} onChange={(x) => onChange(value.map((y, j) => (j === i ? x : y)))} />
          <ListButtons index={i} length={value.length} onMove={(to) => onChange(moveItem(value, i, to))} onDelete={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      {!env.readOnly && (
        <span className="ed-add">
          <button onClick={() => onChange([...value, kind === 'num' ? 1 : defaultNode('cond', 'isKind', env.catalog)])}>+ {kind === 'num' ? 'value' : 'condition'}</button>
          {clipboard.kind === kind && <button onClick={() => onChange([...value, clipboard.value])}>Paste</button>}
        </span>
      )}
    </div>
  );
}

export function EffectList({ label, value, onChange }: { label?: string; value: unknown[]; onChange: (v: unknown) => void }) {
  const env = useEnv();
  const [, force] = useState(0);
  return (
    <div className="effect-list">
      {label && <div className="ed-label">{label}</div>}
      {value.length === 0 && <div className="muted small">no effects</div>}
      {value.map((e, i) => (
        <div key={i} className="effect-item">
          <span className="effect-num">{i + 1}</span>
          <NodeEditor kind="effect" value={e} onChange={(x) => onChange(value.map((y, j) => (j === i ? x : y)))} />
          <span className="effect-tools">
            {!env.readOnly && (
              <button
                className="icon"
                title="Copy this effect"
                onClick={() => {
                  clipboard.kind = 'effect';
                  clipboard.value = JSON.parse(JSON.stringify(e));
                  force((n) => n + 1);
                }}
              >
                ⎘
              </button>
            )}
            <ListButtons
              index={i}
              length={value.length}
              onMove={(to) => onChange(moveItem(value, i, to))}
              onDuplicate={() => onChange([...value.slice(0, i + 1), JSON.parse(JSON.stringify(e)), ...value.slice(i + 1)])}
              onDelete={() => onChange(value.filter((_, j) => j !== i))}
            />
          </span>
        </div>
      ))}
      {!env.readOnly && (
        <span className="ed-add">
          <select value="" onChange={(ev) => ev.target.value && onChange([...value, defaultNode('effect', ev.target.value, env.catalog)])}>
            <option value="">+ add effect…</option>
            {OPS.effect.map((s) => (
              <option key={s.op} value={s.op}>
                {s.label}
              </option>
            ))}
          </select>
          {clipboard.kind === 'effect' && <button onClick={() => onChange([...value, JSON.parse(JSON.stringify(clipboard.value))])}>Paste effect</button>}
        </span>
      )}
    </div>
  );
}

/** Options of a choice (offerChoice) or rulings (askGm). */
function OptionsEditor({ label, value, onChange }: { label: string; value: Json[]; onChange: (v: unknown) => void }) {
  const env = useEnv();
  const set = (i: number, key: string, v: unknown) =>
    onChange(
      value.map((o, j) => {
        if (j !== i) return o;
        const next = { ...o };
        if (v === undefined) delete next[key];
        else next[key] = v;
        return next;
      }),
    );
  return (
    <div className="node-list options">
      <div className="ed-label">{label}</div>
      {value.map((o, i) => (
        <div key={i} className="option-item">
          <div className="ed-inline-row">
            <span className="ed-label">id</span>
            <TextInput value={o['id'] as string} max={40} onChange={(v) => set(i, 'id', v.toLowerCase().replace(/[^a-z0-9_-]/g, ''))} />
            <span className="ed-label">label</span>
            <TextInput value={o['label'] as string} max={120} wide onChange={(v) => set(i, 'label', v)} />
            <ListButtons index={i} length={value.length} onMove={(to) => onChange(moveItem(value, i, to))} onDelete={() => onChange(value.filter((_, j) => j !== i))} />
          </div>
          {o['requires'] !== undefined ? (
            <span className="field">
              <NodeEditor kind="cond" label="only if" value={o['requires']} onChange={(v) => set(i, 'requires', v)} />
              {!env.readOnly && (
                <button className="icon opt-x" onClick={() => set(i, 'requires', undefined)}>
                  ×
                </button>
              )}
            </span>
          ) : (
            !env.readOnly && (
              <button className="add-opt" onClick={() => set(i, 'requires', defaultNode('cond', 'isKind', env.catalog))}>
                + only if…
              </button>
            )
          )}
          <EffectList label="effects" value={(o['effects'] as unknown[] | undefined) ?? []} onChange={(v) => set(i, 'effects', v)} />
        </div>
      ))}
      {!env.readOnly && value.length < 4 && (
        <button onClick={() => onChange([...value, { id: `option${value.length + 1}`, label: `Option ${value.length + 1}`, effects: [] }])}>+ option</button>
      )}
    </div>
  );
}

function BranchesEditor({ value, onChange }: { value: Json[]; onChange: (v: unknown) => void }) {
  const env = useEnv();
  const total = value.reduce((s, b) => s + (typeof b['weight'] === 'number' ? b['weight'] : 0), 0) || 1;
  return (
    <div className="node-list branches">
      {value.map((b, i) => (
        <div key={i} className="option-item">
          <div className="ed-inline-row">
            <span className="ed-label">weight</span>
            <IntInput value={b['weight'] as number} min={1} max={1000} onChange={(w) => onChange(value.map((x, j) => (j === i ? { ...x, weight: w ?? 1 } : x)))} />
            <span className="muted small">{Math.round(((b['weight'] as number) / total) * 100)}%</span>
            <ListButtons index={i} length={value.length} onMove={(to) => onChange(moveItem(value, i, to))} onDelete={() => onChange(value.filter((_, j) => j !== i))} />
          </div>
          <EffectList value={(b['do'] as unknown[] | undefined) ?? []} onChange={(v) => onChange(value.map((x, j) => (j === i ? { ...x, do: v } : x)))} />
        </div>
      ))}
      {!env.readOnly && value.length < 8 && <button onClick={() => onChange([...value, { weight: 1, do: [] }])}>+ outcome</button>}
    </div>
  );
}
