import type { GmCommand } from '../schema/commands.ts';
import type { EventCause, GameState } from '../schema/state.ts';
import type { CompiledGame } from './compile.ts';
import { addTag, applyStatus, changeResource, drawCard, grantItem, moveItemInstance, removeEntity, removeItem, removeStatus, removeTag, setEquipped, setResource, spawnEnemy, teleport } from './effects.ts';
import { canUnequip, equipPlan } from './inventory.ts';
import { namesFor } from './explain.ts';
import { assignObjective } from './objectives.ts';
import { getEntity } from './queries.ts';
import { runOperation, runRoot, type OpOutcome } from './resolve.ts';
import { InvalidInput } from './util.ts';

/**
 * GM interventions. They run as ordinary operations between steps: rules react to them unless
 * the GM asks for a silent correction, and the pending decision is re-issued with a new id.
 */
export function applyGmCommand(game: CompiledGame, state: GameState, cmd: GmCommand): OpOutcome {
  if (state.phase === 'gameOver' && cmd.type !== 'announce') return { ok: false, kind: 'invalid', message: 'the game is over' };
  return runOperation(game, state, (ctx) => {
    const cause: EventCause = { kind: 'gm' };
    const names = namesFor(game, ctx.state);
    const silent = 'silent' in cmd ? cmd.silent : false;
    const summary = (text: string) => ctx.emit({ type: 'gmCommand', summary: text }, cause);
    runRoot(
      ctx,
      () => {
        switch (cmd.type) {
          case 'adjustResource':
            getEntity(ctx.state, cmd.entity);
            summary(`${cmd.delta >= 0 ? '+' : ''}${cmd.delta} ${names.resource(cmd.resource)} for ${names.entity(cmd.entity)}`);
            changeResource(ctx, cmd.entity, cmd.resource, cmd.delta, cause);
            return;
          case 'setResource':
            getEntity(ctx.state, cmd.entity);
            summary(`set ${names.entity(cmd.entity)}'s ${names.resource(cmd.resource)} to ${cmd.value}`);
            setResource(ctx, cmd.entity, cmd.resource, cmd.value, cause);
            return;
          case 'addTag':
            getEntity(ctx.state, cmd.entity);
            summary(`tag ${names.entity(cmd.entity)} as ${names.tag(cmd.tag)}`);
            addTag(ctx, cmd.entity, cmd.tag, cause);
            return;
          case 'removeTag':
            getEntity(ctx.state, cmd.entity);
            summary(`remove tag ${names.tag(cmd.tag)} from ${names.entity(cmd.entity)}`);
            removeTag(ctx, cmd.entity, cmd.tag, cause);
            return;
          case 'teleport':
            getEntity(ctx.state, cmd.entity);
            if (!game.spaces.has(cmd.space)) throw new InvalidInput(`unknown space "${cmd.space}"`);
            summary(`teleport ${names.entity(cmd.entity)} to ${names.space(cmd.space)} (${cmd.asLanding ? 'counts as landing' : 'not a landing'})`);
            teleport(ctx, cmd.entity, cmd.space, cmd.asLanding, cause);
            return;
          case 'grantItem':
            getEntity(ctx.state, cmd.entity);
            if (!game.items.has(cmd.item)) throw new InvalidInput(`unknown item "${cmd.item}"`);
            summary(`give ${names.item(cmd.item)} to ${names.entity(cmd.entity)}`);
            grantItem(ctx, cmd.entity, cmd.item, cause);
            return;
          case 'removeItem':
            getEntity(ctx.state, cmd.entity);
            summary(`take ${names.item(ctx.state.items[cmd.item]?.defId ?? cmd.item)} from ${names.entity(cmd.entity)}`);
            removeItem(ctx, cmd.entity, cmd.item, cause);
            return;
          case 'moveItem': {
            const from = getEntity(ctx.state, cmd.entity);
            const to = getEntity(ctx.state, cmd.to);
            const item = ctx.state.items[cmd.item];
            if (!item || item.holder !== cmd.entity) throw new InvalidInput(`${from.name} does not hold that item`);
            if (to.kind !== 'contestant' || cmd.to === cmd.entity) throw new InvalidInput('give it to another contestant');
            summary(`give ${names.item(item.defId)} from ${names.entity(cmd.entity)} to ${names.entity(cmd.to)}`);
            if (!moveItemInstance(ctx, cmd.entity, cmd.item, cmd.to, cause)) throw new InvalidInput(`${to.name} has no room for it`);
            return;
          }
          case 'equipItem': {
            const entity = getEntity(ctx.state, cmd.entity);
            const item = ctx.state.items[cmd.item];
            if (!item || item.holder !== cmd.entity) throw new InvalidInput(`${entity.name} does not hold that item`);
            const def = game.items.get(item.defId);
            if (cmd.equipped && def?.slot === undefined) throw new InvalidInput(`${def?.name ?? 'that item'} is not worn (it has no equipment slot)`);
            if (cmd.equipped && !equipPlan(game, ctx.state, entity, cmd.item)) throw new InvalidInput(`there is no room to swap ${def?.name ?? 'it'} in (the bag is full)`);
            if (!cmd.equipped && item.equipped && !canUnequip(game, ctx.state, entity, cmd.item)) throw new InvalidInput(`no room in ${entity.name}'s bag to take it off`);
            summary(`${cmd.equipped ? 'equip' : 'take off'} ${names.item(item.defId)} (${names.entity(cmd.entity)})`);
            setEquipped(ctx, cmd.entity, cmd.item, cmd.equipped, cause);
            return;
          }
          case 'applyStatus': {
            const entity = getEntity(ctx.state, cmd.entity);
            const def = game.statuses.get(cmd.status);
            if (!def) throw new InvalidInput(`unknown status "${cmd.status}"`);
            if (entity.status !== 'active') throw new InvalidInput(`${entity.name} is not in play`);
            summary(`${def.transformation ? 'transform' : 'apply'} ${names.entity(cmd.entity)}: ${def.name}${cmd.stacks > 1 ? ` ×${cmd.stacks}` : ''}`);
            applyStatus(ctx, cmd.entity, cmd.status, cmd.stacks, undefined, cause);
            return;
          }
          case 'removeStatus':
            getEntity(ctx.state, cmd.entity);
            if (!game.statuses.has(cmd.status)) throw new InvalidInput(`unknown status "${cmd.status}"`);
            summary(`remove ${game.statuses.get(cmd.status)?.name ?? cmd.status} from ${names.entity(cmd.entity)}`);
            removeStatus(ctx, cmd.entity, cmd.status, 'all', 'removed', cause);
            return;
          case 'spawnEnemy': {
            const def = game.enemies.get(cmd.enemy);
            if (!def) throw new InvalidInput(`unknown enemy "${cmd.enemy}"`);
            if (!game.spaces.has(cmd.space)) throw new InvalidInput(`unknown space "${cmd.space}"`);
            summary(`spawn ${def.boss ? 'boss ' : ''}${def.name} at ${names.space(cmd.space)}`);
            spawnEnemy(ctx, cmd.enemy, cmd.space, cause);
            return;
          }
          case 'removeEntity': {
            const entity = getEntity(ctx.state, cmd.entity);
            if (entity.kind === 'contestant') throw new InvalidInput('contestants cannot be removed; knock them out or eliminate them instead');
            summary(`remove ${entity.name} from the board`);
            removeEntity(ctx, cmd.entity, cause);
            return;
          }
          case 'drawCard': {
            const entity = getEntity(ctx.state, cmd.entity);
            if (entity.kind !== 'contestant') throw new InvalidInput('only contestants draw cards');
            if (!game.decks.has(cmd.deck)) throw new InvalidInput(`unknown deck "${cmd.deck}"`);
            summary(`${names.entity(cmd.entity)} draws from ${game.decks.get(cmd.deck)?.name ?? cmd.deck}`);
            drawCard(ctx, cmd.deck, cmd.entity, cause);
            return;
          }
          case 'assignObjective': {
            const entity = getEntity(ctx.state, cmd.entity);
            if (entity.kind !== 'contestant' || entity.status === 'eliminated') throw new InvalidInput('only contestants in play take objectives');
            if (!game.objectives.has(cmd.objective)) throw new InvalidInput(`unknown objective "${cmd.objective}"`);
            if (ctx.state.objectives.some((o) => o.owner === cmd.entity && o.defId === cmd.objective && !o.done)) throw new InvalidInput(`${entity.name} already has that objective`);
            summary(`give ${names.entity(cmd.entity)} a secret objective`);
            assignObjective(ctx, cmd.entity, cmd.objective, cause);
            return;
          }
          case 'announce':
            ctx.emit({ type: 'announced', text: cmd.text }, cause);
            return;
        }
      },
      { reactions: !silent },
    );
  });
}
