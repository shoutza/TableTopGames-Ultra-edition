/**
 * Seeded sfc32 generator. Its four-word state lives inside GameState, so transactions,
 * saves and replays restore it exactly.
 */
export type RngState = [number, number, number, number];

/** cyrb128 string hash → four 32-bit words. */
function hashSeed(seed: string): RngState {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export function seedRng(seed: string): RngState {
  const state = hashSeed(seed);
  for (let i = 0; i < 15; i++) nextU32(state);
  return state;
}

/** Advances the state in place and returns an unsigned 32-bit integer. */
export function nextU32(s: RngState): number {
  let a = s[0];
  let b = s[1];
  let c = s[2];
  let d = s[3];
  let t = (a + b) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  d = (d + 1) | 0;
  t = (t + d) | 0;
  c = (c + t) | 0;
  s[0] = a >>> 0;
  s[1] = b >>> 0;
  s[2] = c >>> 0;
  s[3] = d >>> 0;
  return t >>> 0;
}

const TWO_32 = 4294967296;

/** Unbiased integer in [0, n). n must be in [1, 2^32]. */
export function randomBelow(s: RngState, n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > TWO_32) throw new Error(`randomBelow: bad bound ${n}`);
  const limit = TWO_32 - (TWO_32 % n);
  for (;;) {
    const x = nextU32(s);
    if (x < limit) return x % n;
  }
}
