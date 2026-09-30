import { z } from 'zod';
import type { TradeOfferInput } from '../schema/trade.ts';
import { ARCHETYPES } from '../schema/persona.ts';

/**
 * Fixed response schemas. The same schema is used for every decision (option ids are checked in
 * code), so providers compile it once. JSON Schemas follow strict structured-output rules: every
 * property required, optional values expressed as null, no additionalProperties.
 */

export const DECISION_SCHEMA_NAME = 'contestant_decision';

const GoodsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['resources', 'items'],
  properties: {
    resources: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['resource', 'amount'], properties: { resource: { type: 'string' }, amount: { type: 'integer' } } },
    },
    items: { type: 'array', items: { type: 'string' }, description: 'Item ids, one entry per item.' },
  },
};

const TradeJsonSchema = {
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      additionalProperties: false,
      required: ['with', 'give', 'get', 'promises', 'message'],
      properties: {
        with: { type: ['string', 'null'], description: 'Partner id (proposals only).' },
        give: { ...GoodsJsonSchema, description: 'What you hand over.' },
        get: { ...GoodsJsonSchema, description: 'What you receive.' },
        promises: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['by', 'kind', 'rounds', 'resource', 'amount'],
            properties: {
              by: { type: 'string', enum: ['me', 'them'] },
              kind: { type: 'string', enum: ['noAttack', 'pay'] },
              rounds: { type: 'integer' },
              resource: { type: ['string', 'null'] },
              amount: { type: ['integer', 'null'] },
            },
          },
        },
        message: { type: ['string', 'null'], description: 'A short note to your partner (max 200 characters).' },
      },
    },
  ],
};

export const DecisionJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['decisionId', 'optionId', 'say', 'plan', 'strategyUpdate', 'trade', 'attempt', 'reason'],
  properties: {
    decisionId: { type: 'string', description: 'The decision id you are answering.' },
    optionId: { type: 'string', description: 'Exactly one option id from the list.' },
    say: { type: ['string', 'null'], description: 'Optional in-character line (max 160 characters), spoken before the outcome is known.' },
    plan: { type: ['string', 'null'], description: 'Your updated short plan (max 200 characters), or null to keep it.' },
    strategyUpdate: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['archetype', 'summary', 'priorities', 'reason'],
          properties: {
            archetype: { type: 'string', enum: [...ARCHETYPES] },
            summary: { type: 'string', description: '40-100 words: how you will win this match.' },
            priorities: { type: 'array', items: { type: 'string' }, description: '1-4 measurable priorities.' },
            reason: { type: 'string' },
          },
        },
      ],
    },
    trade: TradeJsonSchema,
    attempt: { type: ['string', 'null'], description: 'For the "freeform" option only: what you attempt (max 200 characters).' },
    reason: { type: 'string', description: 'One short sentence explaining the choice (max 25 words).' },
  },
};

const clip = (max: number) => z.string().transform((s) => (s.length > max ? `${s.slice(0, max - 1)}…` : s));

const GoodsSchema = z.object({
  resources: z.array(z.object({ resource: z.string(), amount: z.number().int() })).max(6),
  items: z.array(z.string()).max(6),
});

/** The model's trade terms, turned into the engine's input shape (from the answering side). */
export const TradeResponseSchema = z
  .object({
    with: z.string().nullable(),
    give: GoodsSchema,
    get: GoodsSchema,
    promises: z
      .array(
        z.object({
          by: z.enum(['me', 'them']),
          kind: z.enum(['noAttack', 'pay']),
          rounds: z.number().int(),
          resource: z.string().nullable(),
          amount: z.number().int().nullable(),
        }),
      )
      .max(2),
    message: z.string().nullable(),
  })
  .transform((t): TradeOfferInput => {
    const goods = (g: z.infer<typeof GoodsSchema>) => {
      const resources: Record<string, number> = {};
      for (const r of g.resources) resources[r.resource] = (resources[r.resource] ?? 0) + r.amount;
      return { resources, items: g.items };
    };
    return {
      ...(t.with !== null ? { with: t.with } : {}),
      give: goods(t.give),
      get: goods(t.get),
      promises: t.promises.map((p) => (p.kind === 'noAttack' ? { by: p.by, kind: 'noAttack', rounds: p.rounds } : { by: p.by, kind: 'pay', rounds: p.rounds, resource: p.resource ?? '', amount: p.amount ?? 0 })),
      message: t.message,
    };
  });

export const DecisionResponseSchema = z.object({
  decisionId: z.string(),
  optionId: z.string(),
  say: clip(160).nullable(),
  plan: clip(200).nullable(),
  strategyUpdate: z
    .object({
      archetype: z.enum(ARCHETYPES),
      summary: clip(600),
      priorities: z.array(clip(120)).min(1).max(4),
      reason: clip(300),
    })
    .nullable(),
  /** Older scripted answers may omit it. */
  trade: TradeResponseSchema.nullable().default(null),
  attempt: clip(200).nullable().default(null),
  reason: clip(200),
});
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

export const STRATEGY_SCHEMA_NAME = 'match_strategy';

export const StrategyJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['archetype', 'summary', 'priorities', 'avoid', 'plan', 'reason'],
  properties: {
    archetype: { type: 'string', enum: [...ARCHETYPES], description: 'One of the offered archetypes.' },
    summary: { type: 'string', description: '40-100 words: your approach to winning this match with its actual mechanics.' },
    priorities: { type: 'array', items: { type: 'string' }, description: '1-4 measurable priorities.' },
    avoid: { type: 'array', items: { type: 'string' }, description: '0-3 things to avoid.' },
    plan: { type: 'string', description: 'Your immediate plan for the next few turns (max 200 characters).' },
    reason: { type: 'string', description: 'Why this strategy fits you and this match.' },
  },
};

export const StrategyResponseSchema = z.object({
  archetype: z.enum(ARCHETYPES),
  summary: clip(600),
  priorities: z.array(clip(120)).min(1).max(4),
  avoid: z.array(clip(120)).max(3),
  plan: clip(200),
  reason: clip(300),
});
export type StrategyResponse = z.infer<typeof StrategyResponseSchema>;

/** Parses model text into a validated object, or returns a view-safe error message. */
export function parseStructured<T>(schema: z.ZodType<T>, text: string): { ok: true; value: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The response was not valid JSON.' };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: `The response did not match the schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'root'} ${i.message}`).join('; ')}` };
  }
  return { ok: true, value: parsed.data };
}
