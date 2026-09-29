import { formatPercent } from '../engine/combat.ts';
import { describeEvent, makeNames, type Names } from '../engine/explain.ts';
import type { Persona } from '../schema/persona.ts';
import type { PublicGameInfo } from '../visibility/public-info.ts';
import type { ContestantView, FightHint, OptionPreview, ViewEntity } from '../visibility/view.ts';
import { ARCHETYPE_INFO } from './strategy.ts';
import { traitGuidance, type ContestantMind } from './mind.ts';

/**
 * Decision packets: compact text built only from a ContestantView and the public rulebook.
 * The stable part (role, persona, rules) goes into `instructions`; the changing situation into
 * `input`. No sequence numbers or revisions are rendered, so hidden events leave no trace.
 */

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
  const entityNames = new Map(view.entities.map((e) => [e.id, e.name]));
  return makeNames({ resources: map(info.resources), tags: map(info.tags), spaces: map(info.spaces), items: map(info.items), rules, shopEntries: entries }, (id) => entityNames.get(id));
}

const NOISE: ReadonlySet<string> = new Set(['left', 'entered', 'landed', 'turnStarted', 'turnEnded', 'roundEnded', 'spin', 'matchStarted', 'rolled', 'passed']);

/** Events worth a model's attention: drops movement bookkeeping and per-spin HP updates. */
export function notableEvents(view: ContestantView): ContestantView['recentEvents'] {
  const spinSeqs = new Set(view.recentEvents.filter((e) => e.type === 'spin').map((e) => e.seq));
  return view.recentEvents.filter((ve) => {
    if (NOISE.has(ve.type)) return false;
    if (ve.event.type === 'moved' && ve.event.mode === 'walk') return false;
    if (ve.type === 'resourceChanged' && ve.event.cause.parent !== undefined && spinSeqs.has(ve.event.cause.parent)) return false;
    return true;
  });
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function resName(info: PublicGameInfo, id: string): string {
  return info.resources.find((r) => r.id === id)?.name ?? id;
}

function rulesDigest(info: PublicGameInfo, names: Names): string {
  const s = info.settings;
  const v = s.victory;
  const d = s.combat.damage;
  const damageText =
    d.ratioExponent === 1
      ? `${d.base} × (winner Power ÷ loser Power)`
      : d.ratioExponent === 0.5
        ? `${d.base} × √(winner Power ÷ loser Power)`
        : `${d.base}`;
  const lines = [
    `GAME: ${info.name}. ${info.description}`,
    `Goal: first to ${v.threshold} ${resName(info, v.resource)} at the end of a round wins; otherwise most ${resName(info, v.resource)} after round ${v.roundLimit} (ties: ${v.ranking.slice(1).map((r) => resName(info, r)).join(', ')}).`,
    `Turn: roll 1d${s.movement.die}, move up to that many steps along connections (or stay), then one action: buy at a shop here, attack an enemy here, rest (+${s.rest.heal} HP), or pass. Landing on a space triggers its rules; passing through does not.`,
    `Combat: a wheel weighted by effective Power. Each spin, your chance = your Power ÷ (both Powers). The spin winner hits for ${damageText}, rounded, ${d.min}–${d.max} per hit. Up to ${s.combat.maxSpinsPerFight} spins per fight; survivors keep their HP. Items add Power while held (max ${s.inventoryCapacity} items).`,
    `Knocked out (0 HP): lose ${s.ko.goldLossPercent}% of your ${resName(info, s.core.gold)}, return to ${names.space(s.startSpace)}, HP restored, skip ${s.ko.skipTurns} turn.`,
    'Public rules:',
    ...info.rules.map((r) => `- ${r.name}: ${r.text}`),
    'Shops:',
    ...info.shops.map((shop) => `- ${shop.name}: ${shop.entries.map((e) => `${e.label} for ${e.price} ${resName(info, e.priceResource)}${e.grantsItem ? ` (${itemEffect(info, e.grantsItem)})` : ''}`).join('; ')}`),
    'Enemies:',
    ...info.enemies.map(
      (e) =>
        `- ${e.name}: ${e.power} Power, ${e.maxHp} HP${e.regenPerRound ? `, regenerates ${e.regenPerRound} HP per round` : ''}${e.respawnAfterRounds ? `, returns ${e.respawnAfterRounds} round(s) after defeat` : ''}. Reward for defeating it: ${e.rewardsText}.${e.description ? ` ${e.description}` : ''}`,
    ),
    'Hidden rules may exist; their effects can surprise you.',
  ];
  return lines.join('\n');
}

function itemEffect(info: PublicGameInfo, itemId: string): string {
  const item = info.items.find((i) => i.id === itemId);
  return item?.modifiers.map((m) => `${m.add >= 0 ? '+' : ''}${m.add} ${resName(info, m.resource)}`).join(', ') ?? '';
}

export function buildInstructions(info: PublicGameInfo, name: string, persona: Persona, names: Names): string {
  return [
    `You are ${name}, an AI contestant in a board game run by a human Game Master. Other contestants are AIs too.`,
    `Voice: ${persona.voice}`,
    `Personality: ${traitGuidance(persona).join(' ')}`,
    ...(persona.behaviors.length > 0 ? [`Habits: ${persona.behaviors.join(' ')}`] : []),
    '',
    'How to answer:',
    '- Pick exactly one option id from the list. The engine resolves movement, dice and combat; you never decide outcomes.',
    '- Odds and effects shown are computed by the engine from what you can see. Use them.',
    '- Play to win using your strategy, but adapt when it stops working.',
    '- "say" is an optional short in-character line spoken BEFORE the outcome is known: state intent, never claim results. Use null to stay quiet.',
    '- "plan" is one short sentence about your next steps; null keeps your current plan.',
    '- "strategyUpdate" is null unless you decide to change your strategy (you will be prompted when it is worth reconsidering).',
    '',
    rulesDigest(info, names),
  ].join('\n');
}

function statLine(info: PublicGameInfo, e: ViewEntity): string {
  const c = info.settings.core;
  const parts = [
    `HP ${e.stats[c.hp] ?? '?'}/${e.stats[c.maxHp] ?? '?'}`,
    `Power ${e.stats[c.power] ?? '?'}`,
    ...info.resources
      .filter((r) => r.id !== c.hp && r.id !== c.maxHp && r.id !== c.power && e.stats[r.id] !== undefined)
      .map((r) => `${r.name} ${e.stats[r.id]}${r.visibility === 'owner' ? ' (secret)' : ''}`),
  ];
  return parts.join(' · ');
}

function fightLine(f: FightHint, maxSpins: number): string {
  const o = f.odds;
  const needed = (n: number) => (Number.isFinite(n) ? String(n) : '∞');
  return (
    `you win each spin ${formatPercent(o.attackerChance)}; you hit for ${o.attackerHit} (${needed(o.attackerHitsNeeded)} hits to defeat it), it hits for ${o.defenderHit} (${needed(o.defenderHitsNeeded)} hits to knock you out). ` +
    `Within ${maxSpins} spins: you win ${formatPercent(o.pAttackerWins)}, knocked out ${formatPercent(o.pDefenderWins)}, both standing ${formatPercent(o.pBothStand)}; expected HP loss ${Math.round(o.expectedAttackerHpLoss)}.` +
    (f.rewards ? ` Reward: ${f.rewards}.` : '')
  );
}

function optionLine(info: PublicGameInfo, view: ContestantView, names: Names, p: OptionPreview, me: ViewEntity): string {
  const maxSpins = info.settings.combat.maxSpinsPerFight;
  const vendorEntry = info.shops.flatMap((s) => s.entries).find((e) => e.grantsResource === info.settings.victory.resource);
  switch (p.kind) {
    case 'move': {
      const bits: string[] = [];
      for (const h of p.hints) if (!p.fight || !h.text.includes('attacks')) bits.push(h.certain ? h.text : `maybe ${h.text}`);
      if (p.fight) bits.push(`${p.fight.opponentName.toUpperCase()} ATTACKS YOU: ${fightLine(p.fight, maxSpins)}`);
      const fixturesHere = view.entities.filter((e) => e.kind === 'fixture' && e.spaceId === p.space);
      for (const f of fixturesHere) {
        const sellsStar = vendorEntry && f.shopEntries.some((x) => x.entry === vendorEntry.id);
        if (sellsStar && vendorEntry) {
          const gold = me.stats[vendorEntry.priceResource] ?? 0;
          bits.push(`${f.name} here (${gold >= vendorEntry.price ? 'you can afford' : `you need ${vendorEntry.price - gold} more ${resName(info, vendorEntry.priceResource)} for`} a ${resName(info, info.settings.victory.resource)})`);
        } else bits.push(`${f.name} here`);
      }
      for (const e of view.entities) {
        if (e.kind === 'enemy' && e.status === 'active' && e.spaceId === p.space && !p.fight) bits.push(`${e.name} here (can attack next)`);
      }
      const others = p.occupants.filter((n) => view.entities.some((e) => e.name === n && e.kind === 'contestant'));
      if (others.length > 0) bits.push(`with ${others.join(', ')}`);
      const dist = p.distances.filter((d) => view.entities.some((e) => e.id === d.key)).map((d) => `${d.label} ${d.steps}`);
      const head = p.steps === 0 ? `Stay at ${p.spaceName}` : `${p.spaceName} (${p.steps} step${p.steps === 1 ? '' : 's'})`;
      return `[${p.optionId}] ${head}${bits.length ? ` — ${bits.join('; ')}` : ''}${dist.length ? ` | distance to: ${dist.join(', ')}` : ''}`;
    }
    case 'buy': {
      const c = info.settings.core;
      const after = p.powerAfter !== null ? ` → Power ${me.stats[c.power]}→${p.powerAfter}` : p.grantsResource ? ` → ${resName(info, p.grantsResource)} ${me.stats[p.grantsResource] ?? 0}→${(me.stats[p.grantsResource] ?? 0) + p.grantsAmount}` : '';
      return `[${p.optionId}] ${p.label}${after}`;
    }
    case 'attack':
      return `[${p.optionId}] Attack ${p.fight.opponentName} (${p.fight.theirPower} Power, ${p.fight.theirHp} HP): ${fightLine(p.fight, maxSpins)}`;
    case 'rest':
      return `[${p.optionId}] Rest: HP ${me.stats[info.settings.core.hp]}→${p.hpAfter}`;
    case 'pass':
      return `[${p.optionId}] Pass`;
  }
}

export function buildInput(info: PublicGameInfo, view: ContestantView, mind: ContestantMind, names: Names): string {
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
  const items = me.items.length ? me.items.map((i) => i.name).join(', ') : 'none';
  lines.push(`YOU (${me.name}) at ${place}: ${statLine(info, me)} · Items: ${items} (${me.items.length}/${info.settings.inventoryCapacity})`);
  lines.push('');
  lines.push(`STANDINGS — round ${view.round} of ${view.roundLimit}`);
  for (const id of view.turnOrder) {
    const e = view.entities.find((x) => x.id === id);
    if (!e || e.isSelf) continue;
    const items2 = e.items.length ? ` · Items: ${e.items.map((i) => i.name).join(', ')}` : '';
    const hidden = e.hiddenStats.length ? ` · ${e.hiddenStats.map((r) => resName(info, r)).join(', ')} hidden` : '';
    lines.push(`- ${e.name} at ${e.spaceId ? names.space(e.spaceId) : '?'}: ${statLine(info, e)}${items2}${hidden}${e.koTurns > 0 ? ' · knocked out' : ''}`);
  }
  lines.push('ENEMIES');
  for (const e of view.entities.filter((x) => x.kind === 'enemy')) {
    lines.push(
      e.status === 'active'
        ? `- ${e.name} at ${e.spaceId ? names.space(e.spaceId) : '?'}: ${e.stats[info.settings.core.power]} Power, ${e.stats[info.settings.core.hp]}/${e.stats[info.settings.core.maxHp]} HP`
        : `- ${e.name} (defeated${e.respawnRound !== null ? `, returns round ${e.respawnRound}` : ''})`,
    );
  }
  const vendor = view.entities.filter((e) => e.kind === 'fixture' && e.shopEntries.length > 0);
  if (vendor.length) lines.push(`SHOPS NOW: ${vendor.map((f) => `${f.name} at ${f.spaceId ? names.space(f.spaceId) : '?'}`).join('; ')}`);
  const recent = notableEvents(view).slice(-14);
  if (recent.length) {
    lines.push('RECENT EVENTS (oldest first)');
    for (const ve of recent) lines.push(`- ${describeEvent(ve.event, names)}${ve.unknownCause ? ' (unknown cause)' : ''}`);
  }
  lines.push('');
  const what = decision.kind === 'move' ? `You rolled ${view.roll ?? '?'}. Choose where to move.` : 'Choose your action for this turn.';
  lines.push(`DECISION ${decision.id}: ${what}`);
  lines.push('Options:');
  for (const p of decision.previews) lines.push(optionLine(info, view, names, p, me));
  return lines.join('\n');
}

export function buildDecisionPacket(info: PublicGameInfo, view: ContestantView, mind: ContestantMind, persona: Persona): Packet {
  const names = namesFromView(info, view);
  const me = view.entities.find((e) => e.isSelf);
  const instructions = buildInstructions(info, me?.name ?? 'contestant', persona, names);
  const input = buildInput(info, view, mind, names);
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
