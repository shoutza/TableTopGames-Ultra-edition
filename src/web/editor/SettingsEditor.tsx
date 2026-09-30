import { useState } from 'react';
import type { CheckResult } from '../../schema/proposal.ts';
import type { Json } from './model.ts';
import { Checkbox, EnumSelect, IntInput, IssueBadges, RefMulti, RefSelect, Row, TextInput, useEnv } from './fields.tsx';

/** The scenario's name and description, and every game setting (with the schema's defaults shown). */

interface Props {
  def: Json;
  edit: (next: Json, coalesce?: string) => void;
  check: CheckResult | null;
  /** The id cannot change for a saved scenario or a running match (it names the file / match rules). */
  idLocked: boolean;
}

const BUDGET_DEFAULTS: Record<string, number> = { firings: 200, firingsPerRule: 20, events: 500, depth: 24, randomDraws: 256, expressionSteps: 20000, selectorSize: 64, spawns: 10, choices: 4, loopIterations: 256 };

export function SettingsEditor({ def, edit, check, idLocked }: Props) {
  const env = useEnv();
  const [advanced, setAdvanced] = useState(false);
  const s = (def['settings'] ?? {}) as Json;
  const get = (path: string[]): unknown => path.reduce<unknown>((cur, k) => (cur && typeof cur === 'object' ? (cur as Json)[k] : undefined), s);
  const put = (path: string[], v: unknown) => {
    const setIn = (obj: Json, [k, ...rest]: string[]): Json => {
      const next = { ...obj };
      if (!k) return next;
      if (rest.length === 0) {
        if (v === undefined) delete next[k];
        else next[k] = v;
      } else next[k] = setIn((obj[k] as Json | undefined) ?? {}, rest);
      return next;
    };
    edit({ ...def, settings: setIn(s, path) }, `settings.${path.join('.')}`);
  };
  const num = (path: string[], fallback: number, min?: number, max?: number) => <IntInput value={(get(path) as number | undefined) ?? fallback} min={min} max={max} onChange={(v) => put(path, v ?? fallback)} />;
  const bool = (path: string[], fallback: boolean, label: string) => <Checkbox label={label} value={(get(path) as boolean | undefined) ?? fallback} onChange={(v) => put(path, v)} />;
  return (
    <div className="settings-editor">
      <section className="card">
        <h3>Scenario</h3>
        <div className="ed-grid">
          <Row label="Name">
            <TextInput value={def['name'] as string} max={80} wide onChange={(v) => edit({ ...def, name: v }, 'name')} />
          </Row>
          <Row label="Id" help={idLocked ? 'Fixed once saved; use “Save as copy” for a new id.' : 'The file name in the library (lowercase letters, digits, . _ -).'}>
            <TextInput value={def['id'] as string} max={60} onChange={(v) => !idLocked && edit({ ...def, id: v.toLowerCase().replace(/[^a-z0-9_.-]/g, '') }, 'id')} />
          </Row>
          <Row label="Description">
            <TextInput multiline max={2000} value={def['description'] as string | undefined} onChange={(v) => edit({ ...def, description: v }, 'description')} />
          </Row>
        </div>
        {check && (
          <p className="muted small">
            {check.stats.spaces} spaces · {check.stats.connections} connections · {check.stats.rules} rules{check.stats.unreachable > 0 ? ` · ${check.stats.unreachable} unreachable spaces` : ''}
          </p>
        )}
      </section>

      <section className="card">
        <h3>Core resources</h3>
        <p className="muted small">Which resources the engine uses for health, fighting and money.</p>
        <div className="ed-grid">
          {(['hp', 'maxHp', 'power', 'gold'] as const).map((k) => (
            <Row key={k} label={{ hp: 'HP', maxHp: 'Max HP', power: 'Power (combat)', gold: 'Gold (money)' }[k]}>
              <RefSelect section="resources" value={get(['core', k]) as string | undefined} onChange={(v) => put(['core', k], v ?? '')} />
            </Row>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>Turns and movement</h3>
        <div className="ed-grid">
          <Row label="Start space">
            <RefSelect section="spaces" value={get(['startSpace']) as string | undefined} onChange={(v) => put(['startSpace'], v ?? '')} />
          </Row>
          <Row label="Movement die">
            <span className="ed-inline">d{num(['movement', 'die'], 6, 2, 20)}</span>
          </Row>
          <Row label="Movement bonus" help="A stat added to every roll (statuses can lower it).">
            <RefSelect optional section="resources" value={get(['movement', 'bonus']) as string | undefined} onChange={(v) => put(['movement', 'bonus'], v)} />
          </Row>
          <Row label="Inventory slots">{num(['inventoryCapacity'], 3, 0, 20)}</Row>
          <Row label="Resting heals">{num(['rest', 'heal'], 20, 0)}</Row>
        </div>
      </section>

      <section className="card">
        <h3>Combat</h3>
        <div className="ed-grid">
          <Row label="Damage at equal Power">{num(['combat', 'damage', 'base'], 25, 0)}</Row>
          <Row label="Power ratio effect">
            <EnumSelect values={['1', '0.5', '0']} labels={{ '1': 'linear (strong beats weak hard)', '0.5': 'square root (gentler)', '0': 'none (flat damage)' }} value={String(get(['combat', 'damage', 'ratioExponent']) ?? 1)} onChange={(v) => put(['combat', 'damage', 'ratioExponent'], Number(v ?? 1))} />
          </Row>
          <Row label="Damage per hit">
            <span className="ed-inline">
              {num(['combat', 'damage', 'min'], 1, 0)} to {num(['combat', 'damage', 'max'], 100, 1)}
            </span>
          </Row>
          <Row label="Max spins per fight">{num(['combat', 'maxSpinsPerFight'], 8, 1, 50)}</Row>
          <Row label="Contestants fight each other">{bool(['combat', 'pvp'], true, 'allowed')}</Row>
        </div>
      </section>

      <section className="card">
        <h3>Knockouts</h3>
        <div className="ed-grid">
          <Row label="Gold lost">
            <span className="ed-inline">{num(['ko', 'goldLossPercent'], 50, 0, 100)} %</span>
          </Row>
          <Row label="Goes to the victor">{bool(['ko', 'lootToVictor'], true, 'yes')}</Row>
          <Row label="Turns skipped">{num(['ko', 'skipTurns'], 1, 0, 5)}</Row>
          <Row label="Then">
            <EnumSelect values={['respawn', 'eliminate']} labels={{ respawn: 'back to the start', eliminate: 'out of the match' }} value={(get(['ko', 'mode']) as string | undefined) ?? 'respawn'} onChange={(v) => put(['ko', 'mode'], v)} />
          </Row>
          <Row label="Statuses">{bool(['ko', 'clearStatuses'], true, 'a knockout ends them')}</Row>
        </div>
      </section>

      <section className="card">
        <h3>Victory</h3>
        <div className="ed-grid">
          <Row label="Win at">
            <span className="ed-inline">
              {num(['victory', 'threshold'], 5, 1)}
              <RefSelect section="resources" value={get(['victory', 'resource']) as string | undefined} onChange={(v) => put(['victory', 'resource'], v ?? '')} />
            </span>
          </Row>
          <Row label="Or after round">{num(['victory', 'roundLimit'], 20, 1, 500)}</Row>
          <Row label="Ranking" help="Compared in this order for ties and at the round limit.">
            <RefMulti section="resources" max={4} value={get(['victory', 'ranking']) as string[] | undefined} onChange={(v) => put(['victory', 'ranking'], v)} />
          </Row>
        </div>
      </section>

      <section className="card">
        <h3>Social and GM</h3>
        <div className="ed-grid">
          <Row label="Secret objectives each">{num(['objectives', 'perContestant'], 1, 0, 3)}</Row>
          <Row label="Trading">{bool(['trading', 'enabled'], true, 'contestants may trade')}</Row>
          <Row label="Longest promise (rounds)">{num(['trading', 'maxPromiseRounds'], 5, 0, 10)}</Row>
          <Row label="Freeform attempts" help="Contestants may describe something unusual they attempt; you rule on it.">
            {bool(['adjudication', 'freeform'], false, 'allowed')}
          </Row>
          <Row label="Attempt cooldown (rounds)">{num(['adjudication', 'freeformCooldownRounds'], 3, 0, 50)}</Row>
          <Row label="Ruling timeout (seconds)" help="A live match waits this long for your ruling; then the result is “no effect”.">
            {num(['adjudication', 'timeoutSeconds'], 90, 5, 3600)}
          </Row>
        </div>
      </section>

      <section className="card">
        <h3>
          <button className="link" onClick={() => setAdvanced(!advanced)}>
            {advanced ? '▾' : '▸'} Safety limits (advanced)
          </button>
        </h3>
        {advanced && (
          <>
            <p className="muted small">Per operation; a chain of rules that exceeds them is stopped and rolled back.</p>
            <div className="ed-grid">
              {Object.entries(BUDGET_DEFAULTS).map(([k, d]) => (
                <Row key={k} label={k}>
                  {num(['budgets', k], d, 0)}
                </Row>
              ))}
            </div>
          </>
        )}
      </section>
      {env.readOnly && <p className="muted">Read-only.</p>}
      <IssueBadges path={['settings']} />
    </div>
  );
}
