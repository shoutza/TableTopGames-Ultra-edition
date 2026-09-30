import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ContestantMindSchema, type ContestantMind } from '../contestants/mind.ts';
import type { FiringRecord } from '../engine/index.ts';
import { GameDefinitionSchema } from '../schema/definition.ts';
import { GameEventSchema, GameStateSchema, type GameEvent, type GameState } from '../schema/state.ts';
import { ENGINE_VERSION, RULES_LANGUAGE_VERSION, SAVE_FORMAT_VERSION } from '../schema/versions.ts';
import type { AiCallRecord, OperationRecord, RulesVersion } from './session.ts';

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
  rulesLanguageVersion: z.number().int().min(1).max(RULES_LANGUAGE_VERSION),
  savedAt: z.string(),
  scenario: z.string(),
  definition: z.unknown(),
  state: GameStateSchema,
  minds: z.array(ContestantMindSchema),
  activeMs: z.number(),
  /** Ruleset versions (M6); older saves start at 1/0. */
  rulesVersion: z.object({ mechanical: z.number().int().min(1), cosmetic: z.number().int().min(0) }).default({ mechanical: 1, cosmetic: 0 }),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

const HistoryLineSchema = z.object({
  rev: z.number().int(),
  kind: z.string(),
  input: z.unknown(),
  events: z.array(GameEventSchema),
  firings: z.array(z.unknown()).default([]),
  hash: z.string().optional(),
});

/** One committed operation as written to history.jsonl. */
export interface HistoryLine {
  rev: number;
  kind: OperationRecord['kind'];
  input: unknown;
  hash: string | undefined;
  /** Events of the operation (unparsed). */
  events: unknown[];
  /** The raw JSON line, rewritten unchanged when the history is cut (rewind). */
  raw: string;
}

type Json = Record<string, unknown>;

/**
 * Explicit, step-by-step save migrations.
 * 1 (first playable version) → 2 (M4): rule counters gained per-round/per-game/cooldown fields,
 *   attack options name their `target`, buy options carry their price; new state fields
 *   (statuses, decks, choice queue, cooldowns) get their schema defaults.
 * 2 → 3 (M5): objectives, negotiations, commitments and minds' relationships and memories start
 *   empty (schema defaults); only the version numbers change.
 */
const MIGRATIONS: Record<number, (raw: Json) => Json> = {
  1: (raw) => {
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
    return { ...raw, state: { ...state, formatVersion: 2 }, saveFormatVersion: 2 };
  },
  2: (raw) => ({ ...raw, state: { ...((raw['state'] ?? {}) as Json), formatVersion: 3 }, saveFormatVersion: 3 }),
};

export function migrateSnapshot(raw: Json): Json {
  let current = raw;
  for (let guard = 0; guard < 10; guard++) {
    const version = current['saveFormatVersion'];
    if (version === SAVE_FORMAT_VERSION) return current;
    const step = typeof version === 'number' ? MIGRATIONS[version] : undefined;
    if (!step) throw new Error(`save format ${String(version)} cannot be migrated`);
    current = step(current);
  }
  throw new Error('save migration did not finish');
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
    appendFileSync(path.join(dir, 'history.jsonl'), `${JSON.stringify({ rev: record.rev, kind: record.kind, input: record.input, events, firings, hash: record.hash })}\n`);
  }

  appendAiCall(matchId: string, record: AiCallRecord): void {
    const dir = this.dir(matchId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'ai-calls.jsonl'), `${JSON.stringify(record)}\n`);
  }

  /** Writes the snapshot atomically (temp file + rename). */
  saveSnapshot(matchId: string, scenario: string, definition: unknown, state: GameState, minds: ContestantMind[], activeMs: number, rulesVersion: RulesVersion = { mechanical: 1, cosmetic: 0 }): string {
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
      rulesVersion,
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

  /** Every complete history line (with operation inputs), for replays; a torn last line is skipped. */
  readHistory(matchId: string): HistoryLine[] {
    const file = path.join(this.dir(matchId), 'history.jsonl');
    if (!existsSync(file)) return [];
    const out: HistoryLine[] = [];
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      let line: { rev?: unknown; kind?: unknown; input?: unknown; hash?: unknown; events?: unknown };
      try {
        line = JSON.parse(raw) as typeof line;
      } catch {
        break;
      }
      if (typeof line.rev !== 'number' || typeof line.kind !== 'string') break;
      out.push({ rev: line.rev, kind: line.kind as OperationRecord['kind'], input: line.input, hash: typeof line.hash === 'string' ? line.hash : undefined, events: Array.isArray(line.events) ? line.events : [], raw });
    }
    return out;
  }

  /** Replaces the history with the given lines, keeping the old file as a timestamped backup. */
  rewriteHistory(matchId: string, lines: HistoryLine[]): string {
    const dir = this.dir(matchId);
    const file = path.join(dir, 'history.jsonl');
    const backup = path.join(dir, `history-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}.jsonl.bak`);
    if (existsSync(file)) copyFileSync(file, backup);
    const snapshot = path.join(dir, 'snapshot.json');
    if (existsSync(snapshot)) copyFileSync(snapshot, `${backup.slice(0, -'.jsonl.bak'.length)}-snapshot.json.bak`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, lines.map((l) => `${l.raw}\n`).join(''));
    renameSync(tmp, file);
    return path.basename(backup);
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
