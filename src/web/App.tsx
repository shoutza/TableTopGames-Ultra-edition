import { useEffect, useState } from 'react';
import type { HealthResponse } from '../shared/api.ts';

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch((err: unknown) => setError(String(err)));
  }, []);

  return (
    <main className="placeholder">
      <h1>TableTopGames Ultra Edition</h1>
      {error && <p className="error">Server unreachable: {error}</p>}
      {health && (
        <p>
          Server OK · engine v{health.engineVersion} · contestants: {health.contestantProvider} (
          {health.contestantModel})
        </p>
      )}
    </main>
  );
}
