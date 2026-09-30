import { useState } from 'react';
import type { GmCommandInput } from '../../schema/commands.ts';
import type { MatchData } from '../api.ts';

/**
 * A contestant's inventory: equipment slots with the gear worn in them, and the bag (copies of a
 * stackable item shown as one stack), with charges and cooldowns. With GM actions, each item can
 * be put on or taken off, handed to another contestant or taken away, and items can be given.
 */

interface Props {
  data: MatchData;
  entityId: string;
  /** GM actions; without it the panel is read-only. */
  gm?: ((cmd: GmCommandInput, label: string) => void) | undefined;
  silent?: boolean;
}

export function InventoryPanel({ data, entityId, gm, silent = false }: Props) {
  const def = data.definition;
  const { state } = data;
  const entity = state.entities[entityId];
  const [give, setGive] = useState(def.items[0]?.id ?? '');
  const [to, setTo] = useState<Record<string, string>>({});
  if (!entity || entity.kind !== 'contestant') return null;
  const itemDef = (id: string) => def.items.find((x) => x.id === state.items[id]?.defId);
  const worn = entity.items.filter((id) => state.items[id]?.equipped);
  const carried = entity.items.filter((id) => !state.items[id]?.equipped);
  // Stacks: copies of one definition share bag spaces up to its stack size.
  const stacks = new Map<string, string[]>();
  for (const id of carried) {
    const d = state.items[id]?.defId ?? id;
    stacks.set(d, [...(stacks.get(d) ?? []), id]);
  }
  let used = 0;
  for (const [d, ids] of stacks) used += Math.ceil(ids.length / (def.items.find((x) => x.id === d)?.stackSize ?? 1));
  const others = state.turnOrder.filter((id) => id !== entityId && state.entities[id]?.status !== 'removed');
  const cooldown = (id: string) => {
    const ready = state.cooldowns[`item:${id}`];
    return ready !== undefined && ready > state.round ? ready - state.round : 0;
  };
  const cmd = (c: GmCommandInput, label: string) => gm?.(c, label);

  const actions = (id: string) =>
    gm && (
      <span className="inv-actions">
        {itemDef(id)?.slot !== undefined && (
          <button className="icon" title={state.items[id]?.equipped ? 'Take off' : 'Equip'} onClick={() => cmd({ type: 'equipItem', entity: entityId, item: id, equipped: !state.items[id]?.equipped, silent }, `${state.items[id]?.equipped ? 'take off' : 'equip'} ${itemDef(id)?.name ?? id}`)}>
            {state.items[id]?.equipped ? '⤓' : '⤒'}
          </button>
        )}
        {others.length > 0 && (
          <>
            <select value={to[id] ?? ''} onChange={(e) => setTo({ ...to, [id]: e.target.value })} title="Give to">
              <option value="">give to…</option>
              {others.map((o) => (
                <option key={o} value={o}>
                  {state.entities[o]?.name}
                </option>
              ))}
            </select>
            {to[id] && (
              <button className="icon" title="Hand it over" onClick={() => cmd({ type: 'moveItem', entity: entityId, item: id, to: to[id] as string, silent }, `give ${itemDef(id)?.name ?? id}`)}>
                ➜
              </button>
            )}
          </>
        )}
        <button className="icon danger" title="Take it away" onClick={() => cmd({ type: 'removeItem', entity: entityId, item: id, silent }, `take ${itemDef(id)?.name ?? id}`)}>
          ✕
        </button>
      </span>
    );

  const itemLine = (ids: string[]) => {
    const first = ids[0] as string;
    const d = itemDef(first);
    const inst = state.items[first];
    const cd = cooldown(first);
    return (
      <li key={first} className="inv-item" title={d ? data.rulebook.items[d.id] : ''}>
        <span className="inv-icon">{d?.icon ?? '•'}</span>
        <span className="inv-name">
          {d?.name ?? first}
          {ids.length > 1 ? ` ×${ids.length}` : ''}
          {inst?.charges !== null && inst?.charges !== undefined ? <span className="chip">{inst.charges} uses</span> : null}
          {cd > 0 ? <span className="chip">ready in {cd}</span> : null}
          {d?.concealed ? <span className="chip">🔒</span> : null}
          {d?.use?.free ? <span className="chip">free</span> : null}
          <span className="muted small inv-text">{d ? data.rulebook.items[d.id] : ''}</span>
        </span>
        {actions(first)}
      </li>
    );
  };

  return (
    <div className="block inventory">
      <h4>
        Inventory <span className="muted small">bag {used}/{def.settings.inventoryCapacity}</span>
      </h4>
      {def.settings.equipment.length > 0 && (
        <div className="inv-slots">
          {def.settings.equipment.map((slot) => {
            const inSlot = worn.filter((id) => itemDef(id)?.slot === slot.id);
            return (
              <div key={slot.id} className="inv-slot">
                <span className="muted small">{slot.name}</span>
                {inSlot.length === 0 ? <span className="muted"> — </span> : <ul className="plain">{inSlot.map((id) => itemLine([id]))}</ul>}
              </div>
            );
          })}
        </div>
      )}
      {stacks.size === 0 ? <p className="muted small">The bag is empty.</p> : <ul className="plain">{[...stacks.values()].map((ids) => itemLine(ids))}</ul>}
      {gm && (
        <div className="ed-inline-row">
          <select value={give} onChange={(e) => setGive(e.target.value)}>
            {def.items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.icon} {i.name}
              </option>
            ))}
          </select>
          <button onClick={() => cmd({ type: 'grantItem', entity: entityId, item: give, silent }, `give ${give}`)}>Give</button>
        </div>
      )}
    </div>
  );
}
