import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTROLLER_CONFIG } from '../src/contestants/controller.ts';
import { MatchSession } from '../src/server/session.ts';
import { miniGame } from './helpers/mini.ts';

/** The GM steps through a match: next phase, next turn, next round, or keep going. */

async function session(seed: string): Promise<MatchSession> {
  const s = await MatchSession.create(miniGame(), { matchId: `turns-${seed}`, seed }, { provider: null, config: DEFAULT_CONTROLLER_CONFIG, price: null });
  s.stepDelayMs = 0;
  return s;
}

async function play(s: MatchSession, until: 'phase' | 'turn' | 'round'): Promise<void> {
  s.start(until);
  await s.idle();
  expect(s.paused).toBe(true);
  expect(s.running).toBe(false);
}

describe('stepping through a match', () => {
  it('next phase stops as soon as the phase changes', async () => {
    const s = await session('phase');
    expect(s.state.phase).toBe('roundStart');
    const seen: string[] = [];
    for (let i = 0; i < 7; i++) {
      await play(s, 'phase');
      seen.push(s.state.phase);
    }
    expect(seen).toEqual(['turnStart', 'roll', 'move', 'main', 'turnEnd', 'turnStart', 'roll']);
    expect(s.state.turn.index).toBe(1);
  });

  it('next turn stops when the next contestant is about to start', async () => {
    const s = await session('turn');
    // Before the round starts, the first contestant's turn is the one played.
    await play(s, 'turn');
    expect(s.state).toMatchObject({ round: 1, phase: 'turnStart', turn: { index: 1 } });
    expect(s.history.some((e) => e.type === 'turnStarted' && e.entity === s.state.turnOrder[0])).toBe(true);
    await play(s, 'turn');
    // After the last contestant, the round ends and the next one starts with the first contestant.
    expect(s.state).toMatchObject({ round: 2, phase: 'turnStart', turn: { index: 0 } });
  });

  it('next round plays the rest of the round and stops before the next', async () => {
    const s = await session('round');
    await play(s, 'round');
    expect(s.state).toMatchObject({ round: 1, phase: 'roundStart' });
    await play(s, 'round');
    expect(s.state).toMatchObject({ round: 2, phase: 'roundStart' });
  });

  it('auto keeps going until paused', async () => {
    const s = await session('auto');
    s.start();
    await new Promise((r) => setTimeout(r, 30));
    s.pause();
    await s.idle();
    expect(s.state.round).toBeGreaterThanOrEqual(1);
    expect(s.until).toBeNull();
  });
});
