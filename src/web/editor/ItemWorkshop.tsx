import { useState } from 'react';
import { uniqueId } from '../../shared/templates.ts';
import { allIds, type Json } from './model.ts';
import { Checkbox, EnumSelect, IntInput, RefMulti, Row, TextInput, useEnv } from './fields.tsx';
import { EffectList, NodeEditor } from './NodeEditor.tsx';
import { AttachedRules, Description, ListSection, StatModifiers, type EntryTemplate, type FormProps, type SectionProps } from './Sections.tsx';

/**
 * The item workshop: everything about an item in one place — how it is carried (equipment slot,
 * stacking), what it gives while held or worn, how it is used (target, charges, cooldown, free
 * action, requirement, effects), a tip for AI contestants, its worth, where it is sold — with a
 * live item card and the line AI contestants read for it.
 */

const ICONS = ['🗡️', '⚔️', '🪓', '🏹', '🔱', '🛡️', '🪖', '🥾', '💍', '📿', '🧿', '🍀', '🧪', '🍖', '🥜', '🍌', '🍄', '💣', '🧨', '🪄', '📜', '🔮', '🔑', '🗝️', '💎', '🪙', '🎁', '🗿', '🐚', '🦴', '⭐', '🌟', '🔥', '❄️', '⚡', '💀', '🪤', '🧲', '⛏️', '🎲'];

function core(def: Json): { hp: string; power: string; gold: string; maxHp: string } {
  const c = ((def['settings'] as Json | undefined)?.['core'] ?? {}) as { hp?: string; power?: string; gold?: string; maxHp?: string };
  return { hp: c.hp ?? 'res.hp', power: c.power ?? 'res.power', gold: c.gold ?? 'res.gold', maxHp: c.maxHp ?? 'res.max_hp' };
}

function slotLike(def: Json, word: RegExp): string | undefined {
  const slots = (((def['settings'] as Json | undefined)?.['equipment'] ?? []) as Array<{ id: string; name: string }>);
  return (slots.find((s) => word.test(`${s.id} ${s.name}`.toLowerCase())) ?? slots[0])?.id;
}

/** Starting points for common kinds of item. */
export const ITEM_TEMPLATES: EntryTemplate[] = [
  {
    label: '🧪 Healing potion (stacks, used up)',
    make: (def) => ({ name: 'Healing Potion', icon: '🧪', stackSize: 3, value: 5, aiHint: 'Drink it when your HP is low.', use: { label: 'Drink', effects: [{ op: 'changeResource', target: '$actor', resource: core(def).hp, amount: 40 }], consumed: true } }),
  },
  {
    label: '🗡️ Weapon (worn: + Power)',
    make: (def) => ({ name: 'Short Sword', icon: '🗡️', ...(slotLike(def, /weapon|hand/) ? { slot: slotLike(def, /weapon|hand/) } : {}), modifiers: [{ resource: core(def).power, add: 80 }], value: 10 }),
  },
  {
    label: '🛡️ Armor (worn: + Max HP)',
    make: (def) => ({ name: 'Leather Armor', icon: '🛡️', ...(slotLike(def, /armou?r|body|chest/) ? { slot: slotLike(def, /armou?r|body|chest/) } : {}), modifiers: [{ resource: core(def).maxHp, add: 30 }], value: 10 }),
  },
  {
    label: '💣 Bomb (thrown at a rival here)',
    make: () => ({
      name: 'Bomb',
      icon: '💣',
      stackSize: 2,
      value: 7,
      aiHint: 'Throw it at a rival on your space before you attack them.',
      use: { label: 'Throw', target: { kind: 'contestant', range: 'here' }, effects: [{ op: 'damage', target: '$target', amount: { op: 'roll', count: 2, sides: 8 } }], consumed: true },
    }),
  },
  {
    label: '🪄 Wand (3 charges, once a round)',
    make: () => ({ name: 'Wand', icon: '🪄', value: 14, aiHint: 'Zap rivals on your space; it recharges each round.', use: { label: 'Zap', target: { kind: 'contestant', range: 'here' }, effects: [{ op: 'damage', target: '$target', amount: 12 }], consumed: true, charges: 3, cooldownRounds: 1 } }),
  },
  {
    label: '🥜 Snack (free action)',
    make: (def) => ({ name: 'Snack', icon: '🥜', stackSize: 5, value: 2, aiHint: 'Eat it whenever you are hurt; it does not use up your action.', use: { label: 'Eat', effects: [{ op: 'changeResource', target: '$actor', resource: core(def).hp, amount: 10 }], consumed: true, free: true } }),
  },
  {
    label: '📜 Teleport scroll',
    make: (def) => ({
      name: 'Teleport Scroll',
      icon: '📜',
      value: 8,
      aiHint: 'Read it to get back to the start in a hurry.',
      use: { label: 'Read', effects: [{ op: 'teleport', target: '$actor', to: { op: 'space', id: String((def['settings'] as Json | undefined)?.['startSpace'] ?? '') }, asLanding: true }], consumed: true },
    }),
  },
  {
    label: '🍀 Lucky charm (passive rule)',
    make: (def) => ({
      name: 'Lucky Charm',
      icon: '🍀',
      value: 12,
      rules: [
        {
          id: 'rule.lucky_charm_bonus',
          name: 'Lucky Charm bonus',
          kind: 'modifier',
          on: 'resourceChange',
          where: { resource: core(def).gold, direction: 'gain' },
          conditions: { op: 'same', a: '$target', b: '$holder' },
          modify: { op: 'add', amount: 1 },
        },
      ],
    }),
  },
  {
    label: '🗿 Cursed idol (concealed, − Power)',
    make: (def) => ({ name: 'Cursed Idol', icon: '🗿', concealed: true, tradeable: true, modifiers: [{ resource: core(def).power, add: -40 }], aiHint: 'Trade it away to someone you dislike.' }),
  },
  {
    label: '🔑 Key (quest item)',
    make: () => ({ name: 'Old Key', icon: '🔑', value: 0, aiHint: 'Keep it: something on the board needs it.' }),
  },
];

function IconPicker({ value, onChange }: { value: string | undefined; onChange: (v: string | undefined) => void }) {
  const env = useEnv();
  const [open, setOpen] = useState(false);
  return (
    <span className="icon-picker">
      <button className="icon-big" disabled={env.readOnly} onClick={() => setOpen(!open)} title="Choose an icon">
        {value || '＋'}
      </button>
      <TextInput value={value} max={8} onChange={(v) => onChange(v || undefined)} placeholder="emoji" />
      {open && (
        <span className="icon-grid">
          {ICONS.map((i) => (
            <button key={i} className="icon-cell" onClick={() => (onChange(i), setOpen(false))}>
              {i}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

type TargetChoice = 'none' | 'contestant:here' | 'contestant:anywhere' | 'enemy:here' | 'enemy:anywhere';

/** What an AI contestant reads for this item (inventory line and option line), approximated from the definition. */
function aiLines(entry: Json, text: string | undefined): string[] {
  const use = entry['use'] as Json | undefined;
  const name = String(entry['name'] ?? '');
  const lines = [`In its inventory: ${name}${entry['slot'] ? ' (worn)' : ''}${use?.['charges'] ? ` [${String(use['charges'])} uses]` : ''}`];
  if (use) {
    const target = use['target'] as { kind: string; range: string } | undefined;
    const spend = use['consumed'] === false ? '' : use['charges'] ? ` (${String(use['charges'])} uses left)` : ' (used up)';
    const who = target ? ` on <a ${target.kind}${target.range === 'here' ? ' on its space' : ''}>` : '';
    const effects = text?.match(/use[^:]*: ([^;]+)/)?.[1] ?? 'its effects';
    lines.push(`Option: Use ${name}${who}${spend}${use['free'] ? ' (free action)' : ''} — ${effects}${entry['aiHint'] ? ` [GM tip: ${String(entry['aiHint'])}]` : ''}`);
  }
  if (entry['slot']) lines.push(`Option (when not worn): Equip ${name} (free action) — with the stat change`);
  return lines;
}

export function ItemWorkshopForm(p: FormProps & { edit: (next: Json) => void }) {
  const { entry, set, def, edit } = p;
  const env = useEnv();
  const use = entry['use'] as Json | undefined;
  const slots = (((def['settings'] as Json | undefined)?.['equipment'] ?? []) as Array<{ id: string; name: string; count: number }>);
  const setUse = (key: string, v: unknown) => {
    if (!use) return;
    const next = { ...use };
    if (v === undefined) delete next[key];
    else next[key] = v;
    set('use', next);
  };
  const target = use?.['target'] as { kind: string; range: string } | undefined;
  const targetChoice: TargetChoice = target ? (`${target.kind}:${target.range}` as TargetChoice) : 'none';
  const text = env.texts[`items:${entry.id}`];
  const shops = (def['shops'] ?? []) as Array<{ id: string; name: string; entries: Array<{ id: string; grants: Json; price: { resource: string; amount: number } }> }>;
  const soldAt = shops.flatMap((s) => s.entries.filter((e) => e.grants['item'] === entry.id).map((e) => ({ shop: s, entry: e })));
  const [shopPick, setShopPick] = useState('');
  const [price, setPrice] = useState(5);
  const addToShop = () => {
    const shopId = shopPick || shops[0]?.id;
    if (!shopId) return;
    const entryId = uniqueId('entry', `${entry.name}`, allIds(def));
    edit({ ...def, shops: shops.map((s) => (s.id === shopId ? { ...s, entries: [...s.entries, { id: entryId, grants: { item: entry.id }, price: { resource: core(def).gold, amount: price } }] } : s)) });
  };
  return (
    <div className="workshop">
      <div className="workshop-form">
        <div className="ed-block">
          <div className="ed-block-title">Look and worth</div>
          <div className="ed-grid">
            <Row label="Icon" plain>
              <IconPicker value={entry['icon'] as string | undefined} onChange={(v) => set('icon', v)} />
            </Row>
            <Description entry={entry} set={set} />
            <Row label="Worth (gold)" help="Guides AI contestants when buying, trading and discarding.">
              <IntInput optional value={entry['value'] as number | undefined} min={0} onChange={(v) => set('value', v)} />
            </Row>
            <Row label="Tip for AI" help="Plain advice AI contestants read next to the item (≤ 160 characters).">
              <TextInput value={entry['aiHint'] as string | undefined} max={160} wide placeholder="e.g. Drink it when your HP is low" onChange={(v) => set('aiHint', v || undefined)} />
            </Row>
            <Row label="Tags">
              <RefMulti section="entityTags" value={entry['tags'] as string[] | undefined} max={8} onChange={(v) => set('tags', v)} />
            </Row>
          </div>
        </div>

        <div className="ed-block">
          <div className="ed-block-title">Carrying</div>
          <div className="ed-grid">
            <Row label="Worn as" help="Gear in an equipment slot is worn: it takes no bag space and gives its bonuses only while worn.">
              <select disabled={env.readOnly} value={(entry['slot'] as string | undefined) ?? ''} onChange={(e) => set('slot', e.target.value || undefined)}>
                <option value="">not worn (carried in the bag)</option>
                {slots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Row>
            {slots.length === 0 && (
              <p className="muted small" style={{ gridColumn: '1 / -1' }}>
                No equipment slots yet: add them under Overview &amp; settings → Inventory.
              </p>
            )}
            <Row label="Stacks" help="How many copies share one bag space.">
              <IntInput value={(entry['stackSize'] as number | undefined) ?? 1} min={1} max={99} onChange={(v) => set('stackSize', v && v > 1 ? v : undefined)} />
            </Row>
            <Row label="Concealed" help="Other contestants only see “a concealed item”.">
              <Checkbox label="hidden from rivals" value={entry['concealed'] === true} onChange={(v) => set('concealed', v || undefined)} />
            </Row>
            <Row label="Tradeable">
              <Checkbox label="can change hands in trades" value={entry['tradeable'] !== false} onChange={(v) => set('tradeable', v ? undefined : false)} />
            </Row>
          </div>
          <StatModifiers value={entry['modifiers'] as Json[] | undefined} onChange={(v) => set('modifiers', v)} label={entry['slot'] ? 'While worn' : 'While held'} />
        </div>

        <div className="ed-block">
          <div className="ed-block-title">
            Using it{' '}
            {!env.readOnly &&
              (use ? (
                <button className="icon opt-x" title="Not usable" onClick={() => set('use', undefined)}>
                  ×
                </button>
              ) : (
                <button className="add-opt" onClick={() => set('use', { effects: [{ op: 'changeResource', target: '$actor', resource: core(def).hp, amount: 20 }], consumed: true })}>
                  + can be used
                </button>
              ))}
          </div>
          {use ? (
            <>
              <div className="ed-grid">
                <Row label="Button label">
                  <TextInput value={use['label'] as string | undefined} max={60} placeholder={`Use ${entry.name}`} onChange={(v) => setUse('label', v || undefined)} />
                </Row>
                <Row label="Used on" help="A target makes one option per possible target; its effects can use $target.">
                  <EnumSelect
                    values={['none', 'contestant:here', 'contestant:anywhere', 'enemy:here', 'enemy:anywhere']}
                    labels={{ none: 'yourself only', 'contestant:here': 'a contestant on your space', 'contestant:anywhere': 'any contestant', 'enemy:here': 'an enemy on your space', 'enemy:anywhere': 'any enemy' }}
                    value={targetChoice}
                    onChange={(v) => {
                      if (!v || v === 'none') setUse('target', undefined);
                      else {
                        const [kind, range] = v.split(':');
                        setUse('target', { kind, range });
                      }
                    }}
                  />
                </Row>
                <Row label="Uses">
                  <span className="ed-inline">
                    <EnumSelect
                      values={['once', 'charges', 'forever']}
                      labels={{ once: 'used up after one use', charges: 'a number of charges', forever: 'never used up' }}
                      value={use['consumed'] === false ? 'forever' : use['charges'] ? 'charges' : 'once'}
                      onChange={(v) => {
                        const next = { ...use };
                        delete next['charges'];
                        if (v === 'forever') next['consumed'] = false;
                        else {
                          next['consumed'] = true;
                          if (v === 'charges') next['charges'] = 3;
                        }
                        set('use', next);
                      }}
                    />
                    {typeof use['charges'] === 'number' && <IntInput value={use['charges'] as number} min={2} max={20} onChange={(v) => setUse('charges', v ?? 2)} />}
                  </span>
                </Row>
                <Row label="Cooldown (rounds)">
                  <IntInput optional value={use['cooldownRounds'] as number | undefined} min={1} max={50} onChange={(v) => setUse('cooldownRounds', v)} />
                </Row>
                <Row label="Free action" help="Using it does not take the turn's main action (at most four free item actions a turn).">
                  <Checkbox label="does not use up the turn" value={use['free'] === true} onChange={(v) => setUse('free', v || undefined)} />
                </Row>
              </div>
              <div className="ed-inline-row">
                <span className="ed-label">Only if</span>
                {use['requires'] !== undefined ? (
                  <>
                    <NodeEditor kind="cond" value={use['requires']} onChange={(v) => setUse('requires', v)} />
                    {!env.readOnly && (
                      <button className="icon opt-x" onClick={() => setUse('requires', undefined)}>
                        ×
                      </button>
                    )}
                  </>
                ) : (
                  !env.readOnly && (
                    <button className="add-opt" onClick={() => setUse('requires', { op: 'isKind', entity: '$actor', kind: 'contestant' })}>
                      + requirement
                    </button>
                  )
                )}
              </div>
              <EffectList label={`Effects ($actor = the user${target ? ', $target = the chosen target' : ''})`} value={(use['effects'] as unknown[] | undefined) ?? []} onChange={(v) => setUse('effects', v)} />
            </>
          ) : (
            <p className="muted small">Not usable: it only gives its bonuses and attached rules.</p>
          )}
        </div>
        <AttachedRules {...p} />
      </div>

      <aside className="workshop-side">
        <div className="item-card">
          <div className="item-card-icon">{(entry['icon'] as string | undefined) || '❔'}</div>
          <div className="item-card-name">{entry.name}</div>
          <div className="item-card-badges">
            {entry['slot'] ? <span className="chip">{slots.find((s) => s.id === entry['slot'])?.name ?? String(entry['slot'])}</span> : null}
            {(entry['stackSize'] as number | undefined) && (entry['stackSize'] as number) > 1 ? <span className="chip">stacks {String(entry['stackSize'])}</span> : null}
            {typeof entry['value'] === 'number' ? <span className="chip">🪙 {String(entry['value'])}</span> : null}
            {entry['concealed'] ? <span className="chip">🔒 concealed</span> : null}
            {use?.['free'] ? <span className="chip">free action</span> : null}
          </div>
          <p className="item-card-text">{text ?? '…'}</p>
          {typeof entry['description'] === 'string' && entry['description'] ? <p className="muted small">{String(entry['description'])}</p> : null}
        </div>
        <div className="card">
          <h4>What AI contestants read</h4>
          <ul className="plain small ai-lines">
            {aiLines(entry, text).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          {!entry['aiHint'] && use ? <p className="warn small">Tip: add a “Tip for AI” so contestants know when to use it.</p> : null}
        </div>
        <div className="card">
          <h4>Where it comes from</h4>
          {soldAt.length === 0 && <p className="muted small">Not sold anywhere (rules, cards, rewards or the GM can still give it).</p>}
          <ul className="plain small">
            {soldAt.map(({ shop, entry: en }) => (
              <li key={en.id}>
                {shop.name}: {en.price.amount} {en.price.resource.replace(/^res\./, '')}
              </li>
            ))}
          </ul>
          {!env.readOnly && shops.length > 0 && (
            <div className="ed-inline-row wrap">
              <select value={shopPick} onChange={(e) => setShopPick(e.target.value)}>
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <IntInput value={price} min={0} onChange={(v) => setPrice(v ?? 0)} />
              <button onClick={addToShop}>Sell it there</button>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

/** The Items section of the editor: the list with templates, and the workshop for the selected item. */
export function ItemsSection(props: SectionProps) {
  const { def, edit } = props;
  return <ListSection {...props} section="items" title="Items" templates={ITEM_TEMPLATES} form={(p) => <ItemWorkshopForm {...p} edit={edit} />} />;
}
