// src/keeper.js
//
// Every KEEPER_INTERVAL_MS: move the finalization queue along, then settle each
// held trade whose verdict has landed on AgentExecutor.
//
// Double settlement cannot happen. The executor consumes a verdict once
// (CommitmentAlreadyUsed), every settlement is simulated before it is sent,
// and a pass never overlaps another.

import { TERMINAL_STAGES } from './store.js';

/** A trade waiting on the user's token approval is retried this rarely. */
export const NEEDS_APPROVAL_RETRY_MS = 5 * 60 * 1000;
/** Other failures back off 30 seconds per attempt, capped here. */
const BACKOFF_STEP_MS = 30 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

/**
 * One pass over the held trades. Every dependency is injected, so each
 * decision can be tested without a chain.
 */
export async function keeperPass({
  list, update, readUsed, readLive, readExpiry, settle,
  drain = null,
  canSettle = () => true,
  now = Date.now(),
}) {
  const summary = { checked: 0, settled: 0, expired: 0, waiting: 0, blocked: 0, failed: 0, finalized: 0, unreadable: 0 };
  if (drain) {
    try {
      const d = await drain();
      summary.finalized = d?.finalized?.length || 0;
    } catch (err) {
      summary.drainError = err?.shortMessage || err?.message || String(err); // the next pass drains again
    }
  }

  for (const e of list()) {
    if (TERMINAL_STAGES.has(e.stage)) continue;
    summary.checked += 1;

    try {
      // Spent comes first: a trade settled in time is settled, however late
      // this pass looks at it.
      if (await readUsed(e.commitment)) {
        // By this server (a receipt that timed out), or by the user's tab.
        update(e.commitment, { stage: 'settled', settledBy: e.settledBy || (e.execTxHash ? 'server' : 'elsewhere') }, now);
        summary.settled += 1;
        continue;
      }
      // Past the order's own deadline the executor would refuse it anyway.
      if (Number(e.deadline) > 0 && now > Number(e.deadline) * 1000) {
        update(e.commitment, { stage: 'expired' }, now);
        summary.expired += 1;
        continue;
      }
      const expiry = Number(await readExpiry(e.commitment));
      if (expiry > 0 && expiry * 1000 < now) {
        update(e.commitment, { stage: 'expired' }, now);
        summary.expired += 1;
        continue;
      }
      if (!(await readLive(e.commitment))) {
        summary.waiting += 1;
        continue;
      }
    } catch (err) {
      // An unreadable chain is not a verdict: wait for the next pass. Counted,
      // so a run of them shows in the log instead of looking like patience.
      summary.waiting += 1;
      summary.unreadable += 1;
      summary.readError = summary.readError || err?.shortMessage || err?.message || String(err);
      continue;
    }

    // The verdict is live.
    if (!canSettle()) { summary.blocked += 1; continue; }
    const since = now - (e.lastAttemptAt || 0);
    if (e.stage === 'needs-approval' && since < NEEDS_APPROVAL_RETRY_MS) { summary.blocked += 1; continue; }
    const backoff = Math.min(MAX_BACKOFF_MS, (e.attempts || 0) * BACKOFF_STEP_MS);
    if ((e.attempts || 0) > 0 && since < backoff) { summary.waiting += 1; continue; }

    let r;
    try { r = await settle(e); } catch (err) { r = { success: false, error: err?.shortMessage || err?.message || 'settle failed' }; }
    if (r?.success) {
      update(e.commitment, {
        stage: 'settled',
        execTxHash: r.execTxHash || e.execTxHash || null,
        settledBy: r.alreadySettled ? (e.settledBy || 'elsewhere') : 'server',
        settledAt: now,
        error: null,
      }, now);
      summary.settled += 1;
    } else if (r?.refused) {
      // A trade this server must never send. Closed, not retried.
      update(e.commitment, { stage: 'cancelled', error: r.error || null }, now);
      summary.blocked += 1;
    } else if (r?.needsApproval) {
      // Needs the user: one token approval. Nothing the server can do.
      update(e.commitment, { stage: 'needs-approval', lastAttemptAt: now, error: r.error || null }, now);
      summary.blocked += 1;
    } else if (r?.verdictExpired) {
      update(e.commitment, { stage: 'expired', error: r.error || null }, now);
      summary.expired += 1;
    } else {
      update(e.commitment, {
        lastAttemptAt: now,
        attempts: (e.attempts || 0) + 1,
        error: r?.error || null,
        ...(r?.execTxHash ? { execTxHash: r.execTxHash } : {}),
      }, now);
      summary.failed += 1;
    }
  }
  return summary;
}

/** While the chain stays unreadable, say so at most this often. */
const OUTAGE_LOG_EVERY_MS = 5 * 60 * 1000;
/** A line proving the keeper is alive, this often. */
const HEARTBEAT_MS = 10 * 60 * 1000;

/** The interval around keeperPass, with one pass at a time and its last result. */
export function createKeeper({ store, reads, settle, drain, canSettle, intervalMs, log = console, now = () => Date.now() }) {
  let running = null;
  let timer = null;
  let last = { at: null, summary: null, error: null };
  let outageSince = null;
  let outageLoggedAt = 0;
  let heartbeatAt = now();

  function report(summary) {
    const t = now();
    const trouble = summary.readError || summary.drainError;
    if (trouble) {
      if (!outageSince) outageSince = t;
      if (t - outageLoggedAt >= OUTAGE_LOG_EVERY_MS) {
        outageLoggedAt = t;
        log.warn(`[keeper] chain unreadable for ${Math.round((t - outageSince) / 1000)}s, trades wait: ${trouble}`);
      }
    } else if (outageSince) {
      log.log(`[keeper] chain readable again after ${Math.round((t - outageSince) / 1000)}s`);
      outageSince = null;
      outageLoggedAt = 0;
    }
    if (summary.settled || summary.expired || summary.failed || summary.finalized) {
      log.log(`[keeper] ${JSON.stringify(summary)}`);
    }
    if (t - heartbeatAt >= HEARTBEAT_MS) {
      heartbeatAt = t;
      log.log(`[keeper] alive: ${summary.checked} open, ${summary.waiting} waiting for a verdict`);
    }
  }

  const runOnce = () => {
    if (running) return Promise.resolve({ skipped: true });
    running = (async () => {
      try {
        const summary = await keeperPass({
          list: store.list, update: store.update,
          readUsed: reads.readUsed, readLive: reads.readLive, readExpiry: reads.readExpiry,
          settle, drain, canSettle,
        });
        last = { at: new Date().toISOString(), summary, error: null };
        report(summary);
        return summary;
      } catch (err) {
        last = { at: new Date().toISOString(), summary: null, error: err?.message || String(err) };
        log.warn(`[keeper] pass failed: ${last.error}`);
        return { error: last.error };
      } finally {
        running = null;
      }
    })();
    return running;
  };

  return {
    runOnce,
    start() {
      if (timer) return;
      timer = setInterval(runOnce, intervalMs);
      setTimeout(runOnce, 3000);
    },
    /** Stop the interval and let a pass in flight finish (a settlement may be mid-send). */
    async stop() {
      clearInterval(timer);
      timer = null;
      if (running) await Promise.race([running, new Promise((r) => setTimeout(r, 25_000))]);
    },
    status: () => ({ ...last, running: Boolean(running), intervalMs, unreadableSince: outageSince ? new Date(outageSince).toISOString() : null }),
  };
}
