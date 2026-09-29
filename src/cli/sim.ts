import { parseArgs } from 'node:util';
import { describeEvent, namesFor } from '../engine/index.ts';
import { loadStarter, runHeadlessMatch, stateHash } from './headless.ts';

/**
 * npm run sim -- [--matches N] [--seed S] [--log]
 * Runs headless matches with the offline heuristic player and prints a balance report.
 */

const { values } = parseArgs({
  options: {
    matches: { type: 'string', default: '1' },
    seed: { type: 'string', default: 'sim' },
    log: { type: 'boolean', default: false },
  },
});

const game = loadStarter();
const n = Math.max(1, Number(values.matches));
const core = game.def.settings.core;
const victory = game.def.settings.victory.resource;

interface Totals {
  rounds: number;
  byThreshold: number;
  fights: number;
  demonFights: number;
  demonKills: number;
  slimeKills: number;
  kos: number;
  starsBought: number;
  gearBought: number;
  finalPower: number[];
  decisions: number;
  forced: number;
  turns: number;
  faults: number;
  aborted: number;
  winsByArchetype: Record<string, number>;
  ms: number;
}

const t: Totals = {
  rounds: 0,
  byThreshold: 0,
  fights: 0,
  demonFights: 0,
  demonKills: 0,
  slimeKills: 0,
  kos: 0,
  starsBought: 0,
  gearBought: 0,
  finalPower: [],
  decisions: 0,
  forced: 0,
  turns: 0,
  faults: 0,
  aborted: 0,
  winsByArchetype: {},
  ms: 0,
};

for (let i = 0; i < n; i++) {
  const seed = n === 1 ? values.seed : `${values.seed}-${i}`;
  const started = performance.now();
  const r = runHeadlessMatch(game, seed);
  t.ms += performance.now() - started;
  const s = r.state;
  const isDemon = (id: string) => s.entities[id]?.defId === 'enemy.demon';
  t.rounds += s.round;
  if (s.endReason?.startsWith('reached')) t.byThreshold++;
  for (const e of r.events) {
    if (e.type === 'fightStarted') {
      t.fights++;
      if (isDemon(e.attacker) || isDemon(e.defender)) t.demonFights++;
    }
    if (e.type === 'defeated' && isDemon(e.entity)) t.demonKills++;
    if (e.type === 'defeated' && s.entities[e.entity]?.defId === 'enemy.slime') t.slimeKills++;
    if (e.type === 'knockedOut') t.kos++;
    if (e.type === 'purchased') {
      if (e.entry === 'entry.star') t.starsBought++;
      else t.gearBought++;
    }
    if (e.type === 'turnStarted') t.turns++;
  }
  for (const id of s.turnOrder) {
    const e = s.entities[id];
    if (!e) continue;
    let p = e.resources[core.power] ?? 0;
    for (const item of e.items) for (const m of game.items.get(s.items[item]?.defId ?? '')?.modifiers ?? []) if (m.resource === core.power) p += m.add;
    t.finalPower.push(p);
  }
  for (const w of s.winners ?? []) {
    const a = r.archetypes.get(w) ?? '?';
    t.winsByArchetype[a] = (t.winsByArchetype[a] ?? 0) + 1;
  }
  t.decisions += r.decisions;
  t.forced += r.forcedDecisions;
  t.faults += r.faults;
  if (r.aborted) t.aborted++;
  if (n === 1) {
    const names = namesFor(game, s);
    if (values.log) for (const e of r.events) console.log(`[r${e.round}] ${describeEvent(e, names)}`);
    console.log(`\nSeed ${seed} · ${s.round} rounds · ${s.endReason} · state ${stateHash(s)}`);
    for (const id of s.turnOrder) {
      const e = s.entities[id];
      if (!e) continue;
      const archetype = r.archetypes.get(id);
      console.log(
        `  ${s.winners?.includes(id) ? '🏆' : '  '} ${e.name.padEnd(22)} ${String(archetype).padEnd(12)} stars ${e.resources[victory]}  gold ${e.resources[core.gold]}  power ${e.resources[core.power]}+gear  items ${e.items.map((it) => game.items.get(s.items[it]?.defId ?? '')?.name).join(', ') || '-'}`,
      );
    }
  }
}

const avg = (x: number) => (x / n).toFixed(2);
const sorted = [...t.finalPower].sort((a, b) => a - b);
console.log(`\n=== ${n} match${n === 1 ? '' : 'es'} ===`);
console.log(`rounds/match ${avg(t.rounds)} · ended by threshold ${((t.byThreshold / n) * 100).toFixed(0)}% · ${avg(t.ms)} ms/match`);
console.log(`fights/match ${avg(t.fights)} · demon fights ${avg(t.demonFights)} · demon kills ${avg(t.demonKills)} · slime kills ${avg(t.slimeKills)} · KOs ${avg(t.kos)}`);
console.log(`stars bought ${avg(t.starsBought)} · gear bought ${avg(t.gearBought)}`);
console.log(`final effective power: median ${sorted[Math.floor(sorted.length / 2)]} · p90 ${sorted[Math.floor(sorted.length * 0.9)]} · max ${sorted[sorted.length - 1]}`);
console.log(`decisions ${t.decisions} · forced ${t.forced} · real decisions per turn ${((t.decisions - t.forced) / Math.max(1, t.turns)).toFixed(2)}`);
console.log(`rule faults ${t.faults} · aborted operations ${t.aborted}`);
console.log(`wins by archetype ${JSON.stringify(t.winsByArchetype)}`);
