# TableTopGames Ultra Edition — Architecture

A customizable digital board-game sandbox. One human Game Master (GM) builds the board and rules,
intervenes live, and watches AI contestants compete, cooperate, negotiate and betray each other.

This document is the agreed architecture. The staged checklist lives in [MILESTONES.md](MILESTONES.md).
Items marked **Assumption** would change the plan if wrong.

---

## 1. Principles

1. **Deterministic code owns the game.** Positions, resources, inventory, tags, turn order, action
   legality, rule execution, dice, the combat wheel, damage, victory and committed history are all
   computed by the engine. LLMs only *propose*: decisions, dialogue, strategies and (later) authoring
   changes. Every proposal is validated before anything changes.
2. **One authoritative coordinator per match**, one Node process, clearly separated modules. No
   microservices, no long-running autonomous agents: a contestant is persistent data plus one isolated
   model request when a decision is needed.
3. **Reliability over expressiveness.** Customization comes from combining allowlisted primitives.
   User-authored rules are never executable code.
4. **Live GM play first.** The first playable version is about the GM watching and steering one match
   in the browser. Offline simulations exist for testing; infrastructure for many parallel
   model-driven matches is deferred.
5. **Stay runnable offline.** Missing credentials never block engine or UI work: a deterministic
   heuristic controller plays whenever the model provider is unavailable.

**Assumptions:** the only UI user is the GM, on localhost, and the GM is omniscient (no auth, no
spectator views in V1); English only; desktop browser; placeholder visuals.

---

## 2. Stack and build

| Concern | Choice | Notes |
|---|---|---|
| Layout | One npm package, one folder per module, three tsconfig projects | Boundaries enforced by tsconfig `lib`/`types` plus an import-rules test, not by workspaces. |
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly` | `erasableSyntaxOnly` lets Node run sources directly: no enums/namespaces (use string unions). |
| Server runtime | Node ≥ 22.18 built-in type stripping (`node --env-file-if-exists=.env src/server/main.ts`) | No tsx / ts-node / dotenv. |
| HTTP | `node:http` + small route table; Server-Sent Events for pushes; commands via POST | Binds to 127.0.0.1. |
| Web | React + Vite (`@vitejs/plugin-react`), SVG board | Vite runs in middleware mode inside the server: one process, one port. |
| Runtime validation | Zod 4 | Every external input: definitions, saves, GM commands, AI responses. |
| Tests | Vitest | Fuzzing uses the engine's own seeded RNG. |
| Persistence | JSON snapshots + JSONL logs under `data/` (git-ignored) | No database in V1. |
| LLM | `openai` SDK behind a provider port | Contestant model: `gpt-6-luna` (configurable). |

Runtime dependencies: `react`, `react-dom`, `zod`, `openai`. Everything else is a dev dependency.

---

## 3. Modules and ownership

```
src/
  schema/       Zod schemas + inferred types for all external data; version constants
  engine/       deterministic core (no I/O, no clock, no Math.random)
    rng.ts        seeded PRNG; its state lives inside GameState
    compile.ts    definition → compiled ruleset (refs, bindings, limits, rule index, cycle warnings)
    rules/        expression / condition / selector evaluators, effect primitives
    resolve.ts    operations, transactions, cascade, budgets, state checks
    combat.ts     wheel shares, spins, damage, fight-odds calculator
    turn.ts       phase machine, decisions, legal options
    gm.ts         GM command handlers
    explain.ts    structured → English text, "why did this happen?" traces
  visibility/   per-contestant projection (ContestantView), event redaction, view-safe previews
  contestants/  persona / strategy / plan, memory, packet builder, controllers, validation, fallback
  llm/          provider port (core) + OpenAI and mock adapters (server)
  server/       coordinator, HTTP + SSE, persistence, config, metrics
  cli/          headless simulation runner
  shared/       API message types between server and web
  web/          React GM app
content/        starter scenario JSON
tests/          cross-module suites (determinism, hidden-info pairs, rollback fuzz, architecture)
```

| Module | May import | Invariant |
|---|---|---|
| schema | zod | Single source of truth for external data shapes |
| engine | schema | Synchronous, deterministic; all randomness from the state RNG |
| visibility | engine, schema | Produces `ContestantView`, a separate type with no path back to `GameState` |
| contestants | visibility, schema, llm port, engine explain/combat helpers | Never receives `GameState`; the fallback player uses the view too |
| llm adapters | openai, zod | Only place that talks to the provider |
| server | everything except web | Only place with I/O, clock, secrets |
| web | shared, schema | Talks to the server only via HTTP + SSE |

The GM API returns the full state (the GM is omniscient). Visibility filtering exists for the AI
pipeline and for the GM's "view as contestant" panel.

---

## 4. Data model

**Identifiers.** Definitions use immutable namespaced slugs (`res.power`, `tag.fish`, `item.iron_sword`,
`space.lagoon`, `rule.fish_blue_bananas`, `enemy.demon`). Renaming changes only `name`. Runtime instances
use counters stored in the state (`e7`, `i12`, event `seq`, decision `d31`), so rollback and replay
restore them. History and memories store IDs; names are rendered at display time.

| Concept | Representation |
|---|---|
| **ResourceDef** | `id, name, role: pool \| stat, appliesTo[], default, min, max, maxFrom?, visibility: public \| owner \| gm`. Integers only (±10⁹); changes clamp to bounds and events record requested vs applied. |
| **Effective value** | `stat` resources: base value + Σ modifiers (items now; statuses/continuous rules later), then clamped. `pool` resources are plain stored amounts. |
| **HP / Power** | Separate resources. `res.hp` is a pool bounded by `res.max_hp`; `res.power` is a stat whose effective value drives combat. |
| **TagDef** | `id, name, appliesTo, visibility, color`. "Has tag" means base tags (+ status-granted tags from M4). |
| **ItemDef / ItemInstance** | Def: `id, name, description, tags, modifiers[{resource, add}]`. Instance: `id, defId, holder`. Inventory capacity is a setting. |
| **Space / Connection / Layout** | Space: `id, name, tags, description`. Connection: `{a, b, directed}`. Layout (`x, y`) is stored separately, so moving a space on screen never changes movement. |
| **Entity** | `id, kind: contestant \| enemy \| fixture, defId, name, spaceId, resources, tags, items, status: active \| defeated, respawnRound?, koTurns`. Fixtures host shops (e.g. the moving Star Vendor). |
| **EnemyDef** | `id, name, power, maxHp, regenPerRound, respawnAfterRounds \| null, rewards: Effect[]`. Stats come only from data; the engine never rescales enemies. |
| **ShopDef** | Entries selling an item or a resource bundle for a price (`resource, amount`). |
| **Rule** | See §5. |
| **Event** | `seq, rev, round, type, data, cause {kind: action \| rule \| gm \| system, ruleId?, parentSeq?}, audience: all \| [ids] \| gm`. |
| **Decision** | `id, actor, kind: move \| main, rev, options[{id, kind, label, params}]`. Stored in the state so saves include it. |
| **Contestant mind** | Persona, strategy history, plan, memory (AI side, never readable by rules). |

**Missing, deleted, renamed content.** Imported JSON with unknown fields or missing required fields is
rejected; defaults exist only where the schema documents them. A rule reading a resource an entity does
not have is a compile warning and a runtime rule fault unless the expression supplies `ifMissing` —
never an implicit 0. Deleting referenced definitions is blocked (later milestones add retire/cascade
proposals). Removed entities stay as tombstones for history. Renames never break references.

---

## 5. Rule language (subset shipped in the first playable version)

Rules are JSON, validated by Zod, compiled, and interpreted by trusted engine code.

- **Kinds:** `reaction` now; `modifier` (pure before-event value transforms/prevention on damage,
  resourceChange, price, moveRoll, statusApply) and `continuous` (additive, stratified) in M4.
- **Triggers:** `roundStarted`, `roundEnded`, `turnStarted`, `turnEnded`, `left`, `entered`, `landed`,
  `resourceChanged{resource, direction}`, `purchased`, `defeated`, `itemGained`. Each trigger has static
  `where` filters (e.g. `spaceTag`).
- **Bindings:** `$actor` (mover, buyer, victor), `$target` (affected/defeated entity), `$space`,
  `$amount`, `$it` (inside `forEach` / `filter`).
- **Conditions:** `all`, `any`, `not`, `hasTag`, `spaceHasTag`, `isKind`, `holds`, `compare`.
- **Numbers:** literals, `res`, `stat` (effective), `roll`, `add`, `sub`, `mul`,
  `div` (rounding **required**: `floor | ceil | halfUp | towardZero`), `min`, `max`, `count`, `round`,
  `bind`.
- **Selectors:** bindings, `all(kind)`, `at(space)`, `withTag`, `filter`, `random`. Stable order, ≤ 64.
- **Space refs:** `$space`, `space(id)`, `spaceOf(entity)`, `randomSpace(tag, excludeSpaceOf?)`.
- **Effects:** `changeResource`, `setResource`, `transfer`, `addTag`, `removeTag`,
  `teleport(asLanding)`, `grantItem`, `fight(attacker, defender)`, `announce`, `if`, `forEach`,
  `randomBranch`.
- **Limits:** `maxPerTurn`; each rule fires at most once per (event, binding). Static limits per rule:
  ≤ 64 expression nodes, nesting ≤ 4, ≤ 12 effects.
- **Visibility:** `public` or `hidden` (traps: effects are seen, cause shown as "unknown effect").

Customization categories: mechanically defined rules (engine executes), cosmetic changes (names,
descriptions, colors), and GM-adjudicated situations (GM applies explicit results via commands;
`askGm` and freeform attempts arrive in M6). "Become a fish" is a tag; any gameplay consequences are
separate rules or a visible transformation template (M4).

### Example

```json
{
  "id": "rule.fish_blue_bananas",
  "name": "Fishy Blue Bonus",
  "kind": "reaction",
  "visibility": "public",
  "trigger": { "event": "landed", "where": { "spaceTag": "tag.blue" } },
  "conditions": { "op": "all", "conds": [
    { "op": "isKind", "entity": "$actor", "kind": "contestant" },
    { "op": "hasTag", "entity": "$actor", "tag": "tag.fish" },
    { "op": "not", "cond": { "op": "hasTag", "entity": "$actor", "tag": "tag.cursed" } }
  ]},
  "effects": [
    { "op": "changeResource", "target": "$actor", "resource": "res.bananas", "amount": 2 }
  ],
  "limits": { "maxPerTurn": 1 },
  "provenance": { "sourceText": "Whenever an uncursed contestant tagged as a fish lands on a blue space, give them two bananas." }
}
```

Rendered: *"Whenever a contestant lands on a Blue space, if they are tagged Fish and not tagged Cursed:
they gain 2 Bananas. At most once per turn."* (Statuses such as "Cursed" arrive in M4; the starter uses a
tag.)

---

## 6. Combat and character progression

The central progression loop: **contestants must grow stronger before challenging powerful enemies.**
The engine never equalizes an encounter, never scales enemies down, and never requires teamwork.

### 6.1 Power, HP and effective Power

- `res.power` (stat) and `res.hp` (pool, bounded by `res.max_hp`) are separate resources.
- **Effective Power** = base Power + Σ modifiers from held items (+ statuses and continuous rules in M4),
  minimum 1.
- Progression sources are data: training spaces (rules), gear (items with Power modifiers), enemy
  rewards (effects), and anything the GM grants.

### 6.2 The weighted combat wheel

- A **fight** is between an attacker and a defender and lasts up to `maxSpinsPerFight` spins (default 8),
  ending early when either fighter reaches 0 HP.
- Effective Powers are snapshotted when the fight starts.
- **Wheel share** of fighter A = `Power_A / (Power_A + Power_B)`, kept as an exact integer fraction.
- **Each spin** draws an integer `r` uniformly from `[0, Power_A + Power_B)` from the match RNG; A wins the
  spin iff `r < Power_A`. The winner hits the loser; damage reduces the loser's HP.
- **Surviving fighters keep their remaining HP** after the fight. Enemies regenerate only via their
  `regenPerRound` setting.
- The engine records every spin (`share`, `roll`, `winner`, `damage`, `hpAfter`). **The UI animation replays
  the recorded result**; it never computes outcomes. The contestant AI only decides whether to fight.

Examples of per-spin chance against a 500-Power demon: 80 → 13.8 %, 250 → 33.3 %, 500 → 50 %,
1,000 → 66.7 %.

### 6.3 Damage formula (explicit balance settings)

```
damage = clamp( roundHalfUp( base × (winnerPower / loserPower) ^ ratioExponent ), min, max )
```

| Setting | Default | Meaning |
|---|---|---|
| `combat.damage.base` | 25 | Damage when both fighters have equal Power |
| `combat.damage.ratioExponent` | 1 | 1 = linear in the Power ratio; 0.5 = gentler (square root); 0 = flat damage |
| `combat.damage.min` | 1 | Floor per hit |
| `combat.damage.max` | 100 | Cap per hit (a fresh 100-HP contestant can only be one-shot at ≥ 4× Power ratio) |
| `combat.maxSpinsPerFight` | 8 | Spins per fight before both sides disengage |

A stronger fighter therefore wins spins more often **and** hits harder when it wins. Integer arithmetic
is used for exponent 1 and 0; exponent 0.5 uses `Math.sqrt`, which IEEE 754 rounds exactly, so results
stay deterministic.

**Example matchups** (defaults; contestant at 100/100 HP vs Demon: 500 Power, 300 HP; exact outcome
probabilities for one fight of up to 8 spins):

| Contestant Power | Chance per spin | Contestant hits for | Demon hits for | Wins needed / losses survivable | Demon defeated | Contestant KO'd | Both standing |
|---:|---:|---:|---:|---|---:|---:|---:|
| 80 | 13.8 % | 4 | 100 | 75 / 0 | 0 % | 100 % | 0 % |
| 250 | 33.3 % | 13 | 50 | 24 / 1 | 0 % | 99.7 % | 0.3 % |
| 500 | 50.0 % | 25 | 25 | 12 / 3 | 0 % | 63.7 % | 36.3 % |
| 750 | 60.0 % | 38 | 17 | 8 / 5 | 1.7 % | 5.0 % | 93.3 % |
| 1,000 | 66.7 % | 50 | 13 | 6 / 7 | 46.8 % | 0 % | 53.2 % |
| 1,500 | 75.0 % | 75 | 8 | 4 / 12 | 97.3 % | 0 % | 2.7 % |

An 80-Power contestant is hopeless; ~750 Power can wear the demon down across two fights (it keeps its
lost HP apart from regeneration); ~1,000 Power can often finish it in one. Against a Slime (60 Power,
30 HP) a starting 80-Power contestant wins each spin 57.1 % of the time, one-shots it (33 damage) and
wins the fight 99.4 % of the time.

### 6.4 Defeat outcomes (settings)

- **Contestant at 0 HP → knocked out:** loses `ko.goldLossPercent` (50 %, rounded down) of gold,
  teleports to the start space (not a landing), HP restored to max, skips `ko.skipTurns` (1) turns.
  Its current turn ends.
- **Enemy at 0 HP → defeated:** its `rewards` effects run with `$actor` = victor; it becomes inactive
  and respawns at full HP after `respawnAfterRounds` rounds (or never).
- Defeat by non-combat damage (e.g. hazards) uses the same outcome with no victor.

### 6.5 Who fights (first playable version)

- A contestant may **attack an active enemy on its space** as its main action.
- Rules may start fights with the `fight` effect. The starter Demon ambushes any contestant that lands
  on its lair.
- Contestant-vs-contestant combat, retreats, bosses with phases and complex statuses: M4.

### 6.6 Odds shown to contestants

The engine computes exact fight-outcome probabilities (dynamic programming over wins/losses) from
**visible** Powers and HP. Every combat option in a decision packet states the per-spin chance, damage
both ways, hits needed, the outcome probabilities, and the rewards. The same calculator powers the
fallback player and the GM UI. Hidden modifiers (later milestones) are never included in previews.

---

## 7. Starter scenario: "Star Chase"

Data in `content/starter/star-chase.json`, fully configurable.

- **Board:** 20-space outer ring plus a 5-space inner shortcut through the Demon's Lair (25 spaces).
- **Economy:** Coin spaces (+3 gold), Blue spaces (+2 gold; Fishy Blue Bonus), Hazards (lose 2d6 HP),
  a hidden trap (a public-looking space whose hidden rule costs gold), and a private "Stash" resource
  found at the Old Well.
- **Stars:** a Star Vendor fixture sells a Star for 25 gold and relocates to a random star spot after each
  sale. **Victory:** 3 stars at the end of a round, otherwise most stars after round 20 (ties: gold,
  then shared).
- **Power sources:** Dojos (+40 Power), Ash Shrine (+60 Power, −15 HP), Gear Shop (Wooden Sword +60 for
  6 gold, Guardian Mail +100 for 12, Iron Sword +150 for 15, Demon Blade +300 for 32; carry at most 3),
  Slimes (60 Power, 30 HP; +50 Power and +3 gold when defeated, respawn next round).
- **The goal enemy:** Demon (500 Power, 300 HP, regenerates 20/round, respawns after 4 rounds). Defeating
  it grants **2 stars** and 20 gold. It ambushes anyone who lands on its lair.
- **Contestants** start with 80 Power, 100/100 HP, 10 gold.

This creates the intended strategic choices: buy stars early vs invest in gear, farm power vs chase
the vendor, and decide when you are strong enough to take the Demon.

---

## 8. Execution semantics

### 8.1 Turn structure

1. **Round start** (auto): round counter, enemy respawns, `roundStarted` reactions.
2. **Each contestant, in turn order** (drawn from the match seed):
   1. **Turn start** (auto): `turnStarted` reactions. A knocked-out contestant skips the turn.
   2. **Roll** (auto): 1d6 movement, public.
   3. **Move decision:** any space reachable in 0..N steps (staying is an option). Single-option
      decisions resolve without a model call.
   4. **Move** (operation): shortest path (stable tie-break); events `left`, `moved`, `entered`, and
      `landed` if ≥ 1 step. Intermediate spaces fire nothing in V1.
   5. **Main decision:** buy (one shop entry at a fixture on this space), attack an enemy here, rest
      (+40 HP), or pass. Skipped if the contestant was knocked out during the move.
   6. **Turn end** (auto): `turnEnded` reactions.
3. **Round end** (auto): `roundEnded` reactions, enemy regeneration, victory checkpoint, round limit.

**Entering vs landing.** `entered` = any arrival (walk or teleport). `landed` = the end of a walk of ≥ 1
step, or a teleport that explicitly says `asLanding: true` (default false). Staying fires nothing.

### 8.2 Operations and transactions

An operation is the atomic unit: an accepted decision, an automatic phase step, or a GM command.

1. **Pre-check** (no state change): decision ID, state revision, actor, option membership, parameters.
2. **Begin transaction.** The first version snapshots the state (`structuredClone`) as the rollback
   point; this is simple and trivially correct at V1 scale. The `Tx` boundary allows a journal later if
   profiling requires it.
3. **Root firing:** pay costs first, then the action's effects.
4. **Each effect** applies its change (with clamping) and records an event.
5. **Reactions:** after a firing's whole effect list completes, for each emitted event in order,
   matching rules are sorted by `(priority asc, ruleset position asc, binding order)`, their
   conditions are evaluated **at that moment**, and each runs as a child firing, **depth-first**.
6. **Rule fault** (missing reference, missing value): that firing is rolled back to its own rollback
   point, a `ruleFault` event is recorded, and resolution continues.
7. **State checks** after the cascade: defeats and knockouts, repeated until quiescent.
8. **Budget exceeded** anywhere: the whole operation rolls back (state, RNG, counters), the game pauses,
   and the GM sees the partial trace.
9. **Commit:** revision + 1, events appended to history, UI notified.

Pending choices (`offerChoice`, M4) are deferred to the end of the current operation and answered as
their own operations; a choice is a commit boundary.

**Budgets per operation (defaults):** 200 rule firings, 20 firings of any single rule, 500 events,
depth 24, 256 random draws, 20,000 expression steps, selector size 64.

**Cycle analysis:** the compiler derives what each rule's trigger reads and what its effects can emit,
builds a rule→rule graph, and reports cycles as warnings. Runtime budgets remain the safeguard.

**Randomness:** a seeded sfc32 generator whose state is part of `GameState`; every draw is recorded in
its event (die values, wheel rolls).

**"Why did this happen?"** Every event links to its cause (rule + triggering event, action, GM, system);
`explain.ts` renders the chain.

---

## 9. Visibility

| Data | Owner | Others |
|---|---|---|
| Positions, public resources, tags, public rules, enemy Power/HP, items held | ✓ | ✓ |
| `owner` resources (Stash) | value | existence only |
| Hidden rules | ✗ | ✗ (effects visible as "unknown effect") |
| RNG state, future rolls | ✗ | ✗ |
| Others' numeric traits, strategy, plan, memory | own only | ✗ |

- `ContestantView` is its own type; the packet builder and fallback player cannot reach `GameState`.
- Every event type has a redactor producing the version an audience may see.
- Previews and odds use only view data. Legality for contestants depends only on visible data; hidden
  effects happen during resolution (an attempt can fail) rather than hiding options.
- Error messages returned to a model never reveal hidden values.
- **Test:** state pairs differing only in hidden data must produce identical packets, options, previews
  and fallback choices.

---

## 10. GM operations, live edits and saves

| Edit class | Examples | When | Effect on waiting decisions |
|---|---|---|---|
| GM intervention | adjust/set resource, add/remove tag, teleport (as-landing checkbox), grant/remove item, announce | Between operations, running or paused | Pending decision re-issued with a new ID; in-flight model request aborted. Reactions fire unless "silent". |
| Definition change | rules, items, enemies, victory (M6) | Paused only, as a proposal | All decisions invalidated |

**Saves** (`data/matches/<id>/`): `manifest.json` (engine, rules-language and save-format versions),
`snapshot.json` (definition + full state including RNG, phase, pending decision, contestant minds),
`history.jsonl` (events + operation records with inputs, including accepted AI decisions),
`ai-calls.jsonl` (packets, responses, usage, latency, outcome). Loading uses the snapshot.
Re-simulating recorded inputs with the same engine version reproduces the same state hashes (used by
tests and, later, rewind). Replaying recorded results (without re-running rules) serves display and audit.

---

## 11. AI contestants

### 11.1 Persona, match strategy, current plan

- **Persona (stable):** voice (≤ 25 words), six traits 0–10 (risk, aggression, greed, loyalty,
  vindictiveness, sociability), 2–4 concrete behavior rules. Code maps traits to guidance phrases; the
  fallback player uses them as weights. No "intelligence" trait.
- **Match strategy (per match, 40–100 tokens):** `archetype`, summary, 2–4 measurable priorities (e.g.
  `power ≥ 750 by round 10`), what to avoid, reconsider triggers. Archetypes offered only when the
  scenario supports them:
  - **Banker** — income first, buy stars, avoid fights.
  - **Gear Up** — buy equipment, then hunt the Demon.
  - **Power Farmer** — dojos and slimes, then the Demon.
  - **Star Chaser** — follow the vendor, fight only when odds are overwhelming.
  - **Opportunist** — flexible; strike when a favorable fight or cheap star appears.
  A deterministic "casting" step gives each contestant 2–3 candidates (personality fit, ≤ 2 per
  archetype); each contestant picks from its own view at match start.
- **Current plan:** ≤ 30 words, optionally updated with any decision.
- **Reconsideration** is flagged by code (rule change, lost opportunity, progress ≥ 30 % behind, 8 rounds
  elapsed, knockout) and answered inside the next decision response — no extra call.

### 11.2 Decision packets (target 800–1,800 tokens)

System instructions → rules digest (victory, loop, key public rules) → persona, strategy, plan, own
state → standings → recent visible events → options with engine-computed consequences. Combat options
include per-spin chance, damage both ways, outcome probabilities and rewards; move options note shops,
enemies (with odds if you would be ambushed), training and known rule effects.

### 11.3 Responses, validation, fallback

Fixed response schema for every decision (`decisionId, optionId, say, plan, strategyUpdate, reason`)
validated by Zod, then checked for decision ID, revision, actor and option membership. One repair retry
with a view-safe error; timeouts, refusals and repeated failures go to the heuristic fallback player.
Three consecutive provider failures switch all contestants to the fallback and alert the GM. The game
never stalls on the AI.

### 11.4 Provider

- Port: `complete({model, instructions, input, schema, maxOutputTokens, timeoutMs, signal})` →
  parsed value or error kind, usage, latency.
- **OpenAI adapter** (Responses API, `text.format` strict JSON schema) with contestant model
  **`gpt-6-luna`** (configurable via `TTG_CONTESTANT_MODEL`). Reasoning effort is optional config,
  unset by default. The request shape is verified against the installed SDK; model-specific
  parameter support is verified on first live run (the OpenAI docs site is not reachable from the
  build environment).
- Mock adapter for tests; heuristic controller when `OPENAI_API_KEY` is absent.
- Natural-language authoring (M7) uses a separately configured model (`TTG_AUTHORING_MODEL`).
- Metrics per call: input/output/cached/reasoning tokens, latency, attempts, outcome, estimated cost
  from a configurable price table. **Match duration is measured**, not assumed.
- API keys live only in the server's `.env` (git-ignored) and never reach the browser or saves.

---

## 12. Deferred (not in V1 unless noted)

Arbitrary scripts, unrestricted conversations, minigames, interrupt stacks, arbitrary turn systems,
multiplayer hosting, cross-game memory, sophisticated contracts, autonomous rule repair, image
generation, vector databases, parallel model-driven match infrastructure.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Cheap model plays poorly / ignores strategy | Engine-computed odds and consequences in packets, heuristic baseline, strategy-swap probes |
| Match pace too slow for live watching | Auto-resolve forced decisions, piggyback plan/strategy/dialogue, fast-forward with fallback, measured duration |
| Power curve too steep or too flat | All combat and progression numbers are data; the sim reports fight outcomes and win paths |
| GM wants unsupported mechanics | Explicit "unsupported", GM adjudication, grow primitives from logged requests |
| Hidden-info leaks | View-only packet types, redactors, hidden-pair tests |
| Provider API drift | Adapter isolation, configurable model and parameters |
