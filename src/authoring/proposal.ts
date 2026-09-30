import type { CompiledGame } from '../engine/compile.ts';
import { applyDefinitionChange, planMigration } from '../engine/migrate.ts';
import type { GameDefinition } from '../schema/definition.ts';
import type { CheckResult, Proposal, ProposalAnswers, Question } from '../schema/proposal.ts';
import type { GameState } from '../schema/state.ts';
import { checkDefinition } from './check.ts';
import { changeLevel, diffGames, publicSummary } from './diff.ts';
import { dryRun, scratchMatch } from './dryrun.ts';
import { ambiguityQuestions, applyAnswers } from './questions.ts';

/**
 * The proposal pipeline every definition edit goes through, whether it comes from the editor's
 * forms, its JSON tabs or (later) natural language: check → diff → migration plan for the running
 * match → code-generated ambiguity questions → dry runs of the new and changed rules.
 * Nothing here changes a match; `finalizeDefinition` applies the GM's answers and the server then
 * applies the result (as one operation when a match is running).
 */

export interface ProposalContext {
  /** The definition being changed (null for a brand-new scenario). */
  base: CompiledGame | null;
  /** The running match, when the change is made mid-match (its state is under `base`). */
  state: GameState | null;
  /** Dry-run options; `false` skips dry runs (e.g. for quick re-checks). */
  dryRun?: { simulate?: number; maxRules?: number } | false;
}

export interface BuiltProposal {
  proposal: Proposal;
  game: CompiledGame | null;
}

const MAX_DRY_RULES = 24;

/** Rules (top-level and attached) that are new or mechanically different from the base. */
export function changedRules(base: CompiledGame | null, game: CompiledGame): string[] {
  const out: string[] = [];
  for (const [id, r] of game.rules) {
    const old = base?.rules.get(id);
    if (!old || JSON.stringify(old.def) !== JSON.stringify(r.def)) out.push(id);
  }
  return out;
}

function emptyProposal(check: CheckResult): Proposal {
  return { ok: false, check, changes: [], level: 'none', summary: [], migration: null, questions: [], dryRuns: [] };
}

/** The state dry runs start from: the running match as it would be after the change, or a fresh match. */
function dryRunBase(ctx: ProposalContext, game: CompiledGame, blocked: boolean): GameState | null {
  if (ctx.state && ctx.base && !blocked) {
    const plan = planMigration(ctx.base, game, ctx.state);
    const answers: Record<string, string> = {};
    for (const issue of plan.issues) if (issue.severity === 'confirm' && issue.options?.[0]) answers[issue.id] = issue.options[0].id;
    const migrated = applyDefinitionChange(ctx.base, game, ctx.state, { answers, version: 0, summary: [] });
    if (migrated.ok) return migrated.state;
  }
  return scratchMatch(game);
}

export function buildProposal(draft: unknown, ctx: ProposalContext): BuiltProposal {
  const { result: check, game } = checkDefinition(draft);
  if (!game) return { proposal: emptyProposal(check), game: null };
  const changes = diffGames(ctx.base, game);
  const level = changeLevel(changes);
  const migration = ctx.state && ctx.base && level === 'mechanical' ? planMigration(ctx.base, game, ctx.state) : null;
  const questions = ambiguityQuestions(game.def, changes);
  const dryRuns: Proposal['dryRuns'] = [];
  if (ctx.dryRun !== false && level === 'mechanical') {
    const ids = changedRules(ctx.base, game);
    const max = (ctx.dryRun && ctx.dryRun.maxRules) ?? MAX_DRY_RULES;
    const base = ids.length > 0 ? dryRunBase(ctx, game, migration?.blocked === true) : null;
    if (base) dryRuns.push(...dryRun(game, base, ids.slice(0, max), ctx.dryRun ? { simulate: ctx.dryRun.simulate ?? 300 } : {}));
  }
  return { proposal: { ok: true, check, changes, level, summary: publicSummary(changes), migration, questions, dryRuns }, game };
}

export type FinalizeResult = { ok: true; game: CompiledGame; def: GameDefinition; questions: Question[] } | { ok: false; check: CheckResult };

/**
 * Applies the answers to the ambiguity questions and compiles the result. The questions are
 * recomputed from the draft, so the answers always refer to what the GM reviewed.
 */
export function finalizeDefinition(draft: unknown, base: CompiledGame | null, answers: Pick<ProposalAnswers, 'questions'>): FinalizeResult {
  const first = checkDefinition(draft);
  if (!first.game) return { ok: false, check: first.result };
  const questions = ambiguityQuestions(first.game.def, diffGames(base, first.game));
  const unknown = Object.keys(answers.questions).find((id) => !questions.some((q) => q.id === id && q.options.some((o) => o.id === answers.questions[id])));
  if (unknown) return { ok: false, check: { ...first.result, ok: false, issues: [{ severity: 'error', code: 'bad-answer', message: `No such question or answer: ${unknown}`, path: null }] } };
  const patched = applyAnswers(first.game.def, questions, answers.questions);
  const second = checkDefinition(patched);
  if (!second.game) return { ok: false, check: second.result };
  return { ok: true, game: second.game, def: second.game.def, questions };
}
