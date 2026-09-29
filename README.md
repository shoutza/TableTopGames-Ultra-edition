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
npm run dev               # GM app at http://127.0.0.1:5173
npm run check             # typecheck (core, server, web) + tests
```

Without an API key everything still runs: contestants use the deterministic offline controller.
Set `TTG_CONTESTANT_PROVIDER=mock` to exercise the full model pipeline offline with a scripted
provider. Local saves, event histories and AI call logs are written to `data/` (git-ignored).

### Simulations

```sh
npm run sim -- --matches 200                 # balance report with the offline controller
npm run sim -- --seed demo --log             # one match, full event log
npm run sim -- --controllers mock            # one match through the model pipeline, offline
npm run sim -- --controllers llm             # one match with gpt-6-luna (needs OPENAI_API_KEY)
```

### Using the GM app

1. Create a match (Star Chase), press **Start**. Contestants pick strategies, then play.
2. Click a token or standings row to inspect it: stats (base vs. effective Power), items,
   personality, strategy, plan, and **View as contestant** (the exact packet its model sees).
3. **GM tools** act on the selected entity: adjust or set resources, add/remove tags, teleport
   (tick *counts as landing* to trigger landing rules), give items, announce. Tick *silent
   correction* to change state without triggering rules.
4. Fights play on the combat wheel, replaying the engine's recorded spins. Click any log line to
   see why it happened (rule, triggering event, conditions checked).
5. **Save** writes a snapshot; matches also autosave at every round end and on pause. After a
   restart, open the match from the list and resume — the state hash in the top bar matches.
