import type { Audience, EventBody, EventCause, GameEvent, GameState } from '../schema/state.ts';
import type { CompiledGame } from './compile.ts';
import { randomBelow } from './rng.ts';
import { BudgetExceeded, cloneJson } from './util.ts';

/** Record of one rule firing, kept with the operation for "why did this happen?" traces. */
export interface FiringRecord {
  id: number;
  rule: string;
  trigger: number;
  bindings: Record<string, string | number>;
  checks: Array<{ text: string; ok: boolean }>;
}

export interface FaultRecord {
  rule: string;
  message: string;
  trigger: number | null;
}

interface Savepoint {
  state: GameState;
  eventCount: number;
  firingCount: number;
  collectorCount: number;
}

/**
 * Working context of one operation. Holds a private working copy of the state; the caller's
 * state is untouched until the operation commits, so aborting is simply discarding this context.
 */
export class OpContext {
  readonly game: CompiledGame;
  state: GameState;
  readonly events: GameEvent[] = [];
  readonly firings: FiringRecord[] = [];
  readonly faults: FaultRecord[] = [];
  private readonly collectors: GameEvent[][] = [];
  private firingCount = 0;
  private readonly perRule = new Map<string, number>();
  private randomDraws = 0;
  private steps = 0;
  private spawns = 0;
  private choices = 0;
  private loopIterations = 0;
  private nextFiringId = 1;

  constructor(game: CompiledGame, state: GameState) {
    this.game = game;
    this.state = state;
  }

  private get budgets() {
    return this.game.def.settings.budgets;
  }

  emit(body: EventBody, cause: EventCause, audience?: Audience): GameEvent {
    if (this.events.length >= this.budgets.events) {
      throw new BudgetExceeded('events', `more than ${this.budgets.events} events in one operation`);
    }
    this.state.counters.event += 1;
    const event = {
      ...body,
      seq: this.state.counters.event,
      rev: this.state.rev + 1,
      round: this.state.round,
      cause,
      audience: audience ?? this.defaultAudience(body),
    } as GameEvent;
    this.events.push(event);
    this.collectors[this.collectors.length - 1]?.push(event);
    return event;
  }

  private defaultAudience(body: EventBody): Audience {
    if (body.type === 'resourceChanged') {
      const vis = this.game.resources.get(body.resource)?.visibility ?? 'public';
      if (vis === 'owner') return [body.entity];
      if (vis === 'gm') return 'gm';
    }
    if ((body.type === 'statusApplied' || body.type === 'statusRemoved' || body.type === 'statusPrevented') && this.game.statuses.get(body.status)?.visibility === 'hidden') return 'gm';
    if (body.type === 'choiceOffered') return [body.entity];
    return 'all';
  }

  /** Runs fn while collecting the events it emits (the firing's effect list). */
  collect(fn: () => void): GameEvent[] {
    const bucket: GameEvent[] = [];
    this.collectors.push(bucket);
    try {
      fn();
    } finally {
      this.collectors.pop();
    }
    return bucket;
  }

  countFiring(ruleId: string, depth: number): number {
    this.firingCount += 1;
    if (this.firingCount > this.budgets.firings) throw new BudgetExceeded('firings', `more than ${this.budgets.firings} rule firings in one operation`);
    const n = (this.perRule.get(ruleId) ?? 0) + 1;
    this.perRule.set(ruleId, n);
    if (n > this.budgets.firingsPerRule) {
      throw new BudgetExceeded('firingsPerRule', `rule "${this.game.rules.get(ruleId)?.def.name ?? ruleId}" fired more than ${this.budgets.firingsPerRule} times in one operation`);
    }
    if (depth > this.budgets.depth) throw new BudgetExceeded('depth', `cascade deeper than ${this.budgets.depth}`);
    return this.nextFiringId++;
  }

  random(n: number): number {
    this.randomDraws += 1;
    if (this.randomDraws > this.budgets.randomDraws) throw new BudgetExceeded('randomDraws', `more than ${this.budgets.randomDraws} random draws in one operation`);
    return randomBelow(this.state.rng, n);
  }

  step(): void {
    this.steps += 1;
    if (this.steps > this.budgets.expressionSteps) throw new BudgetExceeded('expressionSteps', `more than ${this.budgets.expressionSteps} expression steps in one operation`);
  }

  countSpawn(): void {
    this.spawns += 1;
    if (this.spawns > this.budgets.spawns) throw new BudgetExceeded('spawns', `more than ${this.budgets.spawns} entities spawned in one operation`);
  }

  countChoice(): void {
    this.choices += 1;
    if (this.choices > this.budgets.choices) throw new BudgetExceeded('choices', `more than ${this.budgets.choices} choices offered in one operation`);
  }

  countLoopIterations(n: number): void {
    this.loopIterations += n;
    if (this.loopIterations > this.budgets.loopIterations) throw new BudgetExceeded('loopIterations', `more than ${this.budgets.loopIterations} forEach iterations in one operation`);
  }

  get selectorLimit(): number {
    return this.budgets.selectorSize;
  }

  savepoint(): Savepoint {
    return {
      state: cloneJson(this.state),
      eventCount: this.events.length,
      firingCount: this.firings.length,
      collectorCount: this.collectors[this.collectors.length - 1]?.length ?? 0,
    };
  }

  /** Restores state, events and records to a savepoint. Budget counters are not refunded. */
  restore(sp: Savepoint): void {
    this.state = sp.state;
    this.events.length = sp.eventCount;
    this.firings.length = sp.firingCount;
    const top = this.collectors[this.collectors.length - 1];
    if (top) top.length = sp.collectorCount;
  }
}
