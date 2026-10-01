import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { changeLevel, diffGames } from '../src/authoring/diff.ts';
import { compileGame } from '../src/engine/index.ts';
import { GameDefinitionSchema } from '../src/schema/definition.ts';
import { autoDecorate, layoutOf, THEMES } from '../src/web/boardThemes.ts';

/** The board's look (theme, roads, space shapes, icons, scenery) is layout data and never affects play. */

const starter = () => JSON.parse(readFileSync(new URL('../content/starter/star-chase.json', import.meta.url), 'utf8'));

describe('board look', () => {
  it('older layouts get the plain look', () => {
    const layout = GameDefinitionSchema.parse({ ...starter(), layout: { width: 800, height: 600, positions: starter().layout.positions } }).layout;
    expect(layout).toMatchObject({ theme: 'plain', roads: 'line', curved: false, spaceStyle: 'circle', decor: [] });
  });

  it('changing the theme, scenery and icons is a cosmetic change', () => {
    const before = compileGame(GameDefinitionSchema.parse(starter()));
    const raw = starter();
    raw.layout = { ...raw.layout, theme: 'dungeon', roads: 'trail', spaceStyle: 'hex', decor: [{ icon: '🕯️', x: 10, y: 10 }] };
    raw.tags[0].icon = '🏁';
    raw.spaces[1].icon = '🏰';
    const after = compileGame(GameDefinitionSchema.parse(raw));
    expect(changeLevel(diffGames(before, after))).toBe('cosmetic');
  });

  it('scenery stays off spaces and roads, and is the same every time', () => {
    const def = starter();
    for (const theme of Object.keys(THEMES)) {
      const layout = layoutOf({ ...def.layout, theme, curved: true, decor: [] });
      const decor = autoDecorate(layout, def.connections);
      expect(decor.length).toBeGreaterThan(5);
      expect(autoDecorate(layout, def.connections)).toEqual(decor);
      for (const d of decor) {
        for (const p of Object.values(layout.positions)) expect(Math.hypot(d.x - p.x, d.y - p.y)).toBeGreaterThanOrEqual(64);
        expect(THEMES[layout.theme].decor.includes(d.icon) || THEMES[layout.theme].near?.includes(d.icon) || THEMES[layout.theme].far?.includes(d.icon)).toBe(true);
      }
      // Valid layout data.
      GameDefinitionSchema.parse({ ...def, layout: { ...layout, decor } });
    }
  });

  it('a stored layout with gaps or junk is filled in for drawing', () => {
    expect(layoutOf({ width: 500, positions: {}, theme: 'lava', decor: [{ icon: '🌲', x: 1, y: 2 }, { x: 'no' }] })).toEqual({
      width: 500,
      height: 600,
      positions: {},
      theme: 'plain',
      roads: 'line',
      curved: false,
      spaceStyle: 'circle',
      decor: [{ icon: '🌲', x: 1, y: 2, size: 30 }],
    });
  });
});
