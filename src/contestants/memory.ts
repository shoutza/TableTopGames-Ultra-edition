import type { Names } from '../engine/explain.ts';
import type { TradeTermsView } from '../schema/state.ts';
import type { PublicGameInfo } from '../visibility/public-info.ts';
import type { VisibleEvent } from '../visibility/redact.ts';
import type { ContestantView } from '../visibility/view.ts';
import type { ContestantMind, Memory, MemoryKind, Relationship } from './mind.ts';
import { opportunityLost } from './strategy.ts';

/**
 * Social memory. Everything here is derived by fixed rules from events the contestant could see,
 * so two states that differ only in hidden data give identical memories and relationships.
 * No model-written summaries: repeated memories are grouped by code.
 */

const MAX_MEMORIES = 60;

export function relationship(mind: ContestantMind, other: string): Relationship {
  return mind.relationships[other] ?? { trust: 0, affinity: 0 };
}

function adjust(mind: ContestantMind, other: string, trust: number, affinity: number): void {
  const r = relationship(mind, other);
  const clamp = (v: number) => Math.max(-10, Math.min(10, v));
  mind.relationships[other] = { trust: clamp(r.trust + trust), affinity: clamp(r.affinity + affinity) };
}

function remember(mind: ContestantMind, e: VisibleEvent, kind: MemoryKind, other: string | null, text: string, importance: number): void {
  mind.memories.push({ seq: e.seq, round: e.round, kind, other, text, importance } satisfies Memory);
  if (mind.memories.length > MAX_MEMORIES) mind.memories.splice(0, mind.memories.length - MAX_MEMORIES);
}

/**
 * Updates relationships, memories and the key moment from newly observed events (seq greater than
 * the last one seen). Fixed rules: kept promise to me trust +2, broken −3 (−1 when broken to
 * someone else), attacked me affinity −2, knocked me out and took gold −1 more, a completed trade
 * +1, a hostile action on me −1.
 */
export function observe(mind: ContestantMind, view: ContestantView, events: VisibleEvent[], names: Names): void {
  const me = view.viewer;
  const kind = new Map(view.entities.map((e) => [e.id, e.kind]));
  const isRival = (id: string | null | undefined): id is string => id !== null && id !== undefined && id !== me && kind.get(id) === 'contestant';
  // The most important moment since the last decision wins (a betrayal over the fight that followed).
  let best = mind.keyMoment ? 0 : -1;
  const moment = (text: string, importance: number) => {
    if (importance < best) return;
    best = importance;
    mind.keyMoment = text;
  };
  for (const e of events) {
    if (e.seq <= mind.lastSeenEventSeq) continue;
    const ev = e.event;
    switch (ev.type) {
      case 'promiseBroken':
        if (ev.to === me && isRival(ev.by)) {
          adjust(mind, ev.by, -3, -1);
          remember(mind, e, 'betrayal', ev.by, `${names.entity(ev.by)} broke a promise to you (${ev.kind === 'noAttack' ? 'attacked you anyway' : 'never paid'})`, 5);
          moment(`${names.entity(ev.by)} just broke a promise to you`, 5);
          if (!mind.reconsider) mind.reconsider = `${names.entity(ev.by)} broke a promise to you`;
        } else if (isRival(ev.by)) {
          adjust(mind, ev.by, -1, 0);
          remember(mind, e, 'reputation', ev.by, `${names.entity(ev.by)} broke a promise to ${names.entity(ev.to)}`, 2);
        }
        break;
      case 'promiseKept':
        if (ev.to === me && isRival(ev.by)) {
          adjust(mind, ev.by, 2, 0);
          remember(mind, e, 'promiseKept', ev.by, `${names.entity(ev.by)} kept a promise to you`, 3);
        }
        break;
      case 'fightStarted':
        if (ev.defender === me && isRival(ev.attacker) && ev.cause.kind === 'action') {
          adjust(mind, ev.attacker, 0, -2);
          remember(mind, e, 'attackedMe', ev.attacker, `${names.entity(ev.attacker)} attacked you`, 4);
          moment(`${names.entity(ev.attacker)} just attacked you`, 3);
        }
        break;
      case 'knockedOut':
        if (ev.entity === me) {
          if (isRival(ev.lootTo)) adjust(mind, ev.lootTo, 0, -1);
          remember(mind, e, 'knockedOut', ev.lootTo, ev.lootTo !== null ? `${names.entity(ev.lootTo)} knocked you out and took ${ev.goldLost} gold` : `You were knocked out and lost ${ev.goldLost} gold`, 4);
          moment(ev.lootTo !== null ? `${names.entity(ev.lootTo)} just knocked you out` : 'You were just knocked out', 4);
        } else if (ev.lootTo === me) {
          remember(mind, e, 'knockedOutRival', ev.entity, `You knocked out ${names.entity(ev.entity)} and took ${ev.goldLost} gold`, 3);
          moment(`You just knocked out ${names.entity(ev.entity)}`, 3);
        }
        break;
      case 'tradeCompleted':
        if (ev.from === me || ev.to === me) {
          const other = ev.from === me ? ev.to : ev.from;
          adjust(mind, other, 0, 1);
          remember(mind, e, 'trade', other, `You traded with ${names.entity(other)}: ${tradeFromMySide(ev.terms, ev.from === me, names.entity(other), names)}`, 3);
          moment(`You just closed a deal with ${names.entity(other)}`, 2);
        }
        break;
      case 'tradeRejected':
        if (ev.from === me && ev.by !== me && !ev.automatic) remember(mind, e, 'offerRejected', ev.by, `${names.entity(ev.by)} rejected your offer`, 1);
        break;
      case 'actionUsed':
        if (ev.target === me && isRival(ev.entity)) {
          adjust(mind, ev.entity, 0, -1);
          remember(mind, e, 'robbedMe', ev.entity, `${names.entity(ev.entity)} used ${names.action(ev.action)} on you`, 3);
        }
        break;
      case 'objectiveCompleted':
        if (ev.entity === me) {
          remember(mind, e, 'objective', null, `You completed your secret objective “${names.objective(ev.def)}”`, 3);
          moment(`You just completed your secret objective “${names.objective(ev.def)}”`, 3);
        } else if (isRival(ev.entity)) remember(mind, e, 'objective', ev.entity, `${names.entity(ev.entity)} completed a secret objective (“${names.objective(ev.def)}”)`, 2);
        break;
      default:
        break;
    }
  }
  const last = events.at(-1);
  if (last && last.seq > mind.lastSeenEventSeq) mind.lastSeenEventSeq = last.seq;
}

function goodsText(g: { resources: Record<string, number>; items: string[] }, names: Names): string {
  const parts = [...Object.entries(g.resources).map(([r, a]) => `${a} ${names.resource(r)}`), ...g.items.map((i) => names.item(i))];
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

/** "you gave 2 Gold and got nothing; Brine promised no attack" (terms are from the proposer's side). */
function tradeFromMySide(t: TradeTermsView, iProposed: boolean, other: string, names: Names): string {
  const gave = iProposed ? t.give : t.get;
  const got = iProposed ? t.get : t.give;
  const promises = t.promises.map((p) => {
    const byMe = (p.by === 'from') === iProposed;
    const who = byMe ? 'you' : other;
    return p.kind === 'noAttack' ? `${who} promised no attack for ${p.rounds} rounds` : `${who} promised to pay ${p.amount} ${names.resource(p.resource)}`;
  });
  return [`you gave ${goodsText(gave, names)} and got ${goodsText(got, names)}`, ...promises].join('; ');
}

/** Entities that matter for the current decision: trade partner, attack targets, rivals on my space. */
function relevantOthers(view: ContestantView): Set<string> {
  const out = new Set<string>();
  const me = view.entities.find((e) => e.isSelf);
  if (view.negotiation) out.add(view.negotiation.partner);
  for (const p of view.decision?.previews ?? []) {
    if (p.kind === 'attack') out.add(p.target);
    if (p.kind === 'pay') out.add(p.to);
  }
  for (const e of view.entities) if (e.kind === 'contestant' && !e.isSelf && me?.spaceId && e.spaceId === me.spaceId) out.add(e.id);
  for (const t of view.threatsHere) out.add(t.rival);
  return out;
}

/**
 * The few memories worth putting in a packet: scored by importance, recency and relevance to the
 * current decision, with repeats grouped ("Vex attacked you 3× (rounds 2, 5, 9)").
 */
export function selectMemories(mind: ContestantMind, view: ContestantView, limit = 5): string[] {
  const relevant = relevantOthers(view);
  const groups = new Map<string, Memory[]>();
  for (const m of mind.memories) {
    const key = m.kind === 'trade' ? `${m.seq}` : `${m.kind}:${m.other ?? ''}`;
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }
  const scored = [...groups.values()].map((list) => {
    const latest = list[list.length - 1] as Memory;
    const recency = Math.max(0, 3 - (view.round - latest.round) / 3);
    const relevance = latest.other !== null && relevant.has(latest.other) ? 2 : 0;
    const repeat = Math.min(2, list.length - 1) * 0.5;
    const score = latest.importance + recency + relevance + repeat;
    const rounds = list.map((m) => m.round);
    const text = list.length > 1 ? `${latest.text} ${list.length}× (${rounds.length > 3 ? 'latest rounds' : 'rounds'} ${rounds.slice(-3).join(', ')})` : `r${latest.round}: ${latest.text}`;
    return { score, seq: latest.seq, text };
  });
  return scored
    .sort((a, b) => b.score - a.score || b.seq - a.seq)
    .slice(0, limit)
    .sort((a, b) => a.seq - b.seq)
    .map((x) => x.text);
}

/** Non-neutral relationships as short text ("Vex: trust −3, affinity −2"). */
export function relationshipLines(mind: ContestantMind, view: ContestantView, names: Names): string[] {
  const out: string[] = [];
  for (const id of view.turnOrder) {
    if (id === view.viewer) continue;
    const r = mind.relationships[id];
    if (!r) continue;
    // Only feelings strong enough to matter (|value| ≥ 2).
    const fmt = (v: number) => (v > 0 ? `+${v}` : `−${-v}`);
    const parts = [...(Math.abs(r.trust) >= 2 ? [`trust ${fmt(r.trust)}`] : []), ...(Math.abs(r.affinity) >= 2 ? [`affinity ${fmt(r.affinity)}`] : [])];
    if (parts.length > 0) out.push(`${names.entity(id)} (${parts.join(', ')})`);
  }
  return out;
}

/** Minimum rounds between strategy revisions, unless the strategy's key opportunity is gone. */
export const REVISION_COOLDOWN_ROUNDS = 3;

/**
 * Code-flagged reasons to reconsider the strategy (answered inside the next decision, no extra
 * call): the strategy's key opportunity is gone, a knockout, a betrayal, falling 2+ of the victory
 * resource behind the leader, or 8 rounds on the same strategy.
 */
export function updateReconsider(mind: ContestantMind, view: ContestantView, info: PublicGameInfo, fresh: VisibleEvent[]): void {
  if (!mind.strategy) return;
  const lost = opportunityLost(mind.strategy.archetype, view, info);
  if (lost) {
    // Urgent: no cooldown. Replaces a milder pending reason.
    mind.reconsider = lost;
    return;
  }
  if (mind.reconsider) return;
  const sinceLast = view.round - mind.lastReconsiderRound;
  if (sinceLast < REVISION_COOLDOWN_ROUNDS && mind.lastReconsiderRound > 0) return;
  const knockedOut = fresh.some((e) => e.event.type === 'knockedOut' && e.event.entity === view.viewer);
  const victory = info.settings.victory.resource;
  const mine = view.entities.find((e) => e.isSelf)?.stats[victory] ?? 0;
  const leader = view.entities.filter((e) => e.kind === 'contestant' && !e.isSelf && e.status === 'active').sort((a, b) => (b.stats[victory] ?? 0) - (a.stats[victory] ?? 0))[0];
  const gap = (leader?.stats[victory] ?? 0) - mine;
  const vName = info.resources.find((r) => r.id === victory)?.name ?? victory;
  if (knockedOut) mind.reconsider = 'You were just knocked out';
  else if (leader && gap >= 2 && view.round - mind.strategy.adoptedAtRound >= REVISION_COOLDOWN_ROUNDS) mind.reconsider = `You are ${gap} ${vName} behind ${leader.name}`;
  else if (view.round - mind.strategy.adoptedAtRound >= 8 && sinceLast >= 8) mind.reconsider = `${view.round - mind.strategy.adoptedAtRound} rounds have passed since you chose this strategy; check whether it is working`;
}

/** Everything code does to a mind before a decision: observe new events, then flag reconsideration. */
export function prepareMind(mind: ContestantMind, view: ContestantView, info: PublicGameInfo, fresh: VisibleEvent[], names: Names): void {
  observe(mind, view, fresh, names);
  updateReconsider(mind, view, info, fresh);
}
