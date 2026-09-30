import { mkdtempSync, rmSync } from 'node:fs';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GmApp } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import type { MatchSnapshotDto, MatchUpdateDto } from '../src/shared/api.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
let directories: string[] = [];
let clients: PassThrough[] = [];

function createApp(): GmApp {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ttg-stream-'));
  directories.push(dataDir);
  return new GmApp(loadConfig({ TTG_CONTESTANT_PROVIDER: 'offline', TTG_DATA_DIR: dataDir }), repoRoot);
}

/** Exercise the HTTP handler without opening a socket. */
async function request(app: GmApp, url: string, body?: unknown) {
  const req = Object.assign(new PassThrough(), { url, method: body === undefined ? 'GET' : 'POST' });
  const chunks: string[] = [];
  const res = Object.assign(new PassThrough(), { writeHead: () => res });
  res.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  req.end(body === undefined ? '' : JSON.stringify(body));
  await app.handle(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
  return JSON.parse(chunks.join('')) as MatchSnapshotDto;
}

async function stream(app: GmApp, id: string) {
  const req = Object.assign(new PassThrough(), { url: `/api/matches/${id}/stream`, method: 'GET' });
  clients.push(req);
  let text = '';
  const res = Object.assign(new PassThrough(), { writeHead: () => res });
  res.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  await app.handle(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
  return () =>
    text.split('\n\n').flatMap((frame) => {
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      return data
        ? [
            {
              event: frame.split('\n')[0]?.slice(7),
              data: JSON.parse(data.slice(6)) as MatchSnapshotDto | MatchUpdateDto,
            },
          ]
        : [];
    });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const client of clients) client.emit('close');
  clients = [];
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
  directories = [];
});

describe('live match history', () => {
  it('snapshot reads do not swallow pending events for an existing viewer', async () => {
    const app = createApp();
    const id = await app.createMatch({ seed: 'snapshot-feed' });
    const messages = await stream(app, id);
    await request(app, `/api/matches/${id}/gm`, { type: 'announce', text: 'Keep this event in the feed.' });
    const snapshot = await request(app, `/api/matches/${id}`);
    const announced = snapshot.events.find((e) => e.type === 'announced');
    expect(announced).toBeDefined();
    await vi.advanceTimersByTimeAsync(25);
    const events = messages()
      .filter((m) => m.event === 'update')
      .flatMap((m) => m.data.events);
    expect(events.map((e) => e.seq)).toContain(announced?.seq);
  });

  it('joining another viewer flushes pending events without duplicating their snapshot', async () => {
    const app = createApp();
    const id = await app.createMatch({ seed: 'two-viewers' });
    const first = await stream(app, id);
    await request(app, `/api/matches/${id}/gm`, { type: 'announce', text: 'Before the second viewer joins.' });
    const second = await stream(app, id);
    const firstDelta = first()
      .filter((m) => m.event === 'update')
      .flatMap((m) => m.data.events);
    expect(firstDelta.some((e) => e.type === 'announced')).toBe(true);
    expect(second()[0]?.event).toBe('snapshot');
    expect(second()[0]?.data.events.some((e) => e.type === 'announced')).toBe(true);

    await request(app, `/api/matches/${id}/gm`, { type: 'announce', text: 'Both viewers should get this.' });
    await vi.advanceTimersByTimeAsync(25);
    const firstEvents = first().flatMap((m) => m.data.events);
    const secondEvents = second().flatMap((m) => m.data.events);
    expect(secondEvents.map((e) => e.seq)).toEqual(firstEvents.map((e) => e.seq));
    expect(new Set(secondEvents.map((e) => e.seq)).size).toBe(secondEvents.length);
    expect(secondEvents.filter((e) => e.type === 'announced')).toHaveLength(2);
  });
});
