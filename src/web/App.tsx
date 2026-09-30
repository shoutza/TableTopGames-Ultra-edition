import { useEffect, useState, type FormEvent } from 'react';
import type { HealthResponse, MatchListItem } from '../shared/api.ts';
import { api } from './api.ts';
import { MatchView } from './components/MatchView.tsx';
import { Brand, EmptyState, Icon, Rail, TabletopArt } from './components/Ui.tsx';

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
    window.scrollTo({ top: 0 });
  };
  return matchId ? (
    <MatchView key={matchId} matchId={matchId} onExit={() => open(null)} />
  ) : (
    <MatchPicker onOpen={open} />
  );
}

function MatchPicker({ onOpen }: { onOpen: (id: string) => void }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [matches, setMatches] = useState<MatchListItem[]>([]);
  const [scenarios, setScenarios] = useState<Array<{ id: string; name: string; description: string }>>([]);
  const [scenario, setScenario] = useState('star-chase');
  const [seed, setSeed] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.health(), api.listMatches(), api.scenarios()])
      .then(([h, m, s]) => {
        if (cancelled) return;
        setHealth(h);
        setMatches(m.sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? '')));
        setScenarios(s);
        setScenario((current) => (s.some((item) => item.id === current) ? current : (s[0]?.id ?? '')));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  const create = (e: FormEvent) => {
    e.preventDefault();
    if (busy || loading || !scenario) return;
    setBusy(true);
    setError(null);
    api
      .createMatch(scenario, seed.trim() || undefined)
      .then((r) => onOpen(r.matchId))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  const chosen = scenarios.find((s) => s.id === scenario);
  const visible = matches.filter((m) => `${m.matchId} ${m.scenario}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="app-shell">
      <Rail
        items={[
          {
            icon: 'grid',
            label: 'Tables',
            active: true,
            onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
          },
          {
            icon: 'clock',
            label: 'History',
            active: false,
            onClick: () => document.getElementById('saved-matches')?.scrollIntoView({ behavior: 'smooth' }),
          },
        ]}
      />
      <main className="picker">
        <header className="lobby-header">
          <Brand />
          <div className={`connection-pill${health ? '' : ' offline'}`}>
            <span className="status-dot" />
            {health ? 'Your studio is ready' : loading ? 'Connecting to your studio' : 'Studio unavailable'}
          </div>
        </header>
        <div className="page-heading">
          <div>
            <p className="eyebrow">THE GAME MASTER'S STUDIO</p>
            <h1>Good games start here.</h1>
            <p className="muted">Set the stage. Cast your contestants. Let the chaos unfold.</p>
          </div>
          <span className="small-note">
            <Icon name="sparkles" size={17} /> A little strategy. A lot of possibility.
          </span>
        </div>
        {error && (
          <div className="banner error" role="alert">
            <span>{error}</span>
            <button onClick={() => setAttempt((n) => n + 1)}>Try again</button>
          </div>
        )}
        <section className="lobby-grid" aria-label="Create a match">
          <div className="hero-card">
            <div className="hero-copy">
              <span className="hero-badge">
                <Icon name="dice" size={15} /> YOUR NEXT ADVENTURE
              </span>
              <h2>
                Your table.
                <br />
                Your rules.
              </h2>
              <p>A world of clever moves, unexpected rivals, and stories only you could make.</p>
            </div>
            <TabletopArt />
            <div className="hero-footer">
              <span>
                <span className="status-dot" /> Human imagination. AI contestants.
              </span>
              <span>
                YOU'RE IN CHARGE <Icon name="arrow" size={15} />
              </span>
            </div>
          </div>
          <form className="new-match card" onSubmit={create} aria-busy={busy}>
            <div className="section-heading">
              <span className="section-icon">
                <Icon name="flag" />
              </span>
              <div>
                <p className="eyebrow">MAKE IT A GAME NIGHT</p>
                <h2>Start a new table</h2>
              </div>
            </div>
            <label className="field">
              Choose your scenario
              <select value={scenario} disabled={loading || busy} onChange={(e) => setScenario(e.target.value)}>
                {loading ? (
                  <option>Loading scenarios…</option>
                ) : (
                  scenarios.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))
                )}
              </select>
            </label>
            <div className="scenario-note">
              <span className="scenario-emblem">
                <Icon name="star" size={26} />
              </span>
              <div>
                <strong>{chosen?.name ?? 'An adventure awaits'}</strong>
                <p>{chosen?.description ?? 'Choose a scenario to bring your table to life.'}</p>
              </div>
            </div>
            <label className="field">
              Match seed <span className="optional">OPTIONAL</span>
              <input
                value={seed}
                placeholder="Leave blank for a surprise"
                disabled={busy}
                onChange={(e) => setSeed(e.target.value)}
              />
              <span className="field-hint">Use the same seed to replay the same starting setup.</span>
            </label>
            <button className="primary create-button" type="submit" disabled={busy || loading || !chosen}>
              {busy ? <span className="spinner" /> : <Icon name="play" size={18} />}
              {busy ? 'Preparing your table…' : 'Create match'}
              {!busy && <Icon name="arrow" size={18} />}
            </button>
            <div className="provider-note">
              <Icon name="check" size={15} />
              {health?.contestantProvider === 'openai'
                ? 'AI contestants connected'
                : health?.contestantProvider === 'mock'
                  ? 'Scripted contestants · no API costs'
                  : 'Offline contestants · no API key needed'}
            </div>
          </form>
        </section>
        <section id="saved-matches" className="saved-section">
          <div className="saved-heading">
            <div>
              <p className="eyebrow">PICK UP WHERE YOU LEFT OFF</p>
              <h2>
                Your tables <span className="count">{matches.length}</span>
              </h2>
            </div>
            <label className="search-field">
              <Icon name="search" size={18} />
              <input
                aria-label="Search saved matches"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a table…"
              />
            </label>
          </div>
          {loading ? (
            <div className="card loading-row">
              <span className="spinner" /> Loading your tables…
            </div>
          ) : matches.length === 0 ? (
            <div className="card">
              <EmptyState icon="dice" title="Your first story is waiting">
                Create a match above. Your saved games will have a home here.
              </EmptyState>
            </div>
          ) : visible.length === 0 ? (
            <div className="card">
              <EmptyState icon="search" title="No tables found">
                Try a different name or match ID.
              </EmptyState>
            </div>
          ) : (
            <div className="match-grid">
              {visible.map((m) => (
                <button key={m.matchId} className="saved-card" onClick={() => onOpen(m.matchId)}>
                  <span className="saved-card-top">
                    <span className="saved-emblem">
                      <Icon name="star" size={24} />
                    </span>
                    <span className={`phase-pill${m.winners ? ' complete' : ''}`}>
                      {m.winners ? 'Finished' : m.round === 0 ? 'Ready to play' : 'In progress'}
                    </span>
                  </span>
                  <strong>{scenarios.find((s) => s.id === m.scenario)?.name ?? m.scenario}</strong>
                  <span className="saved-id">{m.matchId}</span>
                  <span className="saved-card-bottom">
                    <span>
                      <Icon name="flag" size={14} /> Round {m.round}
                    </span>
                    <span>
                      Open table <Icon name="arrow" size={15} />
                    </span>
                  </span>
                  <span className="saved-time">
                    {m.savedAt
                      ? `Saved ${new Date(m.savedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                      : 'Not saved yet'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
        <footer className="lobby-footer">
          <span>Made for the stories between the turns.</span>
          <details>
            <summary>Studio details{health ? ` · v${health.engineVersion}` : ''}</summary>
            <p>
              Contestants: {health?.contestantModel ?? 'Connecting…'} · Engine {health?.engineVersion ?? '…'}
            </p>
          </details>
        </footer>
      </main>
    </div>
  );
}
