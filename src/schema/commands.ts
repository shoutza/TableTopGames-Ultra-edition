import { z } from 'zod';

/** GM interventions. Validated at the server boundary; applied by the engine as operations. */
const Id = z.string().min(1).max(80);
const Silent = z.boolean().default(false);

export const GmCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('adjustResource'), entity: Id, resource: Id, delta: z.number().int(), silent: Silent }),
  z.strictObject({ type: z.literal('setResource'), entity: Id, resource: Id, value: z.number().int(), silent: Silent }),
  z.strictObject({ type: z.literal('addTag'), entity: Id, tag: Id, silent: Silent }),
  z.strictObject({ type: z.literal('removeTag'), entity: Id, tag: Id, silent: Silent }),
  z.strictObject({ type: z.literal('teleport'), entity: Id, space: Id, asLanding: z.boolean(), silent: Silent }),
  z.strictObject({ type: z.literal('grantItem'), entity: Id, item: Id, silent: Silent }),
  z.strictObject({ type: z.literal('removeItem'), entity: Id, item: Id, silent: Silent }),
  /** Also used for transformation templates ("turn into a fish"). */
  z.strictObject({ type: z.literal('applyStatus'), entity: Id, status: Id, stacks: z.number().int().min(1).max(10).default(1), silent: Silent }),
  z.strictObject({ type: z.literal('removeStatus'), entity: Id, status: Id, silent: Silent }),
  z.strictObject({ type: z.literal('spawnEnemy'), enemy: Id, space: Id, silent: Silent }),
  /** Takes an enemy or fixture off the board for good (it stays in history as a tombstone). */
  z.strictObject({ type: z.literal('removeEntity'), entity: Id, silent: Silent }),
  z.strictObject({ type: z.literal('drawCard'), entity: Id, deck: Id, silent: Silent }),
  /** Deals an extra secret objective to a contestant. */
  z.strictObject({ type: z.literal('assignObjective'), entity: Id, objective: Id, silent: Silent }),
  z.strictObject({ type: z.literal('announce'), text: z.string().min(1).max(280) }),
]);
export type GmCommand = z.infer<typeof GmCommandSchema>;
export type GmCommandInput = z.input<typeof GmCommandSchema>;
