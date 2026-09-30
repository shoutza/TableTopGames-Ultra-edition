import { z } from 'zod';

/**
 * The constrained rule language. Rules are data: trusted engine code interprets these
 * allowlisted operations. Nothing here is ever executed as code.
 *
 * Three kinds of rules:
 * - reaction: runs after an event (the only source of chains);
 * - modifier: transforms or prevents a value just before it is applied (damage, resource change,
 *   shop price, movement roll, status application);
 * - continuous: adds stat modifiers or suppresses capabilities while a condition holds.
 * Items, statuses and enemies can carry attached rules, active only while held / present, with
 * `$holder` bound to the holding entity.
 */

export const ENTITY_KINDS = ['contestant', 'enemy', 'fixture'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export const EntityKindSchema = z.enum(ENTITY_KINDS);

/** Things an entity can do; statuses and continuous rules can suppress them. */
export const CAPABILITIES = ['takesTurns', 'moves', 'shops', 'attacks', 'attackable', 'usesItems', 'trades'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const CapabilitySchema = z.enum(CAPABILITIES);

export type EntityBinding = '$actor' | '$target' | '$it' | '$holder';
export type EntityRef = EntityBinding | { op: 'entity'; id: string };

export type Selector =
  | EntityBinding
  | { op: 'entity'; id: string }
  | { op: 'all'; kind?: EntityKind | undefined }
  | { op: 'at'; space: SpaceRef; kind?: EntityKind | undefined }
  | { op: 'withTag'; tag: string; kind?: EntityKind | undefined }
  | { op: 'filter'; from: Selector; where: Cond }
  | { op: 'random'; from: Selector; count: number }
  /** Contestants with the most / fewest of a resource (base value); ties return everyone tied. */
  | { op: 'leader'; resource: string }
  | { op: 'trailer'; resource: string };

export type SpaceRef =
  | '$space'
  | { op: 'space'; id: string }
  | { op: 'spaceOf'; entity: EntityRef }
  | { op: 'randomSpace'; tag: string; excludeSpaceOf?: EntityRef | undefined };

export const ROUNDING_MODES = ['floor', 'ceil', 'halfUp', 'towardZero'] as const;
export type Rounding = (typeof ROUNDING_MODES)[number];

export type Num =
  | number
  | { op: 'res'; of: EntityRef; resource: string; ifMissing?: number | undefined }
  | { op: 'stat'; of: EntityRef; resource: string }
  | { op: 'roll'; count: number; sides: number }
  | { op: 'add'; args: Num[] }
  | { op: 'sub'; a: Num; b: Num }
  | { op: 'mul'; args: Num[] }
  | { op: 'div'; a: Num; b: Num; rounding: Rounding }
  | { op: 'min'; args: Num[] }
  | { op: 'max'; args: Num[] }
  | { op: 'count'; of: Selector }
  | { op: 'round' }
  | { op: 'amount' }
  /** Stacks of a status on an entity (0 if absent). */
  | { op: 'stacks'; of: EntityRef; status: string };

export const COMPARATORS = ['<', '<=', '==', '!=', '>=', '>'] as const;
export type Comparator = (typeof COMPARATORS)[number];

export type Cond =
  | { op: 'all'; conds: Cond[] }
  | { op: 'any'; conds: Cond[] }
  | { op: 'not'; cond: Cond }
  | { op: 'hasTag'; entity: EntityRef; tag: string }
  | { op: 'spaceHasTag'; space: SpaceRef; tag: string }
  | { op: 'isKind'; entity: EntityRef; kind: EntityKind }
  | { op: 'holds'; entity: EntityRef; item: string }
  | { op: 'compare'; left: Num; cmp: Comparator; right: Num }
  | { op: 'exists'; of: Selector }
  | { op: 'hasStatus'; entity: EntityRef; status: string; minStacks?: number | undefined }
  /** The two references are the same entity. */
  | { op: 'same'; a: EntityRef; b: EntityRef }
  | { op: 'sameSpace'; a: EntityRef; b: EntityRef };

export interface ChoiceOption {
  id: string;
  label: string;
  /** Legality, checked when the choice is offered (with $actor = the chooser). Must be view-safe. */
  requires?: Cond | undefined;
  effects: Effect[];
}

export type Effect =
  | { op: 'changeResource'; target: Selector; resource: string; amount: Num }
  | { op: 'setResource'; target: Selector; resource: string; value: Num }
  | { op: 'transfer'; from: EntityRef; to: EntityRef; resource: string; amount: Num; ifShort?: 'partial' | 'skip' | undefined }
  | { op: 'addTag'; target: Selector; tag: string }
  | { op: 'removeTag'; target: Selector; tag: string }
  | { op: 'teleport'; target: Selector; to: SpaceRef; asLanding?: boolean | undefined }
  | { op: 'grantItem'; target: EntityRef; item: string; count?: number | undefined }
  /** Moves one held item (a given definition, or a random one) to another entity. */
  | { op: 'transferItem'; from: EntityRef; to: EntityRef; item: string }
  /** Destroys one held item (a given definition, or a random one). */
  | { op: 'loseItem'; target: EntityRef; item: string }
  | { op: 'fight'; attacker: Selector; defender: Selector }
  /** HP loss through damage modifiers (shields, armor); $actor is the source when bound. */
  | { op: 'damage'; target: Selector; amount: Num }
  | { op: 'applyStatus'; target: Selector; status: string; stacks?: number | undefined; duration?: number | undefined }
  | { op: 'removeStatus'; target: Selector; status: string; stacks?: number | undefined }
  | { op: 'spawn'; enemy: string; at: SpaceRef; count?: number | undefined }
  | { op: 'remove'; target: Selector }
  | { op: 'drawCard'; deck: string; for: EntityRef }
  | { op: 'offerChoice'; to: EntityRef; prompt: string; options: ChoiceOption[]; default: string }
  | { op: 'announce'; text: string }
  | { op: 'if'; cond: Cond; then: Effect[]; else?: Effect[] | undefined }
  | { op: 'forEach'; of: Selector; do: Effect[] }
  | { op: 'randomBranch'; branches: Array<{ weight: number; do: Effect[] }> };

export const TRIGGER_EVENTS = [
  'roundStarted',
  'roundEnded',
  'turnStarted',
  'turnEnded',
  'left',
  'entered',
  'landed',
  'resourceChanged',
  'purchased',
  'defeated',
  'itemGained',
  'itemLost',
  'itemUsed',
  'statusApplied',
  'statusRemoved',
  'damaged',
  'cardDrawn',
  'actionUsed',
  'spawned',
] as const;
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

export interface TriggerWhere {
  spaceTag?: string | undefined;
  space?: string | undefined;
  resource?: string | undefined;
  direction?: 'gain' | 'loss' | undefined;
  actorKind?: EntityKind | undefined;
  targetKind?: EntityKind | undefined;
  targetTag?: string | undefined;
  item?: string | undefined;
  shopEntry?: string | undefined;
  status?: string | undefined;
  deck?: string | undefined;
  card?: string | undefined;
  action?: string | undefined;
  enemy?: string | undefined;
}

export interface Trigger {
  event: TriggerEvent;
  where?: TriggerWhere | undefined;
}

export interface RuleLimits {
  maxPerTurn?: number | undefined;
  maxPerRound?: number | undefined;
  maxPerGame?: number | undefined;
  /** After firing in round r, the rule (per holder for attached rules) is ready again in round r + n. */
  cooldownRounds?: number | undefined;
}

interface RuleBase {
  id: string;
  name: string;
  description?: string | undefined;
  enabled: boolean;
  visibility: 'public' | 'hidden';
  priority: number;
  limits?: RuleLimits | undefined;
  provenance?: { sourceText?: string | undefined; proposalId?: string | undefined } | undefined;
}

export interface ReactionRule extends RuleBase {
  kind: 'reaction';
  trigger: Trigger;
  conditions?: Cond | undefined;
  effects: Effect[];
}

/** The five value-producing moments before-modifiers may change. */
export const MODIFIER_EVENTS = ['damage', 'resourceChange', 'price', 'moveRoll', 'statusApply'] as const;
export type ModifierEvent = (typeof MODIFIER_EVENTS)[number];

export type ModifyOp =
  | { op: 'add'; amount: Num }
  | { op: 'scale'; num: number; den: number; rounding: Rounding }
  | { op: 'clampTo'; min?: Num | undefined; max?: Num | undefined }
  | { op: 'prevent' };

export interface ModifierWhere {
  resource?: string | undefined;
  direction?: 'gain' | 'loss' | undefined;
  targetKind?: EntityKind | undefined;
  targetTag?: string | undefined;
  status?: string | undefined;
  shopEntry?: string | undefined;
}

export interface ModifierRule extends RuleBase {
  kind: 'modifier';
  on: ModifierEvent;
  where?: ModifierWhere | undefined;
  conditions?: Cond | undefined;
  modify: ModifyOp;
  /** Paid only when the modifier changes the value: one stack of a status, or the item carrying this rule. */
  consume?: { status: string } | { item: true } | undefined;
}

export interface ContinuousRule extends RuleBase {
  kind: 'continuous';
  /** Entities affected ($holder bound for attached rules). */
  applies: Selector;
  /** Checked per affected entity ($it). May read base values, tags, statuses, positions and items, never effective stats. */
  when?: Cond | undefined;
  modifiers: Array<{ resource: string; add: Num }>;
  suppress: Capability[];
}

export type RuleDef = ReactionRule | ModifierRule | ContinuousRule;

// ---------------------------------------------------------------------------------------------
// Zod schemas (runtime validation of imported definitions and saves)
// ---------------------------------------------------------------------------------------------

const Id = z.string().min(1).max(80);
const EntityBindingSchema = z.enum(['$actor', '$target', '$it', '$holder']);
const EntityLiteralSchema = z.strictObject({ op: z.literal('entity'), id: Id });

export const EntityRefSchema: z.ZodType<EntityRef> = z.union([EntityBindingSchema, EntityLiteralSchema]);

export const SpaceRefSchema: z.ZodType<SpaceRef> = z.lazy(() =>
  z.union([
    z.literal('$space'),
    z.discriminatedUnion('op', [
      z.strictObject({ op: z.literal('space'), id: Id }),
      z.strictObject({ op: z.literal('spaceOf'), entity: EntityRefSchema }),
      z.strictObject({ op: z.literal('randomSpace'), tag: Id, excludeSpaceOf: EntityRefSchema.optional() }),
    ]),
  ]),
);

export const SelectorSchema: z.ZodType<Selector> = z.lazy(() =>
  z.union([
    EntityBindingSchema,
    z.discriminatedUnion('op', [
      EntityLiteralSchema,
      z.strictObject({ op: z.literal('all'), kind: EntityKindSchema.optional() }),
      z.strictObject({ op: z.literal('at'), space: SpaceRefSchema, kind: EntityKindSchema.optional() }),
      z.strictObject({ op: z.literal('withTag'), tag: Id, kind: EntityKindSchema.optional() }),
      z.strictObject({ op: z.literal('filter'), from: SelectorSchema, where: CondSchema }),
      z.strictObject({ op: z.literal('random'), from: SelectorSchema, count: z.number().int().min(1).max(64) }),
      z.strictObject({ op: z.literal('leader'), resource: Id }),
      z.strictObject({ op: z.literal('trailer'), resource: Id }),
    ]),
  ]),
);

const SmallInt = z.number().int().min(-1_000_000_000).max(1_000_000_000);

export const NumSchema: z.ZodType<Num> = z.lazy(() =>
  z.union([
    SmallInt,
    z.discriminatedUnion('op', [
      z.strictObject({ op: z.literal('res'), of: EntityRefSchema, resource: Id, ifMissing: SmallInt.optional() }),
      z.strictObject({ op: z.literal('stat'), of: EntityRefSchema, resource: Id }),
      z.strictObject({ op: z.literal('roll'), count: z.number().int().min(1).max(10), sides: z.number().int().min(2).max(100) }),
      z.strictObject({ op: z.literal('add'), args: z.array(NumSchema).min(1).max(8) }),
      z.strictObject({ op: z.literal('sub'), a: NumSchema, b: NumSchema }),
      z.strictObject({ op: z.literal('mul'), args: z.array(NumSchema).min(1).max(8) }),
      z.strictObject({ op: z.literal('div'), a: NumSchema, b: NumSchema, rounding: z.enum(ROUNDING_MODES) }),
      z.strictObject({ op: z.literal('min'), args: z.array(NumSchema).min(1).max(8) }),
      z.strictObject({ op: z.literal('max'), args: z.array(NumSchema).min(1).max(8) }),
      z.strictObject({ op: z.literal('count'), of: SelectorSchema }),
      z.strictObject({ op: z.literal('round') }),
      z.strictObject({ op: z.literal('amount') }),
      z.strictObject({ op: z.literal('stacks'), of: EntityRefSchema, status: Id }),
    ]),
  ]),
);

export const CondSchema: z.ZodType<Cond> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('all'), conds: z.array(CondSchema).min(1).max(12) }),
    z.strictObject({ op: z.literal('any'), conds: z.array(CondSchema).min(1).max(12) }),
    z.strictObject({ op: z.literal('not'), cond: CondSchema }),
    z.strictObject({ op: z.literal('hasTag'), entity: EntityRefSchema, tag: Id }),
    z.strictObject({ op: z.literal('spaceHasTag'), space: SpaceRefSchema, tag: Id }),
    z.strictObject({ op: z.literal('isKind'), entity: EntityRefSchema, kind: EntityKindSchema }),
    z.strictObject({ op: z.literal('holds'), entity: EntityRefSchema, item: Id }),
    z.strictObject({ op: z.literal('compare'), left: NumSchema, cmp: z.enum(COMPARATORS), right: NumSchema }),
    z.strictObject({ op: z.literal('exists'), of: SelectorSchema }),
    z.strictObject({ op: z.literal('hasStatus'), entity: EntityRefSchema, status: Id, minStacks: z.number().int().min(1).max(99).optional() }),
    z.strictObject({ op: z.literal('same'), a: EntityRefSchema, b: EntityRefSchema }),
    z.strictObject({ op: z.literal('sameSpace'), a: EntityRefSchema, b: EntityRefSchema }),
  ]),
);

export const ChoiceOptionSchema: z.ZodType<ChoiceOption> = z.lazy(() =>
  z.strictObject({
    id: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/, 'choice option ids are short lowercase slugs'),
    label: z.string().min(1).max(120),
    requires: CondSchema.optional(),
    effects: z.array(EffectSchema).max(12),
  }),
);

export const EffectSchema: z.ZodType<Effect> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('changeResource'), target: SelectorSchema, resource: Id, amount: NumSchema }),
    z.strictObject({ op: z.literal('setResource'), target: SelectorSchema, resource: Id, value: NumSchema }),
    z.strictObject({
      op: z.literal('transfer'),
      from: EntityRefSchema,
      to: EntityRefSchema,
      resource: Id,
      amount: NumSchema,
      ifShort: z.enum(['partial', 'skip']).optional(),
    }),
    z.strictObject({ op: z.literal('addTag'), target: SelectorSchema, tag: Id }),
    z.strictObject({ op: z.literal('removeTag'), target: SelectorSchema, tag: Id }),
    z.strictObject({ op: z.literal('teleport'), target: SelectorSchema, to: SpaceRefSchema, asLanding: z.boolean().optional() }),
    z.strictObject({ op: z.literal('grantItem'), target: EntityRefSchema, item: Id, count: z.number().int().min(1).max(5).optional() }),
    z.strictObject({ op: z.literal('transferItem'), from: EntityRefSchema, to: EntityRefSchema, item: Id }),
    z.strictObject({ op: z.literal('loseItem'), target: EntityRefSchema, item: Id }),
    z.strictObject({ op: z.literal('fight'), attacker: SelectorSchema, defender: SelectorSchema }),
    z.strictObject({ op: z.literal('damage'), target: SelectorSchema, amount: NumSchema }),
    z.strictObject({
      op: z.literal('applyStatus'),
      target: SelectorSchema,
      status: Id,
      stacks: z.number().int().min(1).max(10).optional(),
      duration: z.number().int().min(1).max(99).optional(),
    }),
    z.strictObject({ op: z.literal('removeStatus'), target: SelectorSchema, status: Id, stacks: z.number().int().min(1).max(99).optional() }),
    z.strictObject({ op: z.literal('spawn'), enemy: Id, at: SpaceRefSchema, count: z.number().int().min(1).max(3).optional() }),
    z.strictObject({ op: z.literal('remove'), target: SelectorSchema }),
    z.strictObject({ op: z.literal('drawCard'), deck: Id, for: EntityRefSchema }),
    z.strictObject({
      op: z.literal('offerChoice'),
      to: EntityRefSchema,
      prompt: z.string().min(1).max(200),
      options: z.array(ChoiceOptionSchema).min(2).max(4),
      default: z.string().min(1).max(40),
    }),
    z.strictObject({ op: z.literal('announce'), text: z.string().min(1).max(280) }),
    z.strictObject({ op: z.literal('if'), cond: CondSchema, then: z.array(EffectSchema).max(12), else: z.array(EffectSchema).max(12).optional() }),
    z.strictObject({ op: z.literal('forEach'), of: SelectorSchema, do: z.array(EffectSchema).min(1).max(12) }),
    z.strictObject({
      op: z.literal('randomBranch'),
      branches: z
        .array(z.strictObject({ weight: z.number().int().min(1).max(1000), do: z.array(EffectSchema).max(12) }))
        .min(2)
        .max(8),
    }),
  ]),
);

export const TriggerSchema: z.ZodType<Trigger> = z.strictObject({
  event: z.enum(TRIGGER_EVENTS),
  where: z
    .strictObject({
      spaceTag: Id.optional(),
      space: Id.optional(),
      resource: Id.optional(),
      direction: z.enum(['gain', 'loss']).optional(),
      actorKind: EntityKindSchema.optional(),
      targetKind: EntityKindSchema.optional(),
      targetTag: Id.optional(),
      item: Id.optional(),
      shopEntry: Id.optional(),
      status: Id.optional(),
      deck: Id.optional(),
      card: Id.optional(),
      action: Id.optional(),
      enemy: Id.optional(),
    })
    .optional(),
});

const LimitsSchema = z.strictObject({
  maxPerTurn: z.number().int().min(1).max(100).optional(),
  maxPerRound: z.number().int().min(1).max(100).optional(),
  maxPerGame: z.number().int().min(1).max(1000).optional(),
  cooldownRounds: z.number().int().min(1).max(100).optional(),
});

const ruleBase = {
  id: Id,
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  enabled: z.boolean().default(true),
  visibility: z.enum(['public', 'hidden']).default('public'),
  priority: z.number().int().min(-1000).max(1000).default(0),
  limits: LimitsSchema.optional(),
  provenance: z.strictObject({ sourceText: z.string().max(1000).optional(), proposalId: z.string().optional() }).optional(),
};

const ReactionRuleSchema = z.strictObject({
  ...ruleBase,
  kind: z.literal('reaction').default('reaction'),
  trigger: TriggerSchema,
  conditions: CondSchema.optional(),
  effects: z.array(EffectSchema).min(1).max(12),
});

const ModifyOpSchema: z.ZodType<ModifyOp> = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), amount: NumSchema }),
  z.strictObject({ op: z.literal('scale'), num: z.number().int().min(0).max(1000), den: z.number().int().min(1).max(1000), rounding: z.enum(ROUNDING_MODES) }),
  z.strictObject({ op: z.literal('clampTo'), min: NumSchema.optional(), max: NumSchema.optional() }),
  z.strictObject({ op: z.literal('prevent') }),
]);

const ModifierRuleSchema = z.strictObject({
  ...ruleBase,
  kind: z.literal('modifier'),
  on: z.enum(MODIFIER_EVENTS),
  where: z
    .strictObject({
      resource: Id.optional(),
      direction: z.enum(['gain', 'loss']).optional(),
      targetKind: EntityKindSchema.optional(),
      targetTag: Id.optional(),
      status: Id.optional(),
      shopEntry: Id.optional(),
    })
    .optional(),
  conditions: CondSchema.optional(),
  modify: ModifyOpSchema,
  consume: z.union([z.strictObject({ status: Id }), z.strictObject({ item: z.literal(true) })]).optional(),
});

const ContinuousRuleSchema = z.strictObject({
  ...ruleBase,
  kind: z.literal('continuous'),
  applies: SelectorSchema,
  when: CondSchema.optional(),
  modifiers: z.array(z.strictObject({ resource: Id, add: NumSchema })).max(4).default([]),
  suppress: z.array(CapabilitySchema).max(8).default([]),
});

/** Reactions may omit `kind` (the original rule format); modifiers and continuous rules name it. */
export const RuleDefSchema: z.ZodType<RuleDef, z.input<typeof ReactionRuleSchema> | z.input<typeof ModifierRuleSchema> | z.input<typeof ContinuousRuleSchema>> = z.union([
  ReactionRuleSchema,
  ModifierRuleSchema,
  ContinuousRuleSchema,
]);
