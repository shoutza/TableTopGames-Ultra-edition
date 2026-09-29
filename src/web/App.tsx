import { useEffect, useState } from 'react';
import type { HealthResponse, MatchListItem } from '../shared/api.ts';
import { api } from './api.ts';
import { MatchView } from './components/MatchView.tsx';

function matchFromHash(): string | null {
  const m = /^#\/match\/([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  return m?.[1] ?? null;
}

export function App() {
  const [matchId, setMatchId] = useState<string | null>(matchFromHash());
  useEffect(() => {
    const onHash = () => setMatchId(matchFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const open = (id: string | null) => {
    window.location.hash = id ? `/match/${id}` : '';
    setMatchId(id);
  };
  return matchId ? <MatchView key={matchId} matchId={matchId} onExit={() => open(null)} /> : <MatchPicker onOpen={open} />;
}

function MatchPicker({ onOpen }: { onOpen: (id: string) => void }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [matches, setMatches] = useState<MatchListItem[]>([]);
  const [scenarios, setScenarios] = useState<Array<{ id: string; name: string; description: string }>>([]);
  const [scenario, setScenario] = useState('star-chase');
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch((err: unknown) => setError(String(err)));
    api.listMatches().then(setMatches).catch((err: unknown) => setError(String(err)));
    api.scenarios().then(setScenarios).catch((err: unknown) => setError(String(err)));
  }, []);
  const create = () => {
    setBusy(true);
    setError(null);
    api
      .createMatch(scenario, seed.trim() || undefined)
      .then((r) => onOpen(r.matchId))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  return (
    <main className="picker">
      <h1>TableTopGames Ultra Edition</h1>
      <p className="muted">
        Game Master console · engine v{health?.engineVersion ?? '…'} · contestants: {health ? `${health.contestantProvider} (${health.contestantModel})` : '…'}
      </p>
      {error && <p className="error">{error}</p>}
      <section className="card">
        <h2>New match</h2>
        <label>
          Scenario{' '}
          <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Seed <input value={seed} placeholder="random" onChange={(e) => setSeed(e.target.value)} />
        </label>{' '}
        <button disabled={busy} onClick={create}>
          {busy ? 'Choosing strategies…' : 'Create match'}
        </button>
        <p className="muted">{scenarios.find((s) => s.id === scenario)?.description}</p>
      </section>
      <section className="card">
        <h2>Saved matches</h2>
        {matches.length === 0 && <p className="muted">No saved matches yet.</p>}
        <ul className="matches">
          {matches.map((m) => (
            <li key={m.matchId}>
              <button className="link" onClick={() => onOpen(m.matchId)}>
                {m.matchId}
              </button>{' '}
              <span className="muted">
                {m.scenario} · round {m.round} · {m.phase}
                {m.winners ? ' · finished' : ''} · saved {m.savedAt ? new Date(m.savedAt).toLocaleString() : '—'}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
