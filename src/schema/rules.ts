import { z } from 'zod';

/**
 * The constrained rule language. Rules are data: trusted engine code interprets these
 * allowlisted operations. Nothing here is ever executed as code.
 */

export const ENTITY_KINDS = ['contestant', 'enemy', 'fixture'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export const EntityKindSchema = z.enum(ENTITY_KINDS);

export type EntityBinding = '$actor' | '$target' | '$it';
export type EntityRef = EntityBinding | { op: 'entity'; id: string };

export type Selector =
  | EntityBinding
  | { op: 'entity'; id: string }
  | { op: 'all'; kind?: EntityKind | undefined }
  | { op: 'at'; space: SpaceRef; kind?: EntityKind | undefined }
  | { op: 'withTag'; tag: string; kind?: EntityKind | undefined }
  | { op: 'filter'; from: Selector; where: Cond }
  | { op: 'random'; from: Selector; count: number };

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
  | { op: 'amount' };

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
  | { op: 'exists'; of: Selector };

export type Effect =
  | { op: 'changeResource'; target: Selector; resource: string; amount: Num }
  | { op: 'setResource'; target: Selector; resource: string; value: Num }
  | { op: 'transfer'; from: EntityRef; to: EntityRef; resource: string; amount: Num; ifShort?: 'partial' | 'skip' | undefined }
  | { op: 'addTag'; target: Selector; tag: string }
  | { op: 'removeTag'; target: Selector; tag: string }
  | { op: 'teleport'; target: Selector; to: SpaceRef; asLanding?: boolean | undefined }
  | { op: 'grantItem'; target: EntityRef; item: string; count?: number | undefined }
  | { op: 'fight'; attacker: Selector; defender: Selector }
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
}

export interface Trigger {
  event: TriggerEvent;
  where?: TriggerWhere | undefined;
}

export interface RuleDef {
  id: string;
  name: string;
  description?: string | undefined;
  kind: 'reaction';
  enabled: boolean;
  visibility: 'public' | 'hidden';
  priority: number;
  trigger: Trigger;
  conditions?: Cond | undefined;
  effects: Effect[];
  limits?: { maxPerTurn?: number | undefined } | undefined;
  provenance?: { sourceText?: string | undefined; proposalId?: string | undefined } | undefined;
}

// ---------------------------------------------------------------------------------------------
// Zod schemas (runtime validation of imported definitions and saves)
// ---------------------------------------------------------------------------------------------

const Id = z.string().min(1).max(80);
const EntityBindingSchema = z.enum(['$actor', '$target', '$it']);
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
  ]),
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
    z.strictObject({ op: z.literal('fight'), attacker: SelectorSchema, defender: SelectorSchema }),
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
    })
    .optional(),
});

export const RuleDefSchema: z.ZodType<RuleDef> = z.strictObject({
  id: Id,
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  kind: z.literal('reaction').default('reaction'),
  enabled: z.boolean().default(true),
  visibility: z.enum(['public', 'hidden']).default('public'),
  priority: z.number().int().min(-1000).max(1000).default(0),
  trigger: TriggerSchema,
  conditions: CondSchema.optional(),
  effects: z.array(EffectSchema).min(1).max(12),
  limits: z.strictObject({ maxPerTurn: z.number().int().min(1).max(100).optional() }).optional(),
  provenance: z.strictObject({ sourceText: z.string().max(1000).optional(), proposalId: z.string().optional() }).optional(),
});
