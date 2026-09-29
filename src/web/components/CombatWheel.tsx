import { useEffect, useState } from 'react';
import type { EventDto } from '../../shared/api.ts';

/**
 * Replays recorded combat. The engine already decided every spin; this component only animates
 * the recorded rolls so the wheel lands exactly where the engine's draw did.
 */

export interface FightAnimation {
  fight: number;
  /** Sequence number of the fightStarted event (log lines after it wait for the animation). */
  startSeq: number;
  attackerName: string;
  defenderName: string;
  attackerColor: string;
  defenderColor: string;
  attacker: string;
  attackerPower: number;
  defenderPower: number;
  attackerHp: number;
  defenderHp: number;
  attackerDamage: number;
  defenderDamage: number;
  maxSpins: number;
  spins: Array<{ index: number; total: number; roll: number; winner: string; damage: number; loserHpAfter: number }>;
  outcome: 'attackerWon' | 'defenderWon' | 'bothStanding' | null;
}

/** Groups freshly arrived events into fight animations. */
export function fightsFrom(events: EventDto[], nameOf: (id: string) => string, colorOf: (id: string) => string): FightAnimation[] {
  const fights = new Map<number, FightAnimation>();
  for (const e of events) {
    if (e.type === 'fightStarted') {
      fights.set(e.fight, {
        fight: e.fight,
        startSeq: e.seq,
        attacker: e.attacker,
        attackerName: nameOf(e.attacker),
        defenderName: nameOf(e.defender),
        attackerColor: colorOf(e.attacker),
        defenderColor: colorOf(e.defender),
        attackerPower: e.attackerPower,
        defenderPower: e.defenderPower,
        attackerHp: e.attackerHp,
        defenderHp: e.defenderHp,
        attackerDamage: e.attackerDamage,
        defenderDamage: e.defenderDamage,
        maxSpins: e.maxSpins,
        spins: [],
        outcome: null,
      });
    } else if (e.type === 'spin') {
      fights.get(e.fight)?.spins.push({ index: e.index, total: e.total, roll: e.roll, winner: e.winner, damage: e.damage, loserHpAfter: e.loserHpAfter });
    } else if (e.type === 'fightEnded') {
      const f = fights.get(e.fight);
      if (f) f.outcome = e.outcome;
    }
  }
  return [...fights.values()];
}

function point(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}

function arc(cx: number, cy: number, r: number, start: number, end: number): string {
  const [x1, y1] = point(cx, cy, r, start);
  const [x2, y2] = point(cx, cy, r, end);
  const large = end - start > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
}

interface Props {
  fight: FightAnimation;
  spinMs: number;
  onDone: () => void;
}

export function CombatWheel({ fight, spinMs, onDone }: Props) {
  const [shown, setShown] = useState(0); // number of spins revealed
  const [rotation, setRotation] = useState(0);
  const total = fight.attackerPower + fight.defenderPower;
  const shareDeg = (fight.attackerPower / total) * 360;

  useEffect(() => {
    setShown(0);
    setRotation(0);
  }, [fight.fight]);

  useEffect(() => {
    if (shown >= fight.spins.length) {
      const t = setTimeout(onDone, Math.max(600, spinMs * 1.6));
      return () => clearTimeout(t);
    }
    const spin = fight.spins[shown];
    if (!spin) return;
    const landing = ((spin.roll + 0.5) / spin.total) * 360;
    const start = setTimeout(() => setRotation(-((shown + 1) * 3 * 360 + landing)), 30);
    const reveal = setTimeout(() => setShown((n) => n + 1), Math.max(120, spinMs));
    return () => {
      clearTimeout(start);
      clearTimeout(reveal);
    };
  }, [shown, fight, spinMs, onDone]);

  let aHp = fight.attackerHp;
  let dHp = fight.defenderHp;
  for (const s of fight.spins.slice(0, shown)) {
    if (s.winner === fight.attacker) dHp = s.loserHpAfter;
    else aHp = s.loserHpAfter;
  }
  const last = shown > 0 ? fight.spins[shown - 1] : undefined;
  const done = shown >= fight.spins.length;
  const pct = (fight.attackerPower / total) * 100;

  return (
    <div className="wheel-card" role="dialog" aria-label="Combat">
      <div className="wheel-title">
        ⚔ <span style={{ color: fight.attackerColor }}>{fight.attackerName}</span> vs <span style={{ color: fight.defenderColor }}>{fight.defenderName}</span>
      </div>
      <div className="wheel-body">
        <svg viewBox="0 0 200 200" className="wheel">
          <g style={{ transform: `rotate(${rotation}deg)`, transformOrigin: '100px 100px', transition: `transform ${Math.max(100, spinMs - 80)}ms cubic-bezier(0.15, 0.7, 0.2, 1)` }}>
            <path d={arc(100, 100, 90, 0, Math.max(0.5, shareDeg))} fill={fight.attackerColor} />
            <path d={arc(100, 100, 90, shareDeg, 359.99)} fill={fight.defenderColor} />
          </g>
          <circle cx={100} cy={100} r={16} className="wheel-hub" />
          <polygon points="100,4 92,-10 108,-10" className="wheel-pointer" transform="translate(0 14)" />
        </svg>
        <div className="wheel-stats">
          <div>
            <b style={{ color: fight.attackerColor }}>{fight.attackerName}</b> · {fight.attackerPower} Power · {pct.toFixed(1)}% · hits {fight.attackerDamage}
            <Hp value={aHp} max={fight.attackerHp} />
          </div>
          <div>
            <b style={{ color: fight.defenderColor }}>{fight.defenderName}</b> · {fight.defenderPower} Power · {(100 - pct).toFixed(1)}% · hits {fight.defenderDamage}
            <Hp value={dHp} max={fight.defenderHp} />
          </div>
          <div className="wheel-result">
            {last
              ? `Spin ${last.index}/${fight.maxSpins}: ${last.winner === fight.attacker ? fight.attackerName : fight.defenderName} wins (roll ${last.roll + 1} of ${last.total}) — ${last.damage} damage`
              : 'Spinning…'}
          </div>
          {done && (
            <div className="wheel-outcome">
              {fight.outcome === 'bothStanding' ? 'Both fighters still standing.' : `${fight.outcome === 'attackerWon' ? fight.attackerName : fight.defenderName} wins the fight!`}
            </div>
          )}
        </div>
      </div>
      <button className="link" onClick={onDone}>
        Skip
      </button>
    </div>
  );
}

function Hp({ value, max }: { value: number; max: number }) {
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <div className="hp-line">
      <div className="hp-track">
        <div className="hp-fill" style={{ width: `${frac * 100}%` }} />
      </div>
      <span>
        {value} HP
      </span>
    </div>
  );
}
