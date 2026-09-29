import type {
  CastMember,
  EnemyDef,
  FixtureDef,
  GameDefinition,
  ItemDef,
  ResourceDef,
  ShopDef,
  ShopEntry,
  SpaceDef,
  TagDef,
} from '../schema/definition.ts';
import type { Cond, Effect, EntityRef, Num, RuleDef, Selector, SpaceRef, TriggerEvent } from '../schema/rules.ts';

/**
 * Compiles a validated GameDefinition into indexed lookup tables and checks everything a JSON
 * schema cannot: references, bindings, static limits and rule cycles.
 */

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  ref?: string | undefined;
}

export interface CompiledRule {
  def: RuleDef;
  position: number;
}

export interface CompiledGame {
  def: GameDefinition;
  resources: Map<string, ResourceDef>;
  tags: Map<string, TagDef>;
  spaces: Map<string, SpaceDef>;
  spaceOrder: string[];
  /** Neighbors in connection order (stable). */
  adjacency: Map<string, string[]>;
  items: Map<string, ItemDef>;
  shops: Map<string, ShopDef>;
  shopEntries: Map<string, { shop: ShopDef; entry: ShopEntry }>;
  enemies: Map<string, EnemyDef>;
  fixtures: Map<string, FixtureDef>;
  cast: Map<string, CastMember>;
  rules: Map<string, CompiledRule>;
  /** Enabled reaction rules by trigger event, sorted by (priority, position). */
  ruleIndex: Map<TriggerEvent, CompiledRule[]>;
  diagnostics: Diagnostic[];
}

export class CompileError extends Error {
  override readonly name = 'CompileError';
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.filter((d) => d.severity === 'error').map((d) => d.message).join('\n'));
    this.diagnostics = diagnostics;
  }
}

export const STATIC_LIMITS = { nodesPerRule: 64, depth: 4, effectsPerList: 12 } as const;

/** Bindings each trigger provides. */
export const TRIGGER_BINDINGS: Record<TriggerEvent, { entities: Array<'$actor' | '$target'>; space: boolean; amount: boolean }> = {
  roundStarted: { entities: [], space: false, amount: false },
  roundEnded: { entities: [], space: false, amount: false },
  turnStarted: { entities: ['$actor'], space: false, amount: false },
  turnEnded: { entities: ['$actor'], space: false, amount: false },
  left: { entities: ['$actor'], space: true, amount: false },
  entered: { entities: ['$actor'], space: true, amount: false },
  landed: { entities: ['$actor'], space: true, amount: false },
  resourceChanged: { entities: ['$target'], space: false, amount: true },
  purchased: { entities: ['$actor', '$target'], space: false, amount: false },
  defeated: { entities: ['$actor', '$target'], space: false, amount: false },
  itemGained: { entities: ['$actor'], space: false, amount: false },
};

interface Scope {
  entities: Set<string>;
  space: boolean;
  amount: boolean;
  it: boolean;
}

function indexById<T extends { id: string }>(list: T[], kind: string, diags: Diagnostic[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of list) {
    if (map.has(item.id)) diags.push({ severity: 'error', code: 'duplicate-id', message: `Duplicate ${kind} id "${item.id}"`, ref: item.id });
    map.set(item.id, item);
  }
  return map;
}

export function compileGame(def: GameDefinition): CompiledGame {
  const diags: Diagnostic[] = [];
  const resources = indexById(def.resources, 'resource', diags);
  const tags = indexById(def.tags, 'tag', diags);
  const spaces = indexById(def.spaces, 'space', diags);
  const items = indexById(def.items, 'item', diags);
  const shops = indexById(def.shops, 'shop', diags);
  const enemies = indexById(def.enemies, 'enemy', diags);
  const fixtures = indexById(def.fixtures, 'fixture', diags);
  const cast = indexById(def.cast, 'cast member', diags);
  const ruleDefs = indexById(def.rules, 'rule', diags);

  const err = (code: string, message: string, ref?: string) => diags.push({ severity: 'error', code, message, ref });
  const needResource = (id: string, where: string) => {
    if (!resources.has(id)) err('unknown-resource', `${where}: unknown resource "${id}"`, id);
  };
  const needTag = (id: string, where: string) => {
    if (!tags.has(id)) err('unknown-tag', `${where}: unknown tag "${id}"`, id);
  };
  const needSpace = (id: string, where: string) => {
    if (!spaces.has(id)) err('unknown-space', `${where}: unknown space "${id}"`, id);
  };
  const needItem = (id: string, where: string) => {
    if (!items.has(id)) err('unknown-item', `${where}: unknown item "${id}"`, id);
  };

  // --- settings -----------------------------------------------------------------------------
  const s = def.settings;
  for (const [role, id] of Object.entries(s.core)) needResource(id, `settings.core.${role}`);
  needSpace(s.startSpace, 'settings.startSpace');
  needResource(s.victory.resource, 'settings.victory.resource');
  for (const id of s.victory.ranking) needResource(id, 'settings.victory.ranking');
  if (s.combat.damage.min > s.combat.damage.max) err('bad-damage', 'combat.damage.min is greater than combat.damage.max');
  const power = resources.get(s.core.power);
  if (power && power.role !== 'stat') err('power-role', `Power resource "${power.id}" must have role "stat"`);
  if (power && power.min < 1) err('power-min', `Power resource "${power.id}" must have min ≥ 1 (the wheel divides by Power)`);
  const hp = resources.get(s.core.hp);
  if (hp && hp.maxFrom !== s.core.maxHp) err('hp-max', `HP resource must use maxFrom "${s.core.maxHp}"`);

  // --- resources ----------------------------------------------------------------------------
  for (const r of def.resources) {
    if (r.max !== null && r.min > r.max) err('bad-bounds', `Resource "${r.id}" has min > max`, r.id);
    if (r.default < r.min || (r.max !== null && r.default > r.max)) err('bad-default', `Resource "${r.id}" default is out of bounds`, r.id);
    if (r.maxFrom !== undefined) {
      const other = resources.get(r.maxFrom);
      if (!other) err('unknown-resource', `Resource "${r.id}" maxFrom unknown "${r.maxFrom}"`, r.id);
      else if (other.maxFrom !== undefined) err('maxfrom-chain', `Resource "${r.id}" maxFrom must not chain`, r.id);
    }
  }

  // --- board --------------------------------------------------------------------------------
  const adjacency = new Map<string, string[]>();
  for (const space of def.spaces) {
    adjacency.set(space.id, []);
    for (const t of space.tags) needTag(t, `space ${space.id}`);
    if (!def.layout.positions[space.id]) err('missing-layout', `Space "${space.id}" has no layout position`, space.id);
  }
  for (const c of def.connections) {
    needSpace(c.a, 'connection');
    needSpace(c.b, 'connection');
    if (c.a === c.b) err('self-connection', `Connection from "${c.a}" to itself`);
    adjacency.get(c.a)?.push(c.b);
    if (!c.directed) adjacency.get(c.b)?.push(c.a);
  }
  // Connectivity warning from the start space.
  if (spaces.has(s.startSpace)) {
    const seen = new Set([s.startSpace]);
    const queue = [s.startSpace];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      for (const n of adjacency.get(cur) ?? []) if (!seen.has(n)) (seen.add(n), queue.push(n));
    }
    for (const space of def.spaces) {
      if (!seen.has(space.id)) diags.push({ severity: 'warning', code: 'unreachable-space', message: `Space "${space.name}" cannot be reached from the start`, ref: space.id });
    }
  }

  // --- items, shops, enemies, fixtures -----------------------------------------------------------
  for (const item of def.items) {
    for (const t of item.tags) needTag(t, `item ${item.id}`);
    for (const m of item.modifiers) {
      needResource(m.resource, `item ${item.id}`);
      if (resources.get(m.resource)?.role === 'pool') err('modifier-on-pool', `Item "${item.id}" modifies pool resource "${m.resource}"; only stats take modifiers`, item.id);
    }
  }
  const shopEntries = new Map<string, { shop: ShopDef; entry: ShopEntry }>();
  for (const shop of def.shops) {
    for (const entry of shop.entries) {
      if (shopEntries.has(entry.id)) err('duplicate-id', `Duplicate shop entry id "${entry.id}"`, entry.id);
      shopEntries.set(entry.id, { shop, entry });
      needResource(entry.price.resource, `shop entry ${entry.id}`);
      if ('item' in entry.grants) needItem(entry.grants.item, `shop entry ${entry.id}`);
      else needResource(entry.grants.resource, `shop entry ${entry.id}`);
    }
  }
  for (const enemy of def.enemies) {
    for (const t of enemy.tags) needTag(t, `enemy ${enemy.id}`);
    for (const sp of enemy.spawns) needSpace(sp, `enemy ${enemy.id} spawn`);
    const scope: Scope = { entities: new Set(['$actor', '$target']), space: false, amount: false, it: false };
    checkEffects(enemy.rewards, scope, `enemy ${enemy.id} rewards`);
  }
  for (const f of def.fixtures) {
    for (const t of f.tags) needTag(t, `fixture ${f.id}`);
    if (f.shop !== undefined && !shops.has(f.shop)) err('unknown-shop', `Fixture "${f.id}" uses unknown shop "${f.shop}"`, f.id);
    if ('space' in f.start) needSpace(f.start.space, `fixture ${f.id}`);
    else needTag(f.start.randomSpaceTag, `fixture ${f.id}`);
  }

  // --- rules --------------------------------------------------------------------------------
  function checkEntityRef(ref: EntityRef, scope: Scope, where: string): void {
    if (typeof ref === 'string') {
      if (ref === '$it' ? !scope.it : !scope.entities.has(ref)) err('unbound', `${where}: binding ${ref} is not available here`);
    }
  }
  function checkSpaceRef(ref: SpaceRef, scope: Scope, where: string): void {
    if (ref === '$space') {
      if (!scope.space) err('unbound', `${where}: binding $space is not available here`);
      return;
    }
    switch (ref.op) {
      case 'space':
        needSpace(ref.id, where);
        return;
      case 'spaceOf':
        checkEntityRef(ref.entity, scope, where);
        return;
      case 'randomSpace':
        needTag(ref.tag, where);
        if (ref.excludeSpaceOf !== undefined) checkEntityRef(ref.excludeSpaceOf, scope, where);
        return;
    }
  }
  function checkSelector(sel: Selector, scope: Scope, where: string): void {
    if (typeof sel === 'string') return checkEntityRef(sel, scope, where);
    switch (sel.op) {
      case 'entity':
      case 'all':
        return;
      case 'at':
        return checkSpaceRef(sel.space, scope, where);
      case 'withTag':
        return needTag(sel.tag, where);
      case 'filter':
        checkSelector(sel.from, scope, where);
        return checkCond(sel.where, { ...scope, it: true }, where);
      case 'random':
        return checkSelector(sel.from, scope, where);
    }
  }
  function checkNum(num: Num, scope: Scope, where: string): void {
    if (typeof num === 'number') return;
    switch (num.op) {
      case 'res':
      case 'stat':
        needResource(num.resource, where);
        return checkEntityRef(num.of, scope, where);
      case 'roll':
      case 'round':
        return;
      case 'amount':
        if (!scope.amount) err('unbound', `${where}: {op:"amount"} is only available for resourceChanged triggers`);
        return;
      case 'add':
      case 'mul':
      case 'min':
      case 'max':
        return num.args.forEach((a) => checkNum(a, scope, where));
      case 'sub':
      case 'div':
        checkNum(num.a, scope, where);
        return checkNum(num.b, scope, where);
      case 'count':
        return checkSelector(num.of, scope, where);
    }
  }
  function checkCond(cond: Cond, scope: Scope, where: string): void {
    switch (cond.op) {
      case 'all':
      case 'any':
        return cond.conds.forEach((c) => checkCond(c, scope, where));
      case 'not':
        return checkCond(cond.cond, scope, where);
      case 'hasTag':
        needTag(cond.tag, where);
        return checkEntityRef(cond.entity, scope, where);
      case 'spaceHasTag':
        needTag(cond.tag, where);
        return checkSpaceRef(cond.space, scope, where);
      case 'isKind':
        return checkEntityRef(cond.entity, scope, where);
      case 'holds':
        needItem(cond.item, where);
        return checkEntityRef(cond.entity, scope, where);
      case 'compare':
        checkNum(cond.left, scope, where);
        return checkNum(cond.right, scope, where);
      case 'exists':
        return checkSelector(cond.of, scope, where);
    }
  }
  function checkEffects(effects: Effect[], scope: Scope, where: string): void {
    if (effects.length > STATIC_LIMITS.effectsPerList) err('too-many-effects', `${where}: more than ${STATIC_LIMITS.effectsPerList} effects`);
    for (const e of effects) checkEffect(e, scope, where);
  }
  function checkEffect(e: Effect, scope: Scope, where: string): void {
    switch (e.op) {
      case 'changeResource':
        needResource(e.resource, where);
        checkSelector(e.target, scope, where);
        return checkNum(e.amount, scope, where);
      case 'setResource':
        needResource(e.resource, where);
        checkSelector(e.target, scope, where);
        return checkNum(e.value, scope, where);
      case 'transfer':
        needResource(e.resource, where);
        checkEntityRef(e.from, scope, where);
        checkEntityRef(e.to, scope, where);
        return checkNum(e.amount, scope, where);
      case 'addTag':
      case 'removeTag':
        needTag(e.tag, where);
        return checkSelector(e.target, scope, where);
      case 'teleport':
        checkSelector(e.target, scope, where);
        return checkSpaceRef(e.to, scope, where);
      case 'grantItem':
        needItem(e.item, where);
        return checkEntityRef(e.target, scope, where);
      case 'fight':
        checkSelector(e.attacker, scope, where);
        return checkSelector(e.defender, scope, where);
      case 'announce':
        return;
      case 'if':
        checkCond(e.cond, scope, where);
        checkEffects(e.then, scope, where);
        if (e.else) checkEffects(e.else, scope, where);
        return;
      case 'forEach':
        checkSelector(e.of, scope, where);
        return checkEffects(e.do, { ...scope, it: true }, where);
      case 'randomBranch':
        return e.branches.forEach((b) => checkEffects(b.do, scope, where));
    }
  }

  const rules = new Map<string, CompiledRule>();
  const ruleIndex = new Map<TriggerEvent, CompiledRule[]>();
  def.rules.forEach((rule, position) => {
    const where = `rule "${rule.name}"`;
    const bindings = TRIGGER_BINDINGS[rule.trigger.event];
    const scope: Scope = { entities: new Set(bindings.entities), space: bindings.space, amount: bindings.amount, it: false };
    const w = rule.trigger.where;
    if (w?.spaceTag !== undefined) needTag(w.spaceTag, where);
    if (w?.space !== undefined) needSpace(w.space, where);
    if (w?.resource !== undefined) needResource(w.resource, where);
    if (w?.targetTag !== undefined) needTag(w.targetTag, where);
    if (w?.item !== undefined) needItem(w.item, where);
    if (w?.shopEntry !== undefined && !shopEntries.has(w.shopEntry)) err('unknown-entry', `${where}: unknown shop entry "${w.shopEntry}"`);
    if (rule.conditions) checkCond(rule.conditions, scope, where);
    checkEffects(rule.effects, scope, where);
    const size = measure(rule);
    if (size.nodes > STATIC_LIMITS.nodesPerRule) err('rule-too-large', `${where}: ${size.nodes} expression nodes (limit ${STATIC_LIMITS.nodesPerRule})`, rule.id);
    if (size.depth > STATIC_LIMITS.depth) err('rule-too-deep', `${where}: nesting depth ${size.depth} (limit ${STATIC_LIMITS.depth})`, rule.id);
    const compiled: CompiledRule = { def: rule, position };
    rules.set(rule.id, compiled);
    if (rule.enabled) {
      const list = ruleIndex.get(rule.trigger.event) ?? [];
      list.push(compiled);
      ruleIndex.set(rule.trigger.event, list);
    }
  });
  for (const list of ruleIndex.values()) list.sort((a, b) => a.def.priority - b.def.priority || a.position - b.position);

  const game: CompiledGame = {
    def,
    resources,
    tags,
    spaces,
    spaceOrder: def.spaces.map((sp) => sp.id),
    adjacency,
    items,
    shops,
    shopEntries,
    enemies,
    fixtures,
    cast,
    rules,
    ruleIndex,
    diagnostics: diags,
  };
  diags.push(...findRuleCycles(game));
  if (diags.some((d) => d.severity === 'error')) throw new CompileError(diags);
  return game;
}

/** Counts expression nodes and container nesting depth of a rule. */
function measure(rule: RuleDef): { nodes: number; depth: number } {
  let nodes = 0;
  let maxDepth = 0;
  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, depth));
      return;
    }
    const obj = value as Record<string, unknown>;
    if (typeof obj['op'] === 'string') {
      nodes++;
      const op = obj['op'];
      const container = op === 'all' || op === 'any' || op === 'not' || op === 'if' || op === 'forEach' || op === 'randomBranch' || op === 'filter';
      const d = container ? depth + 1 : depth;
      maxDepth = Math.max(maxDepth, d);
      for (const [k, v] of Object.entries(obj)) if (k !== 'op') visit(v, d);
      return;
    }
    for (const v of Object.values(obj)) visit(v, depth);
  };
  visit(rule.conditions, 0);
  visit(rule.effects, 0);
  return { nodes, depth: maxDepth };
}

// ---------------------------------------------------------------------------------------------
// Cycle analysis: which events can each rule emit, and which rules do those events trigger?
// Conservative (over-approximates), used for warnings only; runtime budgets are the safeguard.
// ---------------------------------------------------------------------------------------------

interface Emission {
  event: TriggerEvent;
  resource?: string | undefined;
}

function emissionsOf(game: CompiledGame, effects: Effect[], out: Emission[], seenEnemies: Set<string>): void {
  const core = game.def.settings.core;
  for (const e of effects) {
    switch (e.op) {
      case 'changeResource':
      case 'setResource':
      case 'transfer':
        out.push({ event: 'resourceChanged', resource: e.resource });
        break;
      case 'teleport':
        out.push({ event: 'left' }, { event: 'entered' });
        if (e.asLanding) out.push({ event: 'landed' });
        break;
      case 'grantItem':
        out.push({ event: 'itemGained' });
        break;
      case 'fight':
        out.push(
          { event: 'resourceChanged', resource: core.hp },
          { event: 'defeated' },
          { event: 'resourceChanged', resource: core.gold },
          { event: 'left' },
          { event: 'entered' },
        );
        for (const enemy of game.enemies.values()) {
          if (seenEnemies.has(enemy.id)) continue;
          seenEnemies.add(enemy.id);
          emissionsOf(game, enemy.rewards, out, seenEnemies);
        }
        break;
      case 'if':
        emissionsOf(game, e.then, out, seenEnemies);
        if (e.else) emissionsOf(game, e.else, out, seenEnemies);
        break;
      case 'forEach':
        emissionsOf(game, e.do, out, seenEnemies);
        break;
      case 'randomBranch':
        for (const b of e.branches) emissionsOf(game, b.do, out, seenEnemies);
        break;
      case 'addTag':
      case 'removeTag':
      case 'announce':
        break;
    }
  }
}

function canTrigger(emission: Emission, rule: RuleDef): boolean {
  if (emission.event !== rule.trigger.event) return false;
  const want = rule.trigger.where?.resource;
  if (emission.event === 'resourceChanged' && want !== undefined && emission.resource !== undefined && want !== emission.resource) return false;
  return true;
}

export function findRuleCycles(game: CompiledGame): Diagnostic[] {
  const enabled = [...game.rules.values()].filter((r) => r.def.enabled);
  const edges = new Map<string, string[]>();
  for (const r of enabled) {
    const emits: Emission[] = [];
    emissionsOf(game, r.def.effects, emits, new Set());
    edges.set(
      r.def.id,
      enabled.filter((other) => emits.some((em) => canTrigger(em, other.def))).map((other) => other.def.id),
    );
  }
  // Tarjan's strongly connected components.
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const components: string[][] = [];
  const strong = (v: string): void => {
    indices.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!indices.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) as number, indices.get(w) as number));
    }
    if (low.get(v) === indices.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop() as string;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      components.push(comp);
    }
  };
  for (const r of enabled) if (!indices.has(r.def.id)) strong(r.def.id);

  const diags: Diagnostic[] = [];
  for (const comp of components) {
    const selfLoop = comp.length === 1 && (edges.get(comp[0] as string) ?? []).includes(comp[0] as string);
    if (comp.length < 2 && !selfLoop) continue;
    const names = comp.map((id) => `"${game.rules.get(id)?.def.name ?? id}"`).join(', ');
    const bounded = comp.every((id) => game.rules.get(id)?.def.limits?.maxPerTurn !== undefined);
    diags.push({
      severity: bounded ? 'info' : 'warning',
      code: 'rule-cycle',
      message: bounded
        ? `Rules ${names} can trigger each other, but per-turn limits bound the loop.`
        : `Rules ${names} can trigger each other in a loop. Runtime limits will stop a runaway chain; consider adding maxPerTurn.`,
      ref: comp[0],
    });
  }
  return diags;
}

export type { CastMember };
