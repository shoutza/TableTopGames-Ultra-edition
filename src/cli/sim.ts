import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { describeEvent, namesFor } from '../engine/index.ts';
import { loadConfig } from '../server/config.ts';
import { contestantPrice, contestantProvider, controllerConfig, scriptedProvider } from '../server/providers.ts';
import { MatchSession } from '../server/session.ts';
import { loadStarter, runHeadlessMatch, stateHash } from './headless.ts';

/**
 * npm run sim -- [--matches N] [--seed S] [--log] [--controllers heuristic|llm|mock]
 * heuristic: offline balance report over many matches.
 * llm: one match with model-driven contestants (OPENAI_API_KEY), with a cost/latency report.
 * mock: one match through the full model pipeline with a scripted offline provider.
 */

const { values } = parseArgs({
  options: {
    matches: { type: 'string', default: '1' },
    seed: { type: 'string', default: 'sim' },
    log: { type: 'boolean', default: false },
    controllers: { type: 'string', default: 'heuristic' },
  },
});

const game = loadStarter();

if (values.controllers === 'llm' || values.controllers === 'mock') {
  const config = loadConfig(process.env);
  const provider = values.controllers === 'mock' ? scriptedProvider() : contestantProvider(config);
  if (!provider) console.warn('No OPENAI_API_KEY set: contestants will use the offline controller.');
  const session = await MatchSession.create(game, { matchId: `sim-${values.seed}`, seed: values.seed }, { provider, config: controllerConfig(config), price: contestantPrice(config) });
  for (const [id, mind] of session.minds) console.log(`${session.state.entities[id]?.name}: ${mind.strategy?.archetype} — ${mind.strategy?.summary}`);
  const started = Date.now();
  await session.runToEnd();
  const names = namesFor(game, session.state);
  if (values.log) for (const e of session.history) console.log(`[r${e.round}] ${describeEvent(e, names)}`);
  const dir = path.join(config.dataDir, 'sim');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session.matchId}-ai-calls.jsonl`);
  writeFileSync(file, session.calls.map((c) => JSON.stringify(c)).join('\n') + '\n');
  const m = session.metrics();
  console.log(`\nMatch ${session.matchId}: ${session.state.endReason ?? 'not finished'} after ${m.rounds} rounds · winners ${(session.state.winners ?? []).map((w) => names.entity(w)).join(', ')}`);
  console.log(`wall clock ${((Date.now() - started) / 1000).toFixed(1)}s · model time ${(m.matchDurationMs / 1000).toFixed(1)}s`);
  console.log(`decisions ${m.decisions} ${JSON.stringify(m.bySource)} · model requests ${m.modelRequests} · fallback rate ${(m.fallbackRate * 100).toFixed(1)}% · obsolete ${m.obsolete}`);
  console.log(`tokens in ${m.usage.inputTokens} (cached ${m.usage.cachedInputTokens}) · out ${m.usage.outputTokens} (reasoning ${m.usage.reasoningTokens}) · est. cost ${m.costUsd === null ? 'unknown' : `$${m.costUsd.toFixed(4)}`}`);
  console.log(`latency p50 ${m.latencyMs.p50}ms p95 ${m.latencyMs.p95}ms · packet tokens (est.) p50 ${m.packetTokens.p50} p95 ${m.packetTokens.p95}${m.providerTripped ? ' · PROVIDER CIRCUIT BREAKER TRIPPED' : ''}`);
  console.log(`AI call log: ${file}`);
  process.exit(0);
}
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
