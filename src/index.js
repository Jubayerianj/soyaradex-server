// src/index.js
//
// soyaradex-server: settles Soyara trades that GenLayer consensus approved,
// with every browser tab closed.
//
// The Soyara app opens a consensus round for a trade and hands the trade here.
// About 30 minutes later GenLayer finalizes the round and the verdict lands on
// AgentExecutor; this server sees it and sends the settlement. It never
// authorises anything: without that verdict, AgentExecutor refuses the trade.

import { formatEther } from 'viem';
import { loadConfig } from './config.js';
import { makeClients, executorReads, AGENT_EXECUTOR_ABI } from './chain.js';
import { createStore, TERMINAL_STAGES } from './store.js';
import { createKeeper } from './keeper.js';
import { settleTrade } from './settle.js';
import { drainQueue } from './finalize.js';
import { createApi } from './api.js';
import { log } from './log.js';

const cfg = loadConfig();
const { publicClient, walletClient } = makeClients(cfg);
const store = createStore(cfg.storePath);
const reads = executorReads(publicClient, cfg.executor);

// ── Can this server settle? Checked at start and every 10 minutes ──────────
const checks = {
  relayer: cfg.relayer?.address || null,
  relayerAuthorised: null,
  relayerGen: null,
  validatorMatches: null,
  paused: null,
  storeError: null,
  checkedAt: null,
  error: null,
};

async function selfCheck() {
  checks.storeError = store.probe();
  const r = (functionName, args = []) => publicClient.readContract({ address: cfg.executor, abi: AGENT_EXECUTOR_ABI, functionName, args });
  try {
    const [trusted, paused] = await Promise.all([r('genLayerValidator'), r('paused')]);
    checks.validatorMatches = trusted.toLowerCase() === cfg.validator.toLowerCase();
    checks.paused = paused;
    if (cfg.relayer) {
      const [agent, listed, balance] = await Promise.all([
        r('authorisedAgent'),
        r('agents', [cfg.relayer.address]),
        publicClient.getBalance({ address: cfg.relayer.address }),
      ]);
      checks.relayerAuthorised = agent.toLowerCase() === cfg.relayer.address.toLowerCase() || Boolean(listed);
      checks.relayerGen = Number(formatEther(balance));
    }
    checks.checkedAt = new Date().toISOString();
    checks.error = null;
  } catch (err) {
    checks.error = err?.shortMessage || err?.message || String(err);
  }
  return checks;
}

function warnings() {
  const w = [];
  if (!cfg.relayer) w.push('RELAYER_PRIVATE_KEY is not set: trades are held but not settled');
  if (checks.relayerAuthorised === false) w.push(`relayer ${cfg.relayer.address} is not authorised on AgentExecutor: the owner must call setAgentAuthorisation(${cfg.relayer.address}, true)`);
  if (checks.relayerGen !== null && checks.relayerGen < 0.05) w.push(`relayer has ${checks.relayerGen} GEN: top it up for gas`);
  if (checks.validatorMatches === false) w.push('AgentExecutor trusts a different AgentValidator than VALIDATOR_ADDRESS');
  if (checks.paused) w.push('AgentExecutor is paused');
  if (!cfg.apiKey) w.push('SERVER_API_KEY is not set: the app cannot hand trades over');
  if (checks.error) w.push(`could not read AgentExecutor to check the setup: ${checks.error}`);
  if (checks.storeError) w.push(`STORE_PATH ${cfg.storePath} is not writable (${checks.storeError}): mount a volume there; on Railway, if it still fails, set RAILWAY_RUN_UID=0`);
  return w;
}

const canSettle = () => Boolean(walletClient) && checks.relayerAuthorised !== false && checks.paused !== true;
const canHold = () => !checks.storeError;

const keeper = createKeeper({
  store,
  reads,
  settle: (entry) => settleTrade(entry, { publicClient, walletClient, executor: cfg.executor }),
  drain: walletClient ? () => drainQueue({ publicClient, walletClient, recipient: cfg.validator }) : null,
  canSettle,
  intervalMs: cfg.keeperIntervalMs,
  log,
});

const server = createApi({
  store,
  keeper,
  apiKey: cfg.apiKey,
  readCommitment: reads.readCommitment,
  // Always answers: a broken store is reported here, never a 500, or the
  // deploy's healthcheck would fail without saying why.
  health: async () => {
    let trades = null;
    try {
      const all = store.list();
      trades = { open: all.filter((e) => !TERMINAL_STAGES.has(e.stage)).length, total: all.length };
    } catch (err) {
      checks.storeError = checks.storeError || err?.message || String(err);
    }
    return {
      ok: true,
      canSettle: canSettle(),
      canHold: canHold(),
      storePath: cfg.storePath,
      warnings: warnings(),
      executor: cfg.executor,
      validator: cfg.validator,
      ...checks,
      keeper: keeper.status(),
      trades,
    };
  },
});

await selfCheck();
for (const w of warnings()) log.warn(`[server] ${w}`);
setInterval(selfCheck, 10 * 60 * 1000).unref();

server.listen(cfg.port, () => {
  log.log(`[server] listening on ${cfg.port} · relayer ${checks.relayer || 'none'} · executor ${cfg.executor} · store ${cfg.storePath} · every ${cfg.keeperIntervalMs / 1000}s`);
  keeper.start();
});

// Railway sends SIGTERM on every redeploy. Let a settlement in flight finish.
async function shutdown(signal) {
  log.log(`[server] ${signal}: finishing the current pass`);
  await keeper.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
