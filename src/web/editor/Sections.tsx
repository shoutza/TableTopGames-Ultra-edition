import { useEffect, useState, type ReactNode } from 'react';
import { TRAIT_NAMES } from '../../schema/persona.ts';
import { ID_PREFIX, newCastMember, newEntry, uniqueId } from '../../shared/templates.ts';
import { allIds, clone, countRefs, renameId, type Json } from './model.ts';
import { Checkbox, EnumSelect, IntInput, issuesUnder, IssueBadges, JsonBox, ListButtons, moveItem, RefMulti, RefSelect, Row, TextInput, useEnv } from './fields.tsx';
import { EffectList, NodeEditor } from './NodeEditor.tsx';
import { RuleEditor } from './RuleEditor.tsx';
import { CAPABILITY_LIST, TRIGGER_LABELS, TRIGGER_WHERE, TRIGGERS } from './spec.ts';

/**
 * Editors for every list section of a definition. Each section is a list of entries (add,
 * duplicate, reorder, delete, rename ids everywhere) with a form for the selected entry and a JSON
 * tab for it; the forms cover every field of the schema.
 */

export interface SectionProps {
  def: Json;
  edit: (next: Json, coalesce?: string) => void;
  /** Entry to select (from an issue link). */
  focus: number | null;
}

type Entry = Json & { id: string; name: string };
type FormProps = { entry: Entry; set: (key: string, v: unknown) => void; def: Json; path: Array<string | number> };

const HELP: Record<string, string> = {
  resources: 'Numbers entities have. Pools are stored amounts (Gold, HP); stats are base values that items, statuses and rules modify (Power, Move).',
  tags: 'Labels for spaces (Blue, Shop) or entities (Fish, Cursed). Rules and filters test them.',
  items: 'Things contestants hold: passive stat modifiers, an optional use action, and rules active while held.',
  statuses: 'Timed effects on an entity: stat modifiers, granted tags, suppressed capabilities, and attached rules. Transformations change the token.',
  shops: 'What can be bought, and for how much. A shop is reached through a fixture on the board.',
  fixtures: 'Things placed on the board (shopkeepers, shrines). A fixture with a shop sells to contestants on its space.',
  enemies: 'Monsters on the board. Contestants fight them on the combat wheel; rewards go to the victor.',
  decks: 'Shuffled decks of cards; rules draw from them (drawCard). Each card runs its effects for the drawer.',
  actions: 'Custom main actions contestants can choose (where, cost, cooldown, target and effects).',
  objectives: 'Secret objectives dealt to contestants at the start; completing one reveals it and runs its reward.',
  cast: 'The AI contestants: name, look and personality (voice, traits and rules of thumb).',
  rules: 'What happens when: reactions to events, modifiers of values, and continuous effects.',
};

/** Ids of entries created in this editor session: they follow the entry's name until something refers to them. */
const freshIds = new Set<string>();

export function ListSection({ section, def, edit, focus, title, form }: SectionProps & { section: string; title: string; form: (p: FormProps) => ReactNode }) {
  const env = useEnv();
  const entries = (def[section] ?? []) as Entry[];
  const [selected, setSelected] = useState(0);
  const [raw, setRaw] = useState(false);
  const [filter, setFilter] = useState('');
  const [newId, setNewId] = useState('');
  useEffect(() => {
    if (focus !== null) setSelected(focus);
  }, [focus]);
  const index = Math.min(selected, entries.length - 1);
  const entry = entries[index];
  useEffect(() => setNewId(entry?.id ?? ''), [entry?.id]);
  const setList = (list: Entry[], coalesce?: string) => edit({ ...def, [section]: list }, coalesce);
  const set = (key: string, v: unknown) => {
    if (!entry) return;
    const next: Json = { ...entry };
    if (v === undefined) delete next[key];
    else next[key] = v;
    if (key === 'name' && typeof v === 'string' && v.trim() && freshIds.has(entry.id)) {
      const others = { ...def, [section]: entries.filter((_, j) => j !== index) };
      if (countRefs(others, entry.id) === 0) {
        const id = uniqueId(ID_PREFIX[section] ?? section, v, allIds(others));
        freshIds.delete(entry.id);
        freshIds.add(id);
        next['id'] = id;
      }
    }
    setList(entries.map((e, j) => (j === index ? (next as Entry) : e)), `${section}:${index}:${key}`);
  };
  const add = () => {
    const name = section === 'cast' ? '' : `New ${title.replace(/s$/, '').toLowerCase()}`;
    const created = section === 'cast' ? newCastMember(entries.length, allIds(def)) : newEntry(section, name, uniqueId(ID_PREFIX[section] ?? section, name, allIds(def)), def);
    freshIds.add(String(created['id']));
    setList([...entries, created as Entry]);
    setSelected(entries.length);
  };
  const duplicate = () => {
    if (!entry) return;
    const copy = clone(entry);
    copy.name = `${entry.name} (copy)`.slice(0, 80);
    copy.id = uniqueId(ID_PREFIX[section] ?? section, copy.name, allIds(def));
    // Nested ids (cards, shop entries, attached rules) must be unique too.
    const taken = allIds(def);
    for (const key of ['cards', 'entries', 'rules'] as const) {
      const inner = copy[key];
      if (Array.isArray(inner)) for (const x of inner as Json[]) {
        const fresh = uniqueId(String(x['id']).split('.')[0] ?? key, String(x['name'] ?? x['id']), taken);
        taken.add(fresh);
        x['id'] = fresh;
      }
    }
    freshIds.add(copy.id);
    setList([...entries.slice(0, index + 1), copy, ...entries.slice(index + 1)]);
    setSelected(index + 1);
  };
  const remove = () => {
    if (!entry) return;
    const refs = countRefs({ ...def, [section]: entries.filter((_, j) => j !== index) }, entry.id);
    if (refs > 0 && !window.confirm(`“${entry.name}” is referenced in ${refs} place(s). Delete it anyway? (The references will show up as problems to fix.)`)) return;
    setList(entries.filter((_, j) => j !== index));
    setSelected(Math.max(0, index - 1));
  };
  const rename = () => {
    if (!entry) return;
    if (!/^[a-z][a-z0-9_.-]*$/.test(newId)) return window.alert('Ids are lowercase slugs like item.sword');
    if (allIds(def).has(newId)) return window.alert(`${newId} is already used`);
    edit(renameId(def, entry.id, newId) as Json);
  };
  const shown = entries.map((e, i) => ({ e, i })).filter(({ e }) => !filter || `${e.name} ${e.id}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="list-section">
      <div className="list-col">
        <p className="muted small">{HELP[section]}</p>
        {entries.length > 8 && <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        <ul className="entry-list">
          {shown.map(({ e, i }) => {
            const bad = issuesUnder(env.issues, [section, i]);
            return (
              <li key={`${e.id}-${i}`} className={i === index ? 'active' : ''} onClick={() => setSelected(i)}>
                <span>
                  {typeof e['icon'] === 'string' ? `${e['icon']} ` : ''}
                  {e.name || <em>unnamed</em>}
                </span>
                {bad.some((x) => x.severity === 'error') ? <span className="dot error">●</span> : bad.length > 0 ? <span className="dot warn">●</span> : null}
              </li>
            );
          })}
        </ul>
        {!env.readOnly && <button onClick={add}>+ New {title.replace(/s$/, '').toLowerCase()}</button>}
      </div>
      <div className="form-col">
        {!entry && <p className="muted">Nothing here yet.</p>}
        {entry && (
          <>
            <div className="entry-head">
              <input className="entry-name" disabled={env.readOnly} value={entry.name} maxLength={80} onChange={(e) => set('name', e.target.value)} />
              <span className="ed-inline">
                <span className="ed-label">id</span>
                <input disabled={env.readOnly} value={newId} onChange={(e) => setNewId(e.target.value)} />
                {newId !== entry.id && <button onClick={rename}>Rename everywhere</button>}
              </span>
              <span className="grow" />
              <button className={raw ? 'active' : ''} onClick={() => setRaw(!raw)}>
                {raw ? 'Form' : 'JSON'}
              </button>
              <ListButtons index={index} length={entries.length} onMove={(to) => (setList(moveItem(entries, index, to)), setSelected(to))} onDuplicate={duplicate} onDelete={remove} />
            </div>
            {raw ? (
              <JsonBox value={entry} onChange={(v) => setList(entries.map((e, j) => (j === index ? (v as Entry) : e)), `${section}:${index}:json`)} rows={20} />
            ) : (
              <div className="entry-form">{form({ entry, set, def, path: [section, index] })}</div>
            )}
            <IssueBadges path={[section, index]} />
          </>
        )}
      </div>
    </div>
  );
}

// --- per-section forms ---------------------------------------------------------------------------

function IconField({ entry, set }: { entry: Entry; set: (k: string, v: unknown) => void }) {
  return (
    <Row label="Icon" help="An emoji or a short symbol (up to 8 characters).">
      <TextInput value={entry['icon'] as string | undefined} max={8} onChange={(v) => set('icon', v || undefined)} />
    </Row>
  );
}

function Description({ entry, set, max = 300 }: { entry: Entry; set: (k: string, v: unknown) => void; max?: number }) {
  return (
    <Row label="Description">
      <TextInput multiline max={max} value={entry['description'] as string | undefined} onChange={(v) => set('description', v || undefined)} />
    </Row>
  );
}

function StatModifiers({ value, onChange, label = 'Stat modifiers' }: { value: Json[] | undefined; onChange: (v: Json[]) => void; label?: string }) {
  const env = useEnv();
  const list = value ?? [];
  return (
    <Row label={label}>
      <div>
        {list.map((m, i) => (
          <div key={i} className="ed-inline-row">
            <RefSelect section="resources" value={m['resource'] as string} onChange={(r) => onChange(list.map((x, j) => (j === i ? { ...x, resource: r ?? '' } : x)))} />
            <IntInput value={m['add'] as number} onChange={(a) => onChange(list.map((x, j) => (j === i ? { ...x, add: a ?? 0 } : x)))} />
            {!env.readOnly && (
              <button className="icon danger" onClick={() => onChange(list.filter((_, j) => j !== i))}>
                ✕
              </button>
            )}
          </div>
        ))}
        {!env.readOnly && list.length < 4 && <button onClick={() => onChange([...list, { resource: env.catalog.resources.find((r) => r.id.includes('power'))?.id ?? env.catalog.resources[0]?.id ?? '', add: 10 }])}>+ modifier</button>}
      </div>
    </Row>
  );
}

/** Rules attached to an item, status or enemy ($holder = its holder). */
function AttachedRules({ entry, set, path, def }: FormProps) {
  const env = useEnv();
  const rules = (entry['rules'] ?? []) as Entry[];
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="ed-block">
      <div className="ed-block-title">Attached rules ({rules.length}) — active only while held / present; $holder is the holder</div>
      {rules.map((r, i) => (
        <div key={i} className="attached-rule">
          <div className="ed-inline-row">
            <button className="link" onClick={() => setOpen(open === i ? null : i)}>
              {open === i ? '▾' : '▸'} {r.name}
            </button>
            <span className="muted small">{env.texts[`rules:${r.id}`]}</span>
            <span className="grow" />
            <ListButtons index={i} length={rules.length} onMove={(to) => set('rules', moveItem(rules, i, to))} onDelete={() => set('rules', rules.filter((_, j) => j !== i))} />
          </div>
          {open === i && (
            <>
              <Row label="Name">
                <TextInput value={r.name} max={80} onChange={(v) => set('rules', rules.map((x, j) => (j === i ? { ...x, name: v } : x)))} />
              </Row>
              <RuleEditor attached rule={r} path={[...path, 'rules', i]} onChange={(next) => set('rules', rules.map((x, j) => (j === i ? next : x)))} />
            </>
          )}
        </div>
      ))}
      {!env.readOnly && rules.length < 8 && (
        <button
          onClick={() => {
            const name = `${entry.name} rule ${rules.length + 1}`;
            set('rules', [...rules, { ...newEntry('rules', name, uniqueId('rule', name, allIds(def)), def), effects: [{ op: 'changeResource', target: '$holder', resource: env.catalog.resources[0]?.id ?? '', amount: 1 }] }]);
            setOpen(rules.length);
          }}
        >
          + attached rule
        </button>
      )}
    </div>
  );
}

const KINDS = ['contestant', 'enemy', 'fixture'] as const;

function ResourceForm({ entry, set }: FormProps) {
  const applies = (entry['appliesTo'] ?? []) as string[];
  return (
    <div className="ed-grid">
      <IconField entry={entry} set={set} />
      <Row label="Role" help="pool: a stored amount changed by effects. stat: a base value plus modifiers.">
        <EnumSelect values={['pool', 'stat']} value={entry['role'] as string} onChange={(v) => set('role', v ?? 'pool')} />
      </Row>
      <Row label="Who has it">
        <span className="ed-inline">
          {KINDS.map((k) => (
            <Checkbox key={k} label={k} value={applies.includes(k)} onChange={(v) => set('appliesTo', v ? [...applies, k] : applies.filter((x) => x !== k))} />
          ))}
        </span>
      </Row>
      <Row label="Starts at">
        <IntInput value={entry['default'] as number} onChange={(v) => set('default', v ?? 0)} />
      </Row>
      <Row label="Minimum">
        <IntInput value={entry['min'] as number} onChange={(v) => set('min', v ?? 0)} />
      </Row>
      <Row label="Maximum">
        <span className="ed-inline">
          <Checkbox label="no maximum" value={entry['max'] === null} onChange={(v) => set('max', v ? null : 99)} />
          {entry['max'] !== null && <IntInput value={entry['max'] as number} onChange={(v) => set('max', v ?? 0)} />}
        </span>
      </Row>
      <Row label="Capped by" help="Upper bound taken from another resource (HP capped by Max HP).">
        <RefSelect optional section="resources" value={entry['maxFrom'] as string | undefined} onChange={(v) => set('maxFrom', v)} />
      </Row>
      <Row label="Visible to">
        <EnumSelect values={['public', 'owner', 'gm']} labels={{ public: 'everyone', owner: 'only its owner', gm: 'only the GM' }} value={(entry['visibility'] as string | undefined) ?? 'public'} onChange={(v) => set('visibility', v === 'public' ? undefined : v)} />
      </Row>
      <Row label="Tradeable">
        <Checkbox label="contestants may trade it" value={entry['tradeable'] === true} onChange={(v) => set('tradeable', v || undefined)} />
      </Row>
    </div>
  );
}

function TagForm({ entry, set }: FormProps) {
  return (
    <div className="ed-grid">
      <Row label="For">
        <EnumSelect values={['space', 'entity']} labels={{ space: 'spaces', entity: 'entities (contestants, enemies…)' }} value={entry['appliesTo'] as string} onChange={(v) => set('appliesTo', v ?? 'space')} />
      </Row>
      <Row label="Color">
        <span className="ed-inline">
          <input type="color" value={(entry['color'] as string | undefined) ?? '#95a5a6'} onChange={(e) => set('color', e.target.value)} />
          <TextInput value={entry['color'] as string | undefined} max={20} onChange={(v) => set('color', v || undefined)} />
        </span>
      </Row>
      <Description entry={entry} set={set} />
    </div>
  );
}

function ItemForm(p: FormProps) {
  const { entry, set } = p;
  const env = useEnv();
  const use = entry['use'] as Json | undefined;
  return (
    <>
      <div className="ed-grid">
        <IconField entry={entry} set={set} />
        <Description entry={entry} set={set} />
        <Row label="Tags">
          <RefMulti section="entityTags" value={entry['tags'] as string[] | undefined} max={8} onChange={(v) => set('tags', v)} />
        </Row>
        <StatModifiers value={entry['modifiers'] as Json[] | undefined} onChange={(v) => set('modifiers', v)} label="While held" />
        <Row label="Concealed" help="Other contestants only see “a concealed item”.">
          <Checkbox label="hidden from rivals" value={entry['concealed'] === true} onChange={(v) => set('concealed', v || undefined)} />
        </Row>
        <Row label="Tradeable">
          <Checkbox label="can change hands in trades" value={entry['tradeable'] !== false} onChange={(v) => set('tradeable', v ? undefined : false)} />
        </Row>
      </div>
      <div className="ed-block">
        <div className="ed-block-title">
          Use action{' '}
          {!env.readOnly &&
            (use ? (
              <button className="icon opt-x" onClick={() => set('use', undefined)}>
                ×
              </button>
            ) : (
              <button className="add-opt" onClick={() => set('use', { effects: [{ op: 'changeResource', target: '$actor', resource: env.catalog.resources[0]?.id ?? '', amount: 10 }], consumed: true })}>
                + can be used
              </button>
            ))}
        </div>
        {use && (
          <>
            <div className="ed-inline-row">
              <span className="ed-label">button label</span>
              <TextInput value={use['label'] as string | undefined} max={60} onChange={(v) => set('use', { ...use, label: v || undefined })} />
              <Checkbox label="used up" value={use['consumed'] !== false} onChange={(v) => set('use', { ...use, consumed: v })} />
            </div>
            <EffectList value={(use['effects'] as unknown[] | undefined) ?? []} onChange={(v) => set('use', { ...use, effects: v })} />
          </>
        )}
      </div>
      <AttachedRules {...p} />
    </>
  );
}

function StatusForm(p: FormProps) {
  const { entry, set } = p;
  const suppress = (entry['suppress'] ?? []) as string[];
  return (
    <>
      <div className="ed-grid">
        <IconField entry={entry} set={set} />
        <Description entry={entry} set={set} />
        <Row label="Lasts" help="Counted in the holder's own turns (enemies: rounds).">
          <span className="ed-inline">
            <Checkbox label="until removed" value={entry['duration'] === null} onChange={(v) => set('duration', v ? null : 3)} />
            {entry['duration'] !== null && (
              <>
                <IntInput value={entry['duration'] as number} min={1} max={99} onChange={(v) => set('duration', v ?? 1)} /> turns
              </>
            )}
          </span>
        </Row>
        <Row label="Applied again">
          <EnumSelect values={['refresh', 'extend', 'stack', 'ignore']} labels={{ refresh: 'refresh the duration', extend: 'add to the duration', stack: 'add a stack (and refresh)', ignore: 'nothing happens' }} value={(entry['stacking'] as string | undefined) ?? 'refresh'} onChange={(v) => set('stacking', v)} />
        </Row>
        {entry['stacking'] === 'stack' && (
          <Row label="Max stacks">
            <IntInput value={(entry['maxStacks'] as number | undefined) ?? 1} min={1} max={99} onChange={(v) => set('maxStacks', v ?? 1)} />
          </Row>
        )}
        <StatModifiers value={entry['modifiers'] as Json[] | undefined} onChange={(v) => set('modifiers', v)} label="Per stack" />
        <Row label="Grants tags">
          <RefMulti section="entityTags" value={entry['grantsTags'] as string[] | undefined} max={8} onChange={(v) => set('grantsTags', v)} />
        </Row>
        <Row label="Cannot">
          <span className="ed-inline wrap">
            {CAPABILITY_LIST.map((c) => (
              <Checkbox key={c} label={c} value={suppress.includes(c)} onChange={(v) => set('suppress', v ? [...suppress, c] : suppress.filter((x) => x !== c))} />
            ))}
          </span>
        </Row>
        <Row label="Visibility" help="Hidden statuses (secret curses) are invisible to every contestant, the holder included.">
          <EnumSelect values={['public', 'hidden']} value={(entry['visibility'] as string | undefined) ?? 'public'} onChange={(v) => set('visibility', v === 'public' ? undefined : v)} />
        </Row>
        <Row label="Transformation" help="Changes the token's look (its icon) and is offered as a GM template.">
          <Checkbox label="a transformation" value={entry['transformation'] === true} onChange={(v) => set('transformation', v || undefined)} />
        </Row>
      </div>
      <AttachedRules {...p} />
    </>
  );
}

function ShopForm({ entry, set, def }: FormProps) {
  const env = useEnv();
  const entries = (entry['entries'] ?? []) as Json[];
  const setEntry = (i: number, v: Json) => set('entries', entries.map((x, j) => (j === i ? v : x)));
  return (
    <div className="ed-block">
      <div className="ed-block-title">For sale</div>
      <table className="ed-table">
        <thead>
          <tr>
            <th>id</th>
            <th>sells</th>
            <th>price</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {entries.map((en, i) => {
            const grants = (en['grants'] ?? {}) as Json;
            const price = (en['price'] ?? {}) as Json;
            const isItem = 'item' in grants;
            return (
              <tr key={i}>
                <td>
                  <TextInput value={en['id'] as string} max={80} onChange={(v) => setEntry(i, { ...en, id: v })} />
                </td>
                <td>
                  <span className="ed-inline">
                    <EnumSelect values={['item', 'resource']} value={isItem ? 'item' : 'resource'} onChange={(v) => setEntry(i, { ...en, grants: v === 'item' ? { item: env.catalog.items[0]?.id ?? '' } : { resource: env.catalog.resources[0]?.id ?? '', amount: 1 } })} />
                    {isItem ? (
                      <RefSelect section="items" value={grants['item'] as string} onChange={(v) => setEntry(i, { ...en, grants: { item: v ?? '' } })} />
                    ) : (
                      <>
                        <IntInput value={grants['amount'] as number} min={1} onChange={(v) => setEntry(i, { ...en, grants: { ...grants, amount: v ?? 1 } })} />
                        <RefSelect section="resources" value={grants['resource'] as string} onChange={(v) => setEntry(i, { ...en, grants: { ...grants, resource: v ?? '' } })} />
                      </>
                    )}
                  </span>
                </td>
                <td>
                  <span className="ed-inline">
                    <IntInput value={price['amount'] as number} min={0} onChange={(v) => setEntry(i, { ...en, price: { ...price, amount: v ?? 0 } })} />
                    <RefSelect section="resources" value={price['resource'] as string} onChange={(v) => setEntry(i, { ...en, price: { ...price, resource: v ?? '' } })} />
                  </span>
                </td>
                <td>
                  <ListButtons index={i} length={entries.length} onMove={(to) => set('entries', moveItem(entries, i, to))} onDelete={() => set('entries', entries.filter((_, j) => j !== i))} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!env.readOnly && entries.length < 12 && (
        <button onClick={() => set('entries', [...entries, { id: uniqueId('entry', `${entry.name} ${entries.length + 1}`, allIds(def)), grants: { resource: env.catalog.resources[0]?.id ?? '', amount: 1 }, price: { resource: env.catalog.resources[0]?.id ?? '', amount: 5 } }])}>
          + entry
        </button>
      )}
    </div>
  );
}

function FixtureForm({ entry, set }: FormProps) {
  const start = (entry['start'] ?? {}) as Json;
  const random = 'randomSpaceTag' in start;
  const env = useEnv();
  return (
    <div className="ed-grid">
      <IconField entry={entry} set={set} />
      <Row label="Tags">
        <RefMulti section="entityTags" value={entry['tags'] as string[] | undefined} max={8} onChange={(v) => set('tags', v)} />
      </Row>
      <Row label="Sells from shop">
        <RefSelect optional section="shops" value={entry['shop'] as string | undefined} onChange={(v) => set('shop', v)} />
      </Row>
      <Row label="Starts">
        <span className="ed-inline">
          <EnumSelect values={['space', 'random']} labels={{ space: 'on a space', random: 'on a random space tagged' }} value={random ? 'random' : 'space'} onChange={(v) => set('start', v === 'random' ? { randomSpaceTag: env.catalog.spaceTags[0]?.id ?? '' } : { space: env.catalog.spaces[0]?.id ?? '' })} />
          {random ? (
            <RefSelect section="spaceTags" value={start['randomSpaceTag'] as string} onChange={(v) => set('start', { randomSpaceTag: v ?? '' })} />
          ) : (
            <RefSelect section="spaces" value={start['space'] as string} onChange={(v) => set('start', { space: v ?? '' })} />
          )}
        </span>
      </Row>
    </div>
  );
}

function EnemyForm(p: FormProps) {
  const { entry, set } = p;
  return (
    <>
      <div className="ed-grid">
        <IconField entry={entry} set={set} />
        <Description entry={entry} set={set} />
        <Row label="Tags">
          <RefMulti section="entityTags" value={entry['tags'] as string[] | undefined} max={8} onChange={(v) => set('tags', v)} />
        </Row>
        <Row label="Power">
          <IntInput value={entry['power'] as number} min={1} onChange={(v) => set('power', v ?? 1)} />
        </Row>
        <Row label="Max HP">
          <IntInput value={entry['maxHp'] as number} min={1} onChange={(v) => set('maxHp', v ?? 1)} />
        </Row>
        <Row label="Heals per round">
          <IntInput value={(entry['regenPerRound'] as number | undefined) ?? 0} min={0} onChange={(v) => set('regenPerRound', v ?? 0)} />
        </Row>
        <Row label="Returns after defeat">
          <span className="ed-inline">
            <Checkbox label="never" value={entry['respawnAfterRounds'] === null} onChange={(v) => set('respawnAfterRounds', v ? null : 3)} />
            {entry['respawnAfterRounds'] !== null && (
              <>
                <IntInput value={entry['respawnAfterRounds'] as number} min={1} onChange={(v) => set('respawnAfterRounds', v ?? 1)} /> rounds
              </>
            )}
          </span>
        </Row>
        <Row label="Boss">
          <Checkbox label="a boss (crown on the board)" value={entry['boss'] === true} onChange={(v) => set('boss', v || undefined)} />
        </Row>
        <Row label="Starts at" help="Leave empty for enemies that only appear when spawned.">
          <RefMulti section="spaces" value={entry['spawns'] as string[] | undefined} max={20} onChange={(v) => set('spawns', v)} />
        </Row>
      </div>
      <div className="ed-block">
        <div className="ed-block-title">Reward for the victor ($actor = victor, $target = this enemy)</div>
        <EffectList value={(entry['rewards'] as unknown[] | undefined) ?? []} onChange={(v) => set('rewards', v)} />
      </div>
      <AttachedRules {...p} />
    </>
  );
}

function DeckForm({ entry, set, def }: FormProps) {
  const env = useEnv();
  const cards = (entry['cards'] ?? []) as Json[];
  const [open, setOpen] = useState<number | null>(0);
  const setCard = (i: number, key: string, v: unknown) => set('cards', cards.map((c, j) => (j === i ? (v === undefined ? Object.fromEntries(Object.entries(c).filter(([k]) => k !== key)) : { ...c, [key]: v }) : c)));
  const total = cards.reduce((s, c) => s + ((c['count'] as number | undefined) ?? 1), 0);
  return (
    <>
      <Description entry={entry} set={set} />
      <div className="ed-block">
        <div className="ed-block-title">
          Cards ({cards.length} kinds, {total} in the deck)
        </div>
        {cards.map((c, i) => (
          <div key={i} className="attached-rule">
            <div className="ed-inline-row">
              <button className="link" onClick={() => setOpen(open === i ? null : i)}>
                {open === i ? '▾' : '▸'} {String(c['name'])}
              </button>
              <span className="muted small">
                ×{(c['count'] as number | undefined) ?? 1} · {env.texts[`cards:${String(c['id'])}`]}
              </span>
              <span className="grow" />
              <ListButtons index={i} length={cards.length} onMove={(to) => set('cards', moveItem(cards, i, to))} onDelete={() => set('cards', cards.filter((_, j) => j !== i))} />
            </div>
            {open === i && (
              <>
                <div className="ed-inline-row">
                  <span className="ed-label">name</span>
                  <TextInput value={c['name'] as string} max={80} onChange={(v) => setCard(i, 'name', v)} />
                  <span className="ed-label">id</span>
                  <TextInput value={c['id'] as string} max={80} onChange={(v) => setCard(i, 'id', v)} />
                  <span className="ed-label">copies</span>
                  <IntInput value={(c['count'] as number | undefined) ?? 1} min={1} max={10} onChange={(v) => setCard(i, 'count', v ?? 1)} />
                </div>
                <Row label="Card text">
                  <TextInput multiline max={300} value={c['text'] as string | undefined} onChange={(v) => setCard(i, 'text', v || undefined)} />
                </Row>
                <EffectList label="Effects for the drawer ($actor)" value={(c['effects'] as unknown[] | undefined) ?? []} onChange={(v) => setCard(i, 'effects', v)} />
              </>
            )}
          </div>
        ))}
        {!env.readOnly && cards.length < 40 && (
          <button
            onClick={() => {
              const name = `Card ${cards.length + 1}`;
              set('cards', [...cards, { id: uniqueId('card', `${entry.name} ${name}`, allIds(def)), name, count: 1, effects: [{ op: 'announce', text: 'Nothing happens.' }] }]);
              setOpen(cards.length);
            }}
          >
            + card
          </button>
        )}
      </div>
    </>
  );
}

function ActionForm({ entry, set }: FormProps) {
  const env = useEnv();
  const where = (entry['where'] ?? {}) as Json;
  const cost = entry['cost'] as Json | undefined;
  const target = entry['target'] as Json | undefined;
  const setWhere = (key: string, v: string | undefined) => {
    const next = { ...where };
    if (v === undefined) delete next[key];
    else next[key] = v;
    set('where', Object.keys(next).length > 0 ? next : undefined);
  };
  return (
    <>
      <div className="ed-grid">
        <IconField entry={entry} set={set} />
        <Description entry={entry} set={set} />
        <Row label="Only on space">
          <RefSelect optional section="spaces" value={where['space'] as string | undefined} onChange={(v) => setWhere('space', v)} />
        </Row>
        <Row label="Only on spaces tagged">
          <RefSelect optional section="spaceTags" value={where['spaceTag'] as string | undefined} onChange={(v) => setWhere('spaceTag', v)} />
        </Row>
        <Row label="Costs">
          <span className="ed-inline">
            <Checkbox label="" value={cost !== undefined} onChange={(v) => set('cost', v ? { resource: env.catalog.resources[0]?.id ?? '', amount: 1 } : undefined)} />
            {cost && (
              <>
                <IntInput value={cost['amount'] as number} min={1} onChange={(v) => set('cost', { ...cost, amount: v ?? 1 })} />
                <RefSelect section="resources" value={cost['resource'] as string} onChange={(v) => set('cost', { ...cost, resource: v ?? '' })} />
              </>
            )}
          </span>
        </Row>
        <Row label="Cooldown (rounds)">
          <IntInput optional value={entry['cooldownRounds'] as number | undefined} min={1} max={50} onChange={(v) => set('cooldownRounds', v)} />
        </Row>
        <Row label="Target">
          <span className="ed-inline">
            <Checkbox label="" value={target !== undefined} onChange={(v) => set('target', v ? { kind: 'contestant', range: 'here' } : undefined)} />
            {target && (
              <>
                <EnumSelect values={KINDS} value={target['kind'] as string} onChange={(v) => set('target', { ...target, kind: v ?? 'contestant' })} />
                <EnumSelect values={['here', 'anywhere']} labels={{ here: 'on the same space', anywhere: 'anywhere' }} value={target['range'] as string} onChange={(v) => set('target', { ...target, range: v ?? 'here' })} />
              </>
            )}
          </span>
        </Row>
      </div>
      <div className="ed-block">
        <div className="ed-block-title">
          Only if{' '}
          {entry['requires'] === undefined && !env.readOnly && (
            <button className="add-opt" onClick={() => set('requires', { op: 'isKind', entity: '$actor', kind: 'contestant' })}>
              + requirement
            </button>
          )}
          {entry['requires'] !== undefined && !env.readOnly && (
            <button className="icon opt-x" onClick={() => set('requires', undefined)}>
              ×
            </button>
          )}
        </div>
        {entry['requires'] !== undefined && <NodeEditor kind="cond" value={entry['requires']} onChange={(v) => set('requires', v)} />}
      </div>
      <div className="ed-block">
        <div className="ed-block-title">Effects ($actor = the user{target ? ', $target = the chosen target' : ''})</div>
        <EffectList value={(entry['effects'] as unknown[] | undefined) ?? []} onChange={(v) => set('effects', v)} />
      </div>
    </>
  );
}

function ObjectiveForm({ entry, set }: FormProps) {
  const env = useEnv();
  const goal = (entry['goal'] ?? { kind: 'reach' }) as Json;
  const trigger = (goal['trigger'] ?? { event: 'landed' }) as Json;
  const where = (trigger['where'] ?? {}) as Json;
  const fields = TRIGGER_WHERE[String(trigger['event'])] ?? [];
  return (
    <>
      <div className="ed-grid">
        <IconField entry={entry} set={set} />
        <Row label="Owner reads" help="Generated from the goal when empty.">
          <TextInput value={entry['text'] as string | undefined} max={200} wide onChange={(v) => set('text', v || undefined)} />
        </Row>
        <Row label="Goal">
          <EnumSelect
            values={['reach', 'count']}
            labels={{ reach: 'have at least … of a resource', count: 'do something a number of times' }}
            value={goal['kind'] as string}
            onChange={(v) => set('goal', v === 'count' ? { kind: 'count', trigger: { event: 'landed' }, times: 3 } : { kind: 'reach', resource: env.catalog.resources[0]?.id ?? '', atLeast: 20 })}
          />
        </Row>
        {goal['kind'] === 'reach' ? (
          <Row label="Reach">
            <span className="ed-inline">
              <IntInput value={goal['atLeast'] as number} min={1} onChange={(v) => set('goal', { ...goal, atLeast: v ?? 1 })} />
              <RefSelect section="resources" value={goal['resource'] as string} onChange={(v) => set('goal', { ...goal, resource: v ?? '' })} />
            </span>
          </Row>
        ) : (
          <>
            <Row label="When">
              <EnumSelect values={TRIGGERS} labels={TRIGGER_LABELS} value={String(trigger['event'])} onChange={(v) => set('goal', { ...goal, trigger: { event: v } })} />
            </Row>
            {fields.map((f) =>
              f.type.t === 'ref' ? (
                <Row key={f.key} label={f.label}>
                  <RefSelect optional section={f.type.section} value={where[f.key] as string | undefined} onChange={(v) => {
                    const next = { ...where };
                    if (v === undefined) delete next[f.key];
                    else next[f.key] = v;
                    set('goal', { ...goal, trigger: Object.keys(next).length ? { event: trigger['event'], where: next } : { event: trigger['event'] } });
                  }} />
                </Row>
              ) : null,
            )}
            <Row label="Times">
              <IntInput value={goal['times'] as number} min={1} max={20} onChange={(v) => set('goal', { ...goal, times: v ?? 1 })} />
            </Row>
          </>
        )}
      </div>
      <div className="ed-block">
        <div className="ed-block-title">Reward ($actor = the owner)</div>
        <EffectList value={(entry['reward'] as unknown[] | undefined) ?? []} onChange={(v) => set('reward', v)} />
      </div>
    </>
  );
}

function CastForm({ entry, set }: FormProps) {
  const env = useEnv();
  const persona = (entry['persona'] ?? { voice: '', traits: {}, behaviors: [] }) as Json;
  const traits = (persona['traits'] ?? {}) as Record<string, number>;
  const behaviors = (persona['behaviors'] ?? []) as string[];
  const setPersona = (key: string, v: unknown) => set('persona', { ...persona, [key]: v });
  return (
    <div className="ed-grid">
      <IconField entry={entry} set={set} />
      <Row label="Color">
        <input type="color" disabled={env.readOnly} value={(entry['color'] as string | undefined) ?? '#888888'} onChange={(e) => set('color', e.target.value)} />
      </Row>
      <Row label="Voice" help="How they talk, in a few words (≤ 200 characters).">
        <TextInput multiline max={200} value={persona['voice'] as string} onChange={(v) => setPersona('voice', v)} />
      </Row>
      {TRAIT_NAMES.map((t) => (
        <Row key={t} label={t}>
          <span className="ed-inline">
            <input type="range" min={0} max={10} disabled={env.readOnly} value={traits[t] ?? 5} onChange={(e) => setPersona('traits', { ...traits, [t]: Number(e.target.value) })} />
            <span className="small">{traits[t] ?? 5}</span>
          </span>
        </Row>
      ))}
      <Row label="Rules of thumb">
        <div>
          {behaviors.map((b, i) => (
            <div key={i} className="ed-inline-row">
              <TextInput value={b} max={160} wide onChange={(v) => setPersona('behaviors', behaviors.map((x, j) => (j === i ? v : x)))} />
              {!env.readOnly && (
                <button className="icon danger" onClick={() => setPersona('behaviors', behaviors.filter((_, j) => j !== i))}>
                  ✕
                </button>
              )}
            </div>
          ))}
          {!env.readOnly && behaviors.length < 4 && <button onClick={() => setPersona('behaviors', [...behaviors, 'Never trust a smiling rival.'])}>+ rule of thumb</button>}
        </div>
      </Row>
    </div>
  );
}

export const SECTION_FORMS: Record<string, { title: string; form: (p: FormProps) => ReactNode }> = {
  resources: { title: 'Resources', form: (p) => <ResourceForm {...p} /> },
  tags: { title: 'Tags', form: (p) => <TagForm {...p} /> },
  items: { title: 'Items', form: (p) => <ItemForm {...p} /> },
  statuses: { title: 'Statuses', form: (p) => <StatusForm {...p} /> },
  shops: { title: 'Shops', form: (p) => <ShopForm {...p} /> },
  fixtures: { title: 'Fixtures', form: (p) => <FixtureForm {...p} /> },
  enemies: { title: 'Enemies', form: (p) => <EnemyForm {...p} /> },
  decks: { title: 'Decks', form: (p) => <DeckForm {...p} /> },
  actions: { title: 'Actions', form: (p) => <ActionForm {...p} /> },
  objectives: { title: 'Objectives', form: (p) => <ObjectiveForm {...p} /> },
  cast: { title: 'Cast', form: (p) => <CastForm {...p} /> },
};

/** The rules section: the list plus the full rule editor. */
export function RulesSection(props: SectionProps) {
  const { def, edit } = props;
  return (
    <ListSection
      {...props}
      section="rules"
      title="Rules"
      form={({ entry, path }) => {
        const index = path[1] as number;
        const rules = (def['rules'] ?? []) as Json[];
        return <RuleEditor rule={entry} path={path} onChange={(next) => edit({ ...def, rules: rules.map((r, j) => (j === index ? next : r)) }, `rules:${index}`)} />;
      }}
    />
  );
}
