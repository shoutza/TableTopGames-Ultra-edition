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
| **ResourceDef** | `id, name, role: pool \| stat, appliesTo[], default, min, max, maxFrom?, visibility: public \| owner \| gm, tradeable`. Integers only (±10⁹); changes clamp to bounds and events record requested vs applied. Tradeable resources must be public pools of contestants. |
| **Effective value** | `stat` resources: base value + Σ modifiers from held items, statuses (× stacks) and continuous rules, then clamped. `pool` resources are plain stored amounts. |
| **HP / Power** | Separate resources. `res.hp` is a pool bounded by `res.max_hp`; `res.power` is a stat whose effective value drives combat. |
| **TagDef** | `id, name, appliesTo, color`. "Has tag" means **effective** tags: base tags + tags granted by statuses. |
| **StatusDef / instance** | Def: `duration` (holder turns, or null = until removed), `stacking: refresh \| extend \| stack(maxStacks) \| ignore`, `grantsTags`, `modifiers` (per stack), `suppress` (capabilities), `visibility: public \| hidden`, `transformation` (offered to the GM as a template; one at a time — a new transformation ends the previous one), attached `rules`. Instance on the entity: `defId, stacks, remaining, fresh`. |
| **Capabilities** | `takesTurns, moves, shops, attacks, attackable, usesItems, trades`. Contestants have all, enemies only `attackable`, fixtures none; statuses and continuous rules suppress them. |
| **ItemDef / ItemInstance** | Def: `id, name, description, tags, modifiers[{resource, add}], concealed, tradeable (default true; concealed items never trade), use?{effects, consumed}, rules`. Instance: `id, defId, holder`. Inventory capacity is a setting. |
| **DeckDef** | `id, name, cards[{id, name, count, effects}]`. The deck list is public; the draw order lives in the state and is hidden. |
| **ActionDef** | Custom main actions: `where` (space / space tag), `requires` (view-safe condition), `cost`, `cooldownRounds`, optional `target {kind, range}`, `effects`. |
| **Space / Connection / Layout** | Space: `id, name, tags, description`. Connection: `{a, b, directed}`. Layout (`x, y`) is stored separately, so moving a space on screen never changes movement. |
| **Entity** | `id, kind: contestant \| enemy \| fixture, defId, name, spaceId, resources, tags, items, statuses, status: active \| defeated \| eliminated \| removed, respawnRound?, koTurns`. Fixtures host shops (e.g. the moving Star Vendor). Removed entities stay as tombstones. |
| **EnemyDef** | `id, name, power, maxHp, regenPerRound, respawnAfterRounds \| null, rewards: Effect[], spawns (may be empty), boss, rules`. Stats come only from data; the engine never rescales enemies. |
| **ShopDef** | Entries selling an item or a resource bundle for a price (`resource, amount`). |
| **Rule** | See §5. |
| **Event** | `seq, rev, round, type, data, cause {kind: action \| rule \| gm \| system, ruleId?, parentSeq?}, audience: all \| [ids] \| gm`. |
| **Decision** | `id, actor, kind: move \| main \| choice \| trade, rev, options[{id, kind, label, params}]`. Options: move, buy (with its modified price), attack (enemy or contestant), use (item), act (custom action, optional target), rest, pass, choose, trade (propose; free action), pay (keep a payment promise; free action), tradeAnswer (accept / reject / counter). Stored in the state so saves include it. |
| **Pending choice** | Queued by `offerChoice`: `chooser, prompt, options (label, requires, effects), default, saved bindings`. Answered in its own later operation. |
| **ObjectiveDef / instance** | Def: `id, name, text?, goal: count {trigger, times} \| reach {resource, atLeast}, reward: Effect[]`. Instance: `id, defId, owner, progress, done`. The pool is public; who holds which is secret until completed. |
| **Negotiation** | At most one open: `from, to, terms {give, get, promises}, stage: response \| final, message, original`. Terms are from the proposer's side with item instances. |
| **Commitment (promise)** | `by, to, kind: noAttack \| pay, resource, amount, paid, dueRound, status: open \| kept \| broken \| void, trade`. Public; tracked, never enforced. |
| **Contestant mind** | Persona, strategy history, plan, reconsider flag, relationships `{trust, affinity}` per rival, memories, key moment (AI side, never readable by rules). |

**Missing, deleted, renamed content.** Imported JSON with unknown fields or missing required fields is
rejected; defaults exist only where the schema documents them. A rule reading a resource an entity does
not have is a compile warning and a runtime rule fault unless the expression supplies `ifMissing` —
never an implicit 0. Deleting referenced definitions is blocked (later milestones add retire/cascade
proposals). Removed entities stay as tombstones for history. Renames never break references.

---

## 5. Rule language

Rules are JSON, validated by Zod, compiled, and interpreted by trusted engine code.

- **Kinds:**
  - `reaction`: runs after an event; the only source of chains.
  - `modifier`: a pure before-event transform of one value — `damage` (combat hits and the `damage`
    effect), `resourceChange` (from rule effects and rewards; not payments, knockouts or GM edits),
    `price` (shop prices, shown in the offered option), `moveRoll` and `statusApply` (duration or
    immunity). Ops: `add`, `scale(num/den, rounding)`, `clampTo`, `prevent` (terminal). Optional
    `consume`: one stack of a status, or the item carrying the rule — paid only when the modifier
    changes the value. Applied in (priority, position, holder) order, at most once each per value.
    Price and roll modifiers must be public with view-safe conditions (they are shown before acting).
  - `continuous`: additive stat modifiers and capability suppression for the entities an `applies`
    selector picks while a `when` condition holds. Conditions may read base values, tags, statuses,
    positions and items, never effective stats or randomness (the compiler rejects both), so they are
    evaluated on read in a single pass.
- **Attached rules:** items, statuses and enemies carry rules active only while the item is held,
  the status present or the enemy on the board, with `$holder` bound. They fire once per holder, and
  their limits count per holder.
- **Triggers:** `roundStarted`, `roundEnded`, `turnStarted`, `turnEnded`, `left`, `entered`, `landed`,
  `resourceChanged{resource, direction}`, `purchased`, `defeated`, `itemGained`, `itemLost`, `itemUsed`,
  `statusApplied`, `statusRemoved`, `damaged`, `cardDrawn`, `actionUsed`, `spawned`, each with static
  `where` filters (space tag, resource, status, deck, card, action, enemy …).
- **Bindings:** `$actor` (mover, buyer, victor, damage source, chooser), `$target` (affected entity),
  `$holder` (attached rules), `$space`, `$amount`, `$it` (inside `forEach` / `filter`).
- **Conditions:** `all`, `any`, `not`, `hasTag`, `spaceHasTag`, `isKind`, `holds`, `compare`, `exists`,
  `hasStatus(minStacks)`, `same`, `sameSpace`.
- **Numbers:** literals, `res`, `stat` (effective), `roll`, `add`, `sub`, `mul`,
  `div` (rounding **required**: `floor | ceil | halfUp | towardZero`), `min`, `max`, `count`, `round`,
  `amount`, `stacks`.
- **Selectors:** bindings, `all(kind)`, `at(space)`, `withTag`, `filter`, `random`, `leader(resource)`,
  `trailer(resource)`. Stable order, ≤ 64.
- **Space refs:** `$space`, `space(id)`, `spaceOf(entity)`, `randomSpace(tag, excludeSpaceOf?)`.
- **Effects:** `changeResource`, `setResource`, `transfer`, `addTag`, `removeTag`,
  `teleport(asLanding)`, `grantItem`, `transferItem`, `loseItem`, `fight(attacker, defender)`,
  `damage`, `applyStatus(stacks, duration?)`, `removeStatus`, `spawn(enemy, at, count ≤ 3)`, `remove`,
  `drawCard(deck, for)`, `offerChoice(to, prompt, 2–4 options with requires + effects, default)`,
  `announce`, `if`, `forEach`, `randomBranch`.
- **Limits:** `maxPerTurn`, `maxPerRound`, `maxPerGame`, `cooldownRounds`; each rule fires at most once
  per (event, binding, holder). Static limits per rule: ≤ 64 expression nodes, nesting ≤ 4, ≤ 12 effects.
- **Visibility:** `public` or `hidden` (traps: effects are seen, cause shown as "unknown effect").
  Requirements that decide what a contestant is offered (action `requires`, choice `requires`,
  price and roll modifiers) must be **view-safe**: they may read only the chooser's own secrets and
  public data; the compiler rejects anything else.

Customization categories: mechanically defined rules (engine executes), cosmetic changes (names,
descriptions, colors), and GM-adjudicated situations (GM applies explicit results via commands;
`askGm` and freeform attempts arrive in M6). "Become a fish" is a tag; any gameplay consequences are
separate rules or the visible **Fish Form** transformation template (a status: tagged Fish, −1 Move,
cannot shop, 3 turns).

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
they gain 2 Bananas. At most once per turn."* Tags granted by statuses count, so a contestant in Fish
Form gets the bananas, and the Cursed status grants the Cursed tag.

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
  During live play the session waits for the wheel (per-spin delay from the speed setting, also for
  fights started by GM commands). Until the wheel finishes, the event log holds back the fight's
  result and the board, standings and inspector show the match as it was when the fight started.

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

- **Contestant at 0 HP → knocked out** (`ko.mode: respawn`): loses `ko.goldLossPercent` (50 %, rounded
  down) of gold — to the contestant who won the fight when `ko.lootToVictor` — teleports to the start
  space (not a landing), its statuses end (`ko.clearStatuses`, default on; transformations
  included), HP restored to max, skips `ko.skipTurns` (1) turns. If it was its own turn, the turn
  ends.
- **Elimination mode** (`ko.mode: eliminate`): the contestant leaves the match for good (statuses
  cleared, no further turns or turn events); eliminated contestants cannot win, and the last
  contestant standing wins at the next checkpoint.
- **Enemy at 0 HP → defeated:** its `rewards` effects run with `$actor` = victor; its statuses are
  cleared; it becomes inactive and respawns at full HP after `respawnAfterRounds` rounds (or never).
- Defeat by non-combat damage (e.g. hazards) uses the same outcome with no victor.

### 6.5 Who fights

- A contestant may **attack an active, attackable enemy on its space** as its main action, and (with
  `combat.pvp`) **another contestant on its space** who is not recovering from a knockout.
- Rules may start fights with the `fight` effect (the starter Demon ambushes anyone who lands on its
  lair; the Kraken boss grabs anyone who lands on its space). A defender that cannot be attacked
  (smoke, sanctuary) is not fought.
- **Damage modifiers** apply to every hit (shields absorb whole hits, one stack each). The wheel
  shares and base damage are fixed when the fight starts; statuses gained during the fight (e.g. a
  boss becoming enraged) matter from the next fight.
- **Bosses** are enemies with `boss: true`, usually no starting space (spawned by the GM or by a
  rule/card) and attached rules for phases (the Kraken becomes Enraged below half HP).

### 6.6 Odds shown to contestants

The engine computes exact fight-outcome probabilities (dynamic programming over wins/losses) from
**visible** Powers and HP, including public damage modifiers as per-hit damage sequences (a shield
with 2 stacks absorbs the first two hits). Every combat option in a decision packet states the
per-spin chance, damage both ways, hits needed, the outcome probabilities, and the rewards (for PvP:
the gold at stake both ways). Hidden modifiers and hidden statuses are never included in previews.

**Threats.** For every move option the packet lists rivals who could reach that space on their
next turn (the chance their roll gets there) and the knockout odds if they attack, weighted by how
favorable the fight would be for them; the fallback player prices this in.

---

## 7. Starter scenario: "Star Chase"

Data in `content/starter/star-chase.json`, fully configurable.

- **Board:** 20-space outer ring plus a 5-space inner shortcut through the Demon's Lair (25 spaces).
- **Economy:** Coin spaces (+3 gold), Blue spaces (+2 gold; Fishy Blue Bonus; Go Fishing), Hazards
  (2d6 damage), a hidden trap (the Gilded Idol's hidden rule costs gold), and a private "Stash" found at
  the Old Well. Bananas buy potions, charms or gold at the Banana Stand.
- **Stars:** a Star Vendor fixture sells a Star for 25 gold and relocates to a random star spot after each
  sale. **Victory:** 3 stars at the end of a round, otherwise most stars after round 20 (ties: gold,
  then Stash, then shared).
- **Power sources:** Dojos (+40 Power), Ash Shrine (+60 Power, −15 HP), Gear Bazaar (Wooden Sword +60 for
  6 gold, Guardian Mail +100 for 12, Iron Sword +150 for 15, Demon Blade +300 for 32; carry at most 3),
  Slimes (60 Power, 30 HP; +50 Power and +3 gold when defeated, respawn next round).
- **The goal enemy:** Demon (500 Power, 300 HP, regenerates 20/round, respawns after 4 rounds). Defeating
  it grants **2 stars** and 20 gold. It ambushes anyone who lands on its lair.
- **Mechanics breadth (M4):** a Move stat (added to rolls); Mystery spaces that draw from the 17-card
  Island Events deck (treasure, blessings, curses, Fish Form, a merchant and a crossroads **choice**, a
  storm, a concealed Lucky Coin, poison, and the Kraken); statuses Blessed, Cursed, Shielded (each stack
  absorbs a hit), Poisoned (damage at the end of your turn, per stack), Smoke Cloud (cannot be
  attacked), Stunned, Enraged; usable items (Healing Potion, Smoke Bomb, Shield Charm); custom actions
  Pickpocket (target a contestant here, 50 % steal / 50 % caught), Pray at the Shrine (4 gold →
  Shielded ×2) and Go Fishing; continuous rules Fish Out of Water (−40 Power off Blue spaces while
  tagged Fish) and Harbor Sanctuary (nobody can be attacked at the start space); PvP with loot; the
  **Kraken** boss (900 Power, 600 HP, grabs anyone landing on its space, enraged +300 Power below half
  HP, 2 stars, never returns).
- **Social (M5):** one secret objective each, dealt from eight (Island Hopper, Slime Slayer,
  Treasure Hoard, Pilgrim, Angler, Dojo Devotee, Big Spender, Banana Baron; each +1 Star); Gold and
  Bananas and every non-concealed item are tradeable; promises last up to 5 rounds.
- **Contestants** start with 80 Power, 100/100 HP, 10 gold.

This creates the intended strategic choices: buy stars early vs invest in gear, farm power vs chase
the vendor, decide when you are strong enough to take the Demon — and now also when to gamble on a
Mystery space, when to spend on protection, whom to avoid, whom to deal with, and whether to keep
your word.

---

## 8. Execution semantics

### 8.1 Turn structure

1. **Round start** (auto): round counter, enemy respawns, `roundStarted` reactions.
2. **Each contestant, in turn order** (drawn from the match seed):
   1. **Turn start** (auto): `turnStarted` reactions. A knocked-out or stunned (`takesTurns`
      suppressed) contestant skips the turn (`turnSkipped`; its turn still ends, so end-of-turn
      effects such as poison still tick). Eliminated contestants are passed over silently.
   2. **Roll** (auto): 1d6 + the `movement.bonus` stat (Move), then `moveRoll` modifiers; public.
   3. **Move decision:** any space reachable in 0..N steps (staying is an option; only staying when
      `moves` is suppressed). Single-option decisions resolve without a model call.
   4. **Move** (operation): shortest path (stable tie-break); events `left`, `moved`, `entered`, and
      `landed` if ≥ 1 step. Intermediate spaces fire nothing in V1.
   5. **Main decision:** buy (one shop entry at a fixture on this space, at the modified price),
      attack an enemy or contestant here, use an item, a custom action, rest (+40 HP), or pass.
      Skipped if the contestant was knocked out during its turn. Two **free actions** come back to
      the main decision afterwards: propose a trade (once per turn) and pay a promised debt.
   6. **Turn end** (auto): `turnEnded` reactions, then the contestant's statuses count down (so a
      status's end-of-turn effect still fires on its last turn).
3. **Round end** (auto): enemy regeneration, `roundEnded` reactions, promises due this round are
   settled (no attack happened → kept; unpaid → broken), statuses of enemies and fixtures count
   down, victory checkpoint, round limit.

**Queued choices** are answered before the phase decision, in order, each in its own operation. A
choice whose chooser can no longer answer (eliminated, nothing legal) resolves to its default in the
next automatic step. An open **negotiation** comes next: its offer or counteroffer is answered by the
party whose turn it is to answer, each step its own operation; an offer nobody can answer any more
lapses in the next automatic step. **Objectives** are settled at the end of every operation. Every
operation ends by issuing the next decision with a fresh id.

**Status durations** count the holder's own turns (enemies and fixtures: rounds) and skip the
countdown at the end of the turn (or round) in which the status was applied.

**Entering vs landing.** `entered` = any arrival (walk or teleport). `landed` = the end of a walk of ≥ 1
step, or a teleport that explicitly says `asLanding: true` (default false). Staying fires nothing.

### 8.2 Operations and transactions

An operation is the atomic unit: an accepted decision, an automatic phase step, or a GM command.

1. **Pre-check** (no state change): decision ID, state revision, actor, option membership, parameters.
2. **Begin transaction.** The operation works on a deep copy of the state; each rule firing takes its
   own copy as a rollback point. This is simple and trivially correct at V1 scale (an operation costs
   well under a millisecond on the starter board); a mutation journal can replace it behind the same
   boundary if profiling at M8 scale requires it.
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

Pending choices (`offerChoice`) are queued with their bindings, deferred to the end of the current
operation and answered as their own operations; a choice is a commit boundary. Card effects,
choice effects, item uses and custom actions each run with their own rollback point, like a rule
firing.

**Budgets per operation (defaults):** 200 rule firings, 20 firings of any single rule, 500 events,
depth 24, 256 random draws, 20,000 expression steps, selector size 64, 10 spawned entities, 4 new
choices, 256 `forEach` iterations.

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
| Positions, public resources, tags, public statuses, public rules, enemy Power/HP, items held | ✓ | ✓ |
| `owner` resources (Stash) | value | existence only |
| Concealed items (Lucky Coin) | ✓ | "a concealed item" (count visible, bonus hidden) |
| Hidden statuses (secret curses) | ✗ | ✗ (modifiers excluded from every view) |
| Hidden rules (incl. hidden modifiers and continuous rules) | ✗ | ✗ (effects visible as "unknown effect") |
| Choices offered by hidden rules | labels only | ✗ |
| Deck order | ✗ | ✗ (pile sizes, deck list and discards are public) |
| RNG state, future rolls | ✗ | ✗ |
| Secret objectives | own (with progress) | that one exists; revealed when completed (the pool is public) |
| Negotiations: offers, counteroffers, messages, what was said while answering | the two parties | ✗ (a completed trade is public) |
| Promises (made in completed trades), and whether they were kept or broken | ✓ | ✓ |
| Others' numeric traits, strategy, plan, memories, relationships | own only | ✗ |

- `ContestantView` is its own type; the packet builder and fallback player cannot reach `GameState`.
- Views are computed with a contestant-facing copy of the game (`viewGame`) from which hidden rules
  are removed, so hidden modifiers and continuous rules never affect effective values, odds or prices
  shown to contestants.
- Every event type has a redactor producing the version an audience may see.
- Previews and odds use only view data. Legality for contestants depends only on visible data; hidden
  effects happen during resolution (an attempt can fail) rather than hiding options.
- Error messages returned to a model never reveal hidden values. Trade validation only mentions what
  both parties can see (tradeable resources are public; concealed items never trade).
- Memories and relationships are derived only from events the contestant could see.
- **Test:** state pairs differing only in hidden data (another contestant's Stash, concealed item or
  secret objective, deck order, hidden statuses and rules, private negotiations between others) must
  produce identical packets, options, previews, memories and fallback choices.

---

## 10. GM operations, live edits and saves

| Edit class | Examples | When | Effect on waiting decisions |
|---|---|---|---|
| GM intervention | adjust/set resource, add/remove tag, teleport (as-landing checkbox), grant/remove item, apply/remove status, transform (template), spawn enemy or boss, remove entity, make a contestant draw a card, assign a secret objective, announce | Between operations, running or paused | Pending decision re-issued with a new ID; in-flight model request aborted. Reactions fire unless "silent". |
| Definition change | rules, items, enemies, victory (M6) | Paused only, as a proposal | All decisions invalidated |

**Saves** (`data/matches/<id>/`): `snapshot.json` (engine, rules-language and save-format versions,
definition, full state including RNG, phase, pending decision, contestant minds; rewritten atomically
a moment after every committed operation, so a crash loses at most a fraction of a second),
`history.jsonl` (events + operation records with inputs, including accepted AI decisions),
`ai-calls.jsonl` (packets, responses, usage, latency, outcome). Loading uses the snapshot.
Re-simulating recorded inputs with the same engine version reproduces the same state hashes (used by
tests and, later, rewind). Replaying recorded results (without re-running rules) serves display and audit.
Older save formats are upgraded by explicit, step-by-step migrations, each covered by a committed
fixture: format 1 (first playable version) → 2 (M4) → 3 (M5: objectives, negotiations, promises,
relationships and memories start empty). Newer formats are refused.

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
- **Reconsideration** is flagged by code before each real decision and answered inside the next
  decision response — no extra call. Triggers: the strategy's key opportunity is gone (e.g. the GM
  removed the Demon or the Star Vendor; checked from the contestant's view — no cooldown), a
  knockout, a broken promise, 2+ of the victory resource behind the leader, 8 rounds on the same
  strategy. Otherwise at most one revision per 3 rounds. The fallback player answers the flag too:
  it switches to the best-fitting archetype that still works (or, far behind, to a higher-reward
  plan).

### 11.2 Social layer

- **Secret objectives** (`objectives` in the definition, `settings.objectives.perContestant`): dealt
  at match start with the match RNG, different per contestant. Goals count events in which the owner
  is `$actor` (landing on Mystery spaces, defeating Slimes, using an action, buying) or ask for an
  amount of a resource at once. Progress is settled at the end of every operation; a completed
  objective is revealed to everyone and its reward (the starter: +1 Star) runs for the owner.
- **Trading** (`settings.trading`): the active contestant may propose one trade per turn as a free
  action to any contestant: up to 3 kinds of tradeable resources and 3 items per side, a message
  (≤ 200 characters, private to the two parties) and at most one promise per side. The partner
  accepts, rejects or makes one counteroffer; the proposer accepts or rejects it. Acceptance re-checks
  that both sides can still deliver and fit the items, then swaps everything at once
  (`tradeCompleted` is public). Offers are validated by the engine with messages that only mention
  what both parties can see; a model gets one repair attempt, and a refused answer never stalls the
  game (the fallback player's choice without the trade is used).
- **Promises** (`noAttack` for N rounds, `pay` an amount within N rounds; N ≤
  `trading.maxPromiseRounds`): public commitments tracked by the engine, never enforced. A voluntary
  attack breaks a no-attack promise; paying (a free "pay" option) keeps a payment promise; at the
  end of the due round the rest are settled (kept / broken). Promises involving an eliminated
  contestant lapse.
- **Relationships** (AI side) change by fixed rules from observed events: promise to me kept trust
  +2, broken −3 (broken to someone else −1), attacked me affinity −2, knocked me out and took gold
  −1 more, a completed trade +1, a hostile action on me −1. Range −10..10.
- **Memory**: observed events become memories (betrayal 5, knockout 4, attacked me 4, trade 3,
  kept promise 3, hostile action 3, objectives 2–3, rejected offer 1). The packet shows the top 4 by
  importance, recency and relevance to the current decision (trade partner, attack targets, rivals
  nearby), with repeats grouped by code ("Vex attacked you 3× (rounds 2, 5, 9)"). No model-written
  summaries.
- **Key-moment dialogue**: the most important moment since the contestant's last decision (a
  betrayal, being attacked or knocked out, a deal, a completed objective) is put in the next packet
  with a prompt to react in character through `say` — no extra call. The fallback player speaks
  short lines from its traits when talkative. Separate, non-blocking reaction calls are deferred.
- **Fallback player**: values trades from its own view (shop exchange rates for resources like
  Bananas, crossing the price of a Star, item value, promise value × trust, the attack opportunity
  a no-attack promise gives up), estimates the partner's side with neutral traits, proposes the best
  deal a partner would plausibly accept (resource sales, loans at the Star Vendor, truces with a
  threatening rival), counters once, pays debts if loyal (loyalty ≥ 4), keeps no-attack promises if
  loyal, holds grudges if vindictive, and does not help the leader.

### 11.3 Decision packets (target 800–1,800 tokens of situation per decision)

Instructions: how to answer → rules digest (victory, loop, public rules, statuses, actions, trading
and promises, the objective pool, shops, enemies, deck list) → persona. The shared rulebook comes before the persona so every contestant of a
match sends the same long prefix (providers cache identical prefixes). Input: strategy, plan, own
state (statuses, what you currently cannot do, secret objective with progress, open promises, how
you feel about rivals, up to 4 memories, the key moment) → standings → recent visible events →
options with engine-computed consequences. Trade decisions show the offer from the contestant's own
side ("you give …; you get …; promises; message"); the trade option lists partners with their ids
and tradeable holdings. Combat options include per-spin chance, damage both ways, outcome
probabilities and rewards; move options note shops, enemies (with odds if you would be ambushed),
training, card draws, known rule effects and threats; choices, item uses and custom actions list
their effects with probabilities. Texts in the digest are generated tersely from the structured
definitions ("landing on a Coin space: +3 Gold").

Measured with the M5 starter (mock pipeline, 3 matches): the stable, cacheable instructions are
≈ 1.74k estimated tokens; the per-decision input is p50 ≈ 560, p95 ≈ 1,060 (total p50 ≈ 2.3k,
p95 ≈ 2.8k). The biggest inputs are six-step move decisions with many reachable spaces.

### 11.4 Responses, validation, fallback

Fixed response schema for every decision (`decisionId, optionId, say, plan, strategyUpdate, trade,
reason`; `trade` holds the terms for a proposal or counteroffer, from the answering side) validated
by Zod, then checked for decision ID, revision, actor and option membership, and trade terms are
checked against the engine without committing. One repair retry
with a view-safe error; timeouts, refusals and repeated failures go to the heuristic fallback player.
Three consecutive provider failures switch all contestants to the fallback and alert the GM. The game
never stalls on the AI.

### 11.5 Provider

- Port: `complete({model, instructions, input, schema, maxOutputTokens, timeoutMs, signal})` →
  parsed value or error kind, usage, latency.
- **OpenAI adapter** (Responses API, `text.format` strict JSON schema) with contestant model
  **`gpt-6-luna`** (configurable via `TTG_CONTESTANT_MODEL`). Reasoning effort is optional config,
  unset by default. The request shape is verified against the installed SDK; model-specific
  parameter support is verified on first live run (the OpenAI docs site is not reachable from the
  build environment).
- Mock adapter for tests and a scripted provider (`TTG_CONTESTANT_PROVIDER=mock`) that exercises
  the whole model pipeline offline; heuristic controller when `OPENAI_API_KEY` is absent.
- Natural-language authoring (M7) uses a separately configured model (`TTG_AUTHORING_MODEL`).
- Metrics per call: input/output/cached/reasoning tokens, latency, attempts, outcome, estimated cost
  from a configurable price table. **Match duration is measured**, not assumed.
- API keys live only in the server's `.env` (git-ignored) and never reach the browser or saves.

---

## 12. Deferred (not in V1 unless noted)

Arbitrary scripts, unrestricted conversations, minigames, interrupt stacks, arbitrary turn systems,
multiplayer hosting, cross-game memory, sophisticated or enforceable contracts (escrow), free-text
promises, separate non-blocking dialogue calls, mechanical alliances that rules can read, autonomous
rule repair, image generation, vector databases, parallel model-driven match infrastructure.

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
