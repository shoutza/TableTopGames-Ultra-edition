import { describe, expect, it } from 'vitest';
import { loadStarter } from '../src/cli/headless.ts';
import { fuzzMatch } from '../src/cli/fuzz.ts';
import { cloneJson, loadGame } from '../src/engine/index.ts';

/**
 * Random decisions (including random trade terms) mixed with random GM commands must keep every
 * state invariant, never throw, and replay deterministically. `npm run fuzz` runs long sweeps.
 */
describe('fuzzing', () => {
  const starter = loadStarter();

  it('random play with GM interventions keeps the invariants and replays exactly', () => {
    let operations = 0;
    for (let i = 0; i < 12; i++) {
      const r = fuzzMatch(starter, `test-${i}`, { gmRate: 0.2, maxOperations: 600 });
      expect(r.problems).toEqual([]);
      operations += r.operations;
    }
    // Random GM edits can end a match early (e.g. by handing out Stars); most run long.
    expect(operations).toBeGreaterThan(3000);
  });

  it('also in elimination mode', () => {
    const def = cloneJson(starter.def);
    def.settings.ko.mode = 'eliminate';
    const loaded = loadGame(def);
    if (!loaded.ok) throw new Error(loaded.errors.join('; '));
    for (let i = 0; i < 6; i++) expect(fuzzMatch(loaded.game, `elim-${i}`, { gmRate: 0.25, maxOperations: 600 }).problems).toEqual([]);
  });
});
