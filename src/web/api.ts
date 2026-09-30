import { useEffect, useRef, useState } from 'react';
import type { GmCommandInput } from '../schema/commands.ts';
import type { CheckResult, Proposal, ProposalAnswers } from '../schema/proposal.ts';
import type {
  AiCallDto,
  ApplyChangeResponse,
  CheckpointDto,
  ContestantViewResponse,
  ControlRequest,
  EventDto,
  FiringDto,
  MatchDefinitionResponse,
  MatchListItem,
  MatchProposalResponse,
  MatchSnapshotDto,
  MatchUpdateDto,
  RulesVersion,
  ScenarioDto,
  ScenarioListItem,
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
  scenarios: () => request<ScenarioListItem[]>('GET', '/api/scenarios'),
  scenario: (id: string) => request<ScenarioDto>('GET', `/api/scenarios/${encodeURIComponent(id)}`),
  checkDefinition: (definition: unknown) => request<CheckResult>('POST', '/api/scenarios/check', { definition }),
  proposeScenario: (definition: unknown, base: string | null) => request<Proposal>('POST', '/api/scenarios/propose', { definition, base }),
  saveScenario: (id: string, definition: unknown, answers: Pick<ProposalAnswers, 'questions'>, base: string | null) => request<{ ok: true; definition: unknown }>('PUT', `/api/scenarios/${encodeURIComponent(id)}`, { definition, answers, base }),
  deleteScenario: (id: string) => request<{ ok: true }>('DELETE', `/api/scenarios/${encodeURIComponent(id)}`),
  matchDefinition: (matchId: string) => request<MatchDefinitionResponse>('GET', `/api/matches/${matchId}/definition`),
  proposeMatch: (matchId: string, definition: unknown) => request<MatchProposalResponse>('POST', `/api/matches/${matchId}/propose`, { definition }),
  applyMatch: (matchId: string, definition: unknown, answers: ProposalAnswers, baseVersion: RulesVersion) => request<ApplyChangeResponse>('POST', `/api/matches/${matchId}/apply`, { definition, answers, baseVersion }),
  ruling: (matchId: string, optionId: string) => request<{ ok: true }>('POST', `/api/matches/${matchId}/ruling`, { optionId }),
  checkpoints: (matchId: string) => request<CheckpointDto[]>('GET', `/api/matches/${matchId}/checkpoints`),
  rewind: (matchId: string, rev: number) => request<{ ok: true; rev: number; round: number; backup: string }>('POST', `/api/matches/${matchId}/rewind`, { rev }),
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
  return { ...prev, state: u.state, events: [...prev.events, ...u.events], firings, bySeq, minds: u.minds, effective: u.effective, derived: u.derived, status: u.status, metrics: u.metrics, aiCalls };
}

/**
 * Live match data. `onFreshEvents` receives events that arrived after the initial snapshot,
 * together with the data as it was just before them (used to show pre-fight values while the
 * combat wheel replays a fight).
 */
export function useMatch(matchId: string, onFreshEvents: (events: EventDto[], before: MatchData) => void): { data: MatchData | null; connected: boolean } {
  const [data, setData] = useState<MatchData | null>(null);
  const [connected, setConnected] = useState(false);
  const latest = useRef<MatchData | null>(null);
  const callback = useRef(onFreshEvents);
  callback.current = onFreshEvents;
  useEffect(() => {
    latest.current = null;
    const es = new EventSource(`/api/matches/${matchId}/stream`);
    es.addEventListener('snapshot', (e) => {
      const snapshot = fromSnapshot(JSON.parse((e as MessageEvent<string>).data) as MatchSnapshotDto);
      latest.current = snapshot;
      setData(snapshot);
      setConnected(true);
    });
    es.addEventListener('update', (e) => {
      const update = JSON.parse((e as MessageEvent<string>).data) as MatchUpdateDto;
      const before = latest.current;
      if (!before) return;
      const next = merge(before, update);
      latest.current = next;
      setData(next);
      if (update.events.length > 0) callback.current(update.events, before);
    });
    es.onerror = () => setConnected(false);
    es.onopen = () => setConnected(true);
    return () => es.close();
  }, [matchId]);
  return { data, connected };
}
