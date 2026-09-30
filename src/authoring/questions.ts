import { MODIFIER_BINDINGS, TRIGGER_BINDINGS } from '../engine/compile.ts';
import type { GameDefinition } from '../schema/definition.ts';
import type { DiffEntry, Patch, Question } from '../schema/proposal.ts';

/**
 * Code-generated ambiguity checks. For new or changed content the GM is asked about things that
 * are easy to get subtly wrong; each option is a patch to the definition, and the current value is
 * the default, so answering "as is" never changes anything.
 */

export type { Patch, Question };

type Json = Record<string, unknown>;

const SECTION_LABEL: Record<string, string> = { rules: 'rule', items: 'item', statuses: 'status', enemies: 'enemy', decks: 'deck', actions: 'action', objectives: 'objective' };

const ROUNDINGS = ['floor', 'ceil', 'halfUp', 'towardZero'] as const;

function round(q: number, mode: (typeof ROUNDINGS)[number]): number {
  switch (mode) {
    case 'floor':
      return Math.floor(q);
    case 'ceil':
      return Math.ceil(q);
    case 'halfUp':
      return Math.floor(q + 0.5);
    case 'towardZero':
      return Math.trunc(q);
  }
}

const ROUNDING_TEXT: Record<string, string> = { floor: 'round down', ceil: 'round up', halfUp: 'round to nearest (halves up)', towardZero: 'drop the fraction (toward zero)' };

function isEveryone(sel: unknown): boolean {
  if (!sel || typeof sel !== 'object') return false;
  const s = sel as Json;
  return s['op'] === 'all' && (s['kind'] === undefined || s['kind'] === 'contestant');
}

interface Walk {
  where: string;
  actorBound: boolean;
  out: Question[];
}

const SELECTOR_KEYS: Record<string, string[]> = {
  changeResource: ['target'],
  setResource: ['target'],
  addTag: ['target'],
  removeTag: ['target'],
  teleport: ['target'],
  damage: ['target'],
  applyStatus: ['target'],
  removeStatus: ['target'],
  remove: ['target'],
  forEach: ['of'],
};

function walk(node: unknown, path: Array<string | number>, w: Walk): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, [...path, i], w));
    return;
  }
  if (!node || typeof node !== 'object') return;
  const n = node as Json;
  const op = n['op'];
  if (op === 'teleport') {
    const current = n['asLanding'] === true;
    w.out.push({
      id: `teleport:${path.join('.')}`,
      where: w.where,
      text: 'A teleport moves someone: should arriving count as landing (so landing rules fire, like after a normal move)?',
      options: [
        { id: 'land', label: 'Yes, it counts as landing', patches: [{ path: [...path, 'asLanding'], value: true }] },
        { id: 'arrive', label: 'No, they just arrive', patches: [{ path: [...path, 'asLanding'], value: false }] },
      ],
      default: current ? 'land' : 'arrive',
    });
  }
  if (op === 'div') {
    const a = typeof n['a'] === 'number' ? (n['a'] as number) : 7;
    const b = typeof n['b'] === 'number' && n['b'] !== 0 ? (n['b'] as number) : 2;
    const q = a / b;
    w.out.push({
      id: `div:${path.join('.')}`,
      where: w.where,
      text: `A division needs a rounding rule. For example ${a} ÷ ${b} = ${q.toFixed(2)} and ${-a} ÷ ${b} = ${(-q).toFixed(2)}:`,
      options: ROUNDINGS.map((mode) => ({ id: mode, label: `${ROUNDING_TEXT[mode]}: ${round(q, mode)} and ${round(-q, mode)}`, patches: [{ path: [...path, 'rounding'], value: mode }] })),
      default: typeof n['rounding'] === 'string' ? (n['rounding'] as string) : 'floor',
    });
  }
  if (typeof op === 'string' && w.actorBound) {
    for (const key of SELECTOR_KEYS[op] ?? []) {
      if (!isEveryone(n[key])) continue;
      w.out.push({
        id: `everyone:${[...path, key].join('.')}`,
        where: w.where,
        text: '“Every contestant” here: does that include the one who triggered it?',
        options: [
          { id: 'include', label: 'Yes, everyone including them', patches: [] },
          {
            id: 'exclude',
            label: 'No, everyone else',
            patches: [{ path: [...path, key], value: { op: 'filter', from: n[key], where: { op: 'not', cond: { op: 'same', a: '$it', b: '$actor' } } } }],
          },
        ],
        default: 'include',
      });
    }
  }
  for (const [k, v] of Object.entries(n)) if (v && typeof v === 'object') walk(v, [...path, k], w);
}

function ruleActorBound(rule: Json): boolean {
  const kind = rule['kind'] ?? 'reaction';
  if (kind === 'reaction') {
    const event = (rule['trigger'] as { event?: string } | undefined)?.event;
    return event !== undefined && (TRIGGER_BINDINGS[event as keyof typeof TRIGGER_BINDINGS]?.entities as string[] | undefined)?.includes('$actor') === true;
  }
  if (kind === 'modifier') return (MODIFIER_BINDINGS[rule['on'] as keyof typeof MODIFIER_BINDINGS] as string[] | undefined)?.includes('$actor') === true;
  return false;
}

/** Questions for everything new or changed in the definition. */
export function ambiguityQuestions(def: GameDefinition, changes: DiffEntry[]): Question[] {
  const out: Question[] = [];
  const touched = new Set(changes.filter((c) => c.change !== 'removed' && c.level === 'mechanical').map((c) => `${c.section}:${c.id}`));
  const d = def as unknown as Record<string, Json[]>;
  for (const section of ['rules', 'items', 'statuses', 'enemies', 'decks', 'actions', 'objectives']) {
    (d[section] ?? []).forEach((entry, index) => {
      if (!touched.has(`${section}:${entry['id']}`)) return;
      const where = `${SECTION_LABEL[section]} “${String(entry['name'])}”`;
      // Rules decide whether $actor is bound; cards, actions, item uses and rewards always have one.
      if (section === 'rules') walk(entry, [section, index], { where, actorBound: ruleActorBound(entry), out });
      else {
        const rules = (entry['rules'] ?? []) as Json[];
        rules.forEach((r, j) => walk(r, [section, index, 'rules', j], { where: `${where}, rule “${String(r['name'])}”`, actorBound: ruleActorBound(r), out }));
        const { rules: _r, ...rest } = entry;
        walk(rest, [section, index], { where, actorBound: true, out });
      }
    });
  }
  // A brand-new status: what happens when it is applied again while it lasts?
  const added = new Set(changes.filter((c) => c.section === 'statuses' && c.change === 'added').map((c) => c.id));
  def.statuses.forEach((st, index) => {
    if (!added.has(st.id)) return;
    const options = [
      { id: 'refresh', label: 'Refresh its duration', patches: [{ path: ['statuses', index, 'stacking'], value: 'refresh' }] },
      { id: 'extend', label: 'Add to its duration', patches: [{ path: ['statuses', index, 'stacking'], value: 'extend' }] },
      {
        id: 'stack',
        label: `Add a stack (up to ${Math.max(st.maxStacks, 3)}), refreshing the duration`,
        patches: [
          { path: ['statuses', index, 'stacking'], value: 'stack' },
          { path: ['statuses', index, 'maxStacks'], value: Math.max(st.maxStacks, 3) },
        ],
      },
      { id: 'ignore', label: 'Nothing happens', patches: [{ path: ['statuses', index, 'stacking'], value: 'ignore' }] },
    ];
    out.push({ id: `stacking:${st.id}`, where: `status “${st.name}”`, text: `When ${st.name} is applied again while it still lasts:`, options, default: st.stacking });
  });
  return out;
}

/** Applies the chosen answers' patches to a copy of the definition JSON. */
export function applyAnswers(defJson: unknown, questions: Question[], answers: Record<string, string>): unknown {
  const copy = JSON.parse(JSON.stringify(defJson)) as Json;
  for (const q of questions) {
    // The default is the definition as written: keeping it changes nothing.
    const chosen = answers[q.id];
    if (chosen === undefined || chosen === q.default) continue;
    const option = q.options.find((o) => o.id === chosen);
    for (const p of option?.patches ?? []) {
      let cur: unknown = copy;
      for (const key of p.path.slice(0, -1)) cur = (cur as Record<string | number, unknown>)[key];
      const last = p.path[p.path.length - 1] as string | number;
      if (!cur || typeof cur !== 'object') continue;
      if (p.remove) delete (cur as Record<string | number, unknown>)[last];
      else (cur as Record<string | number, unknown>)[last] = p.value;
    }
  }
  return copy;
}
