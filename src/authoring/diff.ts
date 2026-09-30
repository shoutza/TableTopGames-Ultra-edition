import type { CompiledGame } from '../engine/compile.ts';
import { describeObjective, describeRule, describeStatus, makeNames, summarizeEffects, type Names } from '../engine/explain.ts';
import type { GameDefinition } from '../schema/definition.ts';
import type { ChangeLevel, DiffEntry } from '../schema/proposal.ts';

/**
 * What changed between two definitions, section by section, with a plain-language before/after
 * for each entry. Each change is classified:
 * - cosmetic: names, descriptions, icons, colours, layout, labels (no effect on play);
 * - ai: contestant personas (changes how models play, not the rules);
 * - mechanical: everything the engine uses.
 */

export type { ChangeLevel, DiffEntry };

const COSMETIC_KEYS = new Set(['name', 'description', 'icon', 'color', 'label', 'prompt', 'provenance', 'text', 'voice', 'behaviors']);

/** Drops cosmetic fields (never inside expression or effect nodes, whose fields all matter). */
function mechanical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mechanical);
  if (value === null || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const keep = typeof obj['op'] === 'string' && obj['op'] !== 'entity';
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keep && COSMETIC_KEYS.has(k)) continue;
    out[k] = mechanical(v);
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function levelOf(section: string, before: unknown, after: unknown): ChangeLevel {
  if (section === 'cast') {
    const strip = (v: unknown) => {
      const { persona: _p, ...rest } = (v ?? {}) as Record<string, unknown>;
      return mechanical(rest);
    };
    if (same(strip(before), strip(after))) {
      const b = (before as { persona?: unknown } | undefined)?.persona;
      const a = (after as { persona?: unknown } | undefined)?.persona;
      return same(b, a) ? 'cosmetic' : 'ai';
    }
    return 'mechanical';
  }
  return same(mechanical(before), mechanical(after)) ? 'cosmetic' : 'mechanical';
}

type Described = { id: string; name: string } & Record<string, unknown>;

function describeEntry(section: string, value: Described, game: CompiledGame, names: Names): string {
  const v = value as never;
  switch (section) {
    case 'rules':
      return describeRule(v, names);
    case 'statuses':
      return describeStatus(v, names);
    case 'objectives':
      return describeObjective(v, names);
    case 'resources': {
      const r = value as unknown as GameDefinition['resources'][number];
      return `${r.role}, ${r.min}–${r.max ?? '∞'}, starts at ${r.default}${r.visibility !== 'public' ? `, ${r.visibility}` : ''}${r.tradeable ? ', tradeable' : ''}`;
    }
    case 'items': {
      const i = value as unknown as GameDefinition['items'][number];
      const parts = [...i.modifiers.map((m) => `${m.add >= 0 ? '+' : ''}${m.add} ${names.resource(m.resource)}`), ...(i.use ? [`use: ${summarizeEffects(i.use.effects, names)}`] : []), ...(i.concealed ? ['concealed'] : [])];
      return parts.join('; ') || 'no effect';
    }
    case 'enemies': {
      const e = value as unknown as GameDefinition['enemies'][number];
      return `${e.power} Power, ${e.maxHp} HP${e.boss ? ', boss' : ''}; reward: ${summarizeEffects(e.rewards, names) || 'none'}`;
    }
    case 'shops': {
      const s = value as unknown as GameDefinition['shops'][number];
      return s.entries.map((en) => `${'item' in en.grants ? names.item(en.grants.item) : `${en.grants.amount} ${names.resource(en.grants.resource)}`} for ${en.price.amount} ${names.resource(en.price.resource)}`).join('; ');
    }
    case 'decks': {
      const d = value as unknown as GameDefinition['decks'][number];
      return d.cards.map((c) => `${c.count > 1 ? `${c.count}× ` : ''}${c.name}`).join(', ');
    }
    case 'actions': {
      const a = value as unknown as GameDefinition['actions'][number];
      return `${a.cost ? `costs ${a.cost.amount} ${names.resource(a.cost.resource)}; ` : ''}${summarizeEffects(a.effects, names)}`;
    }
    case 'spaces': {
      const s = value as unknown as GameDefinition['spaces'][number];
      return s.tags.length > 0 ? `tagged ${s.tags.map((t) => names.tag(t)).join(', ')}` : 'no tags';
    }
    case 'cast': {
      const c = value as unknown as GameDefinition['cast'][number];
      return Object.entries(c.persona.traits)
        .map(([k, t]) => `${k} ${t}`)
        .join(', ');
    }
    case 'fixtures': {
      const f = value as unknown as GameDefinition['fixtures'][number];
      return `${f.shop ? `sells from ${f.shop}; ` : ''}${'space' in f.start ? `at ${names.space(f.start.space)}` : `on a random ${names.tag(f.start.randomSpaceTag)} space`}`;
    }
    default:
      return value.name;
  }
}

const SECTIONS = ['resources', 'tags', 'spaces', 'items', 'statuses', 'shops', 'enemies', 'fixtures', 'decks', 'actions', 'objectives', 'cast', 'rules'] as const;

/** Differences from `oldGame` to `newGame`; with no old game (a new scenario) everything is added. */
export function diffGames(oldGame: CompiledGame | null, newGame: CompiledGame): DiffEntry[] {
  const out: DiffEntry[] = [];
  const oldNames = oldGame ? makeNames(oldGame, () => undefined) : null;
  const newNames = makeNames(newGame, () => undefined);
  const a = (oldGame?.def ?? {}) as unknown as Record<string, unknown>;
  const b = newGame.def as unknown as Record<string, unknown>;
  const isHidden = (section: string, v: Described | undefined) => (section === 'rules' || section === 'statuses') && (v as { visibility?: string } | undefined)?.visibility === 'hidden';
  for (const section of SECTIONS) {
    const before = new Map(((a[section] ?? []) as Described[]).map((x) => [x.id, x]));
    const after = new Map(((b[section] ?? []) as Described[]).map((x) => [x.id, x]));
    for (const [id, x] of after) {
      const y = before.get(id);
      if (!y) {
        out.push({ section, id, name: x.name, change: 'added', level: 'mechanical', after: describeEntry(section, x, newGame, newNames), hidden: isHidden(section, x) });
      } else if (oldGame && oldNames && !same(x, y)) {
        const level = levelOf(section, y, x);
        const beforeText = describeEntry(section, y, oldGame, oldNames);
        const afterText = describeEntry(section, x, newGame, newNames);
        out.push({ section, id, name: x.name !== y.name ? `${y.name} → ${x.name}` : x.name, change: 'changed', level, before: beforeText, after: afterText, hidden: isHidden(section, x) || isHidden(section, y) });
      }
    }
    for (const [id, y] of before) {
      if (!after.has(id) && oldGame && oldNames) out.push({ section, id, name: y.name, change: 'removed', level: 'mechanical', before: describeEntry(section, y, oldGame, oldNames), hidden: isHidden(section, y) });
    }
  }
  const key = (c: { a: string; b: string; directed: boolean }) => (c.directed ? `${c.a}>${c.b}` : [c.a, c.b].sort().join('|'));
  const oldLinks = new Set((oldGame?.def.connections ?? []).map(key));
  const newLinks = new Set(newGame.def.connections.map(key));
  const linkName = (k: string, n: Names) => (k.includes('>') ? k.split('>').map((s) => n.space(s)).join(' → ') : k.split('|').map((s) => n.space(s)).join(' — '));
  for (const k of newLinks) if (!oldLinks.has(k)) out.push({ section: 'connections', id: k, name: linkName(k, newNames), change: 'added', level: 'mechanical', hidden: false });
  if (!oldGame || !oldNames) return out;
  for (const k of oldLinks) if (!newLinks.has(k)) out.push({ section: 'connections', id: k, name: linkName(k, oldNames), change: 'removed', level: 'mechanical', hidden: false });
  const oldSettings = oldGame.def.settings as unknown as Record<string, unknown>;
  const newSettings = newGame.def.settings as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(oldSettings), ...Object.keys(newSettings)])) {
    if (!same(oldSettings[k], newSettings[k])) out.push({ section: 'settings', id: k, name: k, change: 'changed', level: 'mechanical', before: JSON.stringify(oldSettings[k]), after: JSON.stringify(newSettings[k]), hidden: false });
  }
  if (!same(oldGame.def.layout, newGame.def.layout)) out.push({ section: 'layout', id: 'layout', name: 'Board layout', change: 'changed', level: 'cosmetic', hidden: false });
  for (const k of ['name', 'description'] as const) {
    if (oldGame.def[k] !== newGame.def[k]) out.push({ section: 'game', id: k, name: k === 'name' ? 'Game name' : 'Game description', change: 'changed', level: 'cosmetic', before: oldGame.def[k], after: newGame.def[k], hidden: false });
  }
  if (oldGame.def.id !== newGame.def.id) out.push({ section: 'game', id: 'id', name: 'Game id', change: 'changed', level: 'cosmetic', before: oldGame.def.id, after: newGame.def.id, hidden: false });
  return out;
}

/** The overall level of a set of changes. */
export function changeLevel(entries: DiffEntry[]): 'none' | ChangeLevel {
  if (entries.some((e) => e.level === 'mechanical')) return 'mechanical';
  if (entries.some((e) => e.level === 'ai')) return 'ai';
  return entries.length > 0 ? 'cosmetic' : 'none';
}

const SECTION_NAMES: Record<string, string> = {
  resources: 'resource',
  tags: 'tag',
  spaces: 'space',
  items: 'item',
  statuses: 'status',
  shops: 'shop',
  enemies: 'enemy',
  fixtures: 'fixture',
  decks: 'deck',
  actions: 'action',
  objectives: 'objective',
  cast: 'contestant',
  rules: 'rule',
  connections: 'connection',
  settings: 'setting',
};

/** What contestants are told about a change: mechanical entries only, hidden rules left out. */
export function publicSummary(entries: DiffEntry[], limit = 8): string[] {
  const lines = entries
    .filter((e) => e.level === 'mechanical' && !e.hidden && e.section !== 'objectives')
    .map((e) => {
      const what = `${SECTION_NAMES[e.section] ?? e.section} “${e.name}”`;
      if (e.change === 'added') return `new ${what}${e.after ? `: ${e.after}` : ''}`;
      if (e.change === 'removed') return `${what} removed`;
      return `${what} now: ${e.after ?? 'changed'}`;
    });
  return lines.length > limit ? [...lines.slice(0, limit), `and ${lines.length - limit} more changes`] : lines;
}
