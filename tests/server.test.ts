import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GmApp } from '../src/server/app.ts';
import type { MatchSnapshotDto } from '../src/shared/api.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'ttg-server-'));
const app = new GmApp(
  { openaiApiKey: null, contestantProvider: 'offline', contestantModel: 'gpt-6-luna', contestantReasoningEffort: null, authoringModel: null, port: 0, dataDir },
  repoRoot,
);
const server = http.createServer((req, res) => {
  void app.handle(req, res).then((handled) => {
    if (!handled) res.writeHead(404).end();
  });
});
let base = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json;
}

describe('GM server', () => {
  it('autosaves shortly after every operation, so a crash loses at most a moment of play', async () => {
    const { matchId } = (await post('/api/matches', { scenario: 'star-chase', seed: 'autosave' })) as { matchId: string };
    for (let i = 0; i < 12; i++) await post(`/api/matches/${matchId}/control`, { action: 'step' });
    const live = (await (await fetch(`${base}/api/matches/${matchId}`)).json()) as MatchSnapshotDto;
    await new Promise((r) => setTimeout(r, 450));
    const snapshot = JSON.parse(readFileSync(path.join(dataDir, 'matches', matchId, 'snapshot.json'), 'utf8')) as { state: { rev: number } };
    expect(live.state.rev).toBeGreaterThan(5);
    expect(snapshot.state.rev).toBe(live.state.rev);
  });

  it('rejects malformed GM commands with a readable error and no state change', async () => {
    const { matchId } = (await post('/api/matches', { scenario: 'star-chase', seed: 'bad-cmd' })) as { matchId: string };
    const before = (await (await fetch(`${base}/api/matches/${matchId}`)).json()) as MatchSnapshotDto;
    const res = await fetch(`${base}/api/matches/${matchId}/gm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'teleport', entity: 'e1' }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/space/);
    const after = (await (await fetch(`${base}/api/matches/${matchId}`)).json()) as MatchSnapshotDto;
    expect(after.status.stateHash).toBe(before.status.stateHash);
  });
});
