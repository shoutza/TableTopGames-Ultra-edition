import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkDefinition } from '../authoring/check.ts';
import type { CompiledGame } from '../engine/index.ts';

/**
 * The scenario library: built-in scenarios (content/starter, read-only) and the GM's own
 * (data/scenarios/<id>.json, created and edited in the editor). Files hold the definition JSON as
 * saved; each is checked when listed, and only valid ones can start a match.
 */

export interface ScenarioEntry {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  valid: boolean;
  spaces: number;
  rules: number;
  updatedAt: string | null;
}

export const SCENARIO_ID = /^[a-z0-9][a-z0-9_.-]{0,59}$/;

interface Loaded {
  json: unknown;
  game: CompiledGame | null;
  builtIn: boolean;
  updatedAt: string | null;
}

export class ScenarioLibrary {
  private readonly builtInDir: string;
  private readonly userDir: string;
  private readonly builtIn = new Map<string, Loaded>();
  /** Cache of the GM's scenarios, keyed by id, invalidated by file modification time. */
  private readonly cache = new Map<string, Loaded & { mtimeMs: number }>();

  constructor(builtInDir: string, dataDir: string) {
    this.builtInDir = builtInDir;
    this.userDir = path.join(dataDir, 'scenarios');
    mkdirSync(this.userDir, { recursive: true });
    for (const file of readdirSync(this.builtInDir).filter((f) => f.endsWith('.json'))) {
      const json: unknown = JSON.parse(readFileSync(path.join(this.builtInDir, file), 'utf8'));
      const { result, game } = checkDefinition(json);
      if (!game) throw new Error(`built-in scenario ${file} is invalid:\n${result.issues.map((i) => i.message).join('\n')}`);
      this.builtIn.set(game.def.id, { json, game, builtIn: true, updatedAt: null });
    }
  }

  private file(id: string): string {
    if (!SCENARIO_ID.test(id)) throw new Error(`invalid scenario id "${id}" (lowercase letters, digits, . _ -)`);
    return path.join(this.userDir, `${id}.json`);
  }

  isBuiltIn(id: string): boolean {
    return this.builtIn.has(id);
  }

  get(id: string): Loaded | null {
    const built = this.builtIn.get(id);
    if (built) return built;
    let file: string;
    try {
      file = this.file(id);
    } catch {
      return null;
    }
    if (!existsSync(file)) {
      this.cache.delete(id);
      return null;
    }
    const mtimeMs = statSync(file).mtimeMs;
    const cached = this.cache.get(id);
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      json = null;
    }
    const { game } = checkDefinition(json);
    const loaded = { json, game, builtIn: false, updatedAt: new Date(mtimeMs).toISOString(), mtimeMs };
    this.cache.set(id, loaded);
    return loaded;
  }

  list(): ScenarioEntry[] {
    const ids = [...this.builtIn.keys(), ...readdirSync(this.userDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((id) => SCENARIO_ID.test(id) && !this.builtIn.has(id))];
    const out: ScenarioEntry[] = [];
    for (const id of ids) {
      const s = this.get(id);
      if (!s) continue;
      const raw = (s.json ?? {}) as { name?: unknown; description?: unknown; spaces?: unknown[]; rules?: unknown[] };
      out.push({
        id,
        name: s.game?.def.name ?? (typeof raw.name === 'string' ? raw.name : id),
        description: s.game?.def.description ?? (typeof raw.description === 'string' ? raw.description : ''),
        builtIn: s.builtIn,
        valid: s.game !== null,
        spaces: Array.isArray(raw.spaces) ? raw.spaces.length : 0,
        rules: s.game?.rules.size ?? (Array.isArray(raw.rules) ? raw.rules.length : 0),
        updatedAt: s.updatedAt,
      });
    }
    return out.sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.name.localeCompare(b.name));
  }

  /** Saves one of the GM's scenarios (atomically). Built-in scenarios are read-only. */
  save(id: string, json: unknown): void {
    if (this.builtIn.has(id)) throw new Error(`"${id}" is a built-in scenario and cannot be changed; save a copy under a new id`);
    const file = this.file(id);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`);
    renameSync(tmp, file);
    this.cache.delete(id);
  }

  remove(id: string): boolean {
    if (this.builtIn.has(id)) throw new Error(`"${id}" is a built-in scenario and cannot be deleted`);
    const file = this.file(id);
    if (!existsSync(file)) return false;
    rmSync(file);
    this.cache.delete(id);
    return true;
  }
}
