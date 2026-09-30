import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadStarter } from '../src/cli/headless.ts';
import { DEFAULT_CONTROLLER_CONFIG } from '../src/contestants/controller.ts';
import { loadGame } from '../src/engine/index.ts';
import { stateHash } from '../src/server/hash.ts';
import { MatchSession } from '../src/server/session.ts';
import { MatchStore, migrateSnapshot } from '../src/server/store.ts';

const starter = loadStarter();
const deps = { provider: null, config: DEFAULT_CONTROLLER_CONFIG, price: null };

async function savedMatch(store: MatchStore, steps: number) {
  const session = await MatchSession.create(starter, { matchId: 'persist', seed: 'persist' }, deps);
  session.subscribe({ onCommit: (rec, events, firings) => store.appendHistory('persist', rec, events, firings) });
  store.appendHistory('persist', session.operations[0] as never, session.history, session.firings);
  for (let i = 0; i < steps; i++) await session.step();
  store.saveSnapshot('persist', 'star-chase', starter.def, session.state, [...session.minds.values()], session.activeMs);
  return session;
}

describe('saves', () => {
  it('reloads to the identical state and continues exactly like an uninterrupted match', async () => {
    const store = new MatchStore(mkdtempSync(path.join(tmpdir(), 'ttg-')));
    const original = await savedMatch(store, 80);
    const loaded = store.load('persist');
    expect(stateHash(loaded.snapshot.state)).toBe(stateHash(original.state));
    expect(loaded.events.length).toBe(original.history.length);

    const compiled = loadGame(loaded.definition);
    if (!compiled.ok) throw new Error('definition');
    const restored = MatchSession.restore(compiled.game, loaded.snapshot.state, loaded.events, loaded.firings, loaded.snapshot.minds, deps);
    for (let i = 0; i < 60; i++) {
      await original.step();
      await restored.step();
    }
    expect(stateHash(restored.state)).toBe(stateHash(original.state));
  });

  it('ignores operations logged after the last snapshot and a torn final line', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ttg-'));
    const store = new MatchStore(dir);
    const session = await savedMatch(store, 20);
    const savedRev = session.state.rev;
    // Simulate a crash: more operations logged, no snapshot, then a partial line.
    for (let i = 0; i < 10; i++) await session.step();
    appendFileSync(path.join(dir, 'matches/persist/history.jsonl'), '{"rev": 99999, "kind": "auto", "ev');
    const loaded = store.load('persist');
    expect(loaded.snapshot.state.rev).toBe(savedRev);
    expect(Math.max(...loaded.events.map((e) => e.rev))).toBeLessThanOrEqual(savedRev);
  });

  it('refuses saves from a newer format', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ttg-'));
    const store = new MatchStore(dir);
    store.saveSnapshot('newer', 'star-chase', starter.def, {} as never, [], 0);
    const file = path.join(dir, 'matches/newer/snapshot.json');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...raw, saveFormatVersion: 999 }));
    expect(() => store.load('newer')).toThrow(/newer than this app supports/);
  });

  it('never writes API keys into saves', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ttg-'));
    const store = new MatchStore(dir);
    await savedMatch(store, 5);
    const text = readFileSync(path.join(dir, 'matches/persist/snapshot.json'), 'utf8') + readFileSync(path.join(dir, 'matches/persist/history.jsonl'), 'utf8');
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(text).not.toMatch(/OPENAI_API_KEY/);
  });
});

describe('save migrations', () => {
  it('loads a format-1 save (first playable version), migrates it and plays on to the end', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ttg-'));
    mkdirSync(path.join(dir, 'matches/v1fixture'), { recursive: true });
    copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/save-v1/snapshot.json'), path.join(dir, 'matches/v1fixture/snapshot.json'));
    const loaded = new MatchStore(dir).load('v1fixture');
    expect(loaded.snapshot.saveFormatVersion).toBe(2);
    const attack = loaded.snapshot.state.pendingDecision?.options.find((o) => o.kind === 'attack');
    expect(attack && attack.kind === 'attack' ? attack.target : null).toBe('e6');
    expect(Object.values(loaded.snapshot.state.ruleCounters).every((c) => typeof c.turnCount === 'number')).toBe(true);
    const compiled = loadGame(loaded.definition);
    if (!compiled.ok) throw new Error(compiled.errors.join('; '));
    const session = MatchSession.restore(compiled.game, loaded.snapshot.state, loaded.events, loaded.firings, loaded.snapshot.minds, deps);
    await session.runToEnd();
    expect(session.over).toBe(true);
    expect(session.state.winners?.length).toBeGreaterThan(0);
  });

  it('migrates buy options by adding the price from the saved definition', () => {
    const raw = {
      saveFormatVersion: 1,
      definition: { shops: [{ entries: [{ id: 'entry.x', price: { amount: 7 } }] }] },
      state: { ruleCounters: {}, pendingDecision: { options: [{ id: 'buy:e9:entry.x', kind: 'buy', label: 'Buy', fixture: 'e9', entry: 'entry.x' }] } },
    };
    const migrated = migrateSnapshot(raw) as { state: { pendingDecision: { options: Array<{ price: number }> } } };
    expect(migrated.state.pendingDecision.options[0]?.price).toBe(7);
  });
});
