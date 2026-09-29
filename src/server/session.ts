import { applyToMind, chooseStrategy, decide, ProviderHealth, type ControllerConfig, type DecisionResult } from '../contestants/controller.ts';
import { newMind, type ContestantMind } from '../contestants/mind.ts';
import { castCandidates } from '../contestants/strategy.ts';
import { advance, answerDecision, applyGmCommand, createMatch, nextStepKind, type CompiledGame, type OpOutcome } from '../engine/index.ts';
import { estimateCost, type Price } from '../llm/prices.ts';
import type { LlmProvider, LlmUsage } from '../llm/port.ts';
import type { GmCommand } from '../schema/commands.ts';
import type { Persona } from '../schema/persona.ts';
import type { GameEvent, GameState } from '../schema/state.ts';
import { publicInfo, type PublicGameInfo } from '../visibility/public-info.ts';
import { buildContestantView, type ContestantView } from '../visibility/view.ts';

/**
 * One authoritative coordinator per match. It owns the state, runs automatic steps, asks
 * contestant controllers for decisions and applies GM commands between operations. A decision
 * that returns after the state moved on (GM edit, pause edit) is discarded, never applied.
 */

export interface AiCallRecord {
  at: string;
  matchId: string;
  round: number;
  contestant: string;
  contestantName: string;
  decisionId: string | null;
  purpose: 'decision' | 'strategy';
  model: string;
  source: string;
  attempts: number;
  errors: string[];
  usage: LlmUsage;
  latencyMs: number;
  packetTokens: number;
  costUsd: number | null;
  optionId: string | null;
  reason: string | null;
  say: string | null;
  obsolete: boolean;
}

export interface OperationRecord {
  rev: number;
  kind: 'setup' | 'auto' | 'decision' | 'gm';
  input: unknown;
  eventCount: number;
  firstSeq: number | null;
  lastSeq: number | null;
}

export interface SessionListener {
  onCommit?(record: OperationRecord, events: GameEvent[], state: GameState): void;
  onAiCall?(record: AiCallRecord): void;
  onStatus?(): void;
  onAbort?(message: string): void;
}

export interface SessionDeps {
  provider: LlmProvider | null;
  config: ControllerConfig;
  price: Price | null;
  now?: () => number;
}

function sumUsage(list: Array<LlmUsage | null>): LlmUsage {
  const out = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  for (const u of list) {
    if (!u) continue;
    out.inputTokens += u.inputTokens;
    out.cachedInputTokens += u.cachedInputTokens;
    out.outputTokens += u.outputTokens;
    out.reasoningTokens += u.reasoningTokens;
  }
  return out;
}

export class MatchSession {
  readonly game: CompiledGame;
  readonly info: PublicGameInfo;
  readonly deps: SessionDeps;
  state: GameState;
  readonly history: GameEvent[] = [];
  readonly operations: OperationRecord[] = [];
  readonly minds = new Map<string, ContestantMind>();
  readonly calls: AiCallRecord[] = [];
  readonly lastPackets = new Map<string, { instructions: string; input: string }>();
  readonly health = new ProviderHealth();
  readonly listeners = new Set<SessionListener>();
  paused = true;
  running = false;
  stepDelayMs = 0;
  abortedMessage: string | null = null;
  /** Wall-clock time spent running (not paused), for match-duration metrics. */
  activeMs = 0;
  private inFlight: { decisionId: string; controller: AbortController } | null = null;
  private loop: Promise<void> | null = null;
  private readonly now: () => number;

  private constructor(game: CompiledGame, state: GameState, deps: SessionDeps) {
    this.game = game;
    this.info = publicInfo(game);
    this.state = state;
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  get matchId(): string {
    return this.state.matchId;
  }

  persona(entityId: string): Persona {
    const member = this.game.cast.get(this.state.entities[entityId]?.defId ?? '');
    if (!member) throw new Error(`no persona for ${entityId}`);
    return member.persona;
  }

  /** Creates the match and lets every contestant pick a strategy from its own view (concurrently). */
  static async create(game: CompiledGame, setup: { matchId: string; seed: string; cast?: string[] }, deps: SessionDeps): Promise<MatchSession> {
    const created = createMatch(game, setup);
    if (!created.ok) throw new Error(`cannot create match: ${created.message}`);
    const session = new MatchSession(game, created.state, deps);
    session.commit({ rev: created.state.rev, kind: 'setup', input: setup, eventCount: 0, firstSeq: null, lastSeq: null }, created.events);
    const contestants = [...created.state.turnOrder].sort((a, b) => a.localeCompare(b)).map((id) => ({ id, persona: session.persona(id) }));
    const candidates = castCandidates(session.info, contestants);
    for (const { id } of contestants) {
      session.minds.set(id, newMind(id, created.state.entities[id]?.defId ?? '', candidates.get(id) ?? ['opportunist'], deps.provider ? 'llm' : 'heuristic'));
    }
    await Promise.all(
      contestants.map(async ({ id, persona }) => {
        const mind = session.minds.get(id) as ContestantMind;
        const view = buildContestantView(game, session.state, id, session.history);
        const res = await chooseStrategy({ view, info: session.info, mind, persona, provider: deps.provider, config: deps.config, health: session.health });
        mind.strategy = res.strategy;
        mind.plan = res.plan;
        if (res.packet) session.lastPackets.set(id, res.packet);
        session.recordCall(id, null, 'strategy', res.source, res.attempts, res.packet ? Math.ceil((res.packet.instructions.length + res.packet.input.length) / 4) : 0, null, res.strategy.reason, null, false);
      }),
    );
    return session;
  }

  /** Restores a saved match. */
  static restore(game: CompiledGame, state: GameState, history: GameEvent[], minds: ContestantMind[], deps: SessionDeps, activeMs = 0): MatchSession {
    const session = new MatchSession(game, state, deps);
    session.history.push(...history);
    for (const m of minds) session.minds.set(m.entityId, m);
    session.activeMs = activeMs;
    return session;
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get over(): boolean {
    return nextStepKind(this.state) === 'gameOver';
  }

  get thinking(): string | null {
    return this.inFlight ? (this.state.pendingDecision?.actor ?? null) : null;
  }

  private commit(record: OperationRecord, events: GameEvent[]): void {
    const rec = { ...record, eventCount: events.length, firstSeq: events[0]?.seq ?? null, lastSeq: events.at(-1)?.seq ?? null };
    this.history.push(...events);
    this.operations.push(rec);
    for (const l of this.listeners) l.onCommit?.(rec, events, this.state);
  }

  private notifyStatus(): void {
    for (const l of this.listeners) l.onStatus?.();
  }

  private apply(out: OpOutcome, kind: OperationRecord['kind'], input: unknown): OpOutcome {
    if (out.ok) {
      this.state = out.state;
      this.commit({ rev: out.state.rev, kind, input, eventCount: 0, firstSeq: null, lastSeq: null }, out.events);
    } else if (out.kind === 'aborted') {
      this.abortedMessage = out.message;
      this.paused = true;
      for (const l of this.listeners) l.onAbort?.(out.message);
    }
    return out;
  }

  private recordCall(
    contestant: string,
    decisionId: string | null,
    purpose: 'decision' | 'strategy',
    source: string,
    attempts: DecisionResult['attempts'],
    packetTokens: number,
    optionId: string | null,
    reason: string | null,
    say: string | null,
    obsolete: boolean,
  ): void {
    if (attempts.length === 0 && source !== 'heuristic' && source !== 'forced') return;
    const usage = sumUsage(attempts.map((a) => a.usage));
    const record: AiCallRecord = {
      at: new Date(this.now()).toISOString(),
      matchId: this.matchId,
      round: this.state.round,
      contestant,
      contestantName: this.state.entities[contestant]?.name ?? contestant,
      decisionId,
      purpose,
      model: attempts.length > 0 ? this.deps.config.model : 'none',
      source,
      attempts: attempts.length,
      errors: attempts.filter((a) => !a.ok).map((a) => `${a.errorKind}: ${a.error ?? ''}`),
      usage,
      latencyMs: attempts.reduce((s, a) => s + a.latencyMs, 0),
      packetTokens,
      costUsd: attempts.length > 0 ? estimateCost(this.deps.price, usage) : 0,
      optionId,
      reason,
      say,
      obsolete,
    };
    this.calls.push(record);
    for (const l of this.listeners) l.onAiCall?.(record);
  }

  view(entityId: string): ContestantView {
    return buildContestantView(this.game, this.state, entityId, this.history);
  }

  /** Runs exactly one operation (an automatic step or one contestant decision). */
  async step(): Promise<'progress' | 'obsolete' | 'over' | 'aborted'> {
    if (this.over) return 'over';
    if (nextStepKind(this.state) === 'auto') {
      const out = this.apply(advance(this.game, this.state), 'auto', null);
      return out.ok ? 'progress' : 'aborted';
    }
    const decision = this.state.pendingDecision;
    if (!decision) return 'over';
    const mind = this.minds.get(decision.actor);
    if (!mind) throw new Error(`no mind for ${decision.actor}`);
    const revAtRequest = this.state.rev;
    const controller = new AbortController();
    this.inFlight = { decisionId: decision.id, controller };
    this.notifyStatus();
    let result: DecisionResult;
    try {
      result = await decide({
        view: this.view(decision.actor),
        info: this.info,
        mind,
        persona: this.persona(decision.actor),
        provider: this.deps.provider,
        config: this.deps.config,
        health: this.health,
        signal: controller.signal,
      });
    } finally {
      this.inFlight = null;
    }
    if (result.packet) this.lastPackets.set(decision.actor, result.packet);
    const obsolete = this.state.pendingDecision?.id !== decision.id || this.state.rev !== revAtRequest || result.source === 'aborted';
    this.recordCall(decision.actor, decision.id, 'decision', result.source, result.attempts, result.packetTokens, result.optionId, result.reason, result.say, obsolete);
    if (obsolete) {
      this.notifyStatus();
      return 'obsolete';
    }
    const out = this.apply(answerDecision(this.game, this.state, { decisionId: decision.id, optionId: result.optionId, rev: revAtRequest, say: result.say ?? undefined }), 'decision', {
      decisionId: decision.id,
      optionId: result.optionId,
      source: result.source,
      say: result.say,
    });
    if (out.ok) applyToMind(mind, result, this.state.round);
    return out.ok ? 'progress' : 'aborted';
  }

  /** GM intervention between operations; invalidates any in-flight decision. */
  gm(command: GmCommand): OpOutcome {
    const out = this.apply(applyGmCommand(this.game, this.state, command), 'gm', command);
    if (out.ok && this.inFlight) this.inFlight.controller.abort();
    this.notifyStatus();
    return out;
  }

  /** Starts (or resumes) the play loop. */
  start(): void {
    if (this.running) {
      this.paused = false;
      this.notifyStatus();
      return;
    }
    this.paused = false;
    this.running = true;
    this.abortedMessage = null;
    this.notifyStatus();
    this.loop = (async () => {
      try {
        while (!this.paused && !this.over) {
          const t0 = this.now();
          const r = await this.step();
          this.activeMs += this.now() - t0;
          if (r === 'aborted') break;
          if (this.stepDelayMs > 0) await new Promise((res) => setTimeout(res, this.stepDelayMs));
        }
      } finally {
        this.running = false;
        this.notifyStatus();
      }
    })();
  }

  pause(): void {
    this.paused = true;
    this.notifyStatus();
  }

  /** Resolves when the current loop has stopped. */
  async idle(): Promise<void> {
    await this.loop;
  }

  /** Runs to the end (headless use). */
  async runToEnd(maxSteps = 50_000): Promise<void> {
    for (let i = 0; i < maxSteps && !this.over; i++) {
      const t0 = this.now();
      const r = await this.step();
      this.activeMs += this.now() - t0;
      if (r === 'aborted') return;
    }
  }

  metrics() {
    const decisionCalls = this.calls.filter((c) => c.purpose === 'decision');
    const bySource: Record<string, number> = {};
    for (const c of decisionCalls) bySource[c.source] = (bySource[c.source] ?? 0) + 1;
    const withModel = this.calls.filter((c) => c.attempts > 0);
    const latencies = withModel.map((c) => c.latencyMs).sort((a, b) => a - b);
    const packets = withModel.map((c) => c.packetTokens).sort((a, b) => a - b);
    const usage = sumUsage(this.calls.map((c) => c.usage));
    const cost = this.calls.reduce<number | null>((s, c) => (s === null || c.costUsd === null ? null : s + c.costUsd), 0);
    const pct = (arr: number[], p: number) => (arr.length ? (arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] as number) : 0);
    return {
      rounds: this.state.round,
      decisions: decisionCalls.length,
      bySource,
      modelRequests: withModel.reduce((s, c) => s + c.attempts, 0),
      usage,
      costUsd: cost,
      latencyMs: { p50: pct(latencies, 0.5), p95: pct(latencies, 0.95) },
      packetTokens: { p50: pct(packets, 0.5), p95: pct(packets, 0.95) },
      fallbackRate: decisionCalls.length ? ((bySource['fallback'] ?? 0) / decisionCalls.length) : 0,
      obsolete: decisionCalls.filter((c) => c.obsolete).length,
      matchDurationMs: this.activeMs,
      providerTripped: this.health.tripped,
    };
  }
}
