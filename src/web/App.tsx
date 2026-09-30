import { useEffect, useState } from 'react';
import type { HealthResponse, MatchListItem, ScenarioListItem } from '../shared/api.ts';
import { api } from './api.ts';
import { MatchView } from './components/MatchView.tsx';
import { EditorPage, type EditorTarget } from './editor/EditorPage.tsx';

type Route = { page: 'home' } | { page: 'match'; id: string } | { page: 'editor'; target: EditorTarget };

function routeFromHash(): Route {
  const h = window.location.hash;
  let m = /^#\/match\/([A-Za-z0-9_-]+)$/.exec(h);
  if (m?.[1]) return { page: 'match', id: m[1] };
  if (h === '#/editor/new') return { page: 'editor', target: { kind: 'scenario', id: null } };
  m = /^#\/editor\/copy\/([a-z0-9_.-]+)$/.exec(h);
  if (m?.[1]) return { page: 'editor', target: { kind: 'scenario', id: null, copyFrom: m[1] } };
  m = /^#\/editor\/([a-z0-9_.-]+)$/.exec(h);
  if (m?.[1]) return { page: 'editor', target: { kind: 'scenario', id: m[1] } };
  return { page: 'home' };
}

export function App() {
  const [route, setRoute] = useState<Route>(routeFromHash());
  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = (hash: string) => {
    window.location.hash = hash;
    setRoute(routeFromHash());
  };
  if (route.page === 'match') return <MatchView key={route.id} matchId={route.id} onExit={() => go('')} />;
  if (route.page === 'editor') {
    const t = route.target;
    return <EditorPage key={t.kind === 'scenario' ? `${t.id}:${t.copyFrom}` : 'm'} target={t} onClose={() => go('')} onPlay={(id) => go(`/match/${id}`)} />;
  }
  return <Home go={go} />;
}

function Home({ go }: { go: (hash: string) => void }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [matches, setMatches] = useState<MatchListItem[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioListItem[]>([]);
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => {
    api.listMatches().then(setMatches).catch((err: unknown) => setError(String(err)));
    api.scenarios().then(setScenarios).catch((err: unknown) => setError(String(err)));
  };
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch((err: unknown) => setError(String(err)));
    reload();
  }, []);
  const play = (scenario: string) => {
    setBusy(scenario);
    setError(null);
    api
      .createMatch(scenario, seed.trim() || undefined)
      .then((r) => go(`/match/${r.matchId}`))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null));
  };
  const remove = (s: ScenarioListItem) => {
    if (!window.confirm(`Delete the scenario “${s.name}”? Matches already played keep their own copy of the rules.`)) return;
    api
      .deleteScenario(s.id)
      .then(reload)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  return (
    <main className="picker">
      <h1>TableTopGames Ultra Edition</h1>
      <p className="muted">
        Game Master console · engine v{health?.engineVersion ?? '…'} · contestants: {health ? `${health.contestantProvider} (${health.contestantModel})` : '…'}
      </p>
      {error && <p className="error">{error}</p>}
      <section className="card">
        <div className="card-head">
          <h2>Scenarios</h2>
          <span className="grow" />
          <label>
            Seed <input value={seed} placeholder="random" onChange={(e) => setSeed(e.target.value)} />
          </label>
          <button className="primary" onClick={() => go('/editor/new')}>
            + New scenario
          </button>
        </div>
        <table className="scenario-table">
          <tbody>
            {scenarios.map((s) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.name}</strong> {s.builtIn && <span className="chip">built-in</span>}
                  {!s.valid && <span className="chip bad">has problems</span>}
                  <div className="muted small">
                    {s.id} · {s.spaces} spaces · {s.rules} rules{s.updatedAt ? ` · edited ${new Date(s.updatedAt).toLocaleString()}` : ''}
                  </div>
                  {s.description && <div className="muted small">{s.description}</div>}
                </td>
                <td className="actions">
                  <button disabled={!s.valid || busy !== null} onClick={() => play(s.id)}>
                    {busy === s.id ? 'Choosing strategies…' : '▶ Play'}
                  </button>
                  <button onClick={() => go(`/editor/${s.id}`)}>{s.builtIn ? 'View / edit a copy' : 'Edit'}</button>
                  <button onClick={() => go(`/editor/copy/${s.id}`)}>Duplicate</button>
                  {!s.builtIn && (
                    <button className="danger" onClick={() => remove(s)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h2>Saved matches</h2>
        {matches.length === 0 && <p className="muted">No saved matches yet.</p>}
        <ul className="matches">
          {matches.map((m) => (
            <li key={m.matchId}>
              <button className="link" onClick={() => go(`/match/${m.matchId}`)}>
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
