import type { EventDto } from '../shared/api.ts';
import type { MatchData } from './api.ts';

/**
 * Display frames for the combat wheel. The server sends the state after a whole operation; while
 * a fight replays, the UI shows the match as it was when that fight started. This replays the
 * operation's earlier events (movement, resource and tag changes) onto the previous frame. It is
 * presentation only: the authoritative state always comes from the server.
 */
export function frameAt(before: MatchData, events: EventDto[], uptoSeq: number): MatchData {
  const entities = { ...before.state.entities };
  const effective = { ...before.effective };
  const touch = (id: string) => {
    const e = entities[id];
    if (!e) return undefined;
    if (e === before.state.entities[id]) entities[id] = { ...e, resources: { ...e.resources }, tags: [...e.tags], items: [...e.items] };
    if (effective[id] === before.effective[id]) effective[id] = { ...(effective[id] ?? {}) };
    return entities[id];
  };
  for (const ev of events) {
    if (ev.seq >= uptoSeq) break;
    switch (ev.type) {
      case 'moved': {
        const e = touch(ev.entity);
        if (e) e.spaceId = ev.to;
        break;
      }
      case 'resourceChanged': {
        const e = touch(ev.entity);
        if (!e) break;
        e.resources[ev.resource] = ev.to;
        const eff = effective[ev.entity] as Record<string, number>;
        eff[ev.resource] = (eff[ev.resource] ?? ev.from) + (ev.to - ev.from);
        break;
      }
      case 'tagAdded': {
        const e = touch(ev.entity);
        if (e && !e.tags.includes(ev.tag)) e.tags.push(ev.tag);
        break;
      }
      case 'tagRemoved': {
        const e = touch(ev.entity);
        if (e) e.tags = e.tags.filter((t) => t !== ev.tag);
        break;
      }
      default:
        break;
    }
  }
  return { ...before, state: { ...before.state, entities }, effective };
}
