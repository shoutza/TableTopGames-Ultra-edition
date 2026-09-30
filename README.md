# TableTopGames-Ultra-edition

A customizable digital board-game sandbox. A human Game Master builds the board and rules, intervenes
live, and watches AI contestants compete, cooperate, negotiate and betray each other. Deterministic
engine code owns all game state, dice and combat; AI models only propose decisions.

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Milestone checklist: [docs/MILESTONES.md](docs/MILESTONES.md)

## Development

Requires Node.js 22.18 or newer (the server runs TypeScript sources directly).

```sh
npm install
cp .env.example .env      # optional: add OPENAI_API_KEY for model-driven contestants
npm run dev               # GM app at http://127.0.0.1:5173 (hot reload)
npm run check             # typecheck (core, server, web) + tests
npm run build && npm start  # serve the prebuilt web bundle from dist-web/ instead of Vite
```

Without an API key everything still runs: contestants use the deterministic offline controller.
Set `TTG_CONTESTANT_PROVIDER=mock` to exercise the full model pipeline offline with a scripted
provider. Local saves, event histories and AI call logs are written to `data/` (git-ignored).

### Simulations

```sh
npm run sim -- --matches 200                 # balance report with the offline controller
npm run sim -- --matches 200 --rounds 30     # longer matches (no early win) to hunt rule faults
npm run sim -- --seed demo --log             # one match, full event log
npm run sim -- --controllers mock            # one match through the model pipeline, offline
npm run sim -- --controllers llm             # one match with gpt-6-luna (needs OPENAI_API_KEY)
npm run fuzz -- --runs 500 --gm 0.2          # random play + random GM edits, checking invariants
```

### Using the GM app

1. On the home page pick a scenario and press **Play** (Star Chase is built in), then **Start**.
   Contestants pick strategies, then play.
2. Click a token or standings row to inspect it: stats (base vs. effective Power), items,
   personality, strategy, plan, and **View as contestant** (the exact packet its model sees).
3. **GM tools** act on the selected entity: adjust or set resources, add/remove tags, teleport
   (tick *counts as landing* to trigger landing rules), give items, apply or remove statuses,
   transform (e.g. into Fish Form), make it draw a card (the GM sees the next card first), remove
   it from the board, spawn an enemy or boss (the Kraken) on its space, deal it another secret
   objective, announce. Tick *silent correction* to change state without triggering rules.
   The inspector's *Social* section shows a contestant's secret objective, promises, how it feels
   about the others and what it remembers; trades and promises appear in the log (🤝, ✅, 💔).
4. Fights play on the combat wheel, replaying the engine's recorded spins. Click any log line to
   see why it happened (rule, triggering event, conditions checked).
5. **Save** writes a snapshot; matches also autosave a moment after every operation, on pause and on
   shutdown, so a crash loses at most the last fraction of a second. After a restart, open the
   match from the list and resume — the state hash in the top bar matches.
6. **Edit rules** (top bar, or the *Timeline* tab) opens the editor on the match's own rules. Names,
   looks and personalities apply at once; rule changes need a pause and are reviewed first (what
   changes, what contestants are told, what happens to the match, questions, dry runs). Changes
   that cannot apply mid-match are blocked with the reason.
7. When a rule asks you (`askGm`) or a contestant attempts something freeform, the **ruling panel**
   shows the question and options; the match waits (the clock runs only while playing).
8. **Timeline → Rewind** goes back to the start of any round; the rest is replayed from the recorded
   inputs (no model calls) and a backup of the cut history is kept.

### Making scenarios

**+ New scenario** starts a small playable scenario (a 30-space ring, coins, hazards, a market and a
troll). Every section has forms and a JSON tab: the **Board** (add, drag, connect, paint tags, or
generate rings, grids, figure eights and hubs), resources, tags, items, statuses, shops, fixtures,
enemies, decks and cards, actions, secret objectives, the cast and their personalities, the rules
(reactions, modifiers and continuous effects with condition trees and nested effects) and all
settings. Problems show up live in the right column (click to jump there); **Review & save** shows
the changes, asks about easy-to-miss details and dry-runs new rules before saving. Built-in scenarios
are saved as copies; **Import / Export** read and write the scenario JSON. Your scenarios live in
`data/scenarios/`.
