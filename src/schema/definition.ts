import { z } from 'zod';
import { CapabilitySchema, CondSchema, EffectSchema, EntityKindSchema, RuleDefSchema, TriggerSchema } from './rules.ts';
import { PersonaSchema } from './persona.ts';
import { RULES_LANGUAGE_VERSION } from './versions.ts';

/**
 * A game definition: everything the GM authors. Stable IDs are independent of display names.
 * Unknown fields are rejected; defaults exist only where written here.
 */

const Id = z.string().min(1).max(80).regex(/^[a-z][a-z0-9_.-]*$/, 'ids are lowercase slugs like res.gold');
const Name = z.string().min(1).max(80);
const Int = z.number().int().min(-1_000_000_000).max(1_000_000_000);
const Icon = z.string().max(8).optional();

export const ResourceDefSchema = z.strictObject({
  id: Id,
  name: Name,
  /** pool: a stored amount changed by effects. stat: base value + modifiers (effective value). */
  role: z.enum(['pool', 'stat']),
  appliesTo: z.array(EntityKindSchema).min(1),
  default: Int,
  min: Int,
  max: Int.nullable(),
  /** Upper bound taken from another resource's effective value (e.g. hp bounded by max_hp). */
  maxFrom: Id.optional(),
  visibility: z.enum(['public', 'owner', 'gm']).default('public'),
  icon: Icon,
  /** Contestants may exchange this resource in trades. */
  tradeable: z.boolean().default(false),
});
export type ResourceDef = z.infer<typeof ResourceDefSchema>;

export const TagDefSchema = z.strictObject({
  id: Id,
  name: Name,
  appliesTo: z.enum(['entity', 'space']),
  color: z.string().max(20).optional(),
  description: z.string().max(300).optional(),
});
export type TagDef = z.infer<typeof TagDefSchema>;

export const SpaceDefSchema = z.strictObject({
  id: Id,
  name: Name,
  tags: z.array(Id).max(8).default([]),
  description: z.string().max(300).optional(),
});
export type SpaceDef = z.infer<typeof SpaceDefSchema>;

export const ConnectionDefSchema = z.strictObject({
  a: Id,
  b: Id,
  directed: z.boolean().default(false),
});
export type ConnectionDef = z.infer<typeof ConnectionDefSchema>;

export const LayoutSchema = z.strictObject({
  width: z.number().int().min(100).max(10_000),
  height: z.number().int().min(100).max(10_000),
  positions: z.record(z.string(), z.strictObject({ x: z.number(), y: z.number() })),
});
export type Layout = z.infer<typeof LayoutSchema>;

const StatModifierSchema = z.strictObject({ resource: Id, add: Int });

export const ItemDefSchema = z.strictObject({
  id: Id,
  name: Name,
  icon: Icon,
  description: z.string().max(300).optional(),
  tags: z.array(Id).max(8).default([]),
  /** Passive modifiers to stat resources while held (e.g. +150 Power). */
  modifiers: z.array(StatModifierSchema).max(4).default([]),
  /** Other contestants see only "a concealed item" (and none of its modifiers). */
  concealed: z.boolean().default(false),
  /** Contestants may hand it over in trades (concealed items never change hands in trades). */
  tradeable: z.boolean().default(true),
  /** Optional use action (a main action); $actor and $holder are the user. */
  use: z
    .strictObject({
      label: z.string().min(1).max(60).optional(),
      effects: z.array(EffectSchema).min(1).max(12),
      consumed: z.boolean().default(true),
    })
    .optional(),
  /** Rules active only while the item is held ($holder = the holder). */
  rules: z.array(RuleDefSchema).max(8).default([]),
});
export type ItemDef = z.infer<typeof ItemDefSchema>;

/**
 * Timed statuses. Durations count the holder's own turns (enemies and fixtures: rounds) and do not
 * count down at the end of the turn in which the status was applied.
 */
export const StatusDefSchema = z.strictObject({
  id: Id,
  name: Name,
  icon: Icon,
  description: z.string().max(300).optional(),
  /** Holder turns the status lasts; null = until removed. */
  duration: z.number().int().min(1).max(99).nullable(),
  /** Re-applying: refresh the duration, extend it, add a stack (and refresh), or ignore. */
  stacking: z.enum(['refresh', 'extend', 'stack', 'ignore']).default('refresh'),
  maxStacks: z.number().int().min(1).max(99).default(1),
  /** Tags the holder counts as having while the status lasts (effective tags). */
  grantsTags: z.array(Id).max(8).default([]),
  /** Stat modifiers per stack. */
  modifiers: z.array(StatModifierSchema).max(4).default([]),
  suppress: z.array(CapabilitySchema).max(8).default([]),
  /** Hidden statuses (secret curses) are invisible to every contestant, including the holder. */
  visibility: z.enum(['public', 'hidden']).default('public'),
  /** Offered to the GM as a transformation template ("turn into a fish"). */
  transformation: z.boolean().default(false),
  rules: z.array(RuleDefSchema).max(8).default([]),
});
export type StatusDef = z.infer<typeof StatusDefSchema>;

export const ShopEntrySchema = z.strictObject({
  id: Id,
  grants: z.union([z.strictObject({ item: Id }), z.strictObject({ resource: Id, amount: z.number().int().min(1) })]),
  price: z.strictObject({ resource: Id, amount: z.number().int().min(0) }),
});
export type ShopEntry = z.infer<typeof ShopEntrySchema>;

export const ShopDefSchema = z.strictObject({
  id: Id,
  name: Name,
  entries: z.array(ShopEntrySchema).min(1).max(12),
});
export type ShopDef = z.infer<typeof ShopDefSchema>;

export const EnemyDefSchema = z.strictObject({
  id: Id,
  name: Name,
  icon: Icon,
  description: z.string().max(300).optional(),
  tags: z.array(Id).max(8).default([]),
  power: z.number().int().min(1),
  maxHp: z.number().int().min(1),
  regenPerRound: z.number().int().min(0).default(0),
  /** Rounds until a defeated enemy returns at full HP; null = never. */
  respawnAfterRounds: z.number().int().min(1).nullable(),
  /** Effects run when defeated, with $actor = victor and $target = this enemy. */
  rewards: z.array(EffectSchema).max(12).default([]),
  /** Spaces where copies start. Empty for enemies that only appear when spawned (bosses). */
  spawns: z.array(Id).max(20),
  boss: z.boolean().default(false),
  /** Rules active while this enemy is on the board ($holder = the enemy). */
  rules: z.array(RuleDefSchema).max(8).default([]),
});
export type EnemyDef = z.infer<typeof EnemyDefSchema>;

export const CardDefSchema = z.strictObject({
  id: Id,
  name: Name,
  text: z.string().max(300).optional(),
  count: z.number().int().min(1).max(10).default(1),
  /** Run for the drawer ($actor, $space = the drawer's space). */
  effects: z.array(EffectSchema).min(1).max(12),
});
export type CardDef = z.infer<typeof CardDefSchema>;

/** A shuffled deck: card order is hidden, the list of cards and the pile sizes are public. */
export const DeckDefSchema = z.strictObject({
  id: Id,
  name: Name,
  description: z.string().max(300).optional(),
  cards: z.array(CardDefSchema).min(1).max(40),
});
export type DeckDef = z.infer<typeof DeckDefSchema>;

/**
 * Custom main actions. Availability (location, requirements, cost, cooldown) is decided from
 * data the contestant can see; effects run with $actor = the user, $target = the chosen target.
 */
export const ActionDefSchema = z.strictObject({
  id: Id,
  name: Name,
  icon: Icon,
  description: z.string().max(300).optional(),
  where: z.strictObject({ spaceTag: Id.optional(), space: Id.optional() }).optional(),
  requires: CondSchema.optional(),
  cost: z.strictObject({ resource: Id, amount: z.number().int().min(1) }).optional(),
  /** The same contestant can use the action again this many rounds later. */
  cooldownRounds: z.number().int().min(1).max(50).optional(),
  target: z.strictObject({ kind: EntityKindSchema, range: z.enum(['here', 'anywhere']) }).optional(),
  effects: z.array(EffectSchema).min(1).max(12),
});
export type ActionDef = z.infer<typeof ActionDefSchema>;

/**
 * Private objectives. Each contestant is dealt some at match start; an objective is secret until
 * it is completed, then its reward runs for the owner ($actor) and everyone sees what it was.
 */
export const ObjectiveDefSchema = z.strictObject({
  id: Id,
  name: Name,
  icon: Icon,
  /** What the owner reads; generated from the goal when omitted. */
  text: z.string().max(200).optional(),
  goal: z.discriminatedUnion('kind', [
    /** Do something N times: events of this trigger in which the owner is $actor. */
    z.strictObject({ kind: z.literal('count'), trigger: TriggerSchema, times: z.number().int().min(1).max(20) }),
    /** Have at least this much of a resource (effective value) at the end of any operation. */
    z.strictObject({ kind: z.literal('reach'), resource: Id, atLeast: z.number().int().min(1) }),
  ]),
  reward: z.array(EffectSchema).min(1).max(8),
});
export type ObjectiveDef = z.infer<typeof ObjectiveDefSchema>;

export const FixtureDefSchema = z.strictObject({
  id: Id,
  name: Name,
  icon: Icon,
  tags: z.array(Id).max(8).default([]),
  shop: Id.optional(),
  start: z.union([z.strictObject({ space: Id }), z.strictObject({ randomSpaceTag: Id })]),
});
export type FixtureDef = z.infer<typeof FixtureDefSchema>;

export const CastMemberSchema = z.strictObject({
  id: Id,
  name: Name,
  icon: Icon,
  color: z.string().max(20),
  persona: PersonaSchema,
});
export type CastMember = z.infer<typeof CastMemberSchema>;

export const DamageSettingsSchema = z.strictObject({
  /** Damage dealt when both fighters have equal Power. */
  base: z.number().int().min(0).max(100_000),
  /** 1 = linear in the Power ratio, 0.5 = square root (gentler), 0 = flat damage. */
  ratioExponent: z.union([z.literal(0), z.literal(0.5), z.literal(1)]),
  min: z.number().int().min(0),
  max: z.number().int().min(1),
});
export type DamageSettings = z.infer<typeof DamageSettingsSchema>;

export const BudgetSettingsSchema = z.strictObject({
  firings: z.number().int().min(1).default(200),
  firingsPerRule: z.number().int().min(1).default(20),
  events: z.number().int().min(1).default(500),
  depth: z.number().int().min(1).default(24),
  randomDraws: z.number().int().min(1).default(256),
  expressionSteps: z.number().int().min(1).default(20_000),
  selectorSize: z.number().int().min(1).default(64),
  /** Entities created by spawn effects in one operation. */
  spawns: z.number().int().min(0).default(10),
  /** Choices queued by one operation. */
  choices: z.number().int().min(0).default(4),
  /** Total forEach iterations in one operation. */
  loopIterations: z.number().int().min(1).default(256),
});
export type BudgetSettings = z.infer<typeof BudgetSettingsSchema>;

export const SettingsSchema = z.strictObject({
  /** Which resources play the core roles the engine needs to know about. */
  core: z.strictObject({ hp: Id, maxHp: Id, power: Id, gold: Id }),
  startSpace: Id,
  movement: z.strictObject({
    die: z.number().int().min(2).max(20),
    /** Optional stat added to every movement roll (e.g. a Move stat that statuses lower). */
    bonus: Id.optional(),
  }),
  inventoryCapacity: z.number().int().min(0).max(20),
  rest: z.strictObject({ heal: z.number().int().min(0) }),
  combat: z.strictObject({
    damage: DamageSettingsSchema,
    maxSpinsPerFight: z.number().int().min(1).max(50),
    /** Contestants may attack other contestants on their space. */
    pvp: z.boolean().default(true),
  }),
  ko: z.strictObject({
    goldLossPercent: z.number().int().min(0).max(100),
    skipTurns: z.number().int().min(0).max(5),
    /** Gold lost in a knockout goes to the contestant who won the fight. */
    lootToVictor: z.boolean().default(true),
    /** respawn: back to start after skipping turns. eliminate: out of the match for good. */
    mode: z.enum(['respawn', 'eliminate']).default('respawn'),
    /** A knockout ends all of the contestant's statuses (transformations included). */
    clearStatuses: z.boolean().default(true),
  }),
  victory: z.strictObject({
    resource: Id,
    threshold: z.number().int().min(1),
    roundLimit: z.number().int().min(1).max(500),
    /** Ranking keys (descending) used for ties and the round limit. */
    ranking: z.array(Id).min(1).max(4),
  }),
  /** Secret objectives dealt to each contestant at match start (when the definition has any). */
  objectives: z.strictObject({ perContestant: z.number().int().min(0).max(3).default(1) }).default({ perContestant: 1 }),
  /** GM adjudication: rulings asked by rules (`askGm`) and contestants' freeform attempts. */
  adjudication: z
    .strictObject({
      /** Contestants may, as their main action, describe something unusual they attempt; the GM rules. */
      freeform: z.boolean().default(false),
      /** Rounds before the same contestant may attempt something freeform again. */
      freeformCooldownRounds: z.number().int().min(0).max(50).default(3),
      /** A live match waits this long for a ruling; then the result is "no effect". */
      timeoutSeconds: z.number().int().min(5).max(3600).default(90),
    })
    .default({ freeform: false, freeformCooldownRounds: 3, timeoutSeconds: 90 }),
  trading: z
    .strictObject({
      /** Contestants may propose one trade per turn (as a free action before their main action). */
      enabled: z.boolean().default(true),
      /** Longest promise, in rounds, a trade may include; 0 = no promises. */
      maxPromiseRounds: z.number().int().min(0).max(10).default(5),
    })
    .default({ enabled: true, maxPromiseRounds: 5 }),
  budgets: BudgetSettingsSchema.default({
    firings: 200,
    firingsPerRule: 20,
    events: 500,
    depth: 24,
    randomDraws: 256,
    expressionSteps: 20_000,
    selectorSize: 64,
    spawns: 10,
    choices: 4,
    loopIterations: 256,
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const GameDefinitionSchema = z.strictObject({
  id: Id,
  name: Name,
  description: z.string().max(2000).default(''),
  /** Older definitions are valid current definitions (later versions only added primitives). */
  rulesLanguageVersion: z.union([z.literal(1), z.literal(2), z.literal(RULES_LANGUAGE_VERSION)]).transform(() => RULES_LANGUAGE_VERSION),
  settings: SettingsSchema,
  resources: z.array(ResourceDefSchema).min(1).max(64),
  tags: z.array(TagDefSchema).max(128).default([]),
  spaces: z.array(SpaceDefSchema).min(2).max(400),
  connections: z.array(ConnectionDefSchema).min(1).max(2000),
  layout: LayoutSchema,
  items: z.array(ItemDefSchema).max(256).default([]),
  statuses: z.array(StatusDefSchema).max(128).default([]),
  shops: z.array(ShopDefSchema).max(32).default([]),
  enemies: z.array(EnemyDefSchema).max(64).default([]),
  fixtures: z.array(FixtureDefSchema).max(32).default([]),
  decks: z.array(DeckDefSchema).max(16).default([]),
  actions: z.array(ActionDefSchema).max(32).default([]),
  objectives: z.array(ObjectiveDefSchema).max(64).default([]),
  cast: z.array(CastMemberSchema).min(1).max(8),
  rules: z.array(RuleDefSchema).max(256).default([]),
});
export type GameDefinition = z.infer<typeof GameDefinitionSchema>;
export type GameDefinitionInput = z.input<typeof GameDefinitionSchema>;
