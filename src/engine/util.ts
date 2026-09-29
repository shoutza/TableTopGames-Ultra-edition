/** Deep copy for plain JSON data (objects, arrays, primitives). Key order is preserved. */
export function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item: unknown) => cloneJson(item)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = cloneJson(item);
  return out as T;
}

export function assertNever(value: never, message = 'unexpected value'): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

/** A rule or effect could not run (missing reference, missing value, invalid target). Rolled back per firing. */
export class RuleFault extends Error {
  override readonly name = 'RuleFault';
}

/** Evaluation needs information that is not available (previews over a contestant's view). */
export class UnknownValue extends Error {
  override readonly name = 'UnknownValue';
}

/** An operation exceeded its work budget. The whole operation is rolled back. */
export class BudgetExceeded extends Error {
  override readonly name = 'BudgetExceeded';
  readonly budget: string;
  constructor(budget: string, message: string) {
    super(message);
    this.budget = budget;
  }
}

/** Input to an operation was not acceptable (stale decision, illegal option). Nothing changes. */
export class InvalidInput extends Error {
  override readonly name = 'InvalidInput';
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Integer division with an explicit rounding mode. */
export function divide(a: number, b: number, rounding: 'floor' | 'ceil' | 'halfUp' | 'towardZero'): number {
  if (b === 0) throw new RuleFault('division by zero');
  const q = a / b;
  switch (rounding) {
    case 'floor':
      return Math.floor(q);
    case 'ceil':
      return Math.ceil(q);
    case 'halfUp':
      return Math.floor(q + 0.5);
    case 'towardZero':
      return Math.trunc(q);
  }
}
