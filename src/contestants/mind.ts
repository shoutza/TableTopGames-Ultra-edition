import { z } from 'zod';
import { ARCHETYPES, StrategySchema, type Persona } from '../schema/persona.ts';

/** How a contestant feels about another (−10..10), updated by fixed rules from observed events. */
export const RelationshipSchema = z.strictObject({
  trust: z.number().int().min(-10).max(10),
  affinity: z.number().int().min(-10).max(10),
});
export type Relationship = z.infer<typeof RelationshipSchema>;

export const MEMORY_KINDS = ['betrayal', 'promiseKept', 'attackedMe', 'knockedOut', 'knockedOutRival', 'trade', 'offerRejected', 'robbedMe', 'objective', 'reputation'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Something the contestant observed and may recall (built only from events it could see). */
export const MemorySchema = z.strictObject({
  seq: z.number().int(),
  round: z.number().int(),
  kind: z.enum(MEMORY_KINDS),
  /** The other contestant involved, if any. */
  other: z.string().nullable(),
  text: z.string(),
  importance: z.number().int().min(0).max(5),
});
export type Memory = z.infer<typeof MemorySchema>;

/**
 * A contestant's persistent AI-side data: persona reference, strategy history, current plan,
 * relationships and memories. Rules never read it; it is saved with the match.
 */
export const ContestantMindSchema = z.strictObject({
  entityId: z.string(),
  castId: z.string(),
  controller: z.enum(['llm', 'heuristic']),
  candidates: z.array(z.enum(ARCHETYPES)),
  strategy: StrategySchema.nullable(),
  strategyHistory: z.array(StrategySchema),
  plan: z.string(),
  planRound: z.number().int(),
  /** Why the contestant should reconsider its strategy at the next decision (set by code). */
  reconsider: z.string().nullable(),
  lastReconsiderRound: z.number().int(),
  lastSeenEventSeq: z.number().int(),
  relationships: z.record(z.string(), RelationshipSchema).default({}),
  /** Most recent last; capped. */
  memories: z.array(MemorySchema).default([]),
  /** A moment worth reacting to in character at the next decision (set by code). */
  keyMoment: z.string().nullable().default(null),
});
export type ContestantMind = z.infer<typeof ContestantMindSchema>;

export function newMind(entityId: string, castId: string, candidates: ContestantMind['candidates'], controller: ContestantMind['controller']): ContestantMind {
  return {
    entityId,
    castId,
    controller,
    candidates,
    strategy: null,
    strategyHistory: [],
    plan: '',
    planRound: 0,
    reconsider: null,
    lastReconsiderRound: 0,
    lastSeenEventSeq: 0,
    relationships: {},
    memories: [],
    keyMoment: null,
  };
}

/** Numeric traits → concrete behavioral guidance. Numbers alone do not change a model's behavior. */
export function traitGuidance(p: Persona): string[] {
  const t = p.traits;
  const lines: string[] = [];
  const pick = (v: number, high: string, low: string, mid: string | null) => {
    if (v >= 7) lines.push(high);
    else if (v <= 3) lines.push(low);
    else if (mid) lines.push(mid);
  };
  pick(t.risk, 'You accept big gambles when the payoff is large.', 'You avoid gambles and prefer near-certain gains.', 'You take measured risks.');
  pick(t.aggression, 'You like to attack and prove your strength.', 'You fight only when victory is nearly certain.', null);
  pick(t.greed, 'You love gold and shiny rewards.', 'Gold matters to you only as a means to an end.', null);
  pick(t.loyalty, 'You keep your word.', 'Promises are tools to you.', null);
  pick(t.vindictiveness, 'You never forget who harmed you.', 'You let grudges go.', null);
  pick(t.sociability, 'You talk a lot and love an audience.', 'You speak rarely and briefly.', null);
  return lines;
}
