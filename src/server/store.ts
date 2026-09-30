import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ContestantMindSchema, type ContestantMind } from '../contestants/mind.ts';
import type { FiringRecord } from '../engine/index.ts';
import { GameDefinitionSchema } from '../schema/definition.ts';
import { GameEventSchema, GameStateSchema, type GameEvent, type GameState } from '../schema/state.ts';
import { ENGINE_VERSION, RULES_LANGUAGE_VERSION, SAVE_FORMAT_VERSION } from '../schema/versions.ts';
import type { AiCallRecord, OperationRecord } from './session.ts';

/**
 * Local saves: data/matches/<matchId>/
 *   snapshot.json   definition + full state (RNG, phase, pending decision) + contestant minds
 *   history.jsonl   one line per committed operation: its input and the events it produced
 *   ai-calls.jsonl  every model call with usage, latency and outcome
 * Loading uses the snapshot; history lines up to the snapshot's revision provide the event log.
 */

export const SnapshotSchema = z.object({
  saveFormatVersion: z.literal(SAVE_FORMAT_VERSION),
  engineVersion: z.string(),
  rulesLanguageVersion: z.union([z.literal(1), z.literal(RULES_LANGUAGE_VERSION)]),
  savedAt: z.string(),
  scenario: z.string(),
  definition: z.unknown(),
  state: GameStateSchema,
  minds: z.array(ContestantMindSchema),
  activeMs: z.number(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

const HistoryLineSchema = z.object({
  rev: z.number().int(),
  kind: z.string(),
  input: z.unknown(),
  events: z.array(GameEventSchema),
  firings: z.array(z.unknown()).default([]),
});

type Json = Record<string, unknown>;

/**
 * Explicit, step-by-step save migrations. Version 1 (first playable version) → 2 (M4): rule
 * counters gained per-round/per-game/cooldown fields, attack options name their `target`, buy
 * options carry their price; new state fields (statuses, decks, choice queue, cooldowns) get
 * their schema defaults.
 */
export function migrateSnapshot(raw: Json): Json {
  const version = raw['saveFormatVersion'];
  if (version === SAVE_FORMAT_VERSION) return raw;
  if (version !== 1) throw new Error(`save format ${String(version)} cannot be migrated`);
  const state = (raw['state'] ?? {}) as Json;
  const counters = (state['ruleCounters'] ?? {}) as Record<string, Json>;
  for (const [key, c] of Object.entries(counters)) {
    if ('count' in c) counters[key] = { turnKey: c['turnKey'], turnCount: c['count'], round: -1, roundCount: 0, total: c['count'], lastRound: -1000 };
  }
  const definition = (raw['definition'] ?? {}) as { shops?: Array<{ entries: Array<{ id: string; price: { amount: number } }> }> };
  const prices = new Map((definition.shops ?? []).flatMap((shop) => shop.entries.map((e) => [e.id, e.price.amount] as const)));
  const pending = state['pendingDecision'] as { options?: Json[] } | null | undefined;
  for (const option of pending?.options ?? []) {
    if (option['kind'] === 'attack' && 'enemy' in option) {
      option['target'] = option['enemy'];
      delete option['enemy'];
    }
    if (option['kind'] === 'buy' && !('price' in option)) option['price'] = prices.get(String(option['entry'])) ?? 0;
  }
  state['formatVersion'] = SAVE_FORMAT_VERSION;
  return { ...raw, state, saveFormatVersion: SAVE_FORMAT_VERSION };
}

export interface LoadedMatch {
  snapshot: Snapshot;
  definition: z.infer<typeof GameDefinitionSchema>;
  events: GameEvent[];
  firings: FiringRecord[];
}

export class MatchStore {
  readonly root: string;
  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'matches');
    mkdirSync(this.root, { recursive: true });
  }

  private dir(matchId: string): string {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(matchId)) throw new Error(`invalid match id ${matchId}`);
    return path.join(this.root, matchId);
  }

  appendHistory(matchId: string, record: OperationRecord, events: GameEvent[], firings: FiringRecord[]): void {
    const dir = this.dir(matchId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'history.jsonl'), `${JSON.stringify({ rev: record.rev, kind: record.kind, input: record.input, events, firings })}\n`);
  }

  appendAiCall(matchId: string, record: AiCallRecord): void {
    const dir = this.dir(matchId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'ai-calls.jsonl'), `${JSON.stringify(record)}\n`);
  }

  /** Writes the snapshot atomically (temp file + rename). */
  saveSnapshot(matchId: string, scenario: string, definition: unknown, state: GameState, minds: ContestantMind[], activeMs: number): string {
    const dir = this.dir(matchId);
    mkdirSync(dir, { recursive: true });
    const savedAt = new Date().toISOString();
    const snapshot: Snapshot = {
      saveFormatVersion: SAVE_FORMAT_VERSION,
      engineVersion: ENGINE_VERSION,
      rulesLanguageVersion: RULES_LANGUAGE_VERSION,
      savedAt,
      scenario,
      definition,
      state,
      minds,
      activeMs,
    };
    const tmp = path.join(dir, 'snapshot.json.tmp');
    writeFileSync(tmp, JSON.stringify(snapshot));
    renameSync(tmp, path.join(dir, 'snapshot.json'));
    return savedAt;
  }

  list(): Array<{ matchId: string; scenario: string; round: number; phase: string; winners: string[] | null; savedAt: string }> {
    const out = [];
    for (const id of existsSync(this.root) ? readdirSync(this.root) : []) {
      const file = path.join(this.root, id, 'snapshot.json');
      if (!existsSync(file)) continue;
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { scenario?: string; savedAt?: string; state?: { round?: number; phase?: string; winners?: string[] | null } };
        out.push({ matchId: id, scenario: raw.scenario ?? '?', round: raw.state?.round ?? 0, phase: raw.state?.phase ?? '?', winners: raw.state?.winners ?? null, savedAt: raw.savedAt ?? '' });
      } catch {
        // Unreadable saves are skipped from the list; loading them reports the error.
      }
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  load(matchId: string): LoadedMatch {
    const dir = this.dir(matchId);
    const raw = JSON.parse(readFileSync(path.join(dir, 'snapshot.json'), 'utf8')) as Json;
    const version = raw['saveFormatVersion'];
    if (typeof version === 'number' && version > SAVE_FORMAT_VERSION) throw new Error(`save format ${version} is newer than this app supports (${SAVE_FORMAT_VERSION})`);
    const snapshot = SnapshotSchema.parse(migrateSnapshot(raw));
    const definition = GameDefinitionSchema.parse(snapshot.definition);
    const events: GameEvent[] = [];
    const firings: FiringRecord[] = [];
    const historyFile = path.join(dir, 'history.jsonl');
    if (existsSync(historyFile)) {
      const lines = readFileSync(historyFile, 'utf8').split('\n').filter((l) => l.trim());
      const kept: string[] = [];
      for (const line of lines) {
        let parsed;
        try {
          parsed = HistoryLineSchema.parse(JSON.parse(line));
        } catch {
          break; // a partially written last line after a crash is ignored
        }
        if (parsed.rev > snapshot.state.rev) break;
        kept.push(line);
        events.push(...(parsed.events as unknown as GameEvent[]));
        firings.push(...(parsed.firings as FiringRecord[]));
      }
      // Operations after the snapshot were never saved as state: drop them so the log matches.
      if (kept.length !== lines.length) writeFileSync(historyFile, kept.length ? `${kept.join('\n')}\n` : '');
    }
    return { snapshot, definition, events, firings };
  }
}
