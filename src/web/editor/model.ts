import type { FieldSpec, FieldType, NodeKind, OpSpec, RefSection } from './spec.ts';
import { OPS } from './spec.ts';

/** Editor data helpers: the draft is plain JSON, edited immutably by path. */

export type Json = Record<string, unknown>;
export type Path = Array<string | number>;

export function getAt(root: unknown, path: Path): unknown {
  let cur = root;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/** A copy of `root` with the value at `path` replaced (`undefined` deletes an object key). */
export function setAt(root: unknown, path: Path, value: unknown): unknown {
  if (path.length === 0) return value;
  const [key, ...rest] = path as [string | number, ...Path];
  if (Array.isArray(root)) {
    const copy = root.slice();
    const next = setAt(copy[key as number], rest, value);
    if (next === undefined && rest.length === 0) copy.splice(key as number, 1);
    else copy[key as number] = next;
    return copy;
  }
  const obj = root !== null && typeof root === 'object' ? { ...(root as Json) } : {};
  const next = setAt(obj[key as string], rest, value);
  if (next === undefined) delete obj[key as string];
  else obj[key as string] = next;
  return obj;
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export interface CatalogEntry {
  id: string;
  name: string;
}

export type Catalog = Record<RefSection, CatalogEntry[]>;

function list(def: Json, key: string): Json[] {
  const v = def[key];
  return Array.isArray(v) ? (v as Json[]) : [];
}

/** Everything a reference field can point to, from the current draft. */
export function catalogOf(def: Json): Catalog {
  const pick = (entries: Json[]) => entries.map((e) => ({ id: String(e['id'] ?? ''), name: String(e['name'] ?? e['id'] ?? '') })).filter((e) => e.id);
  const tags = list(def, 'tags');
  const shopEntries = list(def, 'shops').flatMap((s) =>
    list(s, 'entries').map((en) => {
      const grants = (en['grants'] ?? {}) as Json;
      return { id: String(en['id']), name: `${String(s['name'])}: ${String(grants['item'] ?? `${String(grants['amount'])} ${String(grants['resource'])}`)}` };
    }),
  );
  return {
    resources: pick(list(def, 'resources')),
    tags: pick(tags),
    spaceTags: pick(tags.filter((t) => t['appliesTo'] === 'space')),
    entityTags: pick(tags.filter((t) => t['appliesTo'] === 'entity')),
    spaces: pick(list(def, 'spaces')),
    items: pick(list(def, 'items')),
    statuses: pick(list(def, 'statuses')),
    enemies: pick(list(def, 'enemies')),
    decks: pick(list(def, 'decks')),
    cards: list(def, 'decks').flatMap((d) => pick(list(d, 'cards'))),
    actions: pick(list(def, 'actions')),
    shopEntries,
    shops: pick(list(def, 'shops')),
  };
}

/** Every id defined anywhere in the draft (to keep new ids unique). */
export function allIds(def: Json): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      const o = v as Json;
      if (typeof o['id'] === 'string' && typeof o['op'] !== 'string') out.add(o['id']);
      Object.values(o).forEach(visit);
    }
  };
  visit(def);
  return out;
}

/** Replaces an id everywhere it is referenced (string values and layout keys). */
export function renameId(def: unknown, from: string, to: string): unknown {
  if (from === to) return def;
  const visit = (v: unknown): unknown => {
    if (v === from) return to;
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object') {
      const out: Json = {};
      for (const [k, x] of Object.entries(v as Json)) out[k === from ? to : k] = visit(x);
      return out;
    }
    return v;
  };
  return visit(def);
}

/** How many places reference an id (excluding its own definition). */
export function countRefs(def: unknown, id: string): number {
  let n = 0;
  const visit = (v: unknown, key: string | null) => {
    if (v === id && key !== 'id') n++;
    if (Array.isArray(v)) v.forEach((x) => visit(x, null));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Json)) {
      if (k === id) n++;
      visit(x, k);
    }
  };
  visit(def, null);
  return n;
}

/** A sensible default value for a field. */
export function defaultFor(type: FieldType, catalog: Catalog): unknown {
  switch (type.t) {
    case 'num':
      return 1;
    case 'cond':
      return defaultNode('cond', 'isKind', catalog);
    case 'selector':
    case 'entity':
      return '$actor';
    case 'space':
      return '$space';
    case 'effects':
      return [];
    case 'conds':
      return [defaultNode('cond', 'isKind', catalog)];
    case 'nums':
      return [1, 1];
    case 'ref':
      return catalog[type.section][0]?.id ?? '';
    case 'text':
      return '';
    case 'int':
      return type.min ?? 1;
    case 'bool':
      return false;
    case 'enum':
      return type.values[0];
    case 'options':
      return [
        { id: 'yes', label: 'Yes', effects: [] },
        { id: 'no', label: 'No', effects: [] },
      ];
    case 'branches':
      return [
        { weight: 1, do: [] },
        { weight: 1, do: [] },
      ];
  }
}

export function specFor(kind: NodeKind, op: string): OpSpec | undefined {
  return OPS[kind].find((s) => s.op === op);
}

/** A new node of the given operation, keeping fields of the old node that still fit. */
export function defaultNode(kind: NodeKind, op: string, catalog: Catalog, previous?: unknown): unknown {
  const spec = specFor(kind, op);
  if (!spec) return op;
  const prev = (previous && typeof previous === 'object' ? previous : {}) as Json;
  const out: Json = { op };
  for (const f of spec.fields) {
    if (prev[f.key] !== undefined && compatible(f, prev[f.key])) out[f.key] = prev[f.key];
    else if (!f.optional) out[f.key] = defaultFor(f.type, catalog);
  }
  return out;
}

function compatible(f: FieldSpec, v: unknown): boolean {
  switch (f.type.t) {
    case 'text':
    case 'ref':
      return typeof v === 'string';
    case 'int':
      return typeof v === 'number';
    case 'bool':
      return typeof v === 'boolean';
    case 'enum':
      return typeof v === 'string' && f.type.values.includes(v);
    case 'effects':
    case 'conds':
    case 'nums':
    case 'options':
    case 'branches':
      return Array.isArray(v);
    default:
      return true;
  }
}

/** Where an issue path points: section and entry index. */
export function sectionOf(path: Path | null): { section: string; index: number | null } | null {
  if (!path || path.length === 0) return null;
  const [section, index] = path;
  return { section: String(section), index: typeof index === 'number' ? index : null };
}
