import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(repoRoot, 'src');

/**
 * Which source areas each module may import, and which npm packages it may use.
 * Paths are relative to src/ and match either a directory prefix or an exact file.
 */
const RULES: Record<string, { internal: string[]; packages: string[] }> = {
  schema: { internal: ['schema/'], packages: ['zod'] },
  engine: { internal: ['engine/', 'schema/'], packages: [] },
  visibility: { internal: ['visibility/', 'engine/', 'schema/'], packages: [] },
  contestants: {
    internal: ['contestants/', 'visibility/', 'schema/', 'llm/port.ts', 'engine/combat.ts', 'engine/explain.ts'],
    packages: ['zod'],
  },
  authoring: { internal: ['authoring/', 'engine/', 'schema/'], packages: [] },
  shared: { internal: ['shared/', 'schema/'], packages: [] },
  web: { internal: ['web/', 'shared/', 'schema/'], packages: ['react', 'react-dom', 'zod'] },
};

/** Tokens that would make the engine nondeterministic or give it I/O. */
const ENGINE_FORBIDDEN = [/Math\.random/, /Date\.now/, /new Date\(/, /performance\.now/, /\bprocess\./, /setTimeout/, /console\./];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

export function importsOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2];
    if (spec) found.push(spec);
  }
  return found;
}

function packageName(spec: string): string {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0] ?? spec;
}

/** Returns human-readable violations for one file, or [] if it follows the rules. */
export function violationsFor(file: string, source: string): string[] {
  const rel = path.relative(srcRoot, file).split(path.sep).join('/');
  const moduleName = rel.split('/')[0] ?? '';
  const rule = RULES[moduleName];
  if (!rule) return [];
  const isTest = rel.endsWith('.test.ts');
  const problems: string[] = [];
  for (const spec of importsOf(source)) {
    if (spec.startsWith('.')) {
      const target = path.relative(srcRoot, path.resolve(path.dirname(file), spec)).split(path.sep).join('/');
      const allowed = rule.internal.some((prefix) => (prefix.endsWith('/') ? target.startsWith(prefix) : target === prefix));
      if (!allowed) problems.push(`${rel} imports ${target}`);
    } else {
      const pkg = packageName(spec);
      if (isTest && pkg === 'vitest') continue;
      if (!rule.packages.includes(pkg)) problems.push(`${rel} imports package ${spec}`);
    }
  }
  if (moduleName === 'engine' && !isTest) {
    for (const pattern of ENGINE_FORBIDDEN) {
      if (pattern.test(source)) problems.push(`${rel} uses forbidden ${pattern.source}`);
    }
  }
  if (moduleName === 'contestants' && !isTest && /\bGameState\b/.test(source)) {
    problems.push(`${rel} references GameState (contestants must only see ContestantView)`);
  }
  return problems;
}

describe('module boundaries', () => {
  it('every source file follows the import rules', () => {
    const problems = listSourceFiles(srcRoot).flatMap((file) => violationsFor(file, readFileSync(file, 'utf8')));
    expect(problems).toEqual([]);
  });

  it('detects forbidden imports in the engine', () => {
    const fakeEngineFile = path.join(srcRoot, 'engine/fake.ts');
    expect(violationsFor(fakeEngineFile, "import { useState } from 'react';")).toHaveLength(1);
    expect(violationsFor(fakeEngineFile, "import fs from 'node:fs';")).toHaveLength(1);
    expect(violationsFor(fakeEngineFile, "import { x } from '../server/main.ts';")).toHaveLength(1);
    expect(violationsFor(fakeEngineFile, 'const r = Math.random();')).toHaveLength(1);
    expect(violationsFor(fakeEngineFile, "import type { X } from '../schema/versions.ts';")).toEqual([]);
  });

  it('keeps GameState out of the contestant layer', () => {
    const fakeContestantFile = path.join(srcRoot, 'contestants/fake.ts');
    expect(violationsFor(fakeContestantFile, 'function f(s: GameState) {}')).toHaveLength(1);
  });
});
