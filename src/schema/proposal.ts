/**
 * Types of the authoring pipeline (definition checks, proposals, migrations, ambiguity questions
 * and dry runs). They live in schema so the engine, the server and the web editor share them.
 */

export type ChangeLevel = 'cosmetic' | 'ai' | 'mechanical';

export interface DiffEntry {
  section: string;
  id: string;
  name: string;
  change: 'added' | 'removed' | 'changed';
  level: ChangeLevel;
  before?: string | undefined;
  after?: string | undefined;
  /** Hidden rules and statuses: left out of what contestants are told. */
  hidden: boolean;
}

export interface Patch {
  path: Array<string | number>;
  /** New value; ignored when `remove` is set. */
  value?: unknown;
  remove?: boolean;
}

export interface Question {
  id: string;
  /** Where the question comes from, e.g. `rule “Tide Pull”`. */
  where: string;
  text: string;
  options: Array<{ id: string; label: string; patches: Patch[] }>;
  /** The option matching the definition as written (answering it changes nothing). */
  default: string;
}

export interface MigrationIssue {
  /** Stable key, e.g. `item.removed:item.sword`. */
  id: string;
  severity: 'auto' | 'confirm' | 'blocked';
  title: string;
  detail: string;
  /** For `confirm`: the ways to proceed (the first is the recommended one). */
  options?: Array<{ id: string; label: string }>;
}

export interface MigrationPlan {
  issues: MigrationIssue[];
  blocked: boolean;
}

export interface DryRunExample {
  /** What happened first (the triggering event, or the probe). */
  trigger: string;
  checks: Array<{ text: string; ok: boolean }>;
  /** What the rule did (events it caused, or the value change). */
  results: string[];
}

export interface DryRun {
  rule: string;
  name: string;
  text: string;
  fired: DryRunExample[];
  notFired: DryRunExample[];
  notes: string[];
}

/** One problem found in a definition, located as precisely as possible. */
export interface CheckIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  /** Path into the definition JSON (e.g. `["rules", 3, "effects", 0]`), when known. */
  path: Array<string | number> | null;
}

export interface CheckResult {
  ok: boolean;
  issues: CheckIssue[];
  /** Plain-language text generated from the definition: `rules:<id>`, `statuses:<id>` … → text. */
  texts: Record<string, string>;
  stats: { spaces: number; connections: number; rules: number; unreachable: number };
}

export interface Proposal {
  /** False when the draft does not parse or compile (see `check`). */
  ok: boolean;
  check: CheckResult;
  changes: DiffEntry[];
  level: 'none' | ChangeLevel;
  /** What contestants are told when it is applied (hidden rules left out). */
  summary: string[];
  /** Only for a running match. */
  migration: MigrationPlan | null;
  questions: Question[];
  dryRuns: DryRun[];
}

export interface ProposalAnswers {
  /** Ambiguity question id → option id (unanswered questions keep the default). */
  questions: Record<string, string>;
  /** Migration issue id → option id (every `confirm` issue needs one). */
  migration: Record<string, string>;
}
