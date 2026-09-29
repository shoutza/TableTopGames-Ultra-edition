import { z } from 'zod';
import { ARCHETYPES } from '../schema/persona.ts';

/**
 * Fixed response schemas. The same schema is used for every decision (option ids are checked in
 * code), so providers compile it once. JSON Schemas follow strict structured-output rules: every
 * property required, optional values expressed as null, no additionalProperties.
 */

export const DECISION_SCHEMA_NAME = 'contestant_decision';

export const DecisionJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['decisionId', 'optionId', 'say', 'plan', 'strategyUpdate', 'reason'],
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
    reason: { type: 'string', description: 'One short sentence explaining the choice (max 25 words).' },
  },
};

const clip = (max: number) => z.string().transform((s) => (s.length > max ? `${s.slice(0, max - 1)}…` : s));

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
