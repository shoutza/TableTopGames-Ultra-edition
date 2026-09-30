import { compileGame, CompileError, type CompiledGame, type Diagnostic } from '../engine/compile.ts';
import { describeObjective, describeRule, describeStatus, makeNames, summarizeEffects } from '../engine/explain.ts';
import { GameDefinitionSchema } from '../schema/definition.ts';
import type { CheckIssue, CheckResult } from '../schema/proposal.ts';

/**
 * The editor's live check of a draft definition: schema problems with their exact path, compile
 * diagnostics located at the definition they refer to, and the plain-language text generated for
 * every rule, status, objective, action, card and usable item (so the GM reads what the engine
 * will do, not what the JSON seems to say).
 */

type Json = Record<string, unknown>;

const LOCATABLE = ['resources', 'tags', 'spaces', 'items', 'statuses', 'shops', 'enemies', 'fixtures', 'decks', 'actions', 'objectives', 'cast', 'rules'] as const;

/** Where a definition id (or a nested rule, card or shop entry id) lives in the definition JSON. */
export function locate(def: unknown, ref: string | undefined): Array<string | number> | null {
  if (!ref || !def || typeof def !== 'object') return null;
  const d = def as Record<string, unknown>;
  for (const section of LOCATABLE) {
    const list = d[section];
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const entry = list[i] as Json | undefined;
      if (!entry || typeof entry !== 'object') continue;
      if (entry['id'] === ref) return [section, i];
      for (const nested of ['rules', 'cards', 'entries'] as const) {
        const inner = entry[nested];
        if (!Array.isArray(inner)) continue;
        const j = inner.findIndex((x) => (x as Json | undefined)?.['id'] === ref);
        if (j >= 0) return [section, i, nested, j];
      }
    }
  }
  if (ref.startsWith('settings.')) return ref.split('.');
  return null;
}

/** Where a diagnostic belongs: the definition being checked, a settings path, or the id it names. */
function diagnosticPath(def: unknown, d: Diagnostic): Array<string | number> | null {
  const m = /^(settings(?:\.[A-Za-z]+)+)/.exec(d.message);
  if (m?.[1]) return m[1].split('.');
  return locate(def, d.at) ?? locate(def, d.ref);
}

function textsFor(game: CompiledGame): Record<string, string> {
  const n = makeNames(game, () => undefined);
  const out: Record<string, string> = {};
  const safe = (key: string, fn: () => string) => {
    try {
      out[key] = fn();
    } catch {
      out[key] = '(could not describe)';
    }
  };
  for (const [id, r] of game.rules) safe(`rules:${id}`, () => describeRule(r.def, n));
  for (const st of game.def.statuses) safe(`statuses:${st.id}`, () => describeStatus(st, n));
  for (const o of game.def.objectives) safe(`objectives:${o.id}`, () => describeObjective(o, n));
  for (const a of game.def.actions) safe(`actions:${a.id}`, () => summarizeEffects(a.effects, n));
  for (const i of game.def.items) if (i.use) safe(`items:${i.id}`, () => summarizeEffects(i.use?.effects ?? [], n));
  for (const d of game.def.decks) for (const c of d.cards) safe(`cards:${c.id}`, () => summarizeEffects(c.effects, n));
  for (const e of game.def.enemies) safe(`enemies:${e.id}`, () => summarizeEffects(e.rewards, n) || 'no reward');
  return out;
}

export interface CheckOutcome {
  result: CheckResult;
  /** The compiled game, when the draft is valid. */
  game: CompiledGame | null;
}

export function checkDefinition(json: unknown): CheckOutcome {
  const parsed = GameDefinitionSchema.safeParse(json);
  const empty = { spaces: 0, connections: 0, rules: 0, unreachable: 0 };
  if (!parsed.success) {
    const issues: CheckIssue[] = parsed.error.issues.slice(0, 200).map((i) => ({
      severity: 'error',
      code: `schema-${i.code}`,
      message: `${i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message}`,
      path: i.path.filter((p): p is string | number => typeof p !== 'symbol'),
    }));
    return { result: { ok: false, issues, texts: {}, stats: empty }, game: null };
  }
  let game: CompiledGame;
  try {
    game = compileGame(parsed.data);
  } catch (err) {
    if (!(err instanceof CompileError)) throw err;
    const issues = err.diagnostics.map((d) => ({ severity: d.severity, code: d.code, message: d.message, path: diagnosticPath(json, d) }));
    return { result: { ok: false, issues, texts: {}, stats: empty }, game: null };
  }
  const issues = game.diagnostics.map((d) => ({ severity: d.severity, code: d.code, message: d.message, path: diagnosticPath(json, d) }));
  const def = game.def;
  const stats = { spaces: def.spaces.length, connections: def.connections.length, rules: game.rules.size, unreachable: game.diagnostics.filter((d) => d.code === 'unreachable-space').length };
  return { result: { ok: true, issues, texts: textsFor(game), stats }, game };
}
