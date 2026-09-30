import { defaultNode, type Json } from './model.ts';
import { Checkbox, EnumSelect, IntInput, IssueBadges, RefSelect, Row, TextInput, useEnv } from './fields.tsx';
import { EffectList, FieldEditor, NodeEditor } from './NodeEditor.tsx';
import { CAPABILITY_LIST, type RefSection, MODIFIER_LABELS, MODIFIER_ONS, MODIFIER_WHERE, MODIFY_OPS, modifierBindings, TRIGGER_LABELS, TRIGGER_WHERE, TRIGGERS, triggerBindings } from './spec.ts';

/**
 * Form editor for one rule: its kind, trigger (or modified value), filters, conditions (AND / OR /
 * NOT trees) and effects, plus limits and visibility. The generated plain-language text below the
 * form is what the engine will actually do.
 */

export function RuleEditor({ rule, onChange, path, attached }: { rule: Json; onChange: (r: Json) => void; path: Array<string | number>; attached?: boolean }) {
  const env = useEnv();
  const kind = (rule['kind'] as string | undefined) ?? 'reaction';
  const set = (key: string, v: unknown) => {
    const next = { ...rule };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  const changeKind = (k: string) => {
    const base: Json = { id: rule['id'], name: rule['name'], kind: k };
    for (const key of ['description', 'enabled', 'visibility', 'priority', 'limits']) if (rule[key] !== undefined) base[key] = rule[key];
    if (k === 'reaction') onChange({ ...base, trigger: { event: 'landed' }, effects: (rule['effects'] as unknown[] | undefined) ?? [] });
    else if (k === 'modifier') onChange({ ...base, on: 'damage', modify: { op: 'add', amount: -5 } });
    else onChange({ ...base, applies: { op: 'all', kind: 'contestant' }, modifiers: [], suppress: [] });
  };
  const text = env.texts[`rules:${String(rule['id'])}`];
  const limits = (rule['limits'] ?? {}) as Json;
  const setLimit = (key: string, v: number | undefined) => {
    const next = { ...limits };
    if (v === undefined) delete next[key];
    else next[key] = v;
    set('limits', Object.keys(next).length > 0 ? next : undefined);
  };
  const bindings = kind === 'reaction' ? triggerBindings(String((rule['trigger'] as Json | undefined)?.['event'] ?? '')) : kind === 'modifier' ? modifierBindings(String(rule['on'] ?? '')) : ['$it (each affected entity)'];
  return (
    <div className="rule-editor">
      <div className="ed-grid">
        <Row label="Kind">
          <EnumSelect
            values={['reaction', 'modifier', 'continuous']}
            labels={{ reaction: 'Reaction — after something happens', modifier: 'Modifier — changes a value before it applies', continuous: 'Continuous — while a condition holds' }}
            value={kind}
            onChange={(v) => v && v !== kind && changeKind(v)}
          />
        </Row>
        <Row label="Visibility" help="Hidden rules (traps) are never shown to contestants.">
          <EnumSelect values={['public', 'hidden']} labels={{ public: 'public', hidden: 'hidden (a trap)' }} value={(rule['visibility'] as string | undefined) ?? 'public'} onChange={(v) => set('visibility', v === 'public' ? undefined : v)} />
        </Row>
        <Row label="Enabled">
          <Checkbox label="" value={rule['enabled'] !== false} onChange={(v) => set('enabled', v ? undefined : false)} />
        </Row>
        <Row label="Priority" help="Lower runs first among rules reacting to the same event.">
          <IntInput value={(rule['priority'] as number | undefined) ?? 0} min={-1000} max={1000} onChange={(v) => set('priority', v === 0 || v === undefined ? undefined : v)} />
        </Row>
      </div>

      {kind === 'reaction' && <TriggerEditor rule={rule} set={set} />}
      {kind === 'modifier' && <ModifierHead rule={rule} set={set} />}
      {kind === 'continuous' && (
        <div className="ed-block">
          <div className="ed-block-title">Applies to</div>
          <NodeEditor kind="selector" value={rule['applies']} onChange={(v) => set('applies', v)} />
        </div>
      )}
      <div className="muted small">
        Available here: {bindings.join(', ') || 'no bindings'}
        {attached ? ', $holder' : ''}
      </div>

      <div className="ed-block">
        <div className="ed-block-title">
          {kind === 'continuous' ? 'While' : 'Only if'}{' '}
          {rule[kind === 'continuous' ? 'when' : 'conditions'] === undefined && !env.readOnly && (
            <button className="add-opt" onClick={() => set(kind === 'continuous' ? 'when' : 'conditions', defaultNode('cond', 'all', env.catalog))}>
              + add conditions
            </button>
          )}
          {rule[kind === 'continuous' ? 'when' : 'conditions'] !== undefined && !env.readOnly && (
            <button className="icon opt-x" title="Remove the conditions" onClick={() => set(kind === 'continuous' ? 'when' : 'conditions', undefined)}>
              ×
            </button>
          )}
        </div>
        {rule[kind === 'continuous' ? 'when' : 'conditions'] !== undefined ? (
          <NodeEditor kind="cond" value={rule[kind === 'continuous' ? 'when' : 'conditions']} onChange={(v) => set(kind === 'continuous' ? 'when' : 'conditions', v)} />
        ) : (
          <div className="muted small">always</div>
        )}
      </div>

      {kind === 'reaction' && (
        <div className="ed-block">
          <div className="ed-block-title">Then</div>
          <EffectList value={(rule['effects'] as unknown[] | undefined) ?? []} onChange={(v) => set('effects', v)} />
        </div>
      )}
      {kind === 'modifier' && <ModifyEditor rule={rule} set={set} />}
      {kind === 'continuous' && <ContinuousBody rule={rule} set={set} />}

      <div className="ed-block">
        <div className="ed-block-title">Limits</div>
        <div className="ed-grid">
          <Row label="per turn">
            <IntInput optional value={limits['maxPerTurn'] as number | undefined} min={1} max={100} onChange={(v) => setLimit('maxPerTurn', v)} />
          </Row>
          <Row label="per round">
            <IntInput optional value={limits['maxPerRound'] as number | undefined} min={1} max={100} onChange={(v) => setLimit('maxPerRound', v)} />
          </Row>
          <Row label="per game">
            <IntInput optional value={limits['maxPerGame'] as number | undefined} min={1} max={1000} onChange={(v) => setLimit('maxPerGame', v)} />
          </Row>
          <Row label="cooldown (rounds)">
            <IntInput optional value={limits['cooldownRounds'] as number | undefined} min={1} max={100} onChange={(v) => setLimit('cooldownRounds', v)} />
          </Row>
        </div>
      </div>
      <Row label="Notes">
        <TextInput multiline max={500} value={rule['description'] as string | undefined} onChange={(v) => set('description', v || undefined)} />
      </Row>
      <IssueBadges path={path} />
      {text && (
        <div className="generated">
          <span className="ed-label">What it does</span> {text}
        </div>
      )}
    </div>
  );
}

function TriggerEditor({ rule, set }: { rule: Json; set: (k: string, v: unknown) => void }) {
  const trigger = (rule['trigger'] ?? { event: 'landed' }) as Json;
  const event = String(trigger['event'] ?? 'landed');
  const where = (trigger['where'] ?? {}) as Json;
  const setWhere = (key: string, v: unknown) => {
    const next = { ...where };
    if (v === undefined || v === '') delete next[key];
    else next[key] = v;
    set('trigger', Object.keys(next).length > 0 ? { event, where: next } : { event });
  };
  const fields = TRIGGER_WHERE[event] ?? [];
  return (
    <div className="ed-block">
      <div className="ed-block-title">When</div>
      <div className="ed-inline-row">
        <EnumSelect
          values={TRIGGERS}
          labels={TRIGGER_LABELS}
          value={event}
          onChange={(v) => {
            // Keep only the filters the new event supports.
            const allowed = new Set((TRIGGER_WHERE[v ?? ''] ?? []).map((f) => f.key));
            const kept = Object.fromEntries(Object.entries(where).filter(([k]) => allowed.has(k)));
            set('trigger', Object.keys(kept).length > 0 ? { event: v, where: kept } : { event: v });
          }}
        />
      </div>
      {fields.length > 0 && (
        <div className="ed-inline-row wrap">
          {fields.map((f) =>
            f.type.t === 'ref' || f.type.t === 'enum' ? (
              <FilterField key={f.key} label={f.label} type={f.type} value={where[f.key] as string | undefined} onChange={(v) => setWhere(f.key, v)} />
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

function FilterField({ label, type, value, onChange }: { label: string; type: { t: 'ref'; section: RefSection } | { t: 'enum'; values: readonly string[] }; value: string | undefined; onChange: (v: string | undefined) => void }) {
  return (
    <span className="ed-inline">
      <span className="ed-label">{label}</span>
      {type.t === 'enum' ? <EnumSelect optional values={type.values} value={value} onChange={onChange} /> : <RefSelect optional section={type.section} value={value} onChange={onChange} />}
    </span>
  );
}

function ModifierHead({ rule, set }: { rule: Json; set: (k: string, v: unknown) => void }) {
  const where = (rule['where'] ?? {}) as Json;
  const setWhere = (key: string, v: unknown) => {
    const next = { ...where };
    if (v === undefined || v === '') delete next[key];
    else next[key] = v;
    set('where', Object.keys(next).length > 0 ? next : undefined);
  };
  return (
    <div className="ed-block">
      <div className="ed-block-title">Modifies</div>
      <EnumSelect values={MODIFIER_ONS} labels={MODIFIER_LABELS} value={String(rule['on'] ?? 'damage')} onChange={(v) => set('on', v)} />
      <div className="ed-inline-row wrap">
        {MODIFIER_WHERE.map((f) =>
          f.type.t === 'ref' || f.type.t === 'enum' ? <FilterField key={f.key} label={f.label} type={f.type} value={where[f.key] as string | undefined} onChange={(v) => setWhere(f.key, v)} /> : null,
        )}
      </div>
    </div>
  );
}

function ModifyEditor({ rule, set }: { rule: Json; set: (k: string, v: unknown) => void }) {
  const env = useEnv();
  const modify = (rule['modify'] ?? { op: 'prevent' }) as Json;
  const spec = MODIFY_OPS.find((s) => s.op === modify['op']) ?? MODIFY_OPS[3];
  const consume = rule['consume'] as Json | undefined;
  return (
    <div className="ed-block">
      <div className="ed-block-title">Change it</div>
      <div className="ed-inline-row wrap">
        <EnumSelect
          values={MODIFY_OPS.map((s) => s.op)}
          labels={Object.fromEntries(MODIFY_OPS.map((s) => [s.op, s.label]))}
          value={String(modify['op'])}
          onChange={(op) => {
            const s = MODIFY_OPS.find((x) => x.op === op);
            const next: Json = { op };
            for (const f of s?.fields ?? []) if (!f.optional) next[f.key] = f.type.t === 'enum' ? f.type.values[0] : f.key === 'den' ? 2 : 1;
            set('modify', next);
          }}
        />
        {spec?.fields.map((f) => {
          const v = modify[f.key];
          if (v === undefined && f.optional) {
            return env.readOnly ? null : (
              <button key={f.key} className="add-opt" onClick={() => set('modify', { ...modify, [f.key]: 0 })}>
                + {f.label}
              </button>
            );
          }
          return (
            <span key={f.key} className="field">
              <FieldEditor field={f} value={v} onChange={(x) => set('modify', { ...modify, [f.key]: x })} />
              {f.optional && !env.readOnly && (
                <button
                  className="icon opt-x"
                  onClick={() => {
                    const next = { ...modify };
                    delete next[f.key];
                    set('modify', next);
                  }}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
      </div>
      <div className="ed-inline-row">
        <span className="ed-label">Uses up</span>
        <EnumSelect
          values={['nothing', 'status', 'item']}
          labels={{ nothing: 'nothing', status: 'one stack of a status', item: 'the item carrying this rule' }}
          value={consume === undefined ? 'nothing' : 'item' in consume ? 'item' : 'status'}
          onChange={(v) => set('consume', v === 'status' ? { status: env.catalog.statuses[0]?.id ?? '' } : v === 'item' ? { item: true } : undefined)}
        />
        {consume && 'status' in consume && <RefSelect section="statuses" value={consume['status'] as string} onChange={(s) => set('consume', { status: s ?? '' })} />}
      </div>
    </div>
  );
}

function ContinuousBody({ rule, set }: { rule: Json; set: (k: string, v: unknown) => void }) {
  const env = useEnv();
  const mods = (rule['modifiers'] ?? []) as Json[];
  const suppress = (rule['suppress'] ?? []) as string[];
  return (
    <div className="ed-block">
      <div className="ed-block-title">Effect while it holds</div>
      {mods.map((m, i) => (
        <div key={i} className="ed-inline-row">
          <RefSelect section="resources" value={m['resource'] as string} onChange={(r) => set('modifiers', mods.map((x, j) => (j === i ? { ...x, resource: r ?? '' } : x)))} />
          <NodeEditor kind="num" label="+" value={m['add']} onChange={(v) => set('modifiers', mods.map((x, j) => (j === i ? { ...x, add: v } : x)))} />
          {!env.readOnly && (
            <button className="icon danger" onClick={() => set('modifiers', mods.filter((_, j) => j !== i))}>
              ✕
            </button>
          )}
        </div>
      ))}
      {!env.readOnly && mods.length < 4 && <button onClick={() => set('modifiers', [...mods, { resource: env.catalog.resources.find((r) => r.id.includes('power'))?.id ?? env.catalog.resources[0]?.id ?? '', add: 10 }])}>+ stat modifier</button>}
      <div className="ed-inline-row wrap">
        <span className="ed-label">Cannot</span>
        {CAPABILITY_LIST.map((c) => (
          <Checkbox key={c} label={c} value={suppress.includes(c)} onChange={(v) => set('suppress', v ? [...suppress, c] : suppress.filter((x) => x !== c))} />
        ))}
      </div>
    </div>
  );
}
