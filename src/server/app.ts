import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { describeEvent, effectiveValue, loadGame, namesFor, type CompiledGame, type FiringRecord } from '../engine/index.ts';
import { GmCommandSchema } from '../schema/commands.ts';
import type { GameEvent } from '../schema/state.ts';
import { ENGINE_VERSION, RULES_LANGUAGE_VERSION } from '../schema/versions.ts';
import type {
  AiCallDto,
  ContestantViewResponse,
  EventDto,
  FiringDto,
  HealthResponse,
  MatchListItem,
  MatchSnapshotDto,
  MatchUpdateDto,
  MindDto,
  Speed,
  StatusDto,
} from '../shared/api.ts';
import type { ServerConfig } from './config.ts';
import { contestantPrice, contestantProvider, controllerConfig, scriptedProvider } from './providers.ts';
import { MatchSession, type AiCallRecord } from './session.ts';
import { MatchStore } from './store.ts';
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
  clients: Set<http.ServerResponse>;
  speed: Speed;
  savedAt: string | null;
  sentEvents: number;
  sentFirings: number;
  sentCalls: number;
  pushTimer: ReturnType<typeof setTimeout> | null;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const CreateMatchSchema = z.strictObject({ scenario: z.string().max(80).optional(), seed: z.string().max(80).optional() });
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
  private readonly scenarios = new Map<string, { game: CompiledGame; json: unknown }>();
  private readonly hosted = new Map<string, Hosted>();
  private readonly providerKind: StatusDto['provider'];

  constructor(config: ServerConfig, repoRoot: string) {
    this.config = config;
    this.store = new MatchStore(config.dataDir);
    const mode = config.contestantProvider;
    this.providerKind = mode === 'mock' ? 'mock' : mode === 'offline' ? 'offline' : config.openaiApiKey ? 'openai' : 'offline';
    if (mode === 'openai' && !config.openaiApiKey) console.warn('TTG_CONTESTANT_PROVIDER=openai but OPENAI_API_KEY is empty: using the offline controller.');
    const dir = path.join(repoRoot, 'content/starter');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const json: unknown = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
      const loaded = loadGame(json);
      if (!loaded.ok) throw new Error(`scenario ${file} is invalid:\n${loaded.errors.join('\n')}`);
      this.scenarios.set(loaded.game.def.id, { game: loaded.game, json });
    }
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
    }));
  }

  snapshot(h: Hosted): MatchSnapshotDto {
    const s = h.session;
    return {
      matchId: s.matchId,
      definition: s.game.def,
      state: s.state,
      events: this.eventDtos(h, s.history),
      firings: s.firings as FiringDto[],
      minds: this.minds(h),
      effective: this.effective(h),
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
    const s = h.session;
    h.savedAt = this.store.saveSnapshot(s.matchId, h.scenario, h.definitionJson, s.state, [...s.minds.values()], s.activeMs);
  }

  private host(session: MatchSession, scenario: string, definitionJson: unknown, savedAt: string | null): Hosted {
    const h: Hosted = { session, scenario, definitionJson, clients: new Set(), speed: 'normal', savedAt, sentEvents: 0, sentFirings: 0, sentCalls: 0, pushTimer: null };
    this.applySpeed(h, 'normal');
    session.subscribe({
      onCommit: (record, events, firings: FiringRecord[]) => {
        this.store.appendHistory(session.matchId, record, events, firings);
        if (events.some((e) => e.type === 'roundEnded' || e.type === 'gameOver')) this.save(h);
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
    this.hosted.set(session.matchId, h);
    return h;
  }

  private applySpeed(h: Hosted, speed: Speed): void {
    h.speed = speed;
    h.session.stepDelayMs = SPEEDS[speed].step;
    h.session.spinDelayMs = SPEEDS[speed].spin;
  }

  async createMatch(body: unknown): Promise<string> {
    const req = CreateMatchSchema.parse(body);
    const scenarioId = req.scenario ?? 'star-chase';
    const scenario = this.scenarios.get(scenarioId);
    if (!scenario) throw new HttpError(404, `unknown scenario ${scenarioId}`);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const matchId = `m${stamp}-${randomBytes(2).toString('hex')}`;
    const seed = req.seed ?? randomBytes(6).toString('hex');
    const session = await MatchSession.create(scenario.game, { matchId, seed }, this.deps());
    const h = this.host(session, scenarioId, scenario.json, null);
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
    const session = MatchSession.restore(compiled.game, loaded.snapshot.state, loaded.events, loaded.firings, loaded.snapshot.minds, this.deps(), loaded.snapshot.activeMs);
    return this.host(session, loaded.snapshot.scenario, loaded.snapshot.definition, loaded.snapshot.savedAt);
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
    if (parts[1] === 'scenarios' && method === 'GET') {
      return send(res, 200, [...this.scenarios.values()].map(({ game }) => ({ id: game.def.id, name: game.def.name, description: game.def.description })));
    }
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
    if (action === 'view' && method === 'GET') {
      const h = this.get(matchId);
      const entityId = parts[4] ?? '';
      if (h.session.state.entities[entityId]?.kind !== 'contestant') throw new HttpError(404, 'not a contestant');
      const body: ContestantViewResponse = { entityId, view: h.session.view(entityId), lastPacket: h.session.lastPackets.get(entityId) ?? null };
      return send(res, 200, body);
    }
    throw new HttpError(404, 'not found');
  }

  private stream(h: Hosted, req: http.IncomingMessage, res: http.ServerResponse): void {
    // Existing viewers must receive pending deltas before a new viewer gets the
    // complete snapshot. Reading a snapshot never consumes another viewer's feed.
    if (h.pushTimer) {
      clearTimeout(h.pushTimer);
      h.pushTimer = null;
    }
    this.push(h);
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
