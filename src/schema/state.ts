import { z } from 'zod';
import { EntityKindSchema, type EntityKind } from './rules.ts';
import { SAVE_FORMAT_VERSION } from './versions.ts';

/**
 * Authoritative match state. Plain JSON so it can be cloned, hashed, saved and validated.
 * Only the engine mutates it.
 */

export const EntitySchema = z.strictObject({
  id: z.string(),
  kind: EntityKindSchema,
  /** Cast member, enemy or fixture definition this entity was created from. */
  defId: z.string(),
  name: z.string(),
  spaceId: z.string().nullable(),
  /** Base values. Effective stat values add item modifiers on read. */
  resources: z.record(z.string(), z.number().int()),
  tags: z.array(z.string()),
  items: z.array(z.string()),
  status: z.enum(['active', 'defeated']),
  respawnRound: z.number().int().nullable(),
  koTurns: z.number().int().min(0),
});
export type Entity = z.infer<typeof EntitySchema>;

export const ItemInstanceSchema = z.strictObject({
  id: z.string(),
  defId: z.string(),
  holder: z.string(),
});
export type ItemInstance = z.infer<typeof ItemInstanceSchema>;

export const PHASES = ['roundStart', 'turnStart', 'roll', 'move', 'main', 'turnEnd', 'roundEnd', 'gameOver'] as const;
export type Phase = (typeof PHASES)[number];

export const DecisionOptionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: z.string(), kind: z.literal('move'), label: z.string(), space: z.string(), steps: z.number().int() }),
  z.strictObject({ id: z.string(), kind: z.literal('buy'), label: z.string(), fixture: z.string(), entry: z.string() }),
  z.strictObject({ id: z.string(), kind: z.literal('attack'), label: z.string(), enemy: z.string() }),
  z.strictObject({ id: z.string(), kind: z.literal('rest'), label: z.string() }),
  z.strictObject({ id: z.string(), kind: z.literal('pass'), label: z.string() }),
]);
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

export const DecisionSchema = z.strictObject({
  id: z.string(),
  actor: z.string(),
  kind: z.enum(['move', 'main']),
  issuedRev: z.number().int(),
  options: z.array(DecisionOptionSchema).min(1),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const GameStateSchema = z.strictObject({
  formatVersion: z.literal(SAVE_FORMAT_VERSION),
  matchId: z.string(),
  definitionId: z.string(),
  rev: z.number().int().min(0),
  seed: z.string(),
  rng: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]),
  counters: z.strictObject({
    entity: z.number().int(),
    item: z.number().int(),
    event: z.number().int(),
    decision: z.number().int(),
    fight: z.number().int(),
  }),
  round: z.number().int().min(0),
  phase: z.enum(PHASES),
  turn: z.strictObject({
    index: z.number().int().min(0),
    roll: z.number().int().nullable(),
  }),
  turnOrder: z.array(z.string()),
  entities: z.record(z.string(), EntitySchema),
  items: z.record(z.string(), ItemInstanceSchema),
  ruleCounters: z.record(z.string(), z.strictObject({ turnKey: z.string(), count: z.number().int() })),
  pendingDecision: DecisionSchema.nullable(),
  winners: z.array(z.string()).nullable(),
  endReason: z.string().nullable(),
});
export type GameState = z.infer<typeof GameStateSchema>;

// ---------------------------------------------------------------------------------------------
// Events: the committed history. Every event records its cause and audience.
// ---------------------------------------------------------------------------------------------

export type Audience = 'all' | 'gm' | string[];

export interface EventCause {
  kind: 'action' | 'rule' | 'system' | 'gm' | 'reward';
  /** The acting entity (actions) or enemy granting a reward. */
  entity?: string | undefined;
  /** Rule that produced this event. */
  rule?: string | undefined;
  /** Event that triggered the rule / fight / reward that produced this event. */
  parent?: number | undefined;
  /** Rule firing record for "why?" traces. */
  firing?: number | undefined;
}

export type EventBody =
  | { type: 'matchStarted'; seed: string; turnOrder: string[] }
  | { type: 'roundStarted'; round: number }
  | { type: 'roundEnded'; round: number }
  | { type: 'turnStarted'; entity: string }
  | { type: 'turnSkipped'; entity: string; reason: string }
  | { type: 'turnEnded'; entity: string }
  | { type: 'rolled'; entity: string; sides: number; value: number }
  | { type: 'decided'; entity: string; decision: string; option: string; label: string; say?: string | undefined }
  | { type: 'moved'; entity: string; from: string | null; to: string; path: string[]; mode: 'walk' | 'teleport' }
  | { type: 'left'; entity: string; space: string }
  | { type: 'entered'; entity: string; space: string; mode: 'walk' | 'teleport' }
  | { type: 'landed'; entity: string; space: string }
  | { type: 'resourceChanged'; entity: string; resource: string; from: number; to: number; requested: number }
  | { type: 'tagAdded'; entity: string; tag: string }
  | { type: 'tagRemoved'; entity: string; tag: string }
  | { type: 'itemGained'; entity: string; item: string; itemDef: string }
  | { type: 'itemLost'; entity: string; item: string; itemDef: string }
  | { type: 'purchased'; entity: string; fixture: string; entry: string; priceResource: string; price: number }
  | { type: 'rested'; entity: string; healed: number }
  | { type: 'passed'; entity: string }
  | {
      type: 'fightStarted';
      fight: number;
      attacker: string;
      defender: string;
      attackerPower: number;
      defenderPower: number;
      attackerHp: number;
      defenderHp: number;
      attackerDamage: number;
      defenderDamage: number;
      maxSpins: number;
    }
  | {
      type: 'spin';
      fight: number;
      index: number;
      /** Wheel size = attackerPower + defenderPower; attacker wins iff roll < attackerPower. */
      total: number;
      roll: number;
      winner: string;
      loser: string;
      damage: number;
      loserHpAfter: number;
    }
  | { type: 'fightEnded'; fight: number; outcome: 'attackerWon' | 'defenderWon' | 'bothStanding'; attackerHp: number; defenderHp: number }
  | { type: 'defeated'; entity: string; by: string | null; fight: number | null }
  | { type: 'knockedOut'; entity: string; goldLost: number; respawnSpace: string; skipTurns: number }
  | { type: 'respawned'; entity: string; space: string }
  | { type: 'announced'; text: string }
  | { type: 'ruleFault'; rule: string; message: string }
  | { type: 'gmCommand'; summary: string }
  | { type: 'gameOver'; winners: string[]; reason: string };

export type EventType = EventBody['type'];

export type GameEvent = EventBody & {
  seq: number;
  rev: number;
  round: number;
  cause: EventCause;
  audience: Audience;
};

/** Loose runtime check for events read back from history files. */
export const GameEventSchema = z.looseObject({
  seq: z.number().int(),
  rev: z.number().int(),
  round: z.number().int(),
  type: z.string(),
  cause: z.looseObject({ kind: z.enum(['action', 'rule', 'system', 'gm', 'reward']) }),
});

export type { EntityKind };
