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
Statuses (durations, stacking, granted tags, capability suppression), transformation templates,
contestant-vs-contestant combat, bosses and GM enemy spawning, event deck with pending choices, custom
actions, before-modifiers and continuous modifiers, item/status-attached rules, cooldowns.

## M5 — Social layer
Private objectives (templates, rewards in stars), trading with one counteroffer, commitments and
promises, relationships, memory selection, key-moment dialogue, strategy reconsideration triggers.

## M6 — GM authoring and live edits
Board editor, definition editors (resources, items, enemies with stats and rewards, shops, cast,
victory), constrained rule editor, proposal pipeline with ambiguity probes and dry runs, ruleset
versioning and migrations, rewind, `askGm` and freeform attempts.

## M7 — Natural-language authoring (optional AI feature)
Separately configured authoring model, depth-bounded proposal schema, unsupported/ambiguity reporting,
one-time command proposals, optional reviewer.

## M8 — Scale and evaluation (post-V1)
8 contestants, 200 spaces, 100+ rules, 300+ turns; rule relevance scoring; delta updates to the UI;
evaluation harness and parallel model-driven match runs.
