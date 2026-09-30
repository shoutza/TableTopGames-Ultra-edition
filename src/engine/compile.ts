import type {
  ActionDef,
  CardDef,
  CastMember,
  DeckDef,
  EnemyDef,
  FixtureDef,
  GameDefinition,
  ItemDef,
  ObjectiveDef,
  ResourceDef,
  ShopDef,
  ShopEntry,
  SpaceDef,
  StatusDef,
  TagDef,
} from '../schema/definition.ts';
import { MODIFIER_BINDINGS, TRIGGER_BINDINGS, type ChoiceOption, type Cond, type Effect, type EntityRef, type ModifierEvent, type Num, type RuleDef, type Selector, type SpaceRef, type TriggerEvent, type TriggerWhere } from '../schema/rules.ts';

/**
 * Compiles a validated GameDefinition into indexed lookup tables and checks everything a JSON
 * schema cannot: references, bindings, static limits, view-safety of requirements, and rule cycles.
 */

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  ref?: string | undefined;
  /** The definition (resource, space, item, rule, card …) being checked when the problem was found. */
  at?: string | undefined;
}

/** The definition an attached rule belongs to; the rule is active only while its owner is held/present. */
export interface RuleOwner {
  kind: 'item' | 'status' | 'enemy';
  defId: string;
}

export interface CompiledRule {
  def: RuleDef;
  position: number;
  owner: RuleOwner | null;
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
  statuses: Map<string, StatusDef>;
  shops: Map<string, ShopDef>;
  shopEntries: Map<string, { shop: ShopDef; entry: ShopEntry }>;
  enemies: Map<string, EnemyDef>;
  fixtures: Map<string, FixtureDef>;
  decks: Map<string, DeckDef>;
  cards: Map<string, { deck: DeckDef; card: CardDef }>;
  actions: Map<string, ActionDef>;
  objectives: Map<string, ObjectiveDef>;
  cast: Map<string, CastMember>;
  /** Every rule, including rules attached to items, statuses and enemies. */
  rules: Map<string, CompiledRule>;
  /** Enabled reaction rules by trigger event, sorted by (priority, position). */
  ruleIndex: Map<TriggerEvent, CompiledRule[]>;
  /** Enabled modifier rules by the value they modify, sorted by (priority, position). */
  modifierIndex: Map<ModifierEvent, CompiledRule[]>;
  /** Enabled continuous rules. */
  continuous: CompiledRule[];
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

export { MODIFIER_BINDINGS, TRIGGER_BINDINGS };

interface Scope {
  entities: Set<string>;
  space: boolean;
  amount: boolean;
  it: boolean;
  /** Continuous rules: effective stats, randomness and $amount are not allowed. */
  pure?: boolean | undefined;
}

function indexById<T extends { id: string }>(list: T[], kind: string, diags: Diagnostic[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of list) {
    if (map.has(item.id)) diags.push({ severity: 'error', code: 'duplicate-id', message: `Duplicate ${kind} id "${item.id}"`, ref: item.id });
    map.set(item.id, item);
  }
  return map;
}

/** Visits every object with an `op` field inside a rule fragment. */
function visitOps(value: unknown, fn: (node: Record<string, unknown>) => void): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) visitOps(v, fn);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj['op'] === 'string') fn(obj);
  for (const v of Object.values(obj)) visitOps(v, fn);
}

export function compileGame(def: GameDefinition): CompiledGame {
  const diags: Diagnostic[] = [];
  const resources = indexById(def.resources, 'resource', diags);
  const tags = indexById(def.tags, 'tag', diags);
  const spaces = indexById(def.spaces, 'space', diags);
  const items = indexById(def.items, 'item', diags);
  const statuses = indexById(def.statuses, 'status', diags);
  const shops = indexById(def.shops, 'shop', diags);
  const enemies = indexById(def.enemies, 'enemy', diags);
  const fixtures = indexById(def.fixtures, 'fixture', diags);
  const decks = indexById(def.decks, 'deck', diags);
  const actions = indexById(def.actions, 'action', diags);
  const objectives = indexById(def.objectives, 'objective', diags);
  const cast = indexById(def.cast, 'cast member', diags);

  /** The definition currently being checked (recorded on its diagnostics, for the editor). */
  let at: string | undefined;
  const err = (code: string, message: string, ref?: string) => diags.push({ severity: 'error', code, message, ref, ...(at !== undefined ? { at } : {}) });
  const needResource = (id: string, where: string) => {
    if (!resources.has(id)) err('unknown-resource', `${where}: unknown resource "${id}"`, id);
  };
  const needStat = (id: string, where: string) => {
    needResource(id, where);
    if (resources.get(id)?.role === 'pool') err('modifier-on-pool', `${where}: modifies pool resource "${id}"; only stats take modifiers`, id);
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
  const needStatus = (id: string, where: string) => {
    if (!statuses.has(id)) err('unknown-status', `${where}: unknown status "${id}"`, id);
  };

  // --- settings -----------------------------------------------------------------------------
  const s = def.settings;
  for (const [role, id] of Object.entries(s.core)) needResource(id, `settings.core.${role}`);
  needSpace(s.startSpace, 'settings.startSpace');
  needResource(s.victory.resource, 'settings.victory.resource');
  for (const id of s.victory.ranking) needResource(id, 'settings.victory.ranking');
  if (s.movement.bonus !== undefined) needStat(s.movement.bonus, 'settings.movement.bonus');
  if (s.combat.damage.min > s.combat.damage.max) err('bad-damage', 'combat.damage.min is greater than combat.damage.max');
  const power = resources.get(s.core.power);
  if (power && power.role !== 'stat') err('power-role', `Power resource "${power.id}" must have role "stat"`);
  if (power && power.min < 1) err('power-min', `Power resource "${power.id}" must have min ≥ 1 (the wheel divides by Power)`);
  const hp = resources.get(s.core.hp);
  if (hp && hp.maxFrom !== s.core.maxHp) err('hp-max', `HP resource must use maxFrom "${s.core.maxHp}"`);

  // --- resources ----------------------------------------------------------------------------
  for (const r of def.resources) {
    at = r.id;
    if (r.max !== null && r.min > r.max) err('bad-bounds', `Resource "${r.id}" has min > max`, r.id);
    if (r.default < r.min || (r.max !== null && r.default > r.max)) err('bad-default', `Resource "${r.id}" default is out of bounds`, r.id);
    if (r.maxFrom !== undefined) {
      const other = resources.get(r.maxFrom);
      if (!other) err('unknown-resource', `Resource "${r.id}" maxFrom unknown "${r.maxFrom}"`, r.id);
      else if (other.maxFrom !== undefined) err('maxfrom-chain', `Resource "${r.id}" maxFrom must not chain`, r.id);
    }
    // Both sides of a trade must be able to see what changes hands.
    if (r.tradeable && (r.role !== 'pool' || r.visibility !== 'public' || !r.appliesTo.includes('contestant'))) {
      err('bad-tradeable', `Resource "${r.id}" is tradeable, so it must be a public pool resource of contestants`, r.id);
    }
  }

  // --- board --------------------------------------------------------------------------------
  const adjacency = new Map<string, string[]>();
  for (const space of def.spaces) {
    at = space.id;
    adjacency.set(space.id, []);
    for (const t of space.tags) needTag(t, `space ${space.id}`);
    if (!def.layout.positions[space.id]) err('missing-layout', `Space "${space.id}" has no layout position`, space.id);
  }
  at = undefined;
  for (const c of def.connections) {
    needSpace(c.a, 'connection');
    needSpace(c.b, 'connection');
    if (c.a === c.b) err('self-connection', `Connection from "${c.a}" to itself`);
    adjacency.get(c.a)?.push(c.b);
    if (!c.directed) adjacency.get(c.b)?.push(c.a);
  }
  if (spaces.has(s.startSpace)) {
    const seen = new Set([s.startSpace]);
    const queue = [s.startSpace];
    for (let head = 0; head < queue.length; head++) {
      for (const n of adjacency.get(queue[head] as string) ?? []) if (!seen.has(n)) (seen.add(n), queue.push(n));
    }
    for (const space of def.spaces) {
      if (!seen.has(space.id)) diags.push({ severity: 'warning', code: 'unreachable-space', message: `Space "${space.name}" cannot be reached from the start`, ref: space.id });
    }
  }

  // --- rule-language checks -----------------------------------------------------------------
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
        if (scope.pure) err('impure', `${where}: continuous rules cannot use randomness`);
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
        if (scope.pure) err('impure', `${where}: continuous rules cannot use randomness`);
        return checkSelector(sel.from, scope, where);
      case 'leader':
      case 'trailer':
        return needResource(sel.resource, where);
    }
  }
  function checkNum(num: Num, scope: Scope, where: string): void {
    if (typeof num === 'number') return;
    switch (num.op) {
      case 'res':
        needResource(num.resource, where);
        return checkEntityRef(num.of, scope, where);
      case 'stat':
        if (scope.pure) err('impure', `${where}: continuous rules may not read effective stats (use "res" for base values)`);
        needResource(num.resource, where);
        return checkEntityRef(num.of, scope, where);
      case 'roll':
        if (scope.pure) err('impure', `${where}: continuous rules cannot use randomness`);
        return;
      case 'round':
        return;
      case 'amount':
        if (!scope.amount) err('unbound', `${where}: {op:"amount"} is not available here`);
        return;
      case 'stacks':
        needStatus(num.status, where);
        return checkEntityRef(num.of, scope, where);
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
      case 'hasStatus':
        needStatus(cond.status, where);
        return checkEntityRef(cond.entity, scope, where);
      case 'same':
      case 'sameSpace':
        checkEntityRef(cond.a, scope, where);
        return checkEntityRef(cond.b, scope, where);
    }
  }
  /**
   * Requirements that decide what a contestant is offered must use only what that contestant
   * ($actor) can see, so the offered options never reveal hidden information.
   */
  function checkViewSafe(fragment: unknown, where: string): void {
    visitOps(fragment, (node) => {
      const op = node['op'];
      if ((op === 'res' || op === 'stat') && typeof node['resource'] === 'string') {
        const vis = resources.get(node['resource'])?.visibility;
        if (vis === 'gm' || (vis === 'owner' && node['of'] !== '$actor')) err('not-view-safe', `${where}: reads ${resources.get(node['resource'])?.name ?? node['resource']}, which the contestant may not see`);
      }
      if ((op === 'hasStatus' || op === 'stacks') && typeof node['status'] === 'string' && statuses.get(node['status'])?.visibility === 'hidden') {
        err('not-view-safe', `${where}: reads the hidden status "${node['status']}"`);
      }
      if (op === 'holds' && typeof node['item'] === 'string' && items.get(node['item'])?.concealed && node['entity'] !== '$actor') {
        err('not-view-safe', `${where}: checks for the concealed item "${node['item']}" on someone else`);
      }
    });
  }
  function checkChoiceOptions(options: ChoiceOption[], dflt: string, scope: Scope, where: string): void {
    const ids = new Set<string>();
    for (const o of options) {
      if (ids.has(o.id)) err('duplicate-id', `${where}: duplicate choice option "${o.id}"`);
      ids.add(o.id);
      const inner: Scope = { ...scope, entities: new Set([...scope.entities, '$actor']) };
      if (o.requires) {
        checkCond(o.requires, inner, `${where} option "${o.id}"`);
        checkViewSafe(o.requires, `${where} option "${o.id}"`);
      }
      checkEffects(o.effects, inner, `${where} option "${o.id}"`, true);
    }
    if (!ids.has(dflt)) err('bad-default', `${where}: default "${dflt}" is not one of the options`);
  }
  function checkEffects(effects: Effect[], scope: Scope, where: string, allowEmpty = false): void {
    if (effects.length > STATIC_LIMITS.effectsPerList) err('too-many-effects', `${where}: more than ${STATIC_LIMITS.effectsPerList} effects`);
    if (!allowEmpty && effects.length === 0) err('no-effects', `${where}: needs at least one effect`);
    for (const e of effects) checkEffect(e, scope, where);
  }
  function checkEffect(e: Effect, scope: Scope, where: string): void {
    switch (e.op) {
      case 'changeResource':
        needResource(e.resource, where);
        checkSelector(e.target, scope, where);
        return checkNum(e.amount, { ...scope, it: true }, where);
      case 'setResource':
        needResource(e.resource, where);
        checkSelector(e.target, scope, where);
        return checkNum(e.value, { ...scope, it: true }, where);
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
        return checkSpaceRef(e.to, { ...scope, it: true }, where);
      case 'grantItem':
        needItem(e.item, where);
        return checkEntityRef(e.target, scope, where);
      case 'transferItem':
        if (e.item !== 'random') needItem(e.item, where);
        checkEntityRef(e.from, scope, where);
        return checkEntityRef(e.to, scope, where);
      case 'loseItem':
        if (e.item !== 'random') needItem(e.item, where);
        return checkEntityRef(e.target, scope, where);
      case 'fight':
        checkSelector(e.attacker, scope, where);
        return checkSelector(e.defender, scope, where);
      case 'damage':
        checkSelector(e.target, scope, where);
        return checkNum(e.amount, { ...scope, it: true }, where);
      case 'applyStatus':
      case 'removeStatus':
        needStatus(e.status, where);
        return checkSelector(e.target, scope, where);
      case 'spawn':
        if (!enemies.has(e.enemy)) err('unknown-enemy', `${where}: unknown enemy "${e.enemy}"`, e.enemy);
        return checkSpaceRef(e.at, scope, where);
      case 'remove':
        return checkSelector(e.target, scope, where);
      case 'drawCard':
        if (!decks.has(e.deck)) err('unknown-deck', `${where}: unknown deck "${e.deck}"`, e.deck);
        return checkEntityRef(e.for, scope, where);
      case 'offerChoice':
        checkEntityRef(e.to, scope, where);
        return checkChoiceOptions(e.options, e.default, scope, `${where} choice`);
      case 'askGm': {
        if (e.about !== undefined) checkEntityRef(e.about, scope, where);
        // The GM sees everything, so option requirements need not be view-safe.
        const ids = new Set<string>();
        for (const o of e.options ?? []) {
          if (o.id === 'none') err('reserved-id', `${where}: "none" is the built-in "No effect" ruling`);
          if (ids.has(o.id)) err('duplicate-id', `${where}: duplicate ruling option "${o.id}"`);
          ids.add(o.id);
          if (o.requires) checkCond(o.requires, scope, `${where} ruling "${o.id}"`);
          checkEffects(o.effects, scope, `${where} ruling "${o.id}"`, true);
        }
        return;
      }
      case 'announce':
        return;
      case 'if':
        checkCond(e.cond, scope, where);
        checkEffects(e.then, scope, where, true);
        if (e.else) checkEffects(e.else, scope, where, true);
        return;
      case 'forEach':
        checkSelector(e.of, scope, where);
        return checkEffects(e.do, { ...scope, it: true }, where);
      case 'randomBranch':
        return e.branches.forEach((b) => checkEffects(b.do, scope, where, true));
    }
  }

  // --- items, statuses, shops, enemies, fixtures, decks, actions ----------------------------
  at = undefined;
  const slotIds = new Set<string>();
  for (const slot of s.equipment) {
    if (slotIds.has(slot.id)) err('duplicate-id', `Duplicate equipment slot id "${slot.id}"`, slot.id);
    slotIds.add(slot.id);
  }
  for (const item of def.items) {
    at = item.id;
    for (const t of item.tags) needTag(t, `item ${item.id}`);
    for (const m of item.modifiers) needStat(m.resource, `item ${item.id}`);
    if (item.slot !== undefined && !slotIds.has(item.slot)) err('unknown-slot', `item "${item.name}": unknown equipment slot "${item.slot}" (add it under settings → equipment)`, item.slot);
    const use = item.use;
    if (use) {
      const where = `item "${item.name}" use`;
      const scope: Scope = { entities: new Set(use.target ? ['$actor', '$holder', '$target'] : ['$actor', '$holder']), space: true, amount: false, it: false };
      checkEffects(use.effects, scope, where);
      if (use.requires) {
        checkCond(use.requires, { entities: new Set(['$actor', '$holder']), space: true, amount: false, it: false }, `${where} requirement`);
        checkViewSafe(use.requires, `${where} requirement`);
      }
      if (use.charges !== undefined && !use.consumed) diags.push({ severity: 'warning', code: 'charges-unused', message: `${where}: charges only count for items that are used up`, ref: item.id, at: item.id });
    }
  }
  for (const st of def.statuses) {
    at = st.id;
    for (const t of st.grantsTags) needTag(t, `status ${st.id}`);
    for (const m of st.modifiers) needStat(m.resource, `status ${st.id}`);
    if (st.stacking !== 'stack' && st.maxStacks > 1) diags.push({ severity: 'warning', code: 'stacks-unused', message: `Status "${st.name}" has maxStacks ${st.maxStacks} but stacking "${st.stacking}"`, ref: st.id });
  }
  const shopEntries = new Map<string, { shop: ShopDef; entry: ShopEntry }>();
  for (const shop of def.shops) {
    for (const entry of shop.entries) {
      at = entry.id;
      if (shopEntries.has(entry.id)) err('duplicate-id', `Duplicate shop entry id "${entry.id}"`, entry.id);
      shopEntries.set(entry.id, { shop, entry });
      needResource(entry.price.resource, `shop entry ${entry.id}`);
      if ('item' in entry.grants) needItem(entry.grants.item, `shop entry ${entry.id}`);
      else needResource(entry.grants.resource, `shop entry ${entry.id}`);
    }
  }
  for (const enemy of def.enemies) {
    at = enemy.id;
    for (const t of enemy.tags) needTag(t, `enemy ${enemy.id}`);
    for (const sp of enemy.spawns) needSpace(sp, `enemy ${enemy.id} spawn`);
    checkEffects(enemy.rewards, { entities: new Set(['$actor', '$target']), space: false, amount: false, it: false }, `enemy ${enemy.id} rewards`, true);
  }
  for (const f of def.fixtures) {
    at = f.id;
    for (const t of f.tags) needTag(t, `fixture ${f.id}`);
    if (f.shop !== undefined && !shops.has(f.shop)) err('unknown-shop', `Fixture "${f.id}" uses unknown shop "${f.shop}"`, f.id);
    if ('space' in f.start) needSpace(f.start.space, `fixture ${f.id}`);
    else needTag(f.start.randomSpaceTag, `fixture ${f.id}`);
  }
  const cards = new Map<string, { deck: DeckDef; card: CardDef }>();
  for (const deck of def.decks) {
    for (const card of deck.cards) {
      at = card.id;
      if (cards.has(card.id)) err('duplicate-id', `Duplicate card id "${card.id}"`, card.id);
      cards.set(card.id, { deck, card });
      checkEffects(card.effects, { entities: new Set(['$actor']), space: true, amount: false, it: false }, `card "${card.name}"`);
    }
  }
  for (const action of def.actions) {
    at = action.id;
    const where = `action "${action.name}"`;
    if (action.where?.space !== undefined) needSpace(action.where.space, where);
    if (action.where?.spaceTag !== undefined) needTag(action.where.spaceTag, where);
    if (action.cost) needResource(action.cost.resource, where);
    if (action.requires) {
      checkCond(action.requires, { entities: new Set(['$actor']), space: true, amount: false, it: false }, where);
      checkViewSafe(action.requires, where);
    }
    const scope: Scope = { entities: new Set(action.target ? ['$actor', '$target'] : ['$actor']), space: true, amount: false, it: false };
    checkEffects(action.effects, scope, where);
  }

  function checkTriggerWhere(w: TriggerWhere | undefined, where: string): void {
    if (w?.spaceTag !== undefined) needTag(w.spaceTag, where);
    if (w?.space !== undefined) needSpace(w.space, where);
    if (w?.resource !== undefined) needResource(w.resource, where);
    if (w?.targetTag !== undefined) needTag(w.targetTag, where);
    if (w?.item !== undefined) needItem(w.item, where);
    if (w?.status !== undefined) needStatus(w.status, where);
    if (w?.deck !== undefined && !decks.has(w.deck)) err('unknown-deck', `${where}: unknown deck "${w.deck}"`);
    if (w?.card !== undefined && !cards.has(w.card)) err('unknown-card', `${where}: unknown card "${w.card}"`);
    if (w?.action !== undefined && !actions.has(w.action)) err('unknown-action', `${where}: unknown action "${w.action}"`);
    if (w?.enemy !== undefined && !enemies.has(w.enemy)) err('unknown-enemy', `${where}: unknown enemy "${w.enemy}"`);
    if (w?.shopEntry !== undefined && !shopEntries.has(w.shopEntry)) err('unknown-entry', `${where}: unknown shop entry "${w.shopEntry}"`);
  }

  // --- objectives ---------------------------------------------------------------------------
  for (const o of def.objectives) {
    at = o.id;
    const where = `objective "${o.name}"`;
    if (o.goal.kind === 'count') {
      if (!TRIGGER_BINDINGS[o.goal.trigger.event].entities.includes('$actor')) {
        err('bad-objective', `${where}: "${o.goal.trigger.event}" events have no acting contestant to count`, o.id);
      }
      checkTriggerWhere(o.goal.trigger.where, where);
    } else {
      needResource(o.goal.resource, where);
      const r = resources.get(o.goal.resource);
      if (r && !r.appliesTo.includes('contestant')) err('bad-objective', `${where}: contestants have no ${r.name}`, o.id);
      if (r && r.visibility !== 'public' && r.visibility !== 'owner') err('bad-objective', `${where}: the owner cannot see ${r.name}`, o.id);
      if (r && r.default >= o.goal.atLeast) diags.push({ severity: 'warning', code: 'objective-trivial', message: `${where} is complete from the start`, ref: o.id });
    }
    checkEffects(o.reward, { entities: new Set(['$actor']), space: false, amount: false, it: false }, `${where} reward`);
  }

  // --- rules --------------------------------------------------------------------------------
  const rules = new Map<string, CompiledRule>();
  const ruleIndex = new Map<TriggerEvent, CompiledRule[]>();
  const modifierIndex = new Map<ModifierEvent, CompiledRule[]>();
  const continuous: CompiledRule[] = [];
  let position = 0;

  function compileRule(rule: RuleDef, owner: RuleOwner | null): void {
    at = rule.id;
    const where = `rule "${rule.name}"${owner ? ` (on ${owner.kind} ${owner.defId})` : ''}`;
    if (rules.has(rule.id)) err('duplicate-id', `Duplicate rule id "${rule.id}"`, rule.id);
    const holder: string[] = owner ? ['$holder'] : [];
    switch (rule.kind) {
      case 'reaction': {
        const bindings = TRIGGER_BINDINGS[rule.trigger.event];
        const scope: Scope = { entities: new Set([...bindings.entities, ...holder]), space: bindings.space, amount: bindings.amount, it: false };
        checkTriggerWhere(rule.trigger.where, where);
        if (rule.conditions) checkCond(rule.conditions, scope, where);
        checkEffects(rule.effects, scope, where);
        break;
      }
      case 'modifier': {
        const scope: Scope = { entities: new Set([...MODIFIER_BINDINGS[rule.on], ...holder]), space: false, amount: true, it: false };
        const w = rule.where;
        if (w?.resource !== undefined) needResource(w.resource, where);
        if (w?.targetTag !== undefined) needTag(w.targetTag, where);
        if (w?.status !== undefined) needStatus(w.status, where);
        if (w?.shopEntry !== undefined && !shopEntries.has(w.shopEntry)) err('unknown-entry', `${where}: unknown shop entry "${w.shopEntry}"`);
        if (rule.conditions) checkCond(rule.conditions, scope, where);
        if (rule.modify.op === 'add') checkNum(rule.modify.amount, scope, where);
        if (rule.modify.op === 'clampTo') {
          if (rule.modify.min !== undefined) checkNum(rule.modify.min, scope, where);
          if (rule.modify.max !== undefined) checkNum(rule.modify.max, scope, where);
        }
        if (rule.on === 'price' && rule.modify.op === 'prevent') err('bad-modifier', `${where}: prices can be changed but not prevented`);
        if (rule.on === 'price' || rule.on === 'moveRoll') {
          // Prices and rolls are shown to contestants before they act, so they must be explainable.
          if (rule.visibility !== 'public') err('hidden-modifier', `${where}: ${rule.on} modifiers must be public`);
          checkViewSafe([rule.conditions, rule.modify], where);
        }
        if (rule.consume) {
          if ('status' in rule.consume) needStatus(rule.consume.status, where);
          else if (owner?.kind !== 'item') err('bad-consume', `${where}: only rules attached to an item can consume it`);
        }
        break;
      }
      case 'continuous': {
        const scope: Scope = { entities: new Set(holder), space: false, amount: false, it: false, pure: true };
        checkSelector(rule.applies, scope, where);
        const inner: Scope = { ...scope, it: true };
        if (rule.when) checkCond(rule.when, inner, where);
        for (const m of rule.modifiers) {
          needStat(m.resource, where);
          checkNum(m.add, inner, where);
        }
        if (rule.modifiers.length === 0 && rule.suppress.length === 0) diags.push({ severity: 'warning', code: 'no-effect', message: `${where} has no modifiers and suppresses nothing`, ref: rule.id });
        break;
      }
    }
    const size = measure(rule);
    if (size.nodes > STATIC_LIMITS.nodesPerRule) err('rule-too-large', `${where}: ${size.nodes} expression nodes (limit ${STATIC_LIMITS.nodesPerRule})`, rule.id);
    if (size.depth > STATIC_LIMITS.depth) err('rule-too-deep', `${where}: nesting depth ${size.depth} (limit ${STATIC_LIMITS.depth})`, rule.id);
    const compiled: CompiledRule = { def: rule, position: position++, owner };
    rules.set(rule.id, compiled);
    if (!rule.enabled) return;
    if (rule.kind === 'reaction') {
      const list = ruleIndex.get(rule.trigger.event) ?? [];
      list.push(compiled);
      ruleIndex.set(rule.trigger.event, list);
    } else if (rule.kind === 'modifier') {
      const list = modifierIndex.get(rule.on) ?? [];
      list.push(compiled);
      modifierIndex.set(rule.on, list);
    } else continuous.push(compiled);
  }

  for (const rule of def.rules) compileRule(rule, null);
  for (const item of def.items) for (const rule of item.rules) compileRule(rule, { kind: 'item', defId: item.id });
  for (const st of def.statuses) for (const rule of st.rules) compileRule(rule, { kind: 'status', defId: st.id });
  for (const enemy of def.enemies) for (const rule of enemy.rules) compileRule(rule, { kind: 'enemy', defId: enemy.id });
  const byOrder = (a: CompiledRule, b: CompiledRule) => a.def.priority - b.def.priority || a.position - b.position;
  for (const list of ruleIndex.values()) list.sort(byOrder);
  for (const list of modifierIndex.values()) list.sort(byOrder);
  continuous.sort(byOrder);

  const game: CompiledGame = {
    def,
    resources,
    tags,
    spaces,
    spaceOrder: def.spaces.map((sp) => sp.id),
    adjacency,
    items,
    statuses,
    shops,
    shopEntries,
    enemies,
    fixtures,
    decks,
    cards,
    actions,
    objectives,
    cast,
    rules,
    ruleIndex,
    modifierIndex,
    continuous,
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
      const container = op === 'all' || op === 'any' || op === 'not' || op === 'if' || op === 'forEach' || op === 'randomBranch' || op === 'filter' || op === 'offerChoice';
      const d = container ? depth + 1 : depth;
      maxDepth = Math.max(maxDepth, d);
      for (const [k, v] of Object.entries(obj)) if (k !== 'op') visit(v, d);
      return;
    }
    for (const v of Object.values(obj)) visit(v, depth);
  };
  switch (rule.kind) {
    case 'reaction':
      visit(rule.conditions, 0);
      visit(rule.effects, 0);
      break;
    case 'modifier':
      visit(rule.conditions, 0);
      visit(rule.modify, 0);
      break;
    case 'continuous':
      visit(rule.applies, 0);
      visit(rule.when, 0);
      visit(rule.modifiers, 0);
      break;
  }
  return { nodes, depth: maxDepth };
}

// ---------------------------------------------------------------------------------------------
// Cycle analysis: which events can each rule emit, and which rules do those events trigger?
// Conservative (over-approximates), used for warnings only; runtime budgets are the safeguard.
// Offered choices are deferred to later operations, so they cannot loop within one operation.
// ---------------------------------------------------------------------------------------------

interface Emission {
  event: TriggerEvent;
  resource?: string | undefined;
  status?: string | undefined;
}

function defeatEmissions(game: CompiledGame, out: Emission[], seen: Set<string>): void {
  const core = game.def.settings.core;
  out.push(
    { event: 'resourceChanged', resource: core.hp },
    { event: 'damaged' },
    { event: 'defeated' },
    { event: 'resourceChanged', resource: core.gold },
    { event: 'left' },
    { event: 'entered' },
    { event: 'statusRemoved' },
    { event: 'itemLost' },
  );
  for (const enemy of game.enemies.values()) {
    const key = `enemy:${enemy.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    emissionsOf(game, enemy.rewards, out, seen);
  }
}

function emissionsOf(game: CompiledGame, effects: Effect[], out: Emission[], seen: Set<string>): void {
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
      case 'transferItem':
        out.push({ event: 'itemLost' }, { event: 'itemGained' });
        break;
      case 'loseItem':
        out.push({ event: 'itemLost' });
        break;
      case 'fight':
      case 'damage':
        defeatEmissions(game, out, seen);
        break;
      case 'applyStatus':
        out.push({ event: 'statusApplied', status: e.status });
        break;
      case 'removeStatus':
        out.push({ event: 'statusRemoved', status: e.status });
        break;
      case 'spawn':
        out.push({ event: 'spawned' });
        break;
      case 'drawCard': {
        out.push({ event: 'cardDrawn' });
        const key = `deck:${e.deck}`;
        if (seen.has(key)) break;
        seen.add(key);
        for (const card of game.decks.get(e.deck)?.cards ?? []) emissionsOf(game, card.effects, out, seen);
        break;
      }
      case 'if':
        emissionsOf(game, e.then, out, seen);
        if (e.else) emissionsOf(game, e.else, out, seen);
        break;
      case 'forEach':
        emissionsOf(game, e.do, out, seen);
        break;
      case 'randomBranch':
        for (const b of e.branches) emissionsOf(game, b.do, out, seen);
        break;
      case 'addTag':
      case 'removeTag':
      case 'remove':
      case 'offerChoice':
      case 'askGm':
      case 'announce':
        break;
    }
  }
}

function canTrigger(emission: Emission, rule: RuleDef): boolean {
  if (rule.kind !== 'reaction' || emission.event !== rule.trigger.event) return false;
  const w = rule.trigger.where;
  if (emission.event === 'resourceChanged' && w?.resource !== undefined && emission.resource !== undefined && w.resource !== emission.resource) return false;
  if ((emission.event === 'statusApplied' || emission.event === 'statusRemoved') && w?.status !== undefined && emission.status !== undefined && w.status !== emission.status) return false;
  return true;
}

export function findRuleCycles(game: CompiledGame): Diagnostic[] {
  const enabled = [...game.rules.values()].filter((r) => r.def.enabled && r.def.kind === 'reaction');
  const edges = new Map<string, string[]>();
  for (const r of enabled) {
    const emits: Emission[] = [];
    if (r.def.kind === 'reaction') emissionsOf(game, r.def.effects, emits, new Set());
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
    const bounded = comp.every((id) => {
      const l = game.rules.get(id)?.def.limits;
      return l?.maxPerTurn !== undefined || l?.maxPerRound !== undefined || l?.maxPerGame !== undefined || l?.cooldownRounds !== undefined;
    });
    diags.push({
      severity: bounded ? 'info' : 'warning',
      code: 'rule-cycle',
      message: bounded
        ? `Rules ${names} can trigger each other, but their limits bound the loop.`
        : `Rules ${names} can trigger each other in a loop. Runtime limits will stop a runaway chain; consider adding a limit (e.g. maxPerTurn).`,
      ref: comp[0],
    });
  }
  return diags;
}

export type { CastMember };
