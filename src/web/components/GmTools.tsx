import { useEffect, useState } from 'react';
import type { GmCommandInput } from '../../schema/commands.ts';
import { api, type MatchData } from '../api.ts';
import { resourceName } from '../format.ts';

/**
 * GM interventions for the selected entity. Each one is an engine operation: rules react to it
 * unless "silent correction" is ticked, and a pending contestant decision is re-issued.
 */
export function GmTools({ data, entityId, teleportTarget }: { data: MatchData; entityId: string | null; teleportTarget: string | null }) {
  const def = data.definition;
  const entity = entityId ? data.state.entities[entityId] : undefined;
  const resources = entity ? Object.keys(entity.resources) : [];
  const [resource, setResource] = useState(def.settings.core.hp);
  const [amount, setAmount] = useState('10');
  const [tag, setTag] = useState(def.tags.find((t) => t.appliesTo === 'entity')?.id ?? '');
  const [item, setItem] = useState(def.items[0]?.id ?? '');
  const [space, setSpace] = useState(def.spaces[0]?.id ?? '');
  const [asLanding, setAsLanding] = useState(false);
  const [silent, setSilent] = useState(false);
  const [text, setText] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (teleportTarget) setSpace(teleportTarget);
  }, [teleportTarget]);
  useEffect(() => {
    if (entity && !resources.includes(resource) && resources[0]) setResource(resources[0]);
  }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (cmd: GmCommandInput, label: string) => {
    setMessage(null);
    api
      .gm(data.matchId, cmd)
      .then(() => setMessage({ ok: true, text: `Done: ${label}` }))
      .catch((err: unknown) => setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) }));
  };

  const announce = (
    <div className="tool">
      <h4>Announce</h4>
      <input value={text} placeholder="The volcano rumbles…" onChange={(e) => setText(e.target.value)} />
      <button disabled={!text.trim()} onClick={() => run({ type: 'announce', text: text.trim() }, 'announcement')}>
        Announce
      </button>
    </div>
  );

  if (!entity || !entityId) {
    return (
      <div className="gm-tools">
        <p className="muted">Select a contestant or enemy to intervene. Click a space on the board to pick a teleport destination.</p>
        {announce}
        {message && <p className={message.ok ? 'ok' : 'error'}>{message.text}</p>}
      </div>
    );
  }

  const n = Number.parseInt(amount, 10);
  const valid = Number.isFinite(n);
  return (
    <div className="gm-tools">
      <p>
        Acting on <b>{entity.name}</b>
      </p>
      <label className="check">
        <input type="checkbox" checked={silent} onChange={(e) => setSilent(e.target.checked)} /> Silent correction (rules do not react)
      </label>
      <div className="tool">
        <h4>Resource</h4>
        <select value={resource} onChange={(e) => setResource(e.target.value)}>
          {resources.map((r) => (
            <option key={r} value={r}>
              {resourceName(def, r)}
            </option>
          ))}
        </select>
        <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button disabled={!valid} onClick={() => run({ type: 'adjustResource', entity: entityId, resource, delta: n, silent }, `${n >= 0 ? '+' : ''}${n} ${resourceName(def, resource)}`)}>
          Add
        </button>
        <button disabled={!valid} onClick={() => run({ type: 'setResource', entity: entityId, resource, value: n, silent }, `set ${resourceName(def, resource)} to ${n}`)}>
          Set
        </button>
      </div>
      <div className="tool">
        <h4>Tag</h4>
        <select value={tag} onChange={(e) => setTag(e.target.value)}>
          {def.tags
            .filter((t) => t.appliesTo === 'entity')
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </select>
        <button onClick={() => run({ type: 'addTag', entity: entityId, tag, silent }, `tag ${tag}`)}>Add tag</button>
        <button onClick={() => run({ type: 'removeTag', entity: entityId, tag, silent }, `untag ${tag}`)}>Remove</button>
        <p className="hint">A tag alone changes nothing unless a rule refers to it (e.g. Fish → Fishy Blue Bonus).</p>
      </div>
      <div className="tool">
        <h4>Teleport</h4>
        <select value={space} onChange={(e) => setSpace(e.target.value)}>
          {def.spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={asLanding} onChange={(e) => setAsLanding(e.target.checked)} /> Counts as landing
        </label>
        <button onClick={() => run({ type: 'teleport', entity: entityId, space, asLanding, silent }, `teleport${asLanding ? ' (landing)' : ''}`)}>Teleport</button>
        <p className="hint">Landing rules (coins, ambushes, bananas) fire only if “counts as landing” is ticked.</p>
      </div>
      {entity.kind === 'contestant' && (
        <div className="tool">
          <h4>Items</h4>
          <select value={item} onChange={(e) => setItem(e.target.value)}>
            {def.items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.icon} {i.name}
              </option>
            ))}
          </select>
          <button onClick={() => run({ type: 'grantItem', entity: entityId, item, silent }, `give ${item}`)}>Give</button>
          {entity.items.map((i) => (
            <button key={i} className="chip" onClick={() => run({ type: 'removeItem', entity: entityId, item: i, silent }, `remove ${i}`)}>
              ✕ {def.items.find((x) => x.id === data.state.items[i]?.defId)?.name ?? i}
            </button>
          ))}
        </div>
      )}
      {announce}
      {message && <p className={message.ok ? 'ok' : 'error'}>{message.text}</p>}
    </div>
  );
}
