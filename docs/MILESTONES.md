# Milestones

The first playable version is **M0–M3**. V1 is M0–M7. M8 is post-V1. Each milestone keeps the app
runnable and `npm run check` green.

## M0 — Project setup
- [x] Single npm package, three tsconfig projects (core / server / web), Vite, Vitest
- [x] `.gitignore` additions (`/data/`), `.env.example`, README development section
- [x] Import-boundary test (engine cannot import React, Node built-ins, or other layers)
- [x] `/api/health` and a placeholder page served through Vite middleware (`npm run dev`)

**Done when:** fresh clone → `npm install && npm run check` passes; `npm run dev` serves a page that
shows the server status.

## M1 — Headless engine with combat and progression
- [x] Zod schemas for definitions and state; version constants
- [x] Seeded RNG in state; operations with snapshot rollback; per-rule rollback points; budgets
- [x] Rule subset (§5 of ARCHITECTURE): triggers, conditions, numbers, selectors, effects, `maxPerTurn`
- [x] Compiler: reference checks, binding checks, static limits, rule index, cycle warnings
- [x] Power (stat) and HP (pool) resources; items with Power modifiers; inventory cap
- [x] Weighted combat wheel, configurable damage formula, recorded spins, exact fight-odds calculator
- [x] Enemies (regen, respawn, rewards); Demon lair ambush via rule; KO outcome for contestants
- [x] Turn machine: roll → move decision → landing → main decision (buy / attack / rest / pass)
- [x] Star Vendor that relocates; victory at 3 stars or round limit
- [x] "Star Chase" starter scenario with Dojos, Ash Shrine, Gear Shop, Slimes, Demon
- [x] Explain module: rule text and "why" traces
- [x] Heuristic controller (personality-weighted, uses fight odds)
- [x] `npm run sim` CLI with match report (rounds, winners, fights, win paths, decision counts)

**Status:** done. `npm run sim -- --matches 1000 --seed accept`: 0 rule faults, 0 aborts, 1.74 real
decisions per turn, median final effective Power 630, 0.58 Demon kills per match, wins spread across
archetypes (power farmer 416, banker 367, gear-up 150, star chaser 81).

**Done when:** 1,000 seeded sims finish without faults or aborts; the same seed gives the same state
hash; ≥ 1.5 real decisions per turn with ≥ 2 options; wheel frequencies match shares statistically;
a looping ruleset is aborted, rolled back exactly and flagged by the compiler; the sim report shows
contestants gaining Power and at least some Demon defeats.

## M2 — AI contestants (headless)
- [x] `ContestantView` projection, event redaction, view-safe previews (combat odds included)
- [x] Persona, archetype casting, strategy selection, current plan, reconsider flags
- [x] Packet builder with token-size report
- [x] Fixed response schema, validation, one repair retry, heuristic fallback, circuit breaker
- [x] OpenAI Responses adapter (`gpt-6-luna`, configurable) and mock adapter
- [x] Call metrics (tokens, latency, attempts, outcome, estimated cost) written to `ai-calls.jsonl`
- [x] Hidden-information pair tests; mock failure-scenario tests

**Status:** done, except a live run against the OpenAI API: `api.openai.com` is blocked by the build
environment's egress policy. The adapter is verified against the installed `openai` SDK types and a fake
`fetch`; `npm run sim -- --controllers mock` runs the full pipeline offline (repairs exercised, 0 %
fallback, packet p50 ≈ 1.5k / p95 ≈ 2.0k estimated tokens); `--controllers llm` without a key falls back
cleanly. First live run: set `OPENAI_API_KEY` and run `npm run sim -- --controllers llm`.

**Done when:** `npm run sim -- --controllers llm` completes a match (or cleanly falls back without a
key); hidden-pair and failure tests pass; the report shows packet sizes, fallback rate and match
duration.

## M3 — GM app (first playable version)
- [x] Coordinator per match: engine loop, controllers, pause / resume / step, invalidation of
      outstanding decisions after GM edits
- [x] HTTP commands + SSE updates
- [x] Persistence: snapshot on round end and on save, `history.jsonl`, load after restart
- [x] React UI: SVG board, standings (Power, HP, gold, stars), event log with "why?" traces
- [x] Combat wheel animation replaying recorded spins
- [x] Contestant inspector (persona, strategy, plan, last packet) and "view as contestant"
- [x] GM interventions: adjust resource (HP, Power, gold…), add/remove tag, teleport (as-landing
      checkbox), grant item, announce
- [x] Match duration and AI cost shown in the UI

**Status:** done. Verified in headless Chromium against the running app (scripted provider): at
round 3 a contestant tagged Fish got no bananas from a non-landing teleport onto the Lagoon and +2 from a
landing one, with the "why" trace showing the rule and its checks; a Demon fight played on the wheel
with the log held back until the animation finished; after save → server restart → reload the state
hash was identical and the match resumed. Live watching with `gpt-6-luna` still needs a first run on a
machine with API access (the build environment cannot reach api.openai.com).

**Done when:** the GM starts a match with 4 contestants, pauses in round 3, tags one as Fish, teleports
it onto a Blue space with "counts as landing" off (no bananas) and then on (bananas, trace explains),
grants Power and watches it challenge the Demon with a visible wheel, restarts the server, loads the
save, and continues with an identical state hash.

**Follow-ups (done):**
- [x] Board, standings and inspector show the values from when a fight started until the wheel
      finishes (previously HP and Power jumped to the result immediately)
- [x] Autosave a moment after every committed operation (previously only at round end), so a crash
      loses at most a fraction of a second; covered by a server test
- [x] The play loop waits for the wheel after any fight, including fights started by GM commands
- [x] `npm run build` writes the web bundle to `dist-web/`; `npm start` serves it without Vite

## M4 — Mechanics breadth
- [x] Statuses: durations in the holder's turns (enemies: rounds), stacking (refresh / extend /
      stack / ignore), granted tags, per-stack modifiers, capability suppression, hidden statuses;
      a knockout ends them (`ko.clearStatuses`)
- [x] Transformation templates, one at a time (Fish Form: tagged Fish, −1 Move, no shopping)
- [x] Before-modifiers on damage, resource changes, prices, movement rolls and status application
      (add / scale / clampTo / prevent in priority order, paid with a status stack or the item);
      price and roll modifiers must be public and view-safe
- [x] Continuous rules: stat modifiers and capability suppression, evaluated on read (no effective
      stats, no randomness)
- [x] Rules attached to items, statuses and enemies (`$holder`, limits per holder); limits per
      turn / round / game and cooldowns
- [x] Contestant-vs-contestant combat with loot to the victor, elimination mode, threat previews
- [x] Bosses and enemy spawning (GM tool, `spawn` effect, event card); removing entities
- [x] Event deck (hidden order, public counts, card-counting hints) and pending choices answered in
      their own operations, with defaults when nobody can answer
- [x] Custom actions (location, cost, cooldown, optional target); usable and concealed items
- [x] Save format 2 with a migration from format 1, tested on a real save from the first playable
      version
- [x] Starter content: Mystery spaces with a 17-card Island Events deck, 8 statuses, potions, smoke
      bombs, shield charms, a concealed Lucky Coin, a Banana Stand, the Kraken boss, pickpocket /
      pray / fish actions, a harbor sanctuary
- [x] GM tools: apply / remove status (with stacks), transform, draw a card (the GM sees the next
      card), spawn enemy, remove

**Status:** done. 62 rule-interaction scenarios (`tests/scenarios.test.ts`) pass alongside the 11
rule tests from M1. With Fish Form applied, the move preview and packet show −1 Move on the roll and
"Right now you cannot shop (Fish Form)". A boss scenario plays spawn → wounded → enraged → defeated
→ rewards → never returns. In headless Chromium the GM spawned the Kraken, shielded a contestant and
teleported it onto the boss; the wheel showed the shields absorbing two hits before the knockout.
`npm run sim -- --matches 200 --rounds 30`: 0 rule faults, 0 aborts, operation p99 0.27 ms (max
6.3 ms). `npm run sim -- --matches 1000 --seed accept`: 0 faults, 0 aborts, 1.78 real decisions per
turn, median effective Power 560, 0.45 Demon kills, 3.1 PvP fights and 3.1 knockouts per match,
operation p99 0.24 ms; wins by archetype: power farmer 407, star chaser 302, gear-up 210, banker 101
(the banker is weakest; to revisit in the balance pass). Packets through the model pipeline: p50 ≈
2.0k / p95 ≈ 2.6k estimated tokens, with the shared rulebook first as a cacheable prefix.

**Done when:** about 60 rule-interaction scenarios pass; with Fish Form applied, previews show −1
Move and no shop access; a boss fight works end to end; 30-round sims on the starter content have 0
rule faults; operations run at p99 < 10 ms.

## M5 — Social layer
- [x] Secret objectives from templates: dealt with the match RNG, private until completed, then
      revealed with their reward (+1 Star in the starter); count and "have N at once" goals; GM tool
      to assign one
- [x] Trading: offer (free action, once per turn) → accept / reject / one counteroffer → final
      answer; atomic swap with a re-check; view-safe validation; private messages
- [x] Promises (no attack for N rounds, pay within N rounds): public, tracked, kept or broken,
      never enforced; paying is a free action
- [x] Relationships (trust, affinity) updated by fixed rules; memories with code-side selection and
      grouping
- [x] Key-moment dialogue: the most important moment since the last decision is put in the packet
      (the model reacts through `say`; the fallback player speaks short lines from its traits)
- [x] Reconsideration triggers: lost key opportunity (no cooldown), knockout, betrayal, 2+ behind
      the leader, 8 rounds; the fallback player revises its strategy too
- [x] Fallback player: trading (resource sales, loans at the Star Vendor, truces), counteroffers,
      loyalty-based promise keeping, grudges, objective-aware scoring
- [x] Save format 3 with a migration from format 2, tested on a real save from M4
- [x] GM app: social section in the inspector (objectives, promises, feelings, memories, key moment),
      🎯/🤝 markers in the standings, trade prompts in the top bar

**Status:** done. `npm run sim -- --matches 1000 --seed accept`: 0 rule faults, 0 aborts; accepted
trades per match mean 4.6, **median 4**; 5.9 offers and 0.2 counteroffers per match; 3.1 promises
made, 2.5 kept, 0.3 broken; 2.0 objectives completed; 0.3 strategy revisions; operation p99 0.30 ms;
130 ms per match; wins by archetype: star chaser 332, power farmer 323, gear-up 216, banker 137.
30-round sims (200): 0 faults, median 8 accepted trades. `tests/minds.test.ts`: a broken promise
lowers trust by 3 (and becomes the top memory and a reason to reconsider); removing the Demon makes
a Demon-hunting strategy change within 2 of the contestant's own turns, both with the fallback
player and through the model pipeline (scripted provider). Pair tests cover another contestant's
secret objective, concealed items, Stash, deck order, hidden statuses and rules, and memories built
from histories that differ only in private negotiations between others. Headless Chromium: trades,
promises and objectives appear in the log and inspector; assigning an objective from the GM tools
works; no console errors. Packets (mock pipeline): stable instructions ≈ 1.74k estimated tokens,
per-decision input p50 ≈ 560 / p95 ≈ 1,060.

**Done when:** the median sim has at least 1 accepted trade; broken promises lower trust; pair
tests cover objectives, concealed items and memory; a strategy is revised within ≤ 2 of the
contestant's own turns after its key opportunity is removed.

## Hardening pass (after M5)
- [x] Fuzzer (`npm run fuzz`, `tests/fuzz.test.ts`): seeded random decisions, random trade terms and
      random GM edits; after every operation it checks the state schema, inventories, resource
      bounds, statuses, decisions, negotiations, promises and objectives, and that a replay of the
      same inputs reaches the same state. Found and fixed: a respawning enemy got its definition's
      full HP even when its max HP had been lowered. 2,000 fuzzed matches (≈ 800k operations,
      including elimination mode and heavy GM use) are clean.
- [x] A crash in contestant code can no longer stop a match or the server: a failing decision
      falls back to the offline player (recorded in the AI panel with the error), and any
      unexpected error in the play loop pauses the match with a message instead of an unhandled
      rejection
- [x] View building ~2.5× cheaper (lazy fight-preview copies, shallow move previews, backward scan
      for recent events): headless matches 326 → 130 ms
- [x] Event log: "X chose: …" lines are shown only when the contestant said something (the result
      line always follows)
- [x] Balance: contestants no longer lend a rival the gold for an immediate Star; the banker values
      some armour (it was every rival's favourite target)
- [x] The scripted mock provider now proposes truces and counteroffers, so `--controllers mock` and
      the GM app's mock mode exercise model-driven trading end to end (verified in headless Chromium:
      offer → counteroffer → deal → promise, no console errors)
- [x] The GM cannot deal a contestant an objective it is already working on
- [x] Packets: short names in threat notes, trade memories from the contestant's side, capped round
      lists, repeated truces shown once

**Status:** `npm run sim -- --matches 1000 --seed accept` after the pass: 0 faults, 0 aborts, 127 ms
per match, operation p99 0.29 ms, median 3 accepted trades, 2.0 objectives per match; wins by
archetype with the offline player: power farmer 396, gear-up 280, star chaser 223, banker 109 (the
cautious banker remains weakest; balance should be revisited with model-driven contestants).
`npm run fuzz -- --runs 500 --gm 0.15`: 0 problems. Remaining known gaps: SSE updates still send
full state (deltas are M8); separate non-blocking dialogue calls are deferred.

## M6 — GM authoring and live edits
- [x] `askGm` effect and freeform attempts: the game waits for a GM ruling (authored options or
      "No effect"; also the result on timeout, counted in playing time); ruling panel with countdown
- [x] Scenario library: built-in scenarios (read-only, "save as copy") and the GM's own
      (`data/scenarios/`); create, duplicate, delete, import and export JSON, play any valid scenario
- [x] Editor with every definition section as forms, a JSON tab per entry and for the whole scenario,
      undo/redo, live check (problems located and clickable), generated plain-language text for rules,
      id renaming everywhere, a draft kept in the browser
- [x] Board editor: add, drag, connect (one-way or both), paint tags, delete; start space; generators
      (ring, grid, winding line, figure eight, hub and spokes, with tag patterns)
- [x] Rule editor: reaction / modifier / continuous; trigger with the filters its event supports;
      AND / OR / NOT condition trees; effect lists with nested if / for each / random outcomes /
      choices / GM rulings; limits, priority, visibility; a metadata-driven node editor so every
      primitive of the language is reachable without JSON, and a `{ }` JSON switch on every node
- [x] Proposal pipeline for every save and every live change: diff by level, public summary,
      migration plan (auto / confirm / blocked with the reason), code-generated ambiguity questions
      (teleport landing, rounding with real numbers, "everyone" and the actor, status stacking),
      dry runs with fired and not-fired examples
- [x] Live changes: cosmetic and personality changes apply while playing; mechanical changes apply
      while paused as one operation that withdraws and re-issues the waiting decision; ruleset
      versions and a change log; contestants are told what changed (hidden rules left out) and
      reconsider their strategy
- [x] Rewind to the start of any round by replaying recorded inputs (hash-checked, history backup
      kept, minds rebuilt from what each contestant had seen); play continues from there

**Acceptance (headless Chromium, offline contestants):** a new scenario is built without touching
JSON — a 30-space figure-eight board generated with a Coin / Hazard pattern, a space painted Lair,
renamed and dragged, one more space added and connected, a rule made from forms — reviewed (dry runs
shown), saved and played to round 3. In a running Star Chase match, changing the Coin rule while a
move decision waits shows the review ("what contestants are told", before/after, dry runs), applies
as version 2 and logs "📜 The rules changed (version 2): … — the waiting decision d1 was withdrawn and
asked again". Deleting a playing cast member is blocked ("Captain Brine is playing in this match.
Contestants cannot be removed mid-match …") and cannot be applied. A new `askGm` rule brings up the
ruling panel; answering it continues play. Rewinding from round 3 to round 2 reproduces the recorded
state hash and play continues to round 3 again. No console errors. Bugs found and fixed on the way: a
fresh condition defaulted to an empty tag (invalid at once), new entries kept their placeholder ids,
a paused match could refuse a rewind while its loop was still finishing a combat animation, and dry
runs repeated probe text and missed "trigger does not match" examples.

**Done when:** a GM builds a 30-space board and runs a match without touching JSON; a rule changed
mid-match visibly invalidates the waiting decision; incompatible edits are blocked with an
explanation; rewinding to round N and continuing works.

## M7 — Natural-language authoring (optional AI feature)
Separately configured authoring model, depth-bounded proposal schema, unsupported/ambiguity reporting,
one-time command proposals, optional reviewer.

## M8 — Scale and evaluation (post-V1)
8 contestants, 200 spaces, 100+ rules, 300+ turns; rule relevance scoring; delta updates to the UI;
evaluation harness and parallel model-driven match runs.
