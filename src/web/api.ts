import { useEffect, useRef, useState } from 'react';
import type { GmCommandInput } from '../schema/commands.ts';
import type {
  AiCallDto,
  ContestantViewResponse,
  ControlRequest,
  EventDto,
  FiringDto,
  MatchListItem,
  MatchSnapshotDto,
  MatchUpdateDto,
} from '../shared/api.ts';

/** Thin client for the GM API plus a live match hook fed by Server-Sent Events. */

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const api = {
  listMatches: () => request<MatchListItem[]>('GET', '/api/matches'),
  scenarios: () => request<Array<{ id: string; name: string; description: string }>>('GET', '/api/scenarios'),
  createMatch: (scenario: string, seed?: string) => request<{ matchId: string }>('POST', '/api/matches', seed ? { scenario, seed } : { scenario }),
  control: (matchId: string, body: ControlRequest) => request<{ ok: true }>('POST', `/api/matches/${matchId}/control`, body),
  gm: (matchId: string, cmd: GmCommandInput) => request<{ ok: true }>('POST', `/api/matches/${matchId}/gm`, cmd),
  view: (matchId: string, entityId: string) => request<ContestantViewResponse>('GET', `/api/matches/${matchId}/view/${entityId}`),
};

export interface MatchData extends Omit<MatchSnapshotDto, 'firings'> {
  firings: Map<number, FiringDto>;
  bySeq: Map<number, EventDto>;
}

function fromSnapshot(s: MatchSnapshotDto): MatchData {
  return { ...s, firings: new Map(s.firings.map((f) => [f.id, f])), bySeq: new Map(s.events.map((e) => [e.seq, e])) };
}

function merge(prev: MatchData, u: MatchUpdateDto): MatchData {
  const firings = new Map(prev.firings);
  for (const f of u.firings) firings.set(f.id, f);
  const bySeq = new Map(prev.bySeq);
  for (const e of u.events) bySeq.set(e.seq, e);
  const aiCalls: AiCallDto[] = [...prev.aiCalls, ...u.aiCalls].slice(-300);
  return { ...prev, state: u.state, events: [...prev.events, ...u.events], firings, bySeq, minds: u.minds, effective: u.effective, status: u.status, metrics: u.metrics, aiCalls };
}

/** Live match data. `fresh` receives events that arrived after the initial snapshot. */
export function useMatch(matchId: string, onFreshEvents: (events: EventDto[]) => void): { data: MatchData | null; connected: boolean } {
  const [data, setData] = useState<MatchData | null>(null);
  const [connected, setConnected] = useState(false);
  const callback = useRef(onFreshEvents);
  callback.current = onFreshEvents;
  useEffect(() => {
    const es = new EventSource(`/api/matches/${matchId}/stream`);
    es.addEventListener('snapshot', (e) => {
      setData(fromSnapshot(JSON.parse((e as MessageEvent<string>).data) as MatchSnapshotDto));
      setConnected(true);
    });
    es.addEventListener('update', (e) => {
      const update = JSON.parse((e as MessageEvent<string>).data) as MatchUpdateDto;
      setData((prev) => (prev ? merge(prev, update) : prev));
      if (update.events.length > 0) callback.current(update.events);
    });
    es.onerror = () => setConnected(false);
    es.onopen = () => setConnected(true);
    return () => es.close();
  }, [matchId]);
  return { data, connected };
}
