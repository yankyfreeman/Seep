# Seep ਸੀਪ

An online, real-time version of **Seep** (also known as **Sweep** or **Sip**), the four-player partnership
fishing card game that's popular across Punjab. Create a table, share the link with three friends (or fill
empty seats with bots), and play in the browser on desktop or phone.

## Features

- 4 players in 2 partnerships (partners sit opposite), counter-clockwise play
- Full Seep rules: bidding, capturing, building, raising and cementing (*pakka*) houses, seeps worth 50
- Server-side rules engine: clients only ever see their own hand
- Shareable table links with 4-letter codes, rejoin after a refresh or dropped connection
- Computer players for empty seats; a bot takes over if someone leaves mid-game, and a human can take a bot's seat back
- Live game log, table chat, per-deal score breakdown, configurable winning margin
- Only legal actions are offered in the UI, with a plain-language explanation when a selection doesn't work

## Quick start

Requires Node.js 20+.

```bash
npm install
npm run dev        # game server on :3000 + Vite dev client on http://localhost:5173
```

Open http://localhost:5173, enter a name and create a table. Open the invite link in other browser
windows (or on other devices on your network) to add players, or click **Fill empty seats with bots**.

### Production

```bash
npm run build      # builds the client to dist/client and the server to dist/node
npm start          # serves everything on http://localhost:3000 (set PORT to change)
```

Or with Docker:

```bash
docker build -t seep .
docker run -p 3000:3000 seep
```

Game rooms live in memory, so run a single server instance (rooms are dropped after 30 minutes with nobody connected).

| Env var        | Default | Purpose                                             |
| -------------- | ------- | --------------------------------------------------- |
| `PORT`         | `3000`  | HTTP / WebSocket port                                |
| `BOT_DELAY_MS` | `900`   | Pause before a bot plays, so humans can follow along |
| `CORS_ORIGIN`  | —       | Comma-separated origins if the client is hosted elsewhere |

## Scripts

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Server (auto-reload) + client dev server      |
| `npm test`          | Rules-engine unit tests and bot-vs-bot games  |
| `npm run typecheck` | TypeScript check of server, client and tests  |
| `npm run build`     | Production build                              |

## Rules implemented

**Cards.** Standard 52-card deck. For capturing and building, A = 1, 2–10 = face value, J = 11, Q = 12, K = 13.

**Points (100 per deal).** Every spade is worth its value (A♠ = 1 … K♠ = 13, 91 in total), the other three
aces 1 each, and the 10♦ 6. A **seep** — capturing everything on the floor — is worth 50 more, except on
the final play of a deal.

**Deal and bid.** The dealer gives four cards to the player on their right (the bidder) and four face down
to the floor. The bidder must bid a value from 9 to 13 that they hold (if they have nothing that high, the
cards are redealt). The floor is turned up and the bidder's first play must use the bid: build a house of
that value, capture with a card of that value, or throw that card. Everyone is then dealt up to 12 cards.

**Turns.** Each turn you play one card to:

- **Capture** floor cards equal to your card, alone or in combinations that each add up to it, and/or a house of exactly that value.
- **Build** a house worth 9–13 by combining your card with floor cards. You must hold another card of that value.
- **Raise** an unbroken (*kacha*) house to a higher value (up to 13) by adding a card, again holding the new value.
- **Cement** a house by adding cards totalling its value (a pile of the same value is merged into it).
  Cemented (*pakka*) houses can't be raised.
- **Throw** the card loose on the floor.

While you own a house you may not throw, and you must keep a card of its value. A card equal to a house's
value can't be thrown loose.

**Scoring.** Cards left on the floor at the end go to the team that captured last. Each team scores its card
points plus 50 per seep. Deals continue, with the deal passing to the right, until one team leads by the
target margin (100 by default) and wins the *baazi*.

Seep has many regional variations. These rules live in one place, [`src/shared/rules.ts`](src/shared/rules.ts),
so they're easy to adjust.

## Project layout

```
src/
  shared/     rules engine, card helpers, bot, per-player views, socket protocol (used by server and client)
  server/     Express + Socket.IO server, in-memory rooms
  client/     Vite + TypeScript browser client (no framework)
tests/        Vitest tests for the rules engine
```

## License

MIT
