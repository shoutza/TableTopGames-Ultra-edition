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
npm run sim               # headless match with the offline controller
```

Without an API key everything still runs: contestants fall back to the deterministic offline
controller. Local saves and AI call logs are written to `data/` (git-ignored).
