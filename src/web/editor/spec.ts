import { CAPABILITIES, COMPARATORS, ENTITY_KINDS, MODIFIER_BINDINGS, MODIFIER_EVENTS, ROUNDING_MODES, TRIGGER_BINDINGS, TRIGGER_EVENTS } from '../../schema/rules.ts';

/**
 * Metadata for the rule language, used by the form editor to render any expression, condition,
 * selector or effect node (and nested lists of them) without hand-written forms per operation.
 * It mirrors src/schema/rules.ts; the server's check is the authority on validity.
 */

export type RefSection = 'resources' | 'tags' | 'spaceTags' | 'entityTags' | 'spaces' | 'items' | 'statuses' | 'enemies' | 'decks' | 'cards' | 'actions' | 'shopEntries' | 'shops';

export type FieldType =
  | { t: 'num' }
  | { t: 'cond' }
  | { t: 'selector' }
  | { t: 'entity' }
  | { t: 'space' }
  | { t: 'effects' }
  | { t: 'conds' }
  | { t: 'nums' }
  | { t: 'ref'; section: RefSection }
  | { t: 'text'; max: number; multiline?: boolean }
  | { t: 'int'; min?: number; max?: number }
  | { t: 'bool' }
  | { t: 'enum'; values: readonly string[]; labels?: Record<string, string> }
  | { t: 'options' }
  | { t: 'branches' };

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  optional?: boolean;
  help?: string;
}

export interface OpSpec {
  op: string;
  label: string;
  help?: string;
  fields: FieldSpec[];
}

export type NodeKind = 'num' | 'cond' | 'selector' | 'entity' | 'space' | 'effect';

const kind = { t: 'enum', values: ENTITY_KINDS } as const;
const num = (key: string, label: string, optional = false): FieldSpec => ({ key, label, type: { t: 'num' }, optional });
const entity = (key: string, label: string, optional = false): FieldSpec => ({ key, label, type: { t: 'entity' }, optional });
const selector = (key: string, label: string): FieldSpec => ({ key, label, type: { t: 'selector' } });
const ref = (key: string, label: string, section: RefSection, optional = false): FieldSpec => ({ key, label, type: { t: 'ref', section }, optional });

/** Bindings offered for entity references and selectors. */
export const ENTITY_BINDINGS: Record<string, string> = {
  $actor: 'who did it ($actor)',
  $target: 'who it happened to ($target)',
  $it: 'each one ($it, in filters and loops)',
  $holder: 'the holder ($holder, attached rules)',
};

export const NUM_OPS: OpSpec[] = [
  { op: 'res', label: 'resource of', help: 'Base value; ifMissing is used when the entity has no such resource.', fields: [entity('of', 'of'), ref('resource', 'resource', 'resources'), { key: 'ifMissing', label: 'if missing', type: { t: 'int' }, optional: true }] },
  { op: 'stat', label: 'effective stat of', help: 'Base value plus item, status and rule modifiers.', fields: [entity('of', 'of'), ref('resource', 'stat', 'resources')] },
  { op: 'roll', label: 'dice roll', fields: [{ key: 'count', label: 'dice', type: { t: 'int', min: 1, max: 10 } }, { key: 'sides', label: 'sides', type: { t: 'int', min: 2, max: 100 } }] },
  { op: 'add', label: 'sum', fields: [{ key: 'args', label: 'add up', type: { t: 'nums' } }] },
  { op: 'sub', label: 'difference', fields: [num('a', 'a'), num('b', 'minus b')] },
  { op: 'mul', label: 'product', fields: [{ key: 'args', label: 'multiply', type: { t: 'nums' } }] },
  { op: 'div', label: 'division', fields: [num('a', 'a'), num('b', 'divided by'), { key: 'rounding', label: 'rounding', type: { t: 'enum', values: ROUNDING_MODES } }] },
  { op: 'min', label: 'smallest of', fields: [{ key: 'args', label: 'values', type: { t: 'nums' } }] },
  { op: 'max', label: 'largest of', fields: [{ key: 'args', label: 'values', type: { t: 'nums' } }] },
  { op: 'count', label: 'count of', fields: [selector('of', 'entities')] },
  { op: 'stacks', label: 'status stacks', fields: [entity('of', 'on'), ref('status', 'status', 'statuses')] },
  { op: 'round', label: 'current round', fields: [] },
  { op: 'amount', label: 'the amount ($amount)', help: 'The change that triggered the rule, or the value a modifier changes.', fields: [] },
];

export const COND_OPS: OpSpec[] = [
  { op: 'all', label: 'all of (AND)', fields: [{ key: 'conds', label: 'conditions', type: { t: 'conds' } }] },
  { op: 'any', label: 'any of (OR)', fields: [{ key: 'conds', label: 'conditions', type: { t: 'conds' } }] },
  { op: 'not', label: 'not', fields: [{ key: 'cond', label: 'condition', type: { t: 'cond' } }] },
  { op: 'hasTag', label: 'has tag', fields: [entity('entity', 'who'), ref('tag', 'tag', 'entityTags')] },
  { op: 'spaceHasTag', label: 'space has tag', fields: [{ key: 'space', label: 'space', type: { t: 'space' } }, ref('tag', 'tag', 'spaceTags')] },
  { op: 'isKind', label: 'is a', fields: [entity('entity', 'who'), { key: 'kind', label: 'kind', type: kind }] },
  { op: 'holds', label: 'holds item', fields: [entity('entity', 'who'), ref('item', 'item', 'items')] },
  { op: 'compare', label: 'compare numbers', fields: [num('left', 'left'), { key: 'cmp', label: '', type: { t: 'enum', values: COMPARATORS } }, num('right', 'right')] },
  { op: 'exists', label: 'anyone matches', fields: [selector('of', 'selector')] },
  { op: 'hasStatus', label: 'has status', fields: [entity('entity', 'who'), ref('status', 'status', 'statuses'), { key: 'minStacks', label: 'min stacks', type: { t: 'int', min: 1, max: 99 }, optional: true }] },
  { op: 'same', label: 'is the same as', fields: [entity('a', 'a'), entity('b', 'b')] },
  { op: 'sameSpace', label: 'on the same space', fields: [entity('a', 'a'), entity('b', 'b')] },
];

export const SELECTOR_OPS: OpSpec[] = [
  { op: 'entity', label: 'a specific entity', fields: [{ key: 'id', label: 'entity id', type: { t: 'text', max: 80 } }] },
  { op: 'all', label: 'everyone', fields: [{ key: 'kind', label: 'kind', type: kind, optional: true }] },
  { op: 'at', label: 'everyone at', fields: [{ key: 'space', label: 'space', type: { t: 'space' } }, { key: 'kind', label: 'kind', type: kind, optional: true }] },
  { op: 'withTag', label: 'everyone tagged', fields: [ref('tag', 'tag', 'entityTags'), { key: 'kind', label: 'kind', type: kind, optional: true }] },
  { op: 'filter', label: 'those who …', help: 'Inside the condition, $it is each candidate.', fields: [selector('from', 'from'), { key: 'where', label: 'where', type: { t: 'cond' } }] },
  { op: 'random', label: 'random pick', fields: [selector('from', 'from'), { key: 'count', label: 'how many', type: { t: 'int', min: 1, max: 64 } }] },
  { op: 'leader', label: 'the leader in', fields: [ref('resource', 'resource', 'resources')] },
  { op: 'trailer', label: 'the last in', fields: [ref('resource', 'resource', 'resources')] },
];

export const SPACE_OPS: OpSpec[] = [
  { op: 'space', label: 'a specific space', fields: [ref('id', 'space', 'spaces')] },
  { op: 'spaceOf', label: 'where someone is', fields: [entity('entity', 'who')] },
  { op: 'randomSpace', label: 'a random space tagged', fields: [ref('tag', 'tag', 'spaceTags'), entity('excludeSpaceOf', 'not where', true)] },
];

export const EFFECT_OPS: OpSpec[] = [
  { op: 'changeResource', label: 'change resource', fields: [selector('target', 'who'), ref('resource', 'resource', 'resources'), num('amount', 'by')] },
  { op: 'setResource', label: 'set resource', fields: [selector('target', 'who'), ref('resource', 'resource', 'resources'), num('value', 'to')] },
  { op: 'transfer', label: 'transfer resource', fields: [entity('from', 'from'), entity('to', 'to'), ref('resource', 'resource', 'resources'), num('amount', 'amount'), { key: 'ifShort', label: 'if short', type: { t: 'enum', values: ['partial', 'skip'] }, optional: true }] },
  { op: 'damage', label: 'deal damage', fields: [selector('target', 'who'), num('amount', 'amount')] },
  { op: 'fight', label: 'start a fight', fields: [selector('attacker', 'attacker'), selector('defender', 'defender')] },
  { op: 'teleport', label: 'teleport', fields: [selector('target', 'who'), { key: 'to', label: 'to', type: { t: 'space' } }, { key: 'asLanding', label: 'counts as landing', type: { t: 'bool' }, optional: true }] },
  { op: 'addTag', label: 'add tag', fields: [selector('target', 'who'), ref('tag', 'tag', 'entityTags')] },
  { op: 'removeTag', label: 'remove tag', fields: [selector('target', 'who'), ref('tag', 'tag', 'entityTags')] },
  { op: 'applyStatus', label: 'apply status', fields: [selector('target', 'who'), ref('status', 'status', 'statuses'), { key: 'stacks', label: 'stacks', type: { t: 'int', min: 1, max: 10 }, optional: true }, { key: 'duration', label: 'duration', type: { t: 'int', min: 1, max: 99 }, optional: true }] },
  { op: 'removeStatus', label: 'remove status', fields: [selector('target', 'who'), ref('status', 'status', 'statuses'), { key: 'stacks', label: 'stacks', type: { t: 'int', min: 1, max: 99 }, optional: true }] },
  { op: 'grantItem', label: 'give item', fields: [entity('target', 'to'), ref('item', 'item', 'items'), { key: 'count', label: 'count', type: { t: 'int', min: 1, max: 5 }, optional: true }] },
  { op: 'transferItem', label: 'move item', fields: [entity('from', 'from'), entity('to', 'to'), ref('item', 'item', 'items')] },
  { op: 'loseItem', label: 'destroy item', fields: [entity('target', 'from'), ref('item', 'item', 'items')] },
  { op: 'spawn', label: 'spawn enemy', fields: [ref('enemy', 'enemy', 'enemies'), { key: 'at', label: 'at', type: { t: 'space' } }, { key: 'count', label: 'count', type: { t: 'int', min: 1, max: 3 }, optional: true }] },
  { op: 'remove', label: 'remove from the board', fields: [selector('target', 'who')] },
  { op: 'drawCard', label: 'draw a card', fields: [ref('deck', 'deck', 'decks'), entity('for', 'for')] },
  { op: 'offerChoice', label: 'offer a choice', help: 'The chooser picks one option; its effects run for them.', fields: [entity('to', 'to'), { key: 'prompt', label: 'prompt', type: { t: 'text', max: 200 } }, { key: 'options', label: 'options', type: { t: 'options' } }, { key: 'default', label: 'default option id', type: { t: 'text', max: 40 } }] },
  { op: 'askGm', label: 'ask the GM', help: 'The game waits for your ruling ("No effect" is always an option, and the result on timeout).', fields: [{ key: 'question', label: 'question', type: { t: 'text', max: 300 } }, entity('about', 'about', true), { key: 'options', label: 'rulings', type: { t: 'options' }, optional: true }] },
  { op: 'announce', label: 'announce', fields: [{ key: 'text', label: 'text', type: { t: 'text', max: 280 } }] },
  { op: 'if', label: 'if … then … else', fields: [{ key: 'cond', label: 'if', type: { t: 'cond' } }, { key: 'then', label: 'then', type: { t: 'effects' } }, { key: 'else', label: 'else', type: { t: 'effects' }, optional: true }] },
  { op: 'forEach', label: 'for each', help: 'Inside, $it is each entity.', fields: [selector('of', 'of'), { key: 'do', label: 'do', type: { t: 'effects' } }] },
  { op: 'randomBranch', label: 'random outcome', fields: [{ key: 'branches', label: 'outcomes', type: { t: 'branches' } }] },
];

export const OPS: Record<NodeKind, OpSpec[]> = { num: NUM_OPS, cond: COND_OPS, selector: SELECTOR_OPS, entity: [], space: SPACE_OPS, effect: EFFECT_OPS };

export const TRIGGERS = TRIGGER_EVENTS;
export const TRIGGER_LABELS: Record<string, string> = {
  roundStarted: 'a round starts',
  roundEnded: 'a round ends',
  turnStarted: 'a turn starts',
  turnEnded: 'a turn ends',
  left: 'someone leaves a space',
  entered: 'someone enters a space (passing through)',
  landed: 'someone lands on a space',
  resourceChanged: 'a resource changes',
  purchased: 'someone buys something',
  defeated: 'someone is defeated',
  itemGained: 'someone gains an item',
  itemLost: 'someone loses an item',
  itemUsed: 'someone uses an item',
  statusApplied: 'a status is applied',
  statusRemoved: 'a status ends',
  damaged: 'someone takes damage',
  cardDrawn: 'a card is drawn',
  actionUsed: 'someone uses an action',
  spawned: 'an enemy appears',
};
export const TRIGGER_WHERE: Record<string, Array<{ key: string; label: string; type: FieldType }>> = Object.fromEntries(
  TRIGGER_EVENTS.map((ev) => {
    const b = TRIGGER_BINDINGS[ev];
    const out: Array<{ key: string; label: string; type: FieldType }> = [];
    if (b.space) out.push({ key: 'space', label: 'on space', type: { t: 'ref', section: 'spaces' } }, { key: 'spaceTag', label: 'on a space tagged', type: { t: 'ref', section: 'spaceTags' } });
    if (b.entities.includes('$actor')) out.push({ key: 'actorKind', label: 'actor kind', type: kind });
    if (b.entities.includes('$target')) out.push({ key: 'targetKind', label: 'target kind', type: kind }, { key: 'targetTag', label: 'target tagged', type: { t: 'ref', section: 'entityTags' } });
    if (ev === 'resourceChanged') out.push({ key: 'resource', label: 'resource', type: { t: 'ref', section: 'resources' } }, { key: 'direction', label: 'direction', type: { t: 'enum', values: ['gain', 'loss'] } });
    if (ev === 'itemGained' || ev === 'itemLost' || ev === 'itemUsed') out.push({ key: 'item', label: 'item', type: { t: 'ref', section: 'items' } });
    if (ev === 'purchased') out.push({ key: 'shopEntry', label: 'shop entry', type: { t: 'ref', section: 'shopEntries' } });
    if (ev === 'statusApplied' || ev === 'statusRemoved') out.push({ key: 'status', label: 'status', type: { t: 'ref', section: 'statuses' } });
    if (ev === 'cardDrawn') out.push({ key: 'deck', label: 'deck', type: { t: 'ref', section: 'decks' } }, { key: 'card', label: 'card', type: { t: 'ref', section: 'cards' } });
    if (ev === 'actionUsed') out.push({ key: 'action', label: 'action', type: { t: 'ref', section: 'actions' } });
    if (ev === 'defeated' || ev === 'spawned') out.push({ key: 'enemy', label: 'enemy', type: { t: 'ref', section: 'enemies' } });
    return [ev, out];
  }),
);
export function triggerBindings(event: string): string[] {
  const b = TRIGGER_BINDINGS[event as keyof typeof TRIGGER_BINDINGS];
  if (!b) return [];
  return [...b.entities, ...(b.space ? ['$space'] : []), ...(b.amount ? ['$amount'] : [])];
}

export const MODIFIER_ONS = MODIFIER_EVENTS;
export const MODIFIER_LABELS: Record<string, string> = {
  damage: 'damage about to be dealt',
  resourceChange: 'a resource about to change',
  price: 'a shop price',
  moveRoll: 'a movement roll',
  statusApply: 'a status duration about to be applied',
};
export function modifierBindings(on: string): string[] {
  return [...(MODIFIER_BINDINGS[on as keyof typeof MODIFIER_BINDINGS] ?? []), '$amount'];
}
export const MODIFIER_WHERE: Array<{ key: string; label: string; type: FieldType }> = [
  { key: 'resource', label: 'resource', type: { t: 'ref', section: 'resources' } },
  { key: 'direction', label: 'direction', type: { t: 'enum', values: ['gain', 'loss'] } },
  { key: 'targetKind', label: 'target kind', type: kind },
  { key: 'targetTag', label: 'target tagged', type: { t: 'ref', section: 'entityTags' } },
  { key: 'status', label: 'status', type: { t: 'ref', section: 'statuses' } },
  { key: 'shopEntry', label: 'shop entry', type: { t: 'ref', section: 'shopEntries' } },
];
export const MODIFY_OPS: OpSpec[] = [
  { op: 'add', label: 'add', fields: [num('amount', 'amount')] },
  { op: 'scale', label: 'scale by a fraction', fields: [{ key: 'num', label: 'numerator', type: { t: 'int', min: 0, max: 1000 } }, { key: 'den', label: 'denominator', type: { t: 'int', min: 1, max: 1000 } }, { key: 'rounding', label: 'rounding', type: { t: 'enum', values: ROUNDING_MODES } }] },
  { op: 'clampTo', label: 'clamp', fields: [num('min', 'at least', true), num('max', 'at most', true)] },
  { op: 'prevent', label: 'prevent it entirely', fields: [] },
];
export const CAPABILITY_LIST = CAPABILITIES;
