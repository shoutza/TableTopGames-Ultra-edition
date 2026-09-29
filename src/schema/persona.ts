import { z } from 'zod';

/** Stable personality: voice, numeric tendencies and concrete behavior rules. */
export const TRAIT_NAMES = ['risk', 'aggression', 'greed', 'loyalty', 'vindictiveness', 'sociability'] as const;
export type TraitName = (typeof TRAIT_NAMES)[number];

const Trait = z.number().int().min(0).max(10);

export const PersonaSchema = z.strictObject({
  voice: z.string().min(1).max(200),
  traits: z.strictObject({
    risk: Trait,
    aggression: Trait,
    greed: Trait,
    loyalty: Trait,
    vindictiveness: Trait,
    sociability: Trait,
  }),
  behaviors: z.array(z.string().min(1).max(160)).max(4),
});
export type Persona = z.infer<typeof PersonaSchema>;

/** Strategy archetypes the engine can offer when the scenario supports them. */
export const ARCHETYPES = ['banker', 'gearUp', 'powerFarmer', 'starChaser', 'opportunist'] as const;
export type Archetype = (typeof ARCHETYPES)[number];

export const StrategySchema = z.strictObject({
  archetype: z.enum(ARCHETYPES),
  summary: z.string().min(1).max(600),
  priorities: z.array(z.string().min(1).max(120)).min(1).max(4),
  avoid: z.array(z.string().min(1).max(120)).max(3),
  adoptedAtRound: z.number().int().min(0),
  reason: z.string().max(300),
});
export type Strategy = z.infer<typeof StrategySchema>;
