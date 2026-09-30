import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GmApp } from '../src/server/app.ts';
import type { ApplyChangeResponse, CheckpointDto, MatchDefinitionResponse, MatchProposalResponse, MatchSnapshotDto, ScenarioDto, ScenarioListItem } from '../src/shared/api.ts';
import type { CheckResult, Proposal } from '../src/schema/proposal.ts';

/** M6 server: scenario library, live rule changes, GM rulings and rewind, over HTTP. */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'ttg-editing-'));
const config = { openaiApiKey: null, contestantProvider: 'offline' as const, contestantModel: 'gpt-6-luna', contestantReasoningEffort: null, authoringModel: null, port: 0, dataDir };
const app = new GmApp(config, repoRoot);
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

async function call<T>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${url}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as T };
}

async function ok<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await call<T>(method, url, body);
  if (r.status >= 300) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

type Def = Record<string, unknown> & { id: string; name: string; rules: Array<Record<string, unknown>>; cast: Array<Record<string, unknown>>; settings: Record<string, unknown> };

async function starChase(): Promise<Def> {
  return (await ok<ScenarioDto>('GET', '/api/scenarios/star-chase')).definition as Def;
}

async function snapshot(matchId: string): Promise<MatchSnapshotDto> {
  return ok<MatchSnapshotDto>('GET', `/api/matches/${matchId}`);
}

async function stepUntil(matchId: string, done: (s: MatchSnapshotDto) => boolean, max = 400): Promise<MatchSnapshotDto> {
  let s = await snapshot(matchId);
  for (let i = 0; i < max && !done(s); i++) {
    await ok('POST', `/api/matches/${matchId}/control`, { action: 'step' });
    s = await snapshot(matchId);
  }
  return s;
}

describe('scenario library', () => {
  it('lists built-ins, checks drafts, saves copies through the proposal pipeline, and refuses to change built-ins', async () => {
    const list = await ok<ScenarioListItem[]>('GET', '/api/scenarios');
    expect(list.find((s) => s.id === 'star-chase')).toMatchObject({ builtIn: true, valid: true, spaces: 25 });

    const def = await starChase();
    const broken = { ...def, rules: [...def.rules, { id: 'rule.bad', name: 'Bad', trigger: { event: 'landed' }, effects: [{ op: 'changeResource', target: '$actor', resource: 'res.nope', amount: 1 }] }] };
    const check = await ok<CheckResult>('POST', '/api/scenarios/check', { definition: broken });
    expect(check.ok).toBe(false);
    expect(check.issues[0]).toMatchObject({ code: 'unknown-resource', path: ['rules', def.rules.length] });

    const refused = await call<{ error: string }>('PUT', '/api/scenarios/star-chase', { definition: def, answers: { questions: {} } });
    expect(refused.status).toBe(409);

    const copy = { ...def, id: 'my-chase', name: 'My Chase' };
    const proposal = await ok<Proposal>('POST', '/api/scenarios/propose', { definition: copy, base: null });
    expect(proposal.ok).toBe(true);
    expect(proposal.changes.every((c) => c.change === 'added')).toBe(true);
    const saved = await ok<{ ok: true }>('PUT', '/api/scenarios/my-chase', { definition: copy, answers: { questions: {} } });
    expect(saved.ok).toBe(true);
    expect((await ok<ScenarioListItem[]>('GET', '/api/scenarios')).find((s) => s.id === 'my-chase')).toMatchObject({ builtIn: false, valid: true, name: 'My Chase' });

    // A match can start from the GM's scenario; then the scenario can be deleted.
    const { matchId } = await ok<{ matchId: string }>('POST', '/api/matches', { scenario: 'my-chase', seed: 'copy' });
    expect((await snapshot(matchId)).definition.name).toBe('My Chase');
    await ok('DELETE', '/api/scenarios/my-chase');
    expect((await call('GET', '/api/scenarios/my-chase')).status).toBe(404);
  });
});

describe('changing the rules of a running match', () => {
  it('a mechanical change needs a pause, withdraws the waiting decision and is logged; cosmetic changes apply while playing', async () => {
    const { matchId } = await ok<{ matchId: string }>('POST', '/api/matches', { scenario: 'star-chase', seed: 'live-edit' });
    const before = await stepUntil(matchId, (s) => s.state.pendingDecision?.kind === 'main');
    const waiting = before.state.pendingDecision?.id;
    const { definition } = await ok<MatchDefinitionResponse>('GET', `/api/matches/${matchId}/definition`);
    const def = JSON.parse(JSON.stringify(definition)) as Def;
    def.rules.push({ id: 'rule.tax', name: 'Round Tax', trigger: { event: 'roundStarted' }, effects: [{ op: 'changeResource', target: { op: 'all', kind: 'contestant' }, resource: 'res.gold', amount: -1 }] });

    const review = await ok<MatchProposalResponse>('POST', `/api/matches/${matchId}/propose`, { definition: def });
    expect(review.proposal.level).toBe('mechanical');
    expect(review.needsPause).toBe(true);
    expect(review.proposal.summary.join(' ')).toContain('Round Tax');
    expect(review.proposal.dryRuns[0]?.rule).toBe('rule.tax');

    // While playing, a mechanical change is refused.
    await ok('POST', `/api/matches/${matchId}/control`, { action: 'start' });
    const running = await call<{ error: string }>('POST', `/api/matches/${matchId}/apply`, { definition: def, answers: { questions: {}, migration: {} }, baseVersion: review.baseVersion });
    expect(running.status).toBe(409);
    expect(running.body.error).toMatch(/pause/);
    await ok('POST', `/api/matches/${matchId}/control`, { action: 'pause' });

    const paused = await stepUntil(matchId, (x) => x.state.pendingDecision !== null);
    const fresh = await ok<MatchProposalResponse>('POST', `/api/matches/${matchId}/propose`, { definition: def });
    const applied = await ok<ApplyChangeResponse>('POST', `/api/matches/${matchId}/apply`, { definition: def, answers: { questions: {}, migration: {} }, baseVersion: fresh.baseVersion });
    expect(applied).toMatchObject({ level: 'mechanical', rulesVersion: { mechanical: 2, cosmetic: 0 } });
    expect(applied.invalidated).toBe(paused.state.pendingDecision?.id);
    const after = await snapshot(matchId);
    expect(after.status.rulesVersion.mechanical).toBe(2);
    expect(after.state.pendingDecision?.id).toBeDefined();
    expect(after.state.pendingDecision?.id).not.toBe(paused.state.pendingDecision?.id);
    expect(after.state.pendingDecision?.actor).toBe(paused.state.pendingDecision?.actor);
    const changed = after.events.find((e) => e.type === 'rulesChanged');
    expect(changed?.text).toContain('Round Tax');
    expect(changed?.text).toContain('withdrawn');
    expect(after.rulebook.rules['rule.tax']).toBeDefined();
    expect(waiting).toBeDefined();

    // A stale proposal is refused.
    const stale = await call<{ error: string }>('POST', `/api/matches/${matchId}/apply`, { definition: def, answers: { questions: {}, migration: {} }, baseVersion: review.baseVersion });
    expect(stale.status).toBe(409);

    // Renaming a contestant is cosmetic: applied while running, no revision, logged.
    await ok('POST', `/api/matches/${matchId}/control`, { action: 'start' });
    const renamed = JSON.parse(JSON.stringify(def)) as Def;
    (renamed.cast[0] as { name: string }).name = 'Admiral Brine';
    const cosmetic = await ok<MatchProposalResponse>('POST', `/api/matches/${matchId}/propose`, { definition: renamed });
    expect(cosmetic.proposal.level).toBe('cosmetic');
    const done = await ok<ApplyChangeResponse>('POST', `/api/matches/${matchId}/apply`, { definition: renamed, answers: { questions: {}, migration: {} }, baseVersion: cosmetic.baseVersion });
    expect(done.rulesVersion).toEqual({ mechanical: 2, cosmetic: 1 });
    await ok('POST', `/api/matches/${matchId}/control`, { action: 'pause' });
    const log = await ok<MatchDefinitionResponse>('GET', `/api/matches/${matchId}/definition`);
    expect(log.changes.map((c) => c.level)).toEqual(['mechanical', 'cosmetic']);
    expect(Object.values((await snapshot(matchId)).state.entities).some((e) => e.name === 'Admiral Brine')).toBe(true);
  });

  it('blocks incompatible edits with an explanation, and keeps the match unchanged', async () => {
    const { matchId } = await ok<{ matchId: string }>('POST', '/api/matches', { scenario: 'star-chase', seed: 'blocked' });
    const before = await stepUntil(matchId, (s) => s.state.round >= 1 && s.state.pendingDecision !== null);
    const def = JSON.parse(JSON.stringify(before.definition)) as Def;
    const playing = before.state.entities[before.state.turnOrder[0] as string]?.defId;
    def.cast = def.cast.filter((c) => c['id'] !== playing);
    def.cast.push({ ...(def.cast[0] as object), id: 'cast.newbie', name: 'Newbie' });
    const review = await ok<MatchProposalResponse>('POST', `/api/matches/${matchId}/propose`, { definition: def });
    expect(review.proposal.migration?.blocked).toBe(true);
    const res = await call<{ error: string }>('POST', `/api/matches/${matchId}/apply`, { definition: def, answers: { questions: {}, migration: {} }, baseVersion: review.baseVersion });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/cannot be applied mid-match.*is playing in this match/);
    expect((await snapshot(matchId)).status.stateHash).toBe(before.status.stateHash);
  });
});

describe('GM rulings', () => {
  it('are answered over HTTP', async () => {
    const def = await starChase();
    def.id = 'ruling-chase';
    def.rules = [{ id: 'rule.ask', name: 'Ask', trigger: { event: 'turnStarted' }, limits: { maxPerGame: 1 }, effects: [{ op: 'askGm', question: 'Is {actor} lucky today?', about: '$actor', options: [{ id: 'yes', label: 'Lucky', effects: [{ op: 'changeResource', target: '$actor', resource: 'res.gold', amount: 7 }] }] }] }];
    await ok('PUT', '/api/scenarios/ruling-chase', { definition: def, answers: { questions: {} } });
    const { matchId } = await ok<{ matchId: string }>('POST', '/api/matches', { scenario: 'ruling-chase', seed: 'rule' });
    const s = await stepUntil(matchId, (x) => x.status.ruling !== null);
    expect(s.state.pendingDecision?.kind).toBe('ruling');
    const asked = s.events.findLast((e) => e.type === 'gmAsked');
    const actor = (asked?.type === 'gmAsked' ? asked.about : null) as string;
    expect(actor).toBeTruthy();
    const gold = s.state.entities[actor]?.resources['res.gold'] ?? 0;
    expect((await call('POST', `/api/matches/${matchId}/ruling`, { optionId: 'ch:nope' })).status).toBe(422);
    await ok('POST', `/api/matches/${matchId}/ruling`, { optionId: 'ch:yes' });
    const after = await snapshot(matchId);
    expect(after.status.ruling).toBeNull();
    expect(after.state.entities[actor]?.resources['res.gold']).toBe(gold + 7);
    expect((await call('POST', `/api/matches/${matchId}/ruling`, { optionId: 'ch:yes' })).status).toBe(409);
  });
});

describe('rewind', () => {
  it('rewinds to the start of round N by replay, keeps a backup, and play continues (also after a reload)', async () => {
    const { matchId } = await ok<{ matchId: string }>('POST', '/api/matches', { scenario: 'star-chase', seed: 'rewind' });
    await stepUntil(matchId, (s) => s.state.round >= 2 && s.state.pendingDecision?.kind === 'main');
    // A rules change in round 2, then play on into round 3.
    const def = JSON.parse(JSON.stringify((await snapshot(matchId)).definition)) as Def;
    (def.settings as { movement: { die: number } }).movement.die = 4;
    const review = await ok<MatchProposalResponse>('POST', `/api/matches/${matchId}/propose`, { definition: def });
    await ok('POST', `/api/matches/${matchId}/apply`, { definition: def, answers: { questions: {}, migration: {} }, baseVersion: review.baseVersion });
    const later = await stepUntil(matchId, (s) => s.state.round >= 3 && s.state.pendingDecision?.kind === 'move');
    expect(later.status.rulesVersion.mechanical).toBe(2);

    const checkpoints = await ok<CheckpointDto[]>('GET', `/api/matches/${matchId}/checkpoints`);
    expect(checkpoints.map((c) => c.round)).toEqual([0, 1, 2, 3]);
    const round2 = checkpoints.find((c) => c.round === 2) as CheckpointDto;
    const history = readFileSync(path.join(dataDir, 'matches', matchId, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { rev: number; hash: string });
    const expectedHash = history.find((l) => l.rev === round2.rev)?.hash;

    const r = await ok<{ rev: number; round: number; backup: string }>('POST', `/api/matches/${matchId}/rewind`, { rev: round2.rev });
    expect(r).toMatchObject({ rev: round2.rev, round: 2 });
    const rewound = await snapshot(matchId);
    expect(rewound.state.rev).toBe(round2.rev);
    expect(rewound.status.stateHash).toBe(expectedHash);
    // The rules change came after the checkpoint: it is undone.
    expect(rewound.status.rulesVersion.mechanical).toBe(1);
    expect(rewound.definition.settings.movement.die).toBe(6);
    expect(rewound.events.at(-1)?.seq).toBeLessThan(later.events.at(-1)?.seq ?? 0);
    expect(existsSync(path.join(dataDir, 'matches', matchId, r.backup))).toBe(true);
    for (const m of rewound.minds) expect(m.strategy).not.toBeNull();

    // Continue playing from there.
    const continued = await stepUntil(matchId, (s) => s.state.round >= 3 && s.state.pendingDecision?.kind === 'move');
    expect(continued.state.round).toBe(3);

    // A fresh server loads the rewound match and can rewind it again.
    await new Promise((res) => setTimeout(res, 400));
    const app2 = new GmApp(config, repoRoot);
    const reopened = app2.snapshot(app2.open(matchId));
    expect(reopened.status.stateHash).toBe((await snapshot(matchId)).status.stateHash);
    expect(readdirSync(path.join(dataDir, 'matches', matchId)).filter((f) => f.endsWith('.bak')).length).toBeGreaterThanOrEqual(1);
  });

  it('refuses revisions in the future', async () => {
    const { matchId } = await ok<{ matchId: string }>('POST', '/api/matches', { scenario: 'star-chase', seed: 'future' });
    const s = await snapshot(matchId);
    expect((await call('POST', `/api/matches/${matchId}/rewind`, { rev: s.state.rev + 5 })).status).toBe(422);
  });
});
