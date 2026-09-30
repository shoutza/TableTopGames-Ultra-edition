import type { GameDefinition } from '../schema/definition.ts';
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
