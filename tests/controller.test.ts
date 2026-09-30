import { describe, expect, it } from 'vitest';
import { loadStarter } from '../src/cli/headless.ts';
import { decide, DEFAULT_CONTROLLER_CONFIG, ProviderHealth } from '../src/contestants/controller.ts';
import { newMind } from '../src/contestants/mind.ts';
import { MockProvider, mockOk } from '../src/llm/mock.ts';
import { OpenAiProvider } from '../src/llm/openai.ts';
import type { LlmRequest, LlmResult } from '../src/llm/port.ts';
import { MatchSession } from '../src/server/session.ts';
import { GmCommandSchema } from '../src/schema/commands.ts';
import { publicInfo } from '../src/visibility/public-info.ts';

const starter = loadStarter();
const info = publicInfo(starter);

/** Session without a provider (heuristic strategies); tests pass their provider to decide() directly. */
async function sessionAtMoveDecision(_provider?: MockProvider | null) {
  const session = await MatchSession.create(starter, { matchId: 'ctl', seed: 'ctl' }, { provider: null, config: DEFAULT_CONTROLLER_CONFIG, price: null });
  while (!session.state.pendingDecision) await session.step();
  return session;
}

function decisionInput(session: MatchSession, provider: MockProvider | null, health = new ProviderHealth()) {
  const d = session.state.pendingDecision;
  if (!d) throw new Error('no decision');
  return {
    view: session.view(d.actor),
    info,
    mind: newMind(d.actor, session.state.entities[d.actor]?.defId as string, ['opportunist'], 'llm' as const),
    persona: session.persona(d.actor),
    provider,
    config: DEFAULT_CONTROLLER_CONFIG,
    health,
  };
}

function answerWith(optionOf: (req: LlmRequest) => string, extra: Record<string, unknown> = {}) {
  return (req: LlmRequest): LlmResult => {
    const decisionId = /DECISION (d\d+)/.exec(req.input)?.[1];
    return mockOk({ decisionId, optionId: optionOf(req), say: 'Onward!', plan: 'Head for the vendor.', strategyUpdate: null, reason: 'test', ...extra });
  };
}

const firstOption = (req: LlmRequest) => /^\[([^\]]+)\]/m.exec(req.input)?.[1] ?? '';

describe('decision controller', () => {
  it('accepts a valid answer, keeping say and plan', async () => {
    const provider = new MockProvider(answerWith(firstOption));
    const session = await sessionAtMoveDecision(provider);
    const r = await decide(decisionInput(session, provider));
    expect(r.source).toBe('llm');
    expect(r.say).toBe('Onward!');
    expect(r.plan).toBe('Head for the vendor.');
    expect(session.state.pendingDecision?.options.map((o) => o.id)).toContain(r.optionId);
    const req = provider.calls.at(-1);
    expect(req?.schemaName).toBe('contestant_decision');
    expect(req?.model).toBe('gpt-6-luna');
  });

  it('repairs malformed JSON and illegal options once', async () => {
    let n = 0;
    const provider = new MockProvider((req) => (n++ === 0 ? mockOk('{not json') : answerWith(firstOption)(req)));
    const session = await sessionAtMoveDecision(provider);
    const start = provider.calls.length;
    const r = await decide(decisionInput(session, provider));
    expect(r.source).toBe('repaired');
    expect(provider.calls.length - start).toBe(2);
    expect(provider.calls.at(-1)?.input).toContain('previous answer was rejected');
  });

  it('falls back to the offline player after two unusable answers', async () => {
    const provider = new MockProvider(answerWith(() => 'mv:space.nowhere'));
    const session = await sessionAtMoveDecision(provider);
    const r = await decide(decisionInput(session, provider));
    expect(r.source).toBe('fallback');
    expect(r.attempts).toHaveLength(2);
    expect(session.state.pendingDecision?.options.map((o) => o.id)).toContain(r.optionId);
  });

  it('retries a timeout once, but not a refusal', async () => {
    let calls = 0;
    const timeoutThenOk = new MockProvider((req) =>
      calls++ === 0 ? { ok: false, error: 'timeout', message: 'slow', usage: null, latencyMs: 20000 } : answerWith(firstOption)(req),
    );
    const s1 = await sessionAtMoveDecision(timeoutThenOk);
    expect((await decide(decisionInput(s1, timeoutThenOk))).source).toBe('repaired');

    const refusing = new MockProvider(() => ({ ok: false, error: 'refusal', message: 'no', usage: null, latencyMs: 5 }));
    const s2 = await sessionAtMoveDecision(null);
    const r = await decide(decisionInput(s2, refusing));
    expect(r.source).toBe('fallback');
    expect(refusing.calls).toHaveLength(1);
  });

  it('rejects answers for a different decision id', async () => {
    const provider = new MockProvider((req) => mockOk({ decisionId: 'd999', optionId: firstOption(req), say: null, plan: null, strategyUpdate: null, reason: 'x' }));
    const session = await sessionAtMoveDecision(provider);
    const r = await decide(decisionInput(session, provider));
    expect(r.source).toBe('fallback');
    expect(r.attempts.every((a) => a.errorKind === 'invalid')).toBe(true);
  });

  it('trips the circuit breaker after repeated provider failures and stops calling', async () => {
    const failing = new MockProvider(() => ({ ok: false, error: 'network', message: 'down', usage: null, latencyMs: 1 }));
    const session = await sessionAtMoveDecision(null);
    const health = new ProviderHealth(3);
    await decide(decisionInput(session, failing, health));
    await decide(decisionInput(session, failing, health));
    expect(health.tripped).toBe(true);
    const before = failing.calls.length;
    const r = await decide(decisionInput(session, failing, health));
    expect(r.source).toBe('heuristic');
    expect(failing.calls.length).toBe(before);
  });
});

describe('match session', () => {
  it('discards a model answer that arrives after a GM edit changed the state', async () => {
    let release: (() => void) | null = null;
    const provider = new MockProvider(async (req, i) => {
      if (req.purpose === 'strategy') return mockOk({ archetype: /- (\w+): /.exec(req.input)?.[1], summary: 's', priorities: ['p'], avoid: [], plan: 'p', reason: 'r' });
      if (i >= 4 && release === null) await new Promise<void>((res) => (release = res));
      return answerWith(firstOption)(req);
    });
    const session = await MatchSession.create(starter, { matchId: 'obs', seed: 'obs' }, { provider, config: DEFAULT_CONTROLLER_CONFIG, price: null });
    while (!session.state.pendingDecision) await session.step();
    const pending = session.state.pendingDecision;
    const stepping = session.step();
    await new Promise((r) => setTimeout(r, 5));
    const gm = session.gm(GmCommandSchema.parse({ type: 'adjustResource', entity: pending?.actor as string, resource: 'res.gold', delta: 5 }));
    expect(gm.ok).toBe(true);
    (release as unknown as () => void)();
    expect(await stepping).toBe('obsolete');
    expect(session.state.pendingDecision?.id).not.toBe(pending?.id);
    expect(session.calls.at(-1)?.obsolete).toBe(true);
    expect(session.history.some((e) => e.type === 'decided' && e.decision === pending?.id)).toBe(false);
  });

  it('plays a full match through the model pipeline with a scripted provider', async () => {
    const provider = new MockProvider(async (req) => {
      if (req.purpose === 'strategy') return mockOk({ archetype: /- (\w+): /.exec(req.input)?.[1], summary: 's', priorities: ['p'], avoid: [], plan: 'p', reason: 'r' });
      return answerWith(firstOption)(req);
    });
    const session = await MatchSession.create(starter, { matchId: 'full', seed: 'full' }, { provider, config: DEFAULT_CONTROLLER_CONFIG, price: { input: 0.1, cachedInput: 0.01, output: 0.5 } });
    // The changing part of each packet (the situation and options), apart from the shared rulebook prefix.
    const inputs: number[] = [];
    session.subscribe({
      onAiCall: (r) => {
        const p = session.lastPackets.get(r.contestant);
        if (p && r.purpose === 'decision' && r.attempts > 0) inputs.push(Math.ceil(p.input.length / 4));
      },
    });
    await session.runToEnd();
    expect(session.over).toBe(true);
    const m = session.metrics();
    expect(m.fallbackRate).toBe(0);
    expect(m.costUsd).toBeGreaterThan(0);
    expect(m.packetTokens.p95).toBeLessThan(3000);
    const sorted = [...inputs].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length * 0.95)]).toBeLessThan(1200);
    for (const mind of session.minds.values()) expect(mind.strategy).not.toBeNull();
  });
});

describe('OpenAI adapter', () => {
  function fakeFetch(respond: (body: Record<string, unknown>) => { status: number; json: unknown }) {
    const seen: Array<Record<string, unknown>> = [];
    const fn = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.push(body);
      const r = respond(body);
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { fn, seen };
  }
  const request: LlmRequest = {
    purpose: 'decision',
    model: 'gpt-6-luna',
    instructions: 'be brief',
    input: 'DECISION d1',
    schemaName: 'contestant_decision',
    jsonSchema: { type: 'object', additionalProperties: false, required: [], properties: {} },
    maxOutputTokens: 300,
    timeoutMs: 5000,
  };
  const message = (content: unknown[]) => ({
    id: 'resp_1',
    object: 'response',
    model: 'gpt-6-luna',
    status: 'completed',
    output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content }],
    usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 0 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 1280 },
  });

  it('sends a strict json_schema request and reads text and usage', async () => {
    const { fn, seen } = fakeFetch(() => ({ status: 200, json: message([{ type: 'output_text', text: '{"ok":true}', annotations: [] }]) }));
    const provider = new OpenAiProvider({ apiKey: 'test', fetch: fn });
    const r = await provider.complete(request);
    expect(r).toMatchObject({ ok: true, text: '{"ok":true}', usage: { inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 80, reasoningTokens: 20 } });
    const body = seen[0] as Record<string, unknown>;
    expect(body['model']).toBe('gpt-6-luna');
    expect(body['store']).toBe(false);
    expect(body['max_output_tokens']).toBe(300);
    expect(body['reasoning']).toBeUndefined();
    expect(body['text']).toEqual({ format: { type: 'json_schema', name: 'contestant_decision', schema: request.jsonSchema, strict: true } });
  });

  it('passes reasoning effort only when configured, and maps refusals and auth errors', async () => {
    const refusal = fakeFetch(() => ({ status: 200, json: message([{ type: 'refusal', refusal: 'cannot help' }]) }));
    const r1 = await new OpenAiProvider({ apiKey: 'test', fetch: refusal.fn }).complete({ ...request, reasoningEffort: 'low' });
    expect(r1).toMatchObject({ ok: false, error: 'refusal' });
    expect(refusal.seen[0]?.['reasoning']).toEqual({ effort: 'low' });

    const auth = fakeFetch(() => ({ status: 401, json: { error: { message: 'bad key', type: 'invalid_request_error' } } }));
    const r2 = await new OpenAiProvider({ apiKey: 'test', fetch: auth.fn }).complete(request);
    expect(r2).toMatchObject({ ok: false, error: 'auth' });
  });
});
