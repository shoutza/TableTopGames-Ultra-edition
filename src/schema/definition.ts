import { z } from 'zod';
import { EffectSchema, EntityKindSchema, RuleDefSchema } from './rules.ts';
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

export const ItemDefSchema = z.strictObject({
  id: Id,
  name: Name,
  icon: Icon,
  description: z.string().max(300).optional(),
  tags: z.array(Id).max(8).default([]),
  /** Passive modifiers to stat resources while held (e.g. +150 Power). */
  modifiers: z.array(z.strictObject({ resource: Id, add: Int })).max(4).default([]),
});
export type ItemDef = z.infer<typeof ItemDefSchema>;

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
  spawns: z.array(Id).min(1).max(20),
});
export type EnemyDef = z.infer<typeof EnemyDefSchema>;

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
});
export type BudgetSettings = z.infer<typeof BudgetSettingsSchema>;

export const SettingsSchema = z.strictObject({
  /** Which resources play the core roles the engine needs to know about. */
  core: z.strictObject({ hp: Id, maxHp: Id, power: Id, gold: Id }),
  startSpace: Id,
  movement: z.strictObject({ die: z.number().int().min(2).max(20) }),
  inventoryCapacity: z.number().int().min(0).max(20),
  rest: z.strictObject({ heal: z.number().int().min(0) }),
  combat: z.strictObject({
    damage: DamageSettingsSchema,
    maxSpinsPerFight: z.number().int().min(1).max(50),
  }),
  ko: z.strictObject({
    goldLossPercent: z.number().int().min(0).max(100),
    skipTurns: z.number().int().min(0).max(5),
  }),
  victory: z.strictObject({
    resource: Id,
    threshold: z.number().int().min(1),
    roundLimit: z.number().int().min(1).max(500),
    /** Ranking keys (descending) used for ties and the round limit. */
    ranking: z.array(Id).min(1).max(4),
  }),
  budgets: BudgetSettingsSchema.default({
    firings: 200,
    firingsPerRule: 20,
    events: 500,
    depth: 24,
    randomDraws: 256,
    expressionSteps: 20_000,
    selectorSize: 64,
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const GameDefinitionSchema = z.strictObject({
  id: Id,
  name: Name,
  description: z.string().max(2000).default(''),
  rulesLanguageVersion: z.literal(RULES_LANGUAGE_VERSION),
  settings: SettingsSchema,
  resources: z.array(ResourceDefSchema).min(1).max(64),
  tags: z.array(TagDefSchema).max(128).default([]),
  spaces: z.array(SpaceDefSchema).min(2).max(400),
  connections: z.array(ConnectionDefSchema).min(1).max(2000),
  layout: LayoutSchema,
  items: z.array(ItemDefSchema).max(256).default([]),
  shops: z.array(ShopDefSchema).max(32).default([]),
  enemies: z.array(EnemyDefSchema).max(64).default([]),
  fixtures: z.array(FixtureDefSchema).max(32).default([]),
  cast: z.array(CastMemberSchema).min(1).max(8),
  rules: z.array(RuleDefSchema).max(256).default([]),
});
export type GameDefinition = z.infer<typeof GameDefinitionSchema>;
export type GameDefinitionInput = z.input<typeof GameDefinitionSchema>;
