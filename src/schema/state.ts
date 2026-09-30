import { z } from 'zod';
import { CondSchema, EffectSchema, EntityKindSchema, type EntityKind } from './rules.ts';
import { SAVE_FORMAT_VERSION } from './versions.ts';

/**
 * Authoritative match state. Plain JSON so it can be cloned, hashed, saved and validated.
 * Only the engine mutates it.
 */

export const StatusInstanceSchema = z.strictObject({
  id: z.string(),
  defId: z.string(),
  stacks: z.number().int().min(1),
  /** Holder turns left (null = until removed). */
  remaining: z.number().int().nullable(),
  /** Applied during the holder's current turn (or round): the next countdown is skipped. */
  fresh: z.boolean(),
});
export type StatusInstance = z.infer<typeof StatusInstanceSchema>;

export const ENTITY_STATES = ['active', 'defeated', 'eliminated', 'removed'] as const;

export const EntitySchema = z.strictObject({
  id: z.string(),
  kind: EntityKindSchema,
  /** Cast member, enemy or fixture definition this entity was created from. */
  defId: z.string(),
  name: z.string(),
  spaceId: z.string().nullable(),
  /** Base values. Effective stat values add item, status and continuous-rule modifiers on read. */
  resources: z.record(z.string(), z.number().int()),
  /** Base tags; statuses grant more (effective tags). */
  tags: z.array(z.string()),
  items: z.array(z.string()),
  statuses: z.array(StatusInstanceSchema).default([]),
  /** Lifecycle: defeated enemies wait to respawn; eliminated contestants are out; removed = tombstone. */
  status: z.enum(ENTITY_STATES),
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
  /** `price` is the price after modifiers, fixed when the option is offered. */
  z.strictObject({ id: z.string(), kind: z.literal('buy'), label: z.string(), fixture: z.string(), entry: z.string(), price: z.number().int() }),
  z.strictObject({ id: z.string(), kind: z.literal('attack'), label: z.string(), target: z.string() }),
  z.strictObject({ id: z.string(), kind: z.literal('use'), label: z.string(), item: z.string() }),
  z.strictObject({ id: z.string(), kind: z.literal('act'), label: z.string(), action: z.string(), target: z.string().nullable() }),
  z.strictObject({ id: z.string(), kind: z.literal('rest'), label: z.string() }),
  z.strictObject({ id: z.string(), kind: z.literal('pass'), label: z.string() }),
  z.strictObject({ id: z.string(), kind: z.literal('choose'), label: z.string(), option: z.string() }),
]);
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

export const DecisionSchema = z.strictObject({
  id: z.string(),
  actor: z.string(),
  kind: z.enum(['move', 'main', 'choice']),
  issuedRev: z.number().int(),
  options: z.array(DecisionOptionSchema).min(1),
  /** For choices: the queued choice this decision answers, and its prompt. */
  choice: z.string().optional(),
  prompt: z.string().optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

/**
 * A choice offered by a rule or card. It is answered in its own later operation (a commit
 * boundary); bindings are saved so the chosen option's effects run as if they followed the offer.
 */
export const PendingChoiceSchema = z.strictObject({
  id: z.string(),
  chooser: z.string(),
  prompt: z.string(),
  options: z.array(
    z.strictObject({
      id: z.string(),
      label: z.string(),
      requires: CondSchema.optional(),
      effects: z.array(EffectSchema),
    }),
  ),
  default: z.string(),
  bindings: z.strictObject({
    $target: z.string().optional(),
    $space: z.string().optional(),
    $it: z.string().optional(),
    $holder: z.string().optional(),
    amount: z.number().int().optional(),
  }),
  /** Event that offered the choice (for "why?" traces) and the rule behind it, if any. */
  offeredSeq: z.number().int(),
  rule: z.string().optional(),
});
export type PendingChoice = z.infer<typeof PendingChoiceSchema>;

export const RuleCounterSchema = z.strictObject({
  turnKey: z.string(),
  turnCount: z.number().int(),
  round: z.number().int(),
  roundCount: z.number().int(),
  total: z.number().int(),
  lastRound: z.number().int(),
});
export type RuleCounter = z.infer<typeof RuleCounterSchema>;

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
    status: z.number().int().default(0),
    choice: z.number().int().default(0),
  }),
  round: z.number().int().min(0),
  phase: z.enum(PHASES),
  turn: z.strictObject({
    index: z.number().int().min(0),
    roll: z.number().int().nullable(),
    /** The active contestant was knocked out during its own turn: the turn ends. */
    over: z.boolean().default(false),
  }),
  turnOrder: z.array(z.string()),
  entities: z.record(z.string(), EntitySchema),
  items: z.record(z.string(), ItemInstanceSchema),
  /** Firing counts for rule limits; attached rules count per holder (`rule@holder`). */
  ruleCounters: z.record(z.string(), RuleCounterSchema),
  /** `action:entity` → first round in which the action can be used again. */
  cooldowns: z.record(z.string(), z.number().int()).default({}),
  /** Draw pile (top first) and discard pile per deck. */
  decks: z.record(z.string(), z.strictObject({ draw: z.array(z.string()), discard: z.array(z.string()) })).default({}),
  /** Choices waiting to be answered, in order. They are answered before the phase decision. */
  queue: z.array(PendingChoiceSchema).default([]),
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
  kind: 'action' | 'rule' | 'system' | 'gm' | 'reward' | 'card' | 'choice';
  /** The acting entity (actions, choices) or enemy granting a reward. */
  entity?: string | undefined;
  /** Rule that produced this event. */
  rule?: string | undefined;
  /** Card whose effects produced this event. */
  card?: string | undefined;
  /** Event that triggered the rule / fight / reward that produced this event. */
  parent?: number | undefined;
  /** Rule firing record for "why?" traces. */
  firing?: number | undefined;
}

/** A before-modifier that changed a value on its way into an event. */
export interface ModRecord {
  rule: string;
  holder?: string | undefined;
  from: number;
  to: number;
}

export type EventBody =
  | { type: 'matchStarted'; seed: string; turnOrder: string[] }
  | { type: 'roundStarted'; round: number }
  | { type: 'roundEnded'; round: number }
  | { type: 'turnStarted'; entity: string }
  | { type: 'turnSkipped'; entity: string; reason: string }
  | { type: 'turnEnded'; entity: string }
  | { type: 'rolled'; entity: string; sides: number; value: number; bonus: number; total: number; mods?: ModRecord[] | undefined }
  | { type: 'decided'; entity: string; decision: string; option: string; label: string; say?: string | undefined }
  | { type: 'moved'; entity: string; from: string | null; to: string; path: string[]; mode: 'walk' | 'teleport' }
  | { type: 'left'; entity: string; space: string }
  | { type: 'entered'; entity: string; space: string; mode: 'walk' | 'teleport' }
  | { type: 'landed'; entity: string; space: string }
  | { type: 'resourceChanged'; entity: string; resource: string; from: number; to: number; requested: number; mods?: ModRecord[] | undefined }
  | { type: 'tagAdded'; entity: string; tag: string }
  | { type: 'tagRemoved'; entity: string; tag: string }
  | { type: 'itemGained'; entity: string; item: string; itemDef: string }
  | { type: 'itemLost'; entity: string; item: string; itemDef: string; reason: 'removed' | 'used' | 'given' | 'lost' | 'consumed' }
  | { type: 'itemUsed'; entity: string; item: string; itemDef: string }
  | { type: 'purchased'; entity: string; fixture: string; entry: string; priceResource: string; price: number; mods?: ModRecord[] | undefined }
  | { type: 'rested'; entity: string; healed: number }
  | { type: 'passed'; entity: string }
  | { type: 'actionUsed'; entity: string; action: string; target: string | null }
  | { type: 'statusApplied'; entity: string; status: string; stacks: number; remaining: number | null; mods?: ModRecord[] | undefined }
  | { type: 'statusRemoved'; entity: string; status: string; stacks: number; left: number; reason: 'expired' | 'removed' | 'consumed' }
  | { type: 'statusPrevented'; entity: string; status: string; mods: ModRecord[] }
  | {
      type: 'fightStarted';
      fight: number;
      attacker: string;
      defender: string;
      attackerPower: number;
      defenderPower: number;
      attackerHp: number;
      defenderHp: number;
      /** Base damage per hit before damage modifiers. */
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
      /** Damage actually dealt (after damage modifiers). */
      damage: number;
      loserHpAfter: number;
      mods?: ModRecord[] | undefined;
    }
  | { type: 'fightEnded'; fight: number; outcome: 'attackerWon' | 'defenderWon' | 'bothStanding'; attackerHp: number; defenderHp: number }
  | { type: 'fightPrevented'; attacker: string; defender: string; reason: string }
  | { type: 'damaged'; entity: string; by: string | null; amount: number; base: number; mods?: ModRecord[] | undefined }
  | { type: 'defeated'; entity: string; by: string | null; fight: number | null }
  | { type: 'knockedOut'; entity: string; goldLost: number; lootTo: string | null; respawnSpace: string; skipTurns: number }
  | { type: 'eliminated'; entity: string }
  | { type: 'respawned'; entity: string; space: string }
  | { type: 'spawned'; entity: string; enemy: string; space: string; boss: boolean }
  | { type: 'removed'; entity: string }
  | { type: 'deckShuffled'; deck: string; size: number }
  | { type: 'cardDrawn'; entity: string; deck: string; card: string; name: string }
  | { type: 'choiceOffered'; entity: string; choice: string; prompt: string; options: string[] }
  | { type: 'choiceMade'; entity: string; choice: string; option: string; label: string; automatic: boolean }
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
  cause: z.looseObject({ kind: z.enum(['action', 'rule', 'system', 'gm', 'reward', 'card', 'choice']) }),
});

export type { EntityKind };
