import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { checkDefinition } from '../authoring/check.ts';
import { changeLevel, diffGames, publicSummary } from '../authoring/diff.ts';
import { buildProposal, finalizeDefinition } from '../authoring/proposal.ts';
import { describeEvent, describeObjective, describeRule, describeStatus, effectiveTags, effectiveValue, GM, loadGame, namesFor, suppressedCapabilities, type FiringRecord } from '../engine/index.ts';
import { planMigration } from '../engine/migrate.ts';
import { summarizeEffects } from '../engine/explain.ts';
import { describeItem } from '../visibility/view.ts';
import { GmCommandSchema } from '../schema/commands.ts';
import type { GameEvent } from '../schema/state.ts';
import { ENGINE_VERSION, RULES_LANGUAGE_VERSION } from '../schema/versions.ts';
import type {
  AiCallDto,
  ApplyChangeResponse,
  ChangeLogEntry,
  CheckpointDto,
  ContestantViewResponse,
  DerivedDto,
  EventDto,
  FiringDto,
  HealthResponse,
  MatchDefinitionResponse,
  MatchListItem,
  MatchProposalResponse,
  MatchSnapshotDto,
  MatchUpdateDto,
  MindDto,
  RulebookDto,
  ScenarioDto,
  Speed,
  StatusDto,
} from '../shared/api.ts';
import type { ServerConfig } from './config.ts';
import { contestantPrice, contestantProvider, controllerConfig, scriptedProvider } from './providers.ts';
import { ScenarioLibrary } from './library.ts';
import { replay, ReplayError, rewoundMinds } from './replay.ts';
import { MatchSession, type AiCallRecord, type DefinitionChangeRecord } from './session.ts';
import { MatchStore, type HistoryLine } from './store.ts';
import { stateHash } from './hash.ts';

/**
 * HTTP + Server-Sent Events API for the GM app. One MatchSession per open match; every change is
 * pushed to connected browsers as an incremental update and persisted to data/.
 */

const SPEEDS: Record<Speed, { step: number; spin: number }> = {
  fast: { step: 0, spin: 0 },
  normal: { step: 450, spin: 750 },
  slow: { step: 1200, spin: 1200 },
};

interface Hosted {
  session: MatchSession;
  scenario: string;
  definitionJson: unknown;
  /** Applied definition changes, oldest first. */
  changes: ChangeLogEntry[];
  unsubscribe: () => void;
  clients: Set<http.ServerResponse>;
  speed: Speed;
  savedAt: string | null;
  sentEvents: number;
  sentFirings: number;
  sentCalls: number;
  pushTimer: ReturnType<typeof setTimeout> | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Snapshots are written shortly after every committed operation (debounced), so a crash loses at
 * most the last fraction of a second of play; history lines beyond the snapshot are dropped on load.
 */
const AUTOSAVE_DELAY_MS = 300;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const CreateMatchSchema = z.strictObject({ scenario: z.string().max(80).optional(), seed: z.string().max(80).optional() });
const DefinitionBody = z.strictObject({ definition: z.unknown() });
const ScenarioProposalSchema = z.strictObject({ definition: z.unknown(), base: z.string().max(80).nullable() });
const QuestionAnswers = z.record(z.string().max(200), z.string().max(80));
const SaveScenarioSchema = z.strictObject({ definition: z.unknown(), answers: z.strictObject({ questions: QuestionAnswers }), base: z.string().max(80).nullable().optional() });
const VersionSchema = z.strictObject({ mechanical: z.number().int(), cosmetic: z.number().int() });
const ApplyChangeSchema = z.strictObject({
  definition: z.unknown(),
  answers: z.strictObject({ questions: QuestionAnswers, migration: QuestionAnswers }),
  baseVersion: VersionSchema,
});
const RulingSchema = z.strictObject({ optionId: z.string().min(1).max(80) });
const RewindSchema = z.strictObject({ rev: z.number().int().min(0) });

/** The change log of a match, from its history (rules and cosmetic records). */
function changeLogFrom(lines: HistoryLine[]): ChangeLogEntry[] {
  return lines
    .filter((l) => l.kind === 'rules' || l.kind === 'cosmetic')
    .map((l) => {
      const r = l.input as DefinitionChangeRecord;
      return { rev: l.rev, round: r.round, level: r.level, rulesVersion: r.rulesVersion, summary: r.summary, changes: r.changes };
    });
}
const ControlSchema = z.strictObject({
  action: z.enum(['start', 'pause', 'step', 'save', 'speed', 'resetProvider']),
  speed: z.enum(['fast', 'normal', 'slow']).optional(),
});

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, 'request too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export class GmApp {
  private readonly config: ServerConfig;
  private readonly store: MatchStore;
  readonly library: ScenarioLibrary;
  private readonly hosted = new Map<string, Hosted>();
  private readonly providerKind: StatusDto['provider'];

  constructor(config: ServerConfig, repoRoot: string) {
    this.config = config;
    this.store = new MatchStore(config.dataDir);
    const mode = config.contestantProvider;
    this.providerKind = mode === 'mock' ? 'mock' : mode === 'offline' ? 'offline' : config.openaiApiKey ? 'openai' : 'offline';
    if (mode === 'openai' && !config.openaiApiKey) console.warn('TTG_CONTESTANT_PROVIDER=openai but OPENAI_API_KEY is empty: using the offline controller.');
    this.library = new ScenarioLibrary(path.join(repoRoot, 'content/starter'), config.dataDir);
  }

  private provider() {
    if (this.providerKind === 'mock') return scriptedProvider();
    if (this.providerKind === 'offline') return null;
    return contestantProvider(this.config);
  }

  private deps() {
    return { provider: this.provider(), config: controllerConfig(this.config), price: contestantPrice(this.config) };
  }

  // --- DTOs ------------------------------------------------------------------------------------

  private eventDtos(h: Hosted, events: GameEvent[]): EventDto[] {
    const names = namesFor(h.session.game, h.session.state);
    return events.map((e) => ({ ...e, text: describeEvent(e, names) }));
  }

  private effective(h: Hosted): Record<string, Record<string, number>> {
    const { game, state } = h.session;
    const out: Record<string, Record<string, number>> = {};
    for (const e of Object.values(state.entities)) {
      const values: Record<string, number> = {};
      for (const key of Object.keys(e.resources)) {
        const v = effectiveValue(game, state, e, key);
        if (v !== undefined) values[key] = v;
      }
      out[e.id] = values;
    }
    return out;
  }

  private derived(h: Hosted): Record<string, DerivedDto> {
    const { game, state } = h.session;
    const out: Record<string, DerivedDto> = {};
    for (const e of Object.values(state.entities)) {
      if (e.status === 'removed') continue;
      out[e.id] = { tags: [...effectiveTags(game, e)], suppressed: [...suppressedCapabilities(game, state, e)].map(([capability, by]) => ({ capability, by })) };
    }
    return out;
  }

  private rulebook(h: Hosted): RulebookDto {
    const { game, state } = h.session;
    const names = namesFor(game, state);
    return {
      rules: Object.fromEntries([...game.rules.values()].map((r) => [r.def.id, describeRule(r.def, names)])),
      statuses: Object.fromEntries(game.def.statuses.map((st) => [st.id, describeStatus(st, names)])),
      items: Object.fromEntries(game.def.items.map((i) => [i.id, describeItem(i, names)])),
      actions: Object.fromEntries(game.def.actions.map((a) => [a.id, summarizeEffects(a.effects, names)])),
      cards: Object.fromEntries(game.def.decks.flatMap((d) => d.cards.map((c) => [c.id, summarizeEffects(c.effects, names)] as const))),
      objectives: Object.fromEntries(game.def.objectives.map((o) => [o.id, describeObjective(o, names)])),
    };
  }

  private status(h: Hosted): StatusDto {
    const s = h.session;
    return {
      running: s.running && !s.paused,
      paused: s.paused,
      over: s.over,
      thinking: s.thinking,
      abortedMessage: s.abortedMessage,
      provider: this.providerKind,
      model: this.providerKind === 'offline' ? 'offline heuristic' : this.providerKind === 'mock' ? 'scripted mock' : this.config.contestantModel,
      speed: h.speed,
      stateHash: stateHash(s.state),
      savedAt: h.savedAt,
      ruling: s.state.pendingDecision?.actor === GM ? { decisionId: s.state.pendingDecision.id, timeLeftMs: s.rulingTimeLeft() } : null,
      rulesVersion: { ...s.rulesVersion },
    };
  }

  private minds(h: Hosted): MindDto[] {
    return [...h.session.minds.values()].map((m) => ({
      entityId: m.entityId,
      castId: m.castId,
      controller: m.controller,
      candidates: m.candidates,
      strategy: m.strategy,
      strategyHistory: m.strategyHistory,
      plan: m.plan,
      planRound: m.planRound,
      reconsider: m.reconsider,
      relationships: m.relationships,
      memories: m.memories.slice(-20).map((x) => ({ round: x.round, kind: x.kind, other: x.other, text: x.text, importance: x.importance })),
      keyMoment: m.keyMoment,
    }));
  }

  snapshot(h: Hosted): MatchSnapshotDto {
    const s = h.session;
    h.sentEvents = s.history.length;
    h.sentFirings = s.firings.length;
    h.sentCalls = s.calls.length;
    return {
      matchId: s.matchId,
      definition: s.game.def,
      state: s.state,
      events: this.eventDtos(h, s.history),
      firings: s.firings as FiringDto[],
      minds: this.minds(h),
      effective: this.effective(h),
      derived: this.derived(h),
      rulebook: this.rulebook(h),
      status: this.status(h),
      metrics: s.metrics(),
      aiCalls: s.calls.slice(-300) as AiCallDto[],
    };
  }

  private schedulePush(h: Hosted): void {
    if (h.pushTimer) return;
    h.pushTimer = setTimeout(() => {
      h.pushTimer = null;
      this.push(h);
    }, 25);
  }

  private push(h: Hosted): void {
    const s = h.session;
    const update: MatchUpdateDto = {
      matchId: s.matchId,
      state: s.state,
      events: this.eventDtos(h, s.history.slice(h.sentEvents)),
      firings: s.firings.slice(h.sentFirings) as FiringDto[],
      minds: this.minds(h),
      effective: this.effective(h),
      derived: this.derived(h),
      status: this.status(h),
      metrics: s.metrics(),
      aiCalls: s.calls.slice(h.sentCalls) as AiCallDto[],
    };
    h.sentEvents = s.history.length;
    h.sentFirings = s.firings.length;
    h.sentCalls = s.calls.length;
    const payload = `event: update\ndata: ${JSON.stringify(update)}\n\n`;
    for (const client of h.clients) client.write(payload);
  }

  private save(h: Hosted): void {
    if (h.saveTimer) {
      clearTimeout(h.saveTimer);
      h.saveTimer = null;
    }
    const s = h.session;
    h.savedAt = this.store.saveSnapshot(s.matchId, h.scenario, h.definitionJson, s.state, [...s.minds.values()], s.activeMs, s.rulesVersion);
  }

  private scheduleSave(h: Hosted): void {
    if (h.saveTimer) return;
    h.saveTimer = setTimeout(() => {
      h.saveTimer = null;
      this.save(h);
      this.schedulePush(h);
    }, AUTOSAVE_DELAY_MS);
  }

  private host(session: MatchSession, scenario: string, definitionJson: unknown, savedAt: string | null, changes: ChangeLogEntry[] = []): Hosted {
    const h: Hosted = { session, scenario, definitionJson, changes, unsubscribe: () => undefined, clients: new Set(), speed: 'normal', savedAt, sentEvents: 0, sentFirings: 0, sentCalls: 0, pushTimer: null, saveTimer: null };
    this.attach(h, session);
    this.hosted.set(session.matchId, h);
    return h;
  }

  /** Connects a session to its hosting (persistence and live updates); used again after a rewind. */
  private attach(h: Hosted, session: MatchSession): void {
    h.unsubscribe();
    h.session = session;
    this.applySpeed(h, h.speed);
    h.unsubscribe = session.subscribe({
      onCommit: (record, events, firings: FiringRecord[]) => {
        this.store.appendHistory(session.matchId, record, events, firings);
        if (events.some((e) => e.type === 'gameOver')) this.save(h);
        else this.scheduleSave(h);
        this.schedulePush(h);
      },
      onAiCall: (record: AiCallRecord) => {
        this.store.appendAiCall(session.matchId, record);
        this.schedulePush(h);
      },
      onStatus: () => this.schedulePush(h),
      onAbort: () => {
        this.save(h);
        this.schedulePush(h);
      },
    });
  }

  /** Sends the whole match again (after the rules or the timeline changed). */
  private broadcastSnapshot(h: Hosted): void {
    if (h.pushTimer) {
      clearTimeout(h.pushTimer);
      h.pushTimer = null;
    }
    const payload = `event: snapshot\ndata: ${JSON.stringify(this.snapshot(h))}\n\n`;
    for (const client of h.clients) client.write(payload);
  }

  private applySpeed(h: Hosted, speed: Speed): void {
    h.speed = speed;
    h.session.stepDelayMs = SPEEDS[speed].step;
    h.session.spinDelayMs = SPEEDS[speed].spin;
  }

  async createMatch(body: unknown): Promise<string> {
    const req = CreateMatchSchema.parse(body);
    const scenarioId = req.scenario ?? 'star-chase';
    const scenario = this.library.get(scenarioId);
    if (!scenario) throw new HttpError(404, `unknown scenario ${scenarioId}`);
    if (!scenario.game) throw new HttpError(422, `scenario ${scenarioId} has problems; fix them in the editor first`);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const matchId = `m${stamp}-${randomBytes(2).toString('hex')}`;
    const seed = req.seed ?? randomBytes(6).toString('hex');
    const session = await MatchSession.create(scenario.game, { matchId, seed }, this.deps());
    const h = this.host(session, scenarioId, session.game.def, null);
    // Persist the setup operation and strategies right away.
    const setupOp = session.operations[0];
    if (setupOp) this.store.appendHistory(matchId, setupOp, session.history, session.firings);
    for (const call of session.calls) this.store.appendAiCall(matchId, call);
    this.save(h);
    return matchId;
  }

  open(matchId: string): Hosted {
    const existing = this.hosted.get(matchId);
    if (existing) return existing;
    let loaded;
    try {
      loaded = this.store.load(matchId);
    } catch (err) {
      throw new HttpError(404, `cannot load match ${matchId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const compiled = loadGame(loaded.definition);
    if (!compiled.ok) throw new HttpError(422, `saved definition is invalid: ${compiled.errors.join('; ')}`);
    const session = MatchSession.restore(compiled.game, loaded.snapshot.state, loaded.events, loaded.firings, loaded.snapshot.minds, this.deps(), loaded.snapshot.activeMs, loaded.snapshot.rulesVersion);
    const changes = changeLogFrom(this.store.readHistory(matchId).filter((l) => l.rev <= loaded.snapshot.state.rev));
    return this.host(session, loaded.snapshot.scenario, loaded.snapshot.definition, loaded.snapshot.savedAt, changes);
  }

  private get(matchId: string): Hosted {
    const h = this.hosted.get(matchId);
    if (h) return h;
    return this.open(matchId);
  }

  list(): MatchListItem[] {
    const saved = this.store.list();
    const items: MatchListItem[] = saved.map((s) => ({ ...s, loaded: this.hosted.has(s.matchId) }));
    return items;
  }

  health(): HealthResponse {
    return {
      ok: true,
      engineVersion: ENGINE_VERSION,
      rulesLanguageVersion: RULES_LANGUAGE_VERSION,
      contestantProvider: this.providerKind,
      contestantModel: this.providerKind === 'offline' ? 'offline heuristic' : this.providerKind === 'mock' ? 'scripted mock' : this.config.contestantModel,
    };
  }

  /** Returns true if the request was an API request (handled), false to fall through to the web app. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;
    try {
      await this.route(req, res, url);
    } catch (err) {
      if (err instanceof HttpError) send(res, err.status, { error: err.message });
      else if (err instanceof z.ZodError) send(res, 400, { error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      else {
        console.error(err);
        send(res, 500, { error: err instanceof Error ? err.message : 'internal error' });
      }
    }
    return true;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const method = req.method ?? 'GET';
    if (parts[1] === 'health' && method === 'GET') return send(res, 200, this.health());
    if (parts[1] === 'scenarios') return this.scenarioRoute(req, res, parts, method);
    if (parts[1] !== 'matches') throw new HttpError(404, 'not found');
    if (parts.length === 2) {
      if (method === 'GET') return send(res, 200, this.list());
      if (method === 'POST') return send(res, 201, { matchId: await this.createMatch(await readJson(req)) });
    }
    const matchId = parts[2] ?? '';
    const action = parts[3];
    if (action === undefined && method === 'GET') return send(res, 200, this.snapshot(this.get(matchId)));
    if (action === 'stream' && method === 'GET') return this.stream(this.get(matchId), req, res);
    if (action === 'control' && method === 'POST') return this.control(this.get(matchId), await readJson(req), res);
    if (action === 'gm' && method === 'POST') {
      const h = this.get(matchId);
      const cmd = GmCommandSchema.parse(await readJson(req));
      const out = h.session.gm(cmd);
      if (!out.ok) return send(res, out.kind === 'aborted' ? 409 : 422, { error: out.message });
      return send(res, 200, { ok: true });
    }
    if (action === 'definition' && method === 'GET') {
      const h = this.get(matchId);
      const body: MatchDefinitionResponse = { definition: h.session.game.def, rulesVersion: { ...h.session.rulesVersion }, changes: h.changes };
      return send(res, 200, body);
    }
    if (action === 'propose' && method === 'POST') return send(res, 200, this.proposeForMatch(this.get(matchId), await readJson(req)));
    if (action === 'apply' && method === 'POST') return send(res, 200, await this.applyToMatch(this.get(matchId), await readJson(req)));
    if (action === 'ruling' && method === 'POST') {
      const h = this.get(matchId);
      const { optionId } = RulingSchema.parse(await readJson(req));
      if (h.session.state.pendingDecision?.actor !== GM) throw new HttpError(409, 'no ruling is waiting');
      try {
        h.session.answerRuling(optionId);
      } catch (err) {
        throw new HttpError(422, err instanceof Error ? err.message : String(err));
      }
      return send(res, 200, { ok: true });
    }
    if (action === 'checkpoints' && method === 'GET') return send(res, 200, this.checkpoints(this.get(matchId)));
    if (action === 'rewind' && method === 'POST') return send(res, 200, await this.rewind(this.get(matchId), await readJson(req)));
    if (action === 'view' && method === 'GET') {
      const h = this.get(matchId);
      const entityId = parts[4] ?? '';
      if (h.session.state.entities[entityId]?.kind !== 'contestant') throw new HttpError(404, 'not a contestant');
      const body: ContestantViewResponse = { entityId, view: h.session.view(entityId), lastPacket: h.session.lastPackets.get(entityId) ?? null };
      return send(res, 200, body);
    }
    throw new HttpError(404, 'not found');
  }

  // --- scenario library ------------------------------------------------------------------------

  private async scenarioRoute(req: http.IncomingMessage, res: http.ServerResponse, parts: string[], method: string): Promise<void> {
    const id = parts[2];
    if (id === undefined) {
      if (method === 'GET') return send(res, 200, this.library.list());
      throw new HttpError(405, 'method not allowed');
    }
    if (id === 'check' && method === 'POST') {
      const { definition } = DefinitionBody.parse(await readJson(req));
      return send(res, 200, checkDefinition(definition).result);
    }
    if (id === 'propose' && method === 'POST') {
      const body = ScenarioProposalSchema.parse(await readJson(req));
      const base = body.base === null ? null : (this.library.get(body.base)?.game ?? null);
      return send(res, 200, buildProposal(body.definition, { base, state: null }).proposal);
    }
    if (method === 'GET') {
      const s = this.library.get(id);
      if (!s) throw new HttpError(404, `unknown scenario ${id}`);
      const body: ScenarioDto = { id, builtIn: s.builtIn, definition: s.json, check: checkDefinition(s.json).result };
      return send(res, 200, body);
    }
    if (method === 'PUT') {
      const body = SaveScenarioSchema.parse(await readJson(req));
      if (this.library.isBuiltIn(id)) throw new HttpError(409, `"${id}" is a built-in scenario; save it as a copy under a new id`);
      // The same comparison the review used (the scenario it was copied from, for a copy).
      const baseId = body.base === undefined ? id : body.base;
      const base = baseId === null ? null : (this.library.get(baseId)?.game ?? null);
      const fin = finalizeDefinition(body.definition, base, body.answers);
      if (!fin.ok) return send(res, 422, { error: fin.check.issues.find((i) => i.severity === 'error')?.message ?? 'the scenario has problems', check: fin.check });
      if (fin.def.id !== id) throw new HttpError(422, `the scenario's id is "${fin.def.id}", not "${id}"`);
      try {
        this.library.save(id, fin.def);
      } catch (err) {
        throw new HttpError(422, err instanceof Error ? err.message : String(err));
      }
      return send(res, 200, { ok: true, definition: fin.def });
    }
    if (method === 'DELETE') {
      try {
        if (!this.library.remove(id)) throw new HttpError(404, `unknown scenario ${id}`);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(409, err instanceof Error ? err.message : String(err));
      }
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'not found');
  }

  // --- live rule changes -----------------------------------------------------------------------

  private proposeForMatch(h: Hosted, body: unknown): MatchProposalResponse {
    const { definition } = DefinitionBody.parse(body);
    const s = h.session;
    const { proposal } = buildProposal(definition, { base: s.game, state: s.state });
    return { proposal, baseVersion: { ...s.rulesVersion }, needsPause: proposal.level === 'mechanical' };
  }

  private async applyToMatch(h: Hosted, body: unknown): Promise<ApplyChangeResponse> {
    const req = ApplyChangeSchema.parse(body);
    const s = h.session;
    if (req.baseVersion.mechanical !== s.rulesVersion.mechanical || req.baseVersion.cosmetic !== s.rulesVersion.cosmetic) {
      throw new HttpError(409, 'the rules changed since this proposal was made; review it again');
    }
    const fin = finalizeDefinition(req.definition, s.game, req.answers);
    if (!fin.ok) throw new HttpError(422, fin.check.issues.find((i) => i.severity === 'error')?.message ?? 'the definition has problems');
    const changes = diffGames(s.game, fin.game);
    const level = changeLevel(changes);
    if (level === 'none') return { ok: true, level, rulesVersion: { ...s.rulesVersion }, invalidated: null };
    let invalidated: string | null = null;
    if (level === 'mechanical') {
      await s.settled();
      if (s.running) throw new HttpError(409, 'pause the match before changing its rules (names, looks and personas can change while it plays)');
      if (s.over) throw new HttpError(409, 'the match is over');
      const plan = planMigration(s.game, fin.game, s.state);
      const blocked = plan.issues.find((i) => i.severity === 'blocked');
      if (blocked) throw new HttpError(422, `This change cannot be applied mid-match. ${blocked.title}: ${blocked.detail}`);
      const out = s.changeRules(fin.game, { definition: fin.def, answers: req.answers.migration, summary: publicSummary(changes), changes });
      if (!out.ok) throw new HttpError(out.kind === 'aborted' ? 409 : 422, out.message);
      invalidated = out.invalidated ?? null;
    } else {
      s.changeCosmetic(fin.game, { definition: fin.def, level, summary: [], changes });
    }
    const last = s.operations.at(-1);
    const record = last?.input as DefinitionChangeRecord | undefined;
    if (record) h.changes.push({ rev: last?.rev ?? s.state.rev, round: record.round, level: record.level, rulesVersion: record.rulesVersion, summary: record.summary, changes: record.changes });
    h.definitionJson = fin.def;
    this.save(h);
    this.broadcastSnapshot(h);
    return { ok: true, level, rulesVersion: { ...s.rulesVersion }, invalidated };
  }

  // --- rewind ----------------------------------------------------------------------------------

  private checkpoints(h: Hosted): CheckpointDto[] {
    const out: CheckpointDto[] = [];
    for (const line of this.store.readHistory(h.session.matchId)) {
      if (line.rev > h.session.state.rev) break;
      if (line.kind === 'setup') out.push({ round: 0, rev: line.rev });
      for (const e of line.events as Array<{ type?: string; round?: number }>) if (e.type === 'roundStarted' && typeof e.round === 'number') out.push({ round: e.round, rev: line.rev });
    }
    return out;
  }

  /**
   * Rewinds the match to an earlier revision by replaying its recorded inputs (no model calls).
   * The history after that point is cut (a backup is kept); minds are rebuilt from what each
   * contestant had seen by then.
   */
  private async rewind(h: Hosted, body: unknown): Promise<{ ok: true; rev: number; round: number; backup: string }> {
    const { rev } = RewindSchema.parse(body);
    const s = h.session;
    await s.settled();
    if (s.running) throw new HttpError(409, 'pause the match before rewinding');
    if (rev > s.state.rev) throw new HttpError(422, `revision ${rev} is in the future`);
    if (h.saveTimer) {
      clearTimeout(h.saveTimer);
      h.saveTimer = null;
    }
    let replayed;
    try {
      replayed = replay(this.store.readHistory(s.matchId).filter((l) => l.rev <= s.state.rev), rev);
    } catch (err) {
      if (err instanceof ReplayError) throw new HttpError(409, `cannot rewind: ${err.message}`);
      throw err;
    }
    const minds = rewoundMinds(replayed.game, replayed.state, replayed.events, [...s.minds.values()]);
    const backup = this.store.rewriteHistory(s.matchId, replayed.kept);
    const next = MatchSession.restore(replayed.game, replayed.state, replayed.events, replayed.firings, minds, this.deps(), s.activeMs, replayed.rulesVersion);
    next.calls.push(...s.calls);
    this.attach(h, next);
    h.definitionJson = replayed.game.def;
    h.changes = changeLogFrom(replayed.kept);
    this.save(h);
    this.broadcastSnapshot(h);
    return { ok: true, rev: replayed.state.rev, round: replayed.state.round, backup };
  }

  private stream(h: Hosted, req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: snapshot\ndata: ${JSON.stringify(this.snapshot(h))}\n\n`);
    h.clients.add(res);
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      h.clients.delete(res);
    });
  }

  private async control(h: Hosted, body: unknown, res: http.ServerResponse): Promise<void> {
    const req = ControlSchema.parse(body);
    const s = h.session;
    switch (req.action) {
      case 'start':
        s.start();
        break;
      case 'pause':
        s.pause();
        await s.idle();
        this.save(h);
        break;
      case 'step':
        if (s.running && !s.paused) throw new HttpError(409, 'pause before stepping');
        await s.step();
        break;
      case 'save':
        this.save(h);
        break;
      case 'speed':
        this.applySpeed(h, req.speed ?? 'normal');
        break;
      case 'resetProvider':
        s.health.reset();
        break;
    }
    this.schedulePush(h);
    send(res, 200, { ok: true, status: this.status(h) });
  }

  /** Saves every open match (on shutdown). */
  saveAll(): void {
    for (const h of this.hosted.values()) this.save(h);
  }
}
