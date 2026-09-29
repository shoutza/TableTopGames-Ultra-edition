import type { GmCommand } from '../schema/commands.ts';
import type { EventCause, GameState } from '../schema/state.ts';
import type { CompiledGame } from './compile.ts';
import { addTag, changeResource, grantItem, removeItem, removeTag, setResource, teleport } from './effects.ts';
import { namesFor } from './explain.ts';
import { getEntity } from './queries.ts';
import { runOperation, runRoot, type OpOutcome } from './resolve.ts';
import { reissueDecision } from './turn.ts';
import { InvalidInput } from './util.ts';

/**
 * GM interventions. They run as ordinary operations between steps: rules react to them unless
 * the GM asks for a silent correction, and any pending decision is re-issued with a new id.
 */
export function applyGmCommand(game: CompiledGame, state: GameState, cmd: GmCommand): OpOutcome {
  if (state.phase === 'gameOver' && cmd.type !== 'announce') return { ok: false, kind: 'invalid', message: 'the game is over' };
  return runOperation(game, state, (ctx) => {
    const cause: EventCause = { kind: 'gm' };
    const names = namesFor(game, ctx.state);
    const silent = 'silent' in cmd ? cmd.silent : false;
    runRoot(
      ctx,
      () => {
        switch (cmd.type) {
          case 'adjustResource': {
            getEntity(ctx.state, cmd.entity);
            ctx.emit({ type: 'gmCommand', summary: `${cmd.delta >= 0 ? '+' : ''}${cmd.delta} ${names.resource(cmd.resource)} for ${names.entity(cmd.entity)}` }, cause);
            changeResource(ctx, cmd.entity, cmd.resource, cmd.delta, cause);
            return;
          }
          case 'setResource':
            getEntity(ctx.state, cmd.entity);
            ctx.emit({ type: 'gmCommand', summary: `set ${names.entity(cmd.entity)}'s ${names.resource(cmd.resource)} to ${cmd.value}` }, cause);
            setResource(ctx, cmd.entity, cmd.resource, cmd.value, cause);
            return;
          case 'addTag':
            getEntity(ctx.state, cmd.entity);
            ctx.emit({ type: 'gmCommand', summary: `tag ${names.entity(cmd.entity)} as ${names.tag(cmd.tag)}` }, cause);
            addTag(ctx, cmd.entity, cmd.tag, cause);
            return;
          case 'removeTag':
            getEntity(ctx.state, cmd.entity);
            ctx.emit({ type: 'gmCommand', summary: `remove tag ${names.tag(cmd.tag)} from ${names.entity(cmd.entity)}` }, cause);
            removeTag(ctx, cmd.entity, cmd.tag, cause);
            return;
          case 'teleport':
            getEntity(ctx.state, cmd.entity);
            if (!game.spaces.has(cmd.space)) throw new InvalidInput(`unknown space "${cmd.space}"`);
            ctx.emit({ type: 'gmCommand', summary: `teleport ${names.entity(cmd.entity)} to ${names.space(cmd.space)} (${cmd.asLanding ? 'counts as landing' : 'not a landing'})` }, cause);
            teleport(ctx, cmd.entity, cmd.space, cmd.asLanding, cause);
            return;
          case 'grantItem':
            getEntity(ctx.state, cmd.entity);
            if (!game.items.has(cmd.item)) throw new InvalidInput(`unknown item "${cmd.item}"`);
            ctx.emit({ type: 'gmCommand', summary: `give ${names.item(cmd.item)} to ${names.entity(cmd.entity)}` }, cause);
            grantItem(ctx, cmd.entity, cmd.item, cause);
            return;
          case 'removeItem':
            getEntity(ctx.state, cmd.entity);
            ctx.emit({ type: 'gmCommand', summary: `take ${names.item(ctx.state.items[cmd.item]?.defId ?? cmd.item)} from ${names.entity(cmd.entity)}` }, cause);
            removeItem(ctx, cmd.entity, cmd.item, cause);
            return;
          case 'announce':
            ctx.emit({ type: 'announced', text: cmd.text }, cause);
            return;
        }
      },
      { reactions: !silent },
    );
    reissueDecision(ctx);
  });
}
