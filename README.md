# soyaradex-server

The always-on settlement server for Soyara DEX. It settles trades that GenLayer
consensus approved, with every browser tab closed.

## What it does

1. The Soyara app opens a consensus round for a trade on the AgentValidator
   Intelligent Contract, and hands the trade to this server.
2. About 30 minutes later GenLayer finalizes the round and the verdict lands on
   AgentExecutor. Every 30 seconds this server checks, and settles each trade
   whose verdict is live with `AgentExecutor.executeSwap(order, program)`.
3. It also keeps the AgentValidator finalization queue moving. Rounds finalize
   in order, and GenLayer's network does not finalize one that ended undecided
   or timed out; one of those at the head holds every trade behind it.

It cannot authorise anything. AgentExecutor refuses a trade unless consensus
recorded a verdict for exactly that order, consumes each verdict once, and sends
the output straight to the user's wallet. If this server is down, trades still
settle from the user's open Soyara tab, as before.

## Deploy on Railway

1. **New Project → Deploy from GitHub repo →** `soyaradex-server`.
2. **Variables:**
   - `RELAYER_PRIVATE_KEY`: a key AgentExecutor accepts as a relayer (its
     `authorisedAgent`, today the app's `AGENT_PRIVATE_KEY`), holding a little GEN.
   - `SERVER_API_KEY`: a long random string, for example `openssl rand -hex 32`.
   - `STORE_PATH`: `/data/settlements.json`
3. **Add a Volume** to the service with mount path `/data`, so a redeploy keeps
   the trades it holds.
4. **Settings → Networking → Generate Domain.** Open `https://<domain>/health`
   and check `"canSettle": true` and `"warnings": []`.
5. Keep **one replica**: two would race each other for the same trades.
6. In the **Soyara app's** environment set `SETTLEMENT_SERVER_URL=https://<domain>`
   and `SETTLEMENT_SERVER_KEY=<the same SERVER_API_KEY>`, then redeploy the app.
   The app then hands every approved trade to this server and runs no keeper of
   its own.

## Environment

| Variable | Default | |
|---|---|---|
| `RELAYER_PRIVATE_KEY` | none | Sends settlements and finalize calls. Without it, trades are held but not settled. |
| `SERVER_API_KEY` | none | Required for every write. Without it, the server accepts none. |
| `STORE_PATH` | `./data/settlements.json` | The record of held trades. |
| `PORT` | `4000` | Railway sets this. |
| `RPC_URL` | `https://rpc-bradbury.genlayer.com` | |
| `EXECUTOR_ADDRESS` | `0x1BCBad3da718690fa60289DcBF15835e5C79021f` | AgentExecutor |
| `VALIDATOR_ADDRESS` | `0xd1D809A1210cc039AEdBF5cD04628416Ad0e6a92` | AgentValidator IC |
| `KEEPER_INTERVAL_MS` | `30000` | At least 10000. |

At start, and every 10 minutes, the server checks that the relayer is
authorised, has gas, that AgentExecutor trusts `VALIDATOR_ADDRESS`, and that it
is not paused. Anything wrong shows in the log and in `/health` under `warnings`.

## API

| | | |
|---|---|---|
| `GET /health` | open | Status, warnings, the last keeper pass |
| `GET /v1/settlements/:commitment` | open | Where a trade stands: `waiting`, `needs-approval`, `settled` (with `execTxHash`), `expired`, `cancelled` |
| `GET /v1/settlements?round=0x…` | open | The same, found by its consensus round |
| `POST /v1/settlements` | key | Hand a trade over: `{ commitment, order, program, validationTxHash, label }` |
| `POST /v1/settlements/:commitment/cancel` | key | The user dismissed it: never settle it |
| `POST /v1/keeper` | key | Run a keeper pass now |

Writes need `Authorization: Bearer <SERVER_API_KEY>`. A trade is accepted only if
AgentExecutor derives exactly its commitment from its order, and the route
program hashes to the order's `routeHash`.

## Run it locally

```bash
npm install
cp .env.example .env   # fill in RELAYER_PRIVATE_KEY and SERVER_API_KEY
npm run dev
npm test
```
