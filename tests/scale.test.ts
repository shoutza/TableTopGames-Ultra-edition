import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadStarter, runHeadlessMatch } from '../src/cli/headless.ts';
import { scaleScenario } from '../src/cli/make-scale.ts';
import { buildDecisionPacket, PACKET_BUDGET, relevantRules } from '../src/contestants/packet.ts';

/** M8: the scale scenario (8 contestants, 200 spaces, 100+ rules, 300+ turns) plays cleanly. */

describe('Grand Archipelago (scale scenario)', () => {
  it('is what the generator makes, at the agreed size', () => {
    const stored = JSON.parse(readFileSync(new URL('../content/starter/grand-archipelago.json', import.meta.url), 'utf8'));
    expect(scaleScenario()).toEqual(stored);
    const game = loadStarter({ scenario: 'grand-archipelago' });
    expect(game.def.cast).toHaveLength(8);
    expect(game.def.spaces).toHaveLength(200);
    expect(game.def.rules.length).toBeGreaterThanOrEqual(100);
    expect(game.def.settings.victory.roundLimit * game.def.cast.length).toBeGreaterThanOrEqual(300);
  });

  it('plays 15 full rounds with eight contestants without faults', () => {
    const game = loadStarter({ scenario: 'grand-archipelago', rounds: 15 });
    const r = runHeadlessMatch(game, 'scale-test');
    expect(r.aborted).toBeNull();
    expect(r.faults).toBe(0);
    expect(r.state.round).toBe(15);
    expect(r.events.filter((e) => e.type === 'turnStarted').length).toBeGreaterThan(100);
    // Contestants spread over the islands (by bridges and ferries).
    const visited = new Set(r.events.flatMap((e) => (e.type === 'landed' ? [e.space.split('.')[1]] : [])));
    expect(visited.size).toBeGreaterThanOrEqual(5);
  }, 60_000);
});

describe('packet budget', () => {
  const sizes = (scenario: string, rounds: number, seed: string) => {
    const game = loadStarter({ scenario, rounds });
    const out: number[] = [];
    runHeadlessMatch(game, seed, { onDecision: ({ view, info, mind, persona }) => out.push(buildDecisionPacket(info, view, mind, persona).estimatedTokens) });
    return out.sort((a, b) => a - b);
  };
  const p95 = (list: number[]) => list[Math.floor(list.length * 0.95)] ?? 0;

  it('keeps decision packets within 2,500 tokens at p95, on the starter and at scale', () => {
    const starter = sizes('star-chase', 20, 'budget');
    const scale = sizes('grand-archipelago', 12, 'budget');
    expect(starter.length).toBeGreaterThan(100);
    expect(scale.length).toBeGreaterThan(100);
    expect(p95(starter)).toBeLessThanOrEqual(PACKET_BUDGET);
    expect(p95(scale)).toBeLessThanOrEqual(PACKET_BUDGET);
  }, 60_000);

  it('a large rulebook keeps general rules in the instructions and lists the space rules that matter', () => {
    const game = loadStarter({ scenario: 'grand-archipelago', rounds: 3 });
    let checked = 0;
    runHeadlessMatch(game, 'relevance', {
      onDecision: ({ view, info, mind, persona }) => {
        if (checked > 0 || view.decision?.kind !== 'move') return;
        checked++;
        const packet = buildDecisionPacket(info, view, mind, persona);
        expect(packet.instructions).toContain('rules of particular spaces are listed with each decision');
        expect(packet.instructions).not.toContain('Sky Toll');
        const rules = relevantRules(info, view, 10);
        expect(rules.length).toBeGreaterThan(0);
        // Every listed rule belongs to the viewer's space or a space it can move to.
        const spaces = new Set([view.entities.find((e) => e.isSelf)?.spaceId, ...view.decision.previews.flatMap((p) => (p.kind === 'move' ? [p.space] : []))]);
        const tags = new Set(info.spaces.filter((s) => spaces.has(s.id)).flatMap((s) => s.tags));
        for (const r of rules) expect(r.refs.spaces.some((s) => spaces.has(s)) || r.refs.spaceTags.some((t) => tags.has(t)) || r.refs.statuses.length + r.refs.items.length + r.refs.entityTags.length > 0).toBe(true);
        expect(packet.input).toContain('RULES OF THE SPACES HERE AND AHEAD');
      },
    });
    expect(checked).toBe(1);
  }, 30_000);

  it('the starter keeps every public rule in its instructions', () => {
    const game = loadStarter();
    runHeadlessMatch(game, 'starter-rules', {
      maxOperations: 40,
      onDecision: ({ view, info, mind, persona }) => {
        const packet = buildDecisionPacket(info, view, mind, persona);
        for (const r of info.rules) expect(packet.instructions).toContain(`- ${r.name}: `);
      },
    });
  });
});
