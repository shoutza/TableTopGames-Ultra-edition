import { formatPercent } from '../engine/combat.ts';
import { describeCapabilityLoss, describeEvent, makeNames, type Names } from '../engine/explain.ts';
import type { Persona } from '../schema/persona.ts';
import type { PublicGameInfo, PublicRule } from '../visibility/public-info.ts';
import { threatWeight, type ContestantView, type FightHint, type Hint, type OptionPreview, type ViewEntity, type ViewGoods, type ViewNegotiation, type ViewObjective } from '../visibility/view.ts';
import { ARCHETYPE_INFO } from './strategy.ts';
import { relationshipLines, selectMemories } from './memory.ts';
import { traitGuidance, type ContestantMind } from './mind.ts';

/**
 * Decision packets: compact text built only from a ContestantView and the public rulebook.
 * The stable part (role, persona, rules) goes into `instructions`; the changing situation into
 * `input`. No sequence numbers or revisions are rendered, so hidden events leave no trace.
 *
 * Budget: a packet aims at PACKET_BUDGET estimated tokens. A large rulebook is digested more
 * compactly (the level is fixed per game and contestant, so the instructions stay cacheable);
 * at the most compact level, rules tied to particular spaces leave the instructions and the
 * ones that matter to a decision (scored by the spaces, items and statuses in play) are listed
 * with it. The situation then shrinks step by step (fewer events, nearby enemies only, shorter
 * rival lines) until the packet fits.
 */

export const PACKET_BUDGET = 2500;
/** The situation shrinks until the packet fits this, leaving headroom under the budget for estimate error. */
const PACKET_TARGET = PACKET_BUDGET - 100;
/**
 * The rulebook digest's share of the budget. The level depends on the game alone (not on the
 * contestant's persona), so all contestants of a match share it.
 */
const DIGEST_BUDGET = 1350;

/** 0 = everything, 1 = compact shops, decks and objectives, 2 = also space rules per decision. */
export type DigestLevel = 0 | 1 | 2;

export interface Packet {
  instructions: string;
  input: string;
  estimatedTokens: number;
}

export function namesFromView(info: PublicGameInfo, view: ContestantView): Names {
  const map = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]));
  const entries = new Map<string, { entry: { grants: { item: string } | { resource: string; amount: number } } }>();
  for (const shop of info.shops) {
    for (const e of shop.entries) {
      entries.set(e.id, { entry: { grants: e.grantsItem !== null ? { item: e.grantsItem } : { resource: e.grantsResource ?? '', amount: e.grantsAmount } } });
    }
  }
  const rules = new Map(info.rules.map((r) => [r.id, { def: { name: r.name } }]));
  const cards = new Map(info.decks.flatMap((d) => d.cards.map((c) => [c.id, { card: { name: c.name } }] as const)));
  const entityNames = new Map(view.entities.map((e) => [e.id, e.name]));
  return makeNames(
    {
      resources: map(info.resources),
      tags: map(info.tags),
      spaces: map(info.spaces),
      items: map(info.items),
      rules,
      shopEntries: entries,
      statuses: map(info.statuses),
      decks: map(info.decks),
      cards,
      actions: map(info.actions),
      enemies: map(info.enemies),
      objectives: map(info.objectives),
    },
    (id) => entityNames.get(id),
  );
}

const NOISE: ReadonlySet<string> = new Set([
  'left',
  'entered',
  'landed',
  'turnStarted',
  'turnEnded',
  'roundEnded',
  'spin',
  'matchStarted',
  'rolled',
  'passed',
  'damaged',
  'deckShuffled',
  'choiceOffered',
]);

/** Decisions whose own result event already says what happened ("used Pickpocket", "bought …"). */
const SELF_DESCRIBING = /^(act|atk|buy|use|ch):|^pass$/;

/** Events worth a model's attention: drops movement bookkeeping, per-spin HP updates and repeats. */
export function notableEvents(view: ContestantView): ContestantView['recentEvents'] {
  const spinSeqs = new Set(view.recentEvents.filter((e) => e.type === 'spin').map((e) => e.seq));
  const defeatedFights = new Set(view.recentEvents.flatMap((e) => (e.event.type === 'defeated' && e.event.fight !== null ? [e.event.fight] : [])));
  return view.recentEvents.filter((ve) => {
    if (NOISE.has(ve.type)) return false;
    const e = ve.event;
    if (e.type === 'moved' && e.mode === 'walk') return false;
    if (e.type === 'resourceChanged' && e.cause.parent !== undefined && spinSeqs.has(e.cause.parent)) return false;
    if (e.type === 'decided' && !e.say && SELF_DESCRIBING.test(e.option)) return false;
    if (e.type === 'fightEnded' && defeatedFights.has(e.fight)) return false;
    return true;
  });
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Numbers with a real minus sign ("−1"), matching the rest of the generated text. */
function num(v: number): string {
  return v < 0 ? `−${-v}` : String(v);
}

function resName(info: PublicGameInfo, id: string): string {
  return info.resources.find((r) => r.id === id)?.name ?? id;
}

/** Item text without what a buyer can do without ("stacks 3 per space", "while worn"). */
function shortItemText(text: string): string {
  return text
    .replace(/; stacks \d+ per space/g, '')
    .replace(/^worn \(([^)]+)\); /, '$1: ')
    .replace(/ while worn/g, '')
    .replace(/^use \(once\): /, '')
    .replace(/^use \((.*?)\): /, '($1) ');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function rulesDigest(info: PublicGameInfo, names: Names, level: DigestLevel = 0): string {
  const s = info.settings;
  const v = s.victory;
  const d = s.combat.damage;
  const damageText = d.ratioExponent === 1 ? `${d.base} × (winner Power ÷ loser Power)` : d.ratioExponent === 0.5 ? `${d.base} × √(winner Power ÷ loser Power)` : `${d.base}`;
  const bonus = s.movement.bonus !== undefined ? ` + your ${resName(info, s.movement.bonus)}` : '';
  const ko =
    s.ko.mode === 'eliminate'
      ? 'Reaching 0 HP eliminates you from the match; the last contestant standing wins.'
      : `Knocked out (0 HP): lose ${s.ko.goldLossPercent}% of your ${resName(info, s.core.gold)}${s.ko.lootToVictor ? ' (to the contestant who beat you, if any)' : ''}, return to ${names.space(s.startSpace)}, HP restored${s.ko.clearStatuses && info.statuses.length > 0 ? ', all statuses end' : ''}, skip ${s.ko.skipTurns} turn${s.ko.skipTurns === 1 ? '' : 's'}.`;
  const actionsLine = info.actions.length > 0 ? ['Special actions (as your main action):', ...info.actions.map((a) => `- ${a.name}: ${a.text}`)] : [];
  const tradeRes = info.resources.filter((r) => r.tradeable);
  const tradeItems = info.items.filter((i) => i.tradeable);
  const trading =
    s.trading.enabled && (tradeRes.length > 0 || tradeItems.length > 0)
      ? [
          level === 0
            ? `Trading: once per turn, before your action, you may propose a trade to any contestant (free action). Tradeable: ${tradeRes.map((r) => `${r.name} (${r.id})`).join(', ')}${tradeItems.length > 0 ? `${tradeRes.length > 0 ? ' and ' : ''}items that are not concealed` : ''}.${s.trading.maxPromiseRounds > 0 ? ` Trades may include promises (no attack for N rounds; pay an amount within N rounds; N ≤ ${s.trading.maxPromiseRounds}): public, not enforced, and everyone sees if they are kept or broken.` : ''} The partner accepts, rejects or counters once; the proposer then accepts or rejects.`
            : `Trading (free action, once per turn, before your action): ${tradeRes.map((r) => `${r.name} (${r.id})`).join(', ')}${tradeItems.length > 0 ? `${tradeRes.length > 0 ? ', ' : ''}unconcealed items` : ''}.${s.trading.maxPromiseRounds > 0 ? ` Optional promises (no attack / pay within N ≤ ${s.trading.maxPromiseRounds} rounds) are public, not enforced.` : ''} The partner accepts, rejects or counters once; then the proposer decides.`,
        ]
      : [];
  const objectives =
    info.objectives.length > 0 && s.objectives.perContestant > 0
      ? [
          (() => {
            const same = info.objectives.every((o) => o.reward === info.objectives[0]?.reward);
            const list = level >= 1 ? info.objectives.map((o) => o.name).join(', ') : info.objectives.map((o) => `${o.name} (${o.text}${same ? '' : `; ${o.reward}`})`).join('; ');
            return `Secret objectives: everyone holds ${s.objectives.perContestant}; completing one ${same ? `gives ${info.objectives[0]?.reward}` : 'gives its reward'} and reveals it. Possible: ${list}.`;
          })(),
        ]
      : [];
  const lines = [
    `GAME: ${info.name}. ${info.description}`,
    `Goal: first to ${v.threshold} ${resName(info, v.resource)} at the end of a round wins; otherwise most ${resName(info, v.resource)} after round ${v.roundLimit} (ties: ${v.ranking
      .slice(1)
      .map((r) => resName(info, r))
      .join(', ')}).`,
    `Turn: roll 1d${s.movement.die}${bonus}, move up to that many steps along connections (or stay), then one action: buy at a shop here, attack ${s.combat.pvp ? 'an enemy or contestant' : 'an enemy'} here, use an item, a special action, rest (+${s.rest.heal} HP), or pass. Landing on a space triggers its rules; passing through does not.`,
    level === 0
      ? `Combat: a wheel weighted by effective Power. Each spin, your chance = your Power ÷ (both Powers). The spin winner hits for ${damageText}, rounded, ${d.min}–${d.max} per hit (shields and armor may change hits). Up to ${s.combat.maxSpinsPerFight} spins per fight; survivors keep their HP. Items and statuses change Power.`
      : `Combat: spins of a wheel weighted by effective Power (your chance = your Power ÷ both). Each spin's winner hits for ${damageText}, ${d.min}–${d.max} (shields and armor may change hits); up to ${s.combat.maxSpinsPerFight} spins; survivors keep their HP.`,
    level === 0
      ? `Inventory: a bag of ${s.inventoryCapacity} spaces (copies of a stackable item share a space)${s.equipment.length > 0 ? `; equipment slots ${s.equipment.map((x) => `${x.name}${x.count > 1 ? ` ×${x.count}` : ''}`).join(', ')}: gear gives its bonuses only while worn, and worn gear takes no bag space` : ''}. Equipping and throwing away items are free actions.`
      : `Inventory: a bag of ${s.inventoryCapacity} spaces (a stack shares one)${s.equipment.length > 0 ? `; slots ${s.equipment.map((x) => `${x.name}${x.count > 1 ? ` ×${x.count}` : ''}`).join(', ')} (gear counts only while worn; worn gear takes no bag space)` : ''}. Equipping and throwing away: free actions.`,
    ko,
    ...(level >= 2
      ? [
          'Public rules (rules of particular spaces are listed with each decision when they matter):',
          ...info.rules.filter((r) => !r.local).map((r) => `- ${r.name}: ${r.text}`),
          `(${info.rules.filter((r) => r.local).length} more rules belong to particular spaces.)`,
        ]
      : ['Public rules:', ...info.rules.map((r) => `- ${r.name}: ${r.text}`)]),
    ...(info.statuses.length > 0 ? ['Statuses (durations count your own turns):', ...info.statuses.map((st) => `- ${st.text}`)] : []),
    ...actionsLine,
    ...trading,
    ...objectives,
    'Shops:',
    ...info.shops.map((shop) => {
      if (level === 0)
        return `- ${shop.name}: ${shop.entries.map((e) => `${e.label} for ${e.price} ${resName(info, e.priceResource)}${e.grantsItem ? ` (${info.items.find((i) => i.id === e.grantsItem)?.text ?? ''})` : ''}`).join('; ')}`;
      const currency = shop.entries.every((e) => e.priceResource === shop.entries[0]?.priceResource) ? shop.entries[0]?.priceResource : undefined;
      const entry = (e: (typeof shop.entries)[number]) =>
        `${e.label} ${e.price}${currency ? '' : ` ${resName(info, e.priceResource)}`}${e.grantsItem ? ` (${shortItemText(info.items.find((i) => i.id === e.grantsItem)?.text ?? '')})` : ''}`;
      return `- ${shop.name}${currency ? ` (${resName(info, currency)})` : ''}: ${shop.entries.map(entry).join('; ')}`;
    }),
    'Enemies:',
    ...info.enemies.map(
      (e) =>
        `- ${e.name}${e.boss ? ' (boss)' : ''}: ${e.power} Power, ${e.maxHp} HP${e.regenPerRound ? `, regenerates ${e.regenPerRound} HP per round` : ''}${e.respawnAfterRounds ? `, returns ${e.respawnAfterRounds} round(s) after defeat` : e.respawnAfterRounds === null ? ', does not return once defeated' : ''}. Reward: ${e.rewardsText}.${e.rulesText.length ? ` ${level === 0 ? e.rulesText.join(' ') : e.rulesText.map((t) => clip(t, 80)).join(' ')}` : ''}`,
    ),
    ...info.decks.map(
      (dk) =>
        `Deck ${dk.name} (${dk.size} cards${dk.description ? `, ${dk.description}` : ''}): ${dk.cards.map((c) => `${c.count > 1 ? `${c.count}× ` : ''}${c.name} (${level >= 1 ? clip(c.text, 32) : c.text})`).join('; ')}`,
    ),
    'Hidden rules may exist; their effects can surprise you.',
  ];
  return lines.join('\n');
}

/**
 * The stable part of every request. The shared rulebook comes first and the contestant's persona
 * last, so all contestants of a match share one long identical prefix (providers cache prefixes).
 */
export function buildInstructions(info: PublicGameInfo, name: string, persona: Persona, names: Names): string {
  return instructionsFor(info, name, persona, names).text;
}

/** The most detailed digest level whose rulebook digest fits its budget. */
export function digestLevel(info: PublicGameInfo, names: Names): DigestLevel {
  for (const level of [0, 1] as const) if (estimateTokens(rulesDigest(info, names, level)) <= DIGEST_BUDGET) return level;
  return 2;
}

/** The instructions at the most detailed digest level that fits the budget. */
export function instructionsFor(info: PublicGameInfo, name: string, persona: Persona, names: Names): { text: string; level: DigestLevel } {
  const level = digestLevel(info, names);
  return { text: instructionsText(info, name, persona, names, level), level };
}

export function instructionsText(info: PublicGameInfo, name: string, persona: Persona, names: Names, level: DigestLevel): string {
  return [
    'You are an AI contestant in a board game run by a human Game Master. Other contestants are AIs too.',
    '',
    'How to answer:',
    '- Pick exactly one option id from the list. The engine resolves movement, dice and combat; you never decide outcomes.',
    '- Odds and effects shown are computed by the engine from what you can see. Use them.',
    '- Play to win with your strategy; adapt when it stops working.',
    '- "say": an optional short in-character line spoken BEFORE the outcome is known (state intent, never claim results); null to stay quiet.',
    '- "plan": one short sentence about your next steps; null keeps your plan.',
    '- "strategyUpdate": null unless you change your strategy (you are prompted when it is worth reconsidering).',
    '- "attempt": null unless you pick "freeform"; then briefly what you try (the GM rules on it).',
    '- "trade" is null unless you pick "trade" or "tr:counter"; then terms from YOUR side: with (partner id, proposals only), give/get (resources [{resource, amount}], item ids), promises [{by: "me"|"them", kind, rounds, resource, amount}] (null resource/amount for noAttack), message.',
    '',
    rulesDigest(info, names, level),
    '',
    `YOU ARE ${name.toUpperCase()}.`,
    `Voice: ${persona.voice}`,
    `Personality: ${traitGuidance(persona).join(' ')}`,
    ...(persona.behaviors.length > 0 ? [`Habits: ${persona.behaviors.join(' ')}`] : []),
  ].join('\n');
}

function statLine(info: PublicGameInfo, e: ViewEntity): string {
  const c = info.settings.core;
  const parts = [
    `HP ${e.stats[c.hp] ?? '?'}/${e.stats[c.maxHp] ?? '?'}`,
    `Power ${e.stats[c.power] ?? '?'}`,
    ...info.resources
      .filter((r) => r.id !== c.hp && r.id !== c.maxHp && r.id !== c.power && e.stats[r.id] !== undefined)
      // Zero-valued extras (Move 0, Bananas 0) add tokens without information.
      .filter((r) => r.id === c.gold || r.id === info.settings.victory.resource || r.visibility === 'owner' || e.stats[r.id] !== 0)
      .map((r) => `${r.name} ${num(e.stats[r.id] ?? 0)}${r.visibility === 'owner' ? ' (secret)' : ''}`),
  ];
  if (e.statuses.length > 0)
    parts.push(
      `Statuses: ${e.statuses.map((s) => `${s.name}${s.stacks > 1 ? ` ×${s.stacks}` : ''}${s.remaining !== null ? ` (${s.remaining} turn${s.remaining === 1 ? '' : 's'} left)` : ''}`).join(', ')}`,
    );
  return parts.join(' · ');
}

/** HP, Power, money and the victory resource only. */
function compactStatLine(info: PublicGameInfo, e: ViewEntity): string {
  const c = info.settings.core;
  const v = info.settings.victory.resource;
  return [
    `HP ${e.stats[c.hp] ?? '?'}/${e.stats[c.maxHp] ?? '?'}`,
    `Power ${e.stats[c.power] ?? '?'}`,
    `${resName(info, c.gold)} ${e.stats[c.gold] ?? '?'}`,
    ...(v !== c.gold ? [`${resName(info, v)} ${e.stats[v] ?? '?'}`] : []),
  ].join(' · ');
}

function itemsText(e: ViewEntity): string {
  if (!e.items.length) return 'none';
  // Copies of the same item are listed once with a count; worn gear is marked.
  const groups = new Map<string, { label: string; n: number }>();
  for (const i of e.items) {
    const label = i.concealed ? 'a concealed item' : `${i.name}${i.equipped ? ' (worn)' : ''}${i.charges !== null ? ` [${i.charges} uses]` : ''}`;
    const g = groups.get(label);
    if (g) g.n += 1;
    else groups.set(label, { label, n: 1 });
  }
  return [...groups.values()].map((g) => (g.n > 1 ? `${g.n}× ${g.label}` : g.label)).join(', ');
}

/** GM tips for the viewer's own items that no option line shows (use options carry their own tip). */
function itemTips(e: ViewEntity, view: ContestantView): string {
  const shown = new Set((view.decision?.previews ?? []).flatMap((p) => (p.kind === 'use' ? [e.items.find((i) => i.id === p.item)?.defId] : [])));
  const tips = [...new Map(e.items.filter((i) => i.hint && !shown.has(i.defId)).map((i) => [i.defId, `${i.name}: ${i.hint}`])).values()];
  return tips.length ? ` · Tips: ${tips.join('; ')}` : '';
}

function fightLine(f: FightHint, maxSpins: number): string {
  const o = f.odds;
  const needed = (n: number) => (Number.isFinite(n) ? String(n) : '∞');
  const stakes = f.opponentKind === 'contestant' ? ` If you knock them out you take ${f.loot} gold; if they knock you out you lose ${f.risk}.` : '';
  return (
    `you win each spin ${formatPercent(o.attackerChance)}; you hit for ${o.attackerHit} (${needed(o.attackerHitsNeeded)} hits to win), it hits for ${o.defenderHit} (${needed(o.defenderHitsNeeded)} hits to knock you out)${o.modified ? ' — shields/armor change some hits' : ''}. ` +
    `Within ${maxSpins} spins: you win ${formatPercent(o.pAttackerWins)}, knocked out ${formatPercent(o.pDefenderWins)}, both standing ${formatPercent(o.pBothStand)}; expected HP loss ${Math.round(o.expectedAttackerHpLoss)}.` +
    (f.rewards ? ` Reward: ${f.rewards}.` : '') +
    stakes
  );
}

/** Hints as text; card-draw estimates are summarized as one line per deck. */
function hintsText(hints: Hint[], skipFights: boolean): string[] {
  const bits: string[] = [];
  for (const h of hints) {
    if (h.fromCard || (skipFights && h.fight)) continue;
    const odds = h.p < 1 ? `${Math.round(h.p * 100)}%: ` : '';
    bits.push(h.certain || h.p < 1 ? `${odds}${h.text}` : `maybe ${h.text}`);
  }
  return bits;
}

/** Fight odds in a few words (for crowded decisions). */
function shortFightLine(f: FightHint): string {
  const o = f.odds;
  return `you win ${formatPercent(o.pAttackerWins)}, knocked out ${formatPercent(o.pDefenderWins)}, expected HP loss ${Math.round(o.expectedAttackerHpLoss)}${f.opponentKind === 'contestant' ? `; loot ${f.loot}, risk ${f.risk}` : ''}${f.rewards ? `; reward ${f.rewards}` : ''}`;
}

function optionLine(info: PublicGameInfo, view: ContestantView, names: Names, p: OptionPreview, me: ViewEntity, near = true, terse = false): string {
  const maxSpins = info.settings.combat.maxSpinsPerFight;
  const vendorEntry = info.shops.flatMap((s) => s.entries).find((e) => e.grantsResource === info.settings.victory.resource);
  switch (p.kind) {
    case 'move': {
      const bits = hintsText(p.hints, true);
      if (p.fight) bits.push(`${p.fight.opponentName.toUpperCase()} ATTACKS YOU: ${terse ? shortFightLine(p.fight) : fightLine(p.fight, maxSpins)}`);
      const fixturesHere = view.entities.filter((e) => e.kind === 'fixture' && e.status === 'active' && e.spaceId === p.space);
      for (const f of fixturesHere) {
        const sellsStar = vendorEntry && f.shopEntries.some((x) => x.entry === vendorEntry.id);
        if (sellsStar && vendorEntry) {
          const gold = me.stats[vendorEntry.priceResource] ?? 0;
          bits.push(`${f.name} here (${gold >= vendorEntry.price ? 'you can afford one' : `you need ${vendorEntry.price - gold} more ${resName(info, vendorEntry.priceResource)} to buy`})`);
        } else bits.push(`${f.name} here`);
      }
      for (const e of view.entities) {
        if (e.kind === 'enemy' && e.status === 'active' && e.spaceId === p.space && !p.fight) bits.push(`${e.name} here (can attack next)`);
      }
      const others = p.occupants.filter((n) => view.entities.some((e) => e.name === n && e.kind === 'contestant'));
      if (others.length > 0) bits.push(`with ${others.join(', ')}`);
      // The Star Vendor plus the two nearest other points of interest (entities only).
      const vendorId = view.entities.find((e) => e.kind === 'fixture' && e.status === 'active' && vendorEntry !== undefined && e.shopEntries.some((x) => x.entry === vendorEntry.id))?.id;
      const byDistance = p.distances.filter((d) => view.entities.some((e) => e.id === d.key) && d.key !== vendorId).sort((a, b) => a.steps - b.steps);
      const dist = [...p.distances.filter((d) => d.key === vendorId), ...byDistance.slice(0, 1)].map((d) => `${d.label} ${d.steps}`);
      // Only serious threats: a rival that likely reaches this space and would probably knock you out.
      const danger = p.threats
        .filter((t) => threatWeight(t) >= 0.3 && t.reach * t.pKnockout >= 0.2)
        .sort((a, b) => b.reach * b.pKnockout - a.reach * a.pKnockout)
        .slice(0, 2)
        .map((t) => `${shortName(view, t.rival, t.name)} ${Math.round(t.reach * 100)}/${Math.round(t.pKnockout * 100)}`);
      if (danger.length > 0) bits.push(`⚠ ${danger.join(', ')}`);
      const head = p.steps === 0 ? `Stay at ${p.spaceName}` : `${p.spaceName} (${p.steps} step${p.steps === 1 ? '' : 's'})`;
      return `[${p.optionId}] ${head}${bits.length ? ` — ${bits.join('; ')}` : ''}${near && dist.length ? ` | near: ${dist.join(', ')}` : ''}`;
    }
    case 'buy': {
      const c = info.settings.core;
      const after =
        p.powerAfter !== null
          ? ` → Power ${me.stats[c.power]}→${p.powerAfter}`
          : p.grantsResource
            ? ` → ${resName(info, p.grantsResource)} ${me.stats[p.grantsResource] ?? 0}→${(me.stats[p.grantsResource] ?? 0) + p.grantsAmount}`
            : '';
      const discount = p.price !== p.basePrice ? ` (usually ${p.basePrice})` : '';
      return `[${p.optionId}] ${p.label}${discount}${after}${p.itemText && p.powerAfter === null ? ` — ${terse ? shortItemText(p.itemText) : p.itemText}` : ''}`;
    }
    case 'attack':
      return `[${p.optionId}] Attack ${p.fight.opponentName} (${p.fight.theirPower} Power, ${p.fight.theirHp} HP): ${terse ? shortFightLine(p.fight) : fightLine(p.fight, maxSpins)}`;
    case 'use': {
      const bits = hintsText(p.hints, false);
      const spend = p.consumed ? (p.charges !== null && p.charges > 1 ? ` (${p.charges} uses left)` : ' (used up)') : '';
      const hint = p.aiHint ? ` [GM tip: ${p.aiHint}]` : '';
      return `[${p.optionId}] Use ${p.name}${p.targetName ? ` on ${p.targetName}` : ''}${spend}${p.free ? ' (free action)' : ''}${bits.length ? ` — ${bits.join('; ')}` : ''}${hint}`;
    }
    case 'equip': {
      const changes = p.changes.map((ch) => `${resName(info, ch.resource)} ${ch.from}→${ch.to}`).join(', ');
      return `[${p.optionId}] Equip ${p.name}${p.replacesName ? ` (${p.replacesName} goes back in your bag)` : ''} (free action)${changes ? ` — ${changes}` : ''}`;
    }
    case 'drop': {
      const changes = p.changes.map((ch) => `${resName(info, ch.resource)} ${ch.from}→${ch.to}`).join(', ');
      return `[${p.optionId}] Throw away ${p.name}${p.worn ? ' (worn)' : ''} to make room (free action)${changes ? ` — ${changes}` : ''}`;
    }
    case 'act': {
      const bits = hintsText(p.hints, false);
      const cost = p.cost ? ` for ${p.cost.amount} ${resName(info, p.cost.resource)}` : '';
      const cooldown = p.cooldownRounds !== null ? `; then unavailable for ${p.cooldownRounds} round${p.cooldownRounds === 1 ? '' : 's'}` : '';
      const effects = bits.join('; ') || p.description || 'unknown effects';
      return `[${p.optionId}] ${p.name}${p.targetName ? ` on ${p.targetName}` : ''}${cost} — ${terse ? effects.replaceAll(` (${p.name})`, '') : effects}${cooldown}`;
    }
    case 'choose': {
      const bits = hintsText(p.hints, false);
      return `[${p.optionId}] ${p.label}${p.unknown ? ' — effects unknown' : bits.length ? ` — ${bits.join('; ')}` : ' — nothing happens'}`;
    }
    case 'rest':
      return `[${p.optionId}] Rest: HP ${me.stats[info.settings.core.hp]}→${p.hpAfter}`;
    case 'pass':
      return `[${p.optionId}] Pass`;
    case 'trade': {
      const holdings = (g: ViewGoods) => goodsText(info, names, g, true) || 'nothing tradeable';
      const partners = p.partners.map((x) => `${x.name} [${x.id}]: ${holdings(x.holds)}`).join('; ');
      return `[${p.optionId}] Propose a trade (free action; you still act afterwards). You hold ${holdings(p.youHold)}. Partners: ${partners}`;
    }
    case 'pay':
      return `[${p.optionId}] Pay ${p.toName} ${p.amount} ${resName(info, p.resource)} as you promised (free action)`;
    case 'tradeAnswer':
      return `[${p.optionId}] ${p.answer === 'accept' ? 'Accept' : p.answer === 'reject' ? 'Reject' : 'Counteroffer (terms in "trade"; only one allowed)'}`;
    case 'freeform':
      return `[${p.optionId}] Attempt something the rules do not cover — describe it in "attempt" (≤ 200 characters); the GM decides what happens (uses your action; again in ${p.cooldownRounds} rounds)`;
  }
}

const TITLES = new Set(['captain', 'lady', 'lord', 'sir', 'dame', 'mr', 'mrs', 'ms', 'dr', 'king', 'queen', 'prince', 'princess', 'the']);

function firstName(full: string): string {
  const words = full.split(' ');
  return words.find((w) => !TITLES.has(w.toLowerCase())) ?? full;
}

/** A rival's short name ("Gorp", "Vex") when that is unambiguous at this table. */
function shortName(view: ContestantView, id: string, full: string): string {
  const short = firstName(full);
  const clash = view.entities.some((e) => e.id !== id && e.kind === 'contestant' && firstName(e.name) === short);
  return clash ? full : short;
}

function goodsText(info: PublicGameInfo, names: Names, g: ViewGoods, ids = false): string {
  return [...Object.entries(g.resources).map(([r, a]) => `${a} ${resName(info, r)}`), ...g.items.map((i) => (ids ? `${names.item(i)} (${i})` : names.item(i)))].join(', ');
}

function negotiationText(info: PublicGameInfo, names: Names, n: ViewNegotiation): string {
  const who = n.proposedByYou ? 'Your offer' : `${n.partnerName}${n.stage === 'final' ? ' counters your offer' : ' offers you a trade'}`;
  const parts = [`you give ${goodsText(info, names, n.youGive) || 'nothing'}`, `you get ${goodsText(info, names, n.youGet) || 'nothing'}`, ...n.promises.map((x) => x.text)];
  return `${who}: ${parts.join('; ')}${n.message ? `. Message: “${n.message}”` : ''}`;
}

function objectiveLine(info: PublicGameInfo, o: ViewObjective): string {
  const progress = o.done ? 'done' : o.current !== null ? `you have ${o.current}/${o.target}` : `${o.progress}/${o.target}`;
  return `${o.name} — ${o.goal} (${progress}); reward: ${o.reward}`;
}

/** "You rolled 4; −1 Move (Fish Form) → up to 3 steps." */
function rollText(info: PublicGameInfo, view: ContestantView, names: Names): string {
  const rolled = [...view.recentEvents].reverse().find((e) => e.event.type === 'rolled' && e.event.entity === view.viewer)?.event;
  if (!rolled || rolled.type !== 'rolled') return `You rolled ${view.roll ?? '?'}.`;
  const me = view.entities.find((e) => e.isSelf);
  const moveBlocked = me?.suppressed.find((s) => s.capability === 'moves');
  const parts = [`You rolled ${rolled.value}`];
  if (rolled.bonus !== 0 && info.settings.movement.bonus !== undefined) {
    const sources = me?.statuses.filter((s) => info.statuses.find((d) => d.id === s.defId)?.modifiers.some((m) => m.resource === info.settings.movement.bonus)).map((s) => s.name) ?? [];
    parts.push(`${rolled.bonus > 0 ? '+' : ''}${num(rolled.bonus)} ${resName(info, info.settings.movement.bonus)}${sources.length ? ` (${sources.join(', ')})` : ''}`);
  }
  if (rolled.mods?.length) parts.push(`modified by ${rolled.mods.map((m) => names.rule(m.rule)).join(', ')}`);
  return `${parts.join('; ')} → ${moveBlocked ? `you cannot move (${moveBlocked.by})` : `move up to ${rolled.total} step${rolled.total === 1 ? '' : 's'}`}.`;
}

/** How much of the situation a packet shows; later shapes are smaller. */
interface InputShape {
  events: number;
  memories: number;
  rules: number;
  enemies: 'all' | 'near' | 'grouped';
  rivals: 'full' | 'compact';
  near: boolean;
  /** Short fight, item and action lines (crowded decisions). */
  terse?: boolean;
}

const SHAPES: InputShape[] = [
  { events: 12, memories: 4, rules: 10, enemies: 'all', rivals: 'full', near: true },
  { events: 8, memories: 3, rules: 8, enemies: 'near', rivals: 'full', near: true },
  { events: 6, memories: 2, rules: 6, enemies: 'near', rivals: 'compact', near: true },
  { events: 4, memories: 2, rules: 4, enemies: 'grouped', rivals: 'compact', near: false },
  { events: 2, memories: 1, rules: 3, enemies: 'grouped', rivals: 'compact', near: false },
  { events: 2, memories: 1, rules: 2, enemies: 'grouped', rivals: 'compact', near: false, terse: true },
];

/**
 * Space rules that matter to this decision: rules of the viewer's space and of the spaces it can
 * move to (by space or tag), then rules about its items, statuses and tags, then rules that just fired.
 */
export function relevantRules(info: PublicGameInfo, view: ContestantView, limit: number): PublicRule[] {
  const me = view.entities.find((e) => e.isSelf);
  if (!me || limit <= 0) return [];
  const spaces = new Set<string>();
  if (me.spaceId) spaces.add(me.spaceId);
  for (const p of view.decision?.previews ?? []) if (p.kind === 'move') spaces.add(p.space);
  const here = new Set(me.spaceId ? (info.spaces.find((x) => x.id === me.spaceId)?.tags ?? []) : []);
  const tags = new Set<string>();
  for (const id of spaces) for (const t of info.spaces.find((x) => x.id === id)?.tags ?? []) tags.add(t);
  const items = new Set(me.items.map((i) => i.defId));
  const statuses = new Set(me.statuses.map((st) => st.defId));
  const myTags = new Set(me.tags);
  const fired = new Set(view.recentEvents.flatMap((ve) => (!ve.unknownCause && ve.event.cause.rule ? [ve.event.cause.rule] : [])));
  const scored = info.rules
    .map((r, i) => {
      let score = 0;
      if (r.refs.spaces.some((x) => spaces.has(x))) score += 10;
      if (r.refs.spaceTags.some((t) => here.has(t))) score += 9;
      else if (r.refs.spaceTags.some((t) => tags.has(t))) score += 7;
      if (r.refs.items.some((x) => items.has(x)) || r.refs.statuses.some((x) => statuses.has(x)) || r.refs.entityTags.some((x) => myTags.has(x))) score += 5;
      if (fired.has(r.id)) score += 3;
      return { r, i, score };
    })
    .filter((x) => x.r.local && x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.r);
}

/** Fewest steps from the viewer's reachable spaces to each entity (from move previews). */
function stepsToEntities(view: ContestantView): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of view.decision?.previews ?? []) {
    if (p.kind !== 'move') continue;
    for (const d of p.distances) out.set(d.key, Math.min(out.get(d.key) ?? Infinity, d.steps + p.steps));
  }
  return out;
}

function enemyLines(info: PublicGameInfo, view: ContestantView, names: Names, mode: InputShape['enemies']): string[] {
  const c = info.settings.core;
  const me = view.entities.find((e) => e.isSelf);
  const enemies = view.entities.filter((x) => x.kind === 'enemy' && x.status !== 'removed');
  const line = (e: ViewEntity) => {
    const statuses = e.statuses.length ? ` · ${e.statuses.map((st) => st.name).join(', ')}` : '';
    return e.status === 'active'
      ? `- ${e.name}${e.boss ? ' (boss)' : ''} at ${e.spaceId ? names.space(e.spaceId) : '?'}: ${e.stats[c.power]} Power, ${e.stats[c.hp]}/${e.stats[c.maxHp]} HP${statuses}`
      : `- ${e.name} (defeated${e.respawnRound !== null ? `, returns round ${e.respawnRound}` : ''})`;
  };
  if (mode === 'all') return enemies.map(line);
  const steps = stepsToEntities(view);
  const close = (e: ViewEntity) => e.status === 'active' && (e.boss || e.spaceId === me?.spaceId || (steps.get(e.id) ?? Infinity) <= (mode === 'near' ? 10 : 4));
  const shown = enemies.filter(close);
  const rest = enemies.filter((e) => !close(e));
  const groups = new Map<string, ViewEntity[]>();
  for (const e of rest) groups.set(e.name, [...(groups.get(e.name) ?? []), e]);
  const summary = [...groups.values()].map((list) => {
    const active = list.filter((e) => e.status === 'active');
    const powers = active.map((e) => e.stats[c.power] ?? 0);
    const range = powers.length === 0 ? 'all defeated' : Math.min(...powers) === Math.max(...powers) ? `${powers[0]} Power` : `${Math.min(...powers)}–${Math.max(...powers)} Power`;
    return `${list.length > 1 ? `${list.length}× ` : ''}${list[0]?.name} (${range}${active.length < list.length && active.length > 0 ? `, ${list.length - active.length} defeated` : ''})`;
  });
  return [...shown.map(line), ...(summary.length ? [`- Further away: ${summary.join('; ')}`] : [])];
}

export function buildInput(info: PublicGameInfo, view: ContestantView, mind: ContestantMind, names: Names, level: DigestLevel = 0, budget = Infinity): string {
  let text = '';
  for (const shape of SHAPES) {
    text = renderInput(info, view, mind, names, level, shape);
    if (estimateTokens(text) <= budget) break;
  }
  return text;
}

function renderInput(info: PublicGameInfo, view: ContestantView, mind: ContestantMind, names: Names, level: DigestLevel, shape: InputShape): string {
  const me = view.entities.find((e) => e.isSelf);
  const decision = view.decision;
  if (!me || !decision) throw new Error('packet needs a pending decision for the viewer');
  const s = mind.strategy;
  const lines: string[] = [];
  if (s) {
    lines.push(`YOUR STRATEGY (${ARCHETYPE_INFO[s.archetype].title}, adopted round ${s.adoptedAtRound}): ${s.summary}`);
    lines.push(`Priorities: ${s.priorities.join('; ')}${s.avoid.length ? ` · Avoid: ${s.avoid.join('; ')}` : ''}`);
  }
  if (mind.reconsider) lines.push(`RECONSIDER: ${mind.reconsider}. Keep your strategy (strategyUpdate null) or revise it.`);
  lines.push(`Current plan: ${mind.plan || 'none yet'}`);
  lines.push('');
  const place = me.spaceId ? names.space(me.spaceId) : 'nowhere';
  lines.push(`YOU (${me.name}) at ${place}: ${statLine(info, me)} · Items: ${itemsText(me)} (bag ${view.inventory.bagUsed}/${view.inventory.bagCapacity})${itemTips(me, view)}`);
  if (me.suppressed.length > 0) lines.push(`Right now you ${me.suppressed.map((x) => `${describeCapabilityLoss(x.capability)} (${x.by})`).join('; ')}.`);
  const mine = view.objectives.filter((o) => o.mine && !o.done);
  if (mine.length > 0) lines.push(`YOUR SECRET OBJECTIVE${mine.length > 1 ? 'S' : ''}: ${mine.map((o) => objectiveLine(info, o)).join(' | ')}`);
  const revealed = view.objectives.filter((o) => o.done && !o.mine);
  if (revealed.length > 0) lines.push(`Completed objectives: ${revealed.map((o) => `${o.ownerName} — ${o.name}`).join('; ')}`);
  // Promises that involve you first; of repeated truces between the same pair only the latest.
  const latestTruce = new Map<string, number>();
  for (const c of view.commitments) if (c.kind === 'noAttack') latestTruce.set(`${c.by}>${c.to}`, Math.max(latestTruce.get(`${c.by}>${c.to}`) ?? 0, c.dueRound));
  const promises = view.commitments
    .filter((c) => c.kind !== 'noAttack' || latestTruce.get(`${c.by}>${c.to}`) === c.dueRound)
    .sort((a, b) => Number(b.by === view.viewer || b.to === view.viewer) - Number(a.by === view.viewer || a.to === view.viewer))
    .slice(0, 4);
  if (promises.length > 0) lines.push(`OPEN PROMISES: ${promises.map((c) => c.text).join('; ')}`);
  const relations = relationshipLines(mind, view, names);
  if (relations.length > 0) lines.push(`HOW YOU FEEL: ${relations.join('; ')}`);
  const memories = selectMemories(mind, view, shape.memories);
  if (memories.length > 0) lines.push(`YOU REMEMBER: ${memories.join('; ')}`);
  if (mind.keyMoment) lines.push(`KEY MOMENT: ${mind.keyMoment}. React in character with "say" if you like.`);
  lines.push('');
  lines.push(`STANDINGS — round ${view.round} of ${view.roundLimit}`);
  for (const id of view.turnOrder) {
    const e = view.entities.find((x) => x.id === id);
    if (!e || e.isSelf) continue;
    const state = e.status === 'eliminated' ? ' · ELIMINATED' : e.koTurns > 0 ? ' · knocked out' : '';
    if (shape.rivals === 'compact') {
      lines.push(`- ${e.name} at ${e.spaceId ? names.space(e.spaceId) : '—'}: ${compactStatLine(info, e)}${state}`);
      continue;
    }
    const items2 = e.items.length ? ` · Items: ${itemsText(e)}` : '';
    const hidden = e.hiddenStats.length ? ` · ${e.hiddenStats.map((r) => resName(info, r)).join(', ')} hidden` : '';
    lines.push(`- ${e.name} at ${e.spaceId ? names.space(e.spaceId) : '—'}: ${statLine(info, e)}${items2}${hidden}${state}`);
  }
  lines.push('ENEMIES');
  lines.push(...enemyLines(info, view, names, shape.enemies));
  const shops = view.entities.filter((e) => e.kind === 'fixture' && e.status === 'active' && e.shopEntries.length > 0);
  if (shops.length) lines.push(`SHOPS NOW: ${shops.map((f) => `${f.name} at ${f.spaceId ? names.space(f.spaceId) : '?'}`).join('; ')}`);
  if (view.decks.length) lines.push(`DECKS: ${view.decks.map((d) => `${d.name} ${d.drawCount} left (${d.discardCount} drawn)`).join('; ')}`);
  const recent = notableEvents(view).slice(-shape.events);
  if (recent.length) {
    lines.push('RECENT EVENTS (oldest first)');
    for (const ve of recent) lines.push(`- ${describeEvent(ve.event, names)}${ve.unknownCause ? ' (unknown cause)' : ''}`);
  }
  if (level >= 2) {
    const rules = relevantRules(info, view, shape.rules);
    if (rules.length) {
      lines.push('RULES OF THE SPACES HERE AND AHEAD');
      for (const r of rules) lines.push(`- ${r.name}: ${r.text}`);
    }
  }
  lines.push('');
  const what =
    decision.kind === 'move'
      ? `${rollText(info, view, names)} Choose where to move.`
      : decision.kind === 'choice'
        ? `CHOICE: ${decision.prompt ?? 'choose one'}`
        : decision.kind === 'trade' && view.negotiation
          ? `TRADE — ${negotiationText(info, names, view.negotiation)}.`
          : 'Choose your action for this turn.';
  lines.push(`DECISION ${decision.id}: ${what}`);
  lines.push(
    decision.kind === 'move'
      ? `Options (⚠ rival a/b = a% chance they reach you there next turn, b% chance they knock you out if they attack${shape.near ? '; near = steps to key places' : ''}):`
      : 'Options:',
  );
  for (const p of decision.previews) lines.push(optionLine(info, view, names, p, me, shape.near, shape.terse === true));
  const cardHints = decision.previews.some((p) => p.kind === 'move' && p.hints.some((h) => h.deck !== undefined && !h.fromCard));
  if (cardHints) lines.push('(Card draws are random: the deck list above shows what remains possible.)');
  return lines.join('\n');
}

export function buildDecisionPacket(info: PublicGameInfo, view: ContestantView, mind: ContestantMind, persona: Persona): Packet {
  const names = namesFromView(info, view);
  const me = view.entities.find((e) => e.isSelf);
  const { text: instructions, level } = instructionsFor(info, me?.name ?? 'contestant', persona, names);
  const input = buildInput(info, view, mind, names, level, PACKET_TARGET - estimateTokens(instructions));
  return { instructions, input, estimatedTokens: estimateTokens(instructions) + estimateTokens(input) };
}

export function buildStrategyPacket(info: PublicGameInfo, view: ContestantView, mind: ContestantMind, persona: Persona): Packet {
  const names = namesFromView(info, view);
  const me = view.entities.find((e) => e.isSelf);
  const instructions = buildInstructions(info, me?.name ?? 'contestant', persona, names);
  const candidates = mind.candidates.map((a) => `- ${a}: ${ARCHETYPE_INFO[a].title} — ${ARCHETYPE_INFO[a].summary(info)}`);
  const others = view.turnOrder.filter((id) => id !== view.viewer).map((id) => view.entities.find((e) => e.id === id)?.name ?? id);
  const input = [
    `The match is starting. Opponents: ${others.join(', ')}. You start with ${me ? statLine(info, me) : '?'}.`,
    'Choose your match strategy from these archetypes (they fit this game and your personality):',
    ...candidates,
    'Write a compact strategy (40-100 words) that fits the actual mechanics above: how you will gain what you need, when you will fight, and what you will avoid. Then give your plan for the first few turns.',
  ].join('\n');
  return { instructions, input, estimatedTokens: estimateTokens(instructions) + estimateTokens(input) };
}
