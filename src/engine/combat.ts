/**
 * Combat math: wheel shares, damage and exact fight-outcome odds. Pure functions with no game
 * state, shared by the engine (authoritative results), previews, the fallback player and the UI.
 */

export interface DamageSettings {
  base: number;
  ratioExponent: 0 | 0.5 | 1;
  min: number;
  max: number;
}

/** Damage dealt by the winner of a spin: clamp(roundHalfUp(base × (winner/loser)^exponent), min, max). */
export function damageFor(winnerPower: number, loserPower: number, s: DamageSettings): number {
  const w = Math.max(1, winnerPower);
  const l = Math.max(1, loserPower);
  let raw: number;
  if (s.ratioExponent === 1) raw = Math.floor((2 * s.base * w + l) / (2 * l));
  else if (s.ratioExponent === 0) raw = s.base;
  else raw = Math.floor(s.base * Math.sqrt(w / l) + 0.5);
  return Math.min(s.max, Math.max(s.min, raw));
}

/** Probability (0..1) that fighter A wins a single spin. */
export function spinChance(powerA: number, powerB: number): number {
  const a = Math.max(1, powerA);
  const b = Math.max(1, powerB);
  return a / (a + b);
}

export interface FightInput {
  attackerPower: number;
  attackerHp: number;
  defenderPower: number;
  defenderHp: number;
  maxSpins: number;
  damage: DamageSettings;
}

export interface FightOdds {
  attackerChance: number;
  attackerHit: number;
  defenderHit: number;
  /** Winning spins the attacker needs to defeat the defender (Infinity if it deals no damage). */
  attackerHitsNeeded: number;
  defenderHitsNeeded: number;
  pAttackerWins: number;
  pDefenderWins: number;
  pBothStand: number;
  expectedAttackerHpLoss: number;
  expectedDefenderHpLoss: number;
}

/** Exact outcome distribution of one fight of up to maxSpins spins. */
export function fightOdds(input: FightInput): FightOdds {
  const p = spinChance(input.attackerPower, input.defenderPower);
  const attackerHit = damageFor(input.attackerPower, input.defenderPower, input.damage);
  const defenderHit = damageFor(input.defenderPower, input.attackerPower, input.damage);
  const attackerHitsNeeded = attackerHit > 0 ? Math.ceil(Math.max(0, input.defenderHp) / attackerHit) : Infinity;
  const defenderHitsNeeded = defenderHit > 0 ? Math.ceil(Math.max(0, input.attackerHp) / defenderHit) : Infinity;

  let pAttackerWins = 0;
  let pDefenderWins = 0;
  let pBothStand = 0;
  let expectedAttackerHpLoss = 0;
  let expectedDefenderHpLoss = 0;

  // frontier[w] = probability of being at (w attacker wins, spins - w defender wins) with nobody down.
  let frontier = new Map<number, number>([[0, 1]]);
  if (attackerHitsNeeded === 0) {
    pAttackerWins = 1;
    frontier = new Map();
  }
  for (let spin = 0; spin < input.maxSpins && frontier.size > 0; spin++) {
    const next = new Map<number, number>();
    for (const [w, prob] of frontier) {
      const l = spin - w;
      const winW = w + 1;
      const pw = prob * p;
      if (winW >= attackerHitsNeeded) {
        pAttackerWins += pw;
        expectedAttackerHpLoss += pw * Math.min(input.attackerHp, l * defenderHit);
        expectedDefenderHpLoss += pw * input.defenderHp;
      } else next.set(winW, (next.get(winW) ?? 0) + pw);
      const pl = prob * (1 - p);
      if (l + 1 >= defenderHitsNeeded) {
        pDefenderWins += pl;
        expectedAttackerHpLoss += pl * input.attackerHp;
        expectedDefenderHpLoss += pl * Math.min(input.defenderHp, w * attackerHit);
      } else next.set(w, (next.get(w) ?? 0) + pl);
    }
    frontier = next;
  }
  const spinsDone = input.maxSpins;
  for (const [w, prob] of frontier) {
    const l = spinsDone - w;
    pBothStand += prob;
    expectedAttackerHpLoss += prob * Math.min(input.attackerHp, l * defenderHit);
    expectedDefenderHpLoss += prob * Math.min(input.defenderHp, w * attackerHit);
  }
  return {
    attackerChance: p,
    attackerHit,
    defenderHit,
    attackerHitsNeeded,
    defenderHitsNeeded,
    pAttackerWins,
    pDefenderWins,
    pBothStand,
    expectedAttackerHpLoss,
    expectedDefenderHpLoss,
  };
}

export function formatPercent(p: number): string {
  const pct = p * 100;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  if (pct < 100 && pct > 99.9) return '>99.9%';
  return `${pct.toFixed(1)}%`;
}
