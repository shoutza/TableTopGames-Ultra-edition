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
  /**
   * Optional damage of each successful hit after damage modifiers (index k = the attacker's
   * (k+1)-th winning spin), e.g. a shield absorbing the first two hits. Missing entries use the
   * formula's damage.
   */
  attackerHitSeq?: number[] | undefined;
  defenderHitSeq?: number[] | undefined;
}

export interface FightOdds {
  attackerChance: number;
  /** Damage per hit from the formula (before modifiers). */
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
  /** True when damage modifiers change some hits (shields, armor). */
  modified: boolean;
}

/** cumulative[k] = total damage of the first k hits (k = 0..n). */
function cumulative(n: number, base: number, seq: number[] | undefined): number[] {
  const out = [0];
  for (let k = 0; k < n; k++) out.push((out[k] as number) + Math.max(0, seq?.[k] ?? base));
  return out;
}

function hitsNeeded(hp: number, base: number, seq: number[] | undefined): number {
  if (hp <= 0) return 0;
  let total = 0;
  const known = seq?.length ?? 0;
  for (let k = 0; k < known; k++) {
    total += Math.max(0, seq?.[k] ?? base);
    if (total >= hp) return k + 1;
  }
  if (base <= 0) return Infinity;
  return known + Math.ceil((hp - total) / base);
}

/** Exact outcome distribution of one fight of up to maxSpins spins. */
export function fightOdds(input: FightInput): FightOdds {
  const p = spinChance(input.attackerPower, input.defenderPower);
  const attackerHit = damageFor(input.attackerPower, input.defenderPower, input.damage);
  const defenderHit = damageFor(input.defenderPower, input.attackerPower, input.damage);
  const n = input.maxSpins;
  const cumA = cumulative(n, attackerHit, input.attackerHitSeq);
  const cumD = cumulative(n, defenderHit, input.defenderHitSeq);
  const attackerHitsNeeded = hitsNeeded(input.defenderHp, attackerHit, input.attackerHitSeq);
  const defenderHitsNeeded = hitsNeeded(input.attackerHp, defenderHit, input.defenderHitSeq);
  const modified =
    (input.attackerHitSeq ?? []).some((d) => d !== attackerHit) || (input.defenderHitSeq ?? []).some((d) => d !== defenderHit);
  const aHp = Math.max(0, input.attackerHp);
  const dHp = Math.max(0, input.defenderHp);

  let pAttackerWins = 0;
  let pDefenderWins = 0;
  let pBothStand = 0;
  let expectedAttackerHpLoss = 0;
  let expectedDefenderHpLoss = 0;

  // frontier[w] = probability of being at (w attacker wins, spins - w defender wins) with nobody down.
  let frontier = new Map<number, number>([[0, 1]]);
  if (dHp <= 0) {
    pAttackerWins = 1;
    frontier = new Map();
  }
  for (let spin = 0; spin < n && frontier.size > 0; spin++) {
    const next = new Map<number, number>();
    for (const [w, prob] of frontier) {
      const l = spin - w;
      const pw = prob * p;
      if ((cumA[w + 1] as number) >= dHp) {
        pAttackerWins += pw;
        expectedAttackerHpLoss += pw * Math.min(aHp, cumD[l] as number);
        expectedDefenderHpLoss += pw * dHp;
      } else next.set(w + 1, (next.get(w + 1) ?? 0) + pw);
      const pl = prob * (1 - p);
      if ((cumD[l + 1] as number) >= aHp) {
        pDefenderWins += pl;
        expectedAttackerHpLoss += pl * aHp;
        expectedDefenderHpLoss += pl * Math.min(dHp, cumA[w] as number);
      } else next.set(w, (next.get(w) ?? 0) + pl);
    }
    frontier = next;
  }
  for (const [w, prob] of frontier) {
    const l = n - w;
    pBothStand += prob;
    expectedAttackerHpLoss += prob * Math.min(aHp, cumD[l] as number);
    expectedDefenderHpLoss += prob * Math.min(dHp, cumA[w] as number);
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
    modified,
  };
}

export function formatPercent(p: number): string {
  const pct = p * 100;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  if (pct < 100 && pct > 99.9) return '>99.9%';
  return `${pct.toFixed(1)}%`;
}
