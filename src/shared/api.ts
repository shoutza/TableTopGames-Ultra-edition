import type { GameDefinition } from '../schema/definition.ts';
import type { CheckResult, DiffEntry, Proposal, ProposalAnswers } from '../schema/proposal.ts';
import type { Strategy } from '../schema/persona.ts';
import type { GameEvent, GameState } from '../schema/state.ts';

/**
 * Wire types shared by the server and the GM web client. The GM is omniscient, so these carry
 * full state; contestant-facing data is produced separately by the visibility layer.
 */

export interface HealthResponse {
  ok: true;
  engineVersion: string;
  rulesLanguageVersion: number;
  contestantProvider: 'openai' | 'offline' | 'mock';
  contestantModel: string;
}

export type EventDto = GameEvent & { text: string };

export interface FiringDto {
  id: number;
  rule: string;
  trigger: number;
  bindings: Record<string, string | number>;
  checks: Array<{ text: string; ok: boolean }>;
}

export interface MindDto {
  entityId: string;
  castId: string;
  controller: 'llm' | 'heuristic';
  candidates: string[];
  strategy: Strategy | null;
  strategyHistory: Strategy[];
  plan: string;
  planRound: number;
  reconsider: string | null;
  relationships: Record<string, { trust: number; affinity: number }>;
  /** Most recent last (the last 20). */
  memories: Array<{ round: number; kind: string; other: string | null; text: string; importance: number }>;
  keyMoment: string | null;
}

export interface AiCallDto {
  at: string;
  round: number;
  contestant: string;
  contestantName: string;
  decisionId: string | null;
  purpose: 'decision' | 'strategy';
  model: string;
  source: string;
  attempts: number;
  errors: string[];
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number };
  latencyMs: number;
  packetTokens: number;
  costUsd: number | null;
  optionId: string | null;
  reason: string | null;
  say: string | null;
  obsolete: boolean;
}

export interface MetricsDto {
  rounds: number;
  decisions: number;
  bySource: Record<string, number>;
  modelRequests: number;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number };
  costUsd: number | null;
  latencyMs: { p50: number; p95: number };
  packetTokens: { p50: number; p95: number };
  fallbackRate: number;
  obsolete: number;
  matchDurationMs: number;
  providerTripped: boolean;
}

export type Speed = 'fast' | 'normal' | 'slow';

export interface StatusDto {
  running: boolean;
  paused: boolean;
  over: boolean;
  /** Contestant whose model request is in flight. */
  thinking: string | null;
  abortedMessage: string | null;
  provider: 'openai' | 'offline' | 'mock';
  model: string;
  speed: Speed;
  stateHash: string;
  savedAt: string | null;
  /** A GM ruling is waiting (the match does not go on until it is answered or times out). */
  ruling: { decisionId: string; timeLeftMs: number | null } | null;
  /** Ruleset versions: mechanical changes (shown to contestants) and cosmetic ones. */
  rulesVersion: RulesVersion;
}

export interface RulesVersion {
  mechanical: number;
  cosmetic: number;
}

/** Values the engine derives per entity (the web app never runs engine code). */
export interface DerivedDto {
  /** Base tags plus tags granted by statuses. */
  tags: string[];
  /** Capabilities currently suppressed, and by which status or rule. */
  suppressed: Array<{ capability: string; by: string }>;
}

/** Plain-language texts generated from the definition (the GM's view: hidden rules included). */
export interface RulebookDto {
  rules: Record<string, string>;
  statuses: Record<string, string>;
  items: Record<string, string>;
  actions: Record<string, string>;
  cards: Record<string, string>;
  /** "Island Hopper: Land on a Mystery space 3 times (reward: +1 Star)". */
  objectives: Record<string, string>;
}

export interface MatchSnapshotDto {
  matchId: string;
  definition: GameDefinition;
  state: GameState;
  events: EventDto[];
  firings: FiringDto[];
  minds: MindDto[];
  /** Effective resource values (base + item, status and continuous-rule modifiers) per entity. */
  effective: Record<string, Record<string, number>>;
  derived: Record<string, DerivedDto>;
  rulebook: RulebookDto;
  status: StatusDto;
  metrics: MetricsDto;
  aiCalls: AiCallDto[];
}

export interface MatchUpdateDto {
  matchId: string;
  state: GameState;
  events: EventDto[];
  firings: FiringDto[];
  minds: MindDto[];
  effective: Record<string, Record<string, number>>;
  derived: Record<string, DerivedDto>;
  status: StatusDto;
  metrics: MetricsDto;
  aiCalls: AiCallDto[];
}

export interface MatchListItem {
  matchId: string;
  scenario: string;
  round: number;
  phase: string;
  winners: string[] | null;
  savedAt: string | null;
  loaded: boolean;
}

export interface CreateMatchRequest {
  scenario?: string | undefined;
  seed?: string | undefined;
}

export interface ControlRequest {
  action: 'start' | 'pause' | 'step' | 'save' | 'speed' | 'resetProvider';
  speed?: Speed | undefined;
}

export interface ContestantViewResponse {
  entityId: string;
  /** What the contestant currently knows (JSON of its ContestantView). */
  view: unknown;
  /** The most recent packet sent to its model, if any. */
  lastPacket: { instructions: string; input: string } | null;
}

// --- scenario library and editing ------------------------------------------------------------

export interface ScenarioListItem {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  valid: boolean;
  spaces: number;
  rules: number;
  updatedAt: string | null;
}

export interface ScenarioDto {
  id: string;
  builtIn: boolean;
  /** The definition JSON as saved. */
  definition: unknown;
  check: CheckResult;
}

export interface CheckRequest {
  definition: unknown;
}

/** Review a scenario edit: against the saved scenario `base` (null for a new one). */
export interface ScenarioProposalRequest {
  definition: unknown;
  base: string | null;
}

export interface SaveScenarioRequest {
  definition: unknown;
  answers: Pick<ProposalAnswers, 'questions'>;
  /** The scenario the review compared against (default: the saved version of this id). */
  base?: string | null;
}

/** Review a change to a running match's rules. */
export interface MatchProposalRequest {
  definition: unknown;
}

export interface MatchProposalResponse {
  proposal: Proposal;
  /** The ruleset version the proposal was made against; applying checks it is still current. */
  baseVersion: RulesVersion;
  /** Mechanical changes are applied only while the match is paused. */
  needsPause: boolean;
}

export interface ApplyChangeRequest {
  definition: unknown;
  answers: ProposalAnswers;
  baseVersion: RulesVersion;
}

export interface ApplyChangeResponse {
  ok: true;
  level: Proposal['level'];
  rulesVersion: RulesVersion;
  /** The decision that was withdrawn and asked again, if any. */
  invalidated: string | null;
}

export interface MatchDefinitionResponse {
  definition: GameDefinition;
  rulesVersion: RulesVersion;
  changes: ChangeLogEntry[];
}

/** One applied change to a match's rules (the GM's change log). */
export interface ChangeLogEntry {
  rev: number;
  round: number;
  level: Proposal['level'];
  rulesVersion: RulesVersion;
  summary: string[];
  changes: DiffEntry[];
}

export interface RulingRequest {
  optionId: string;
}

/** Points the match can be rewound to (the start of each round). */
export interface CheckpointDto {
  round: number;
  rev: number;
}

export interface RewindRequest {
  rev: number;
}
