// src/finalize.js
//
// Keep the AgentValidator's finalization queue moving.
//
// A verdict reaches AgentExecutor only when its consensus round finalizes, and
// rounds finalize in order, per contract. GenLayer's network finalizes a
// decided round at the head of the queue by itself. It does not finalize a
// round that ended undecided or timed out, or one that stopped mid-vote, and
// one of those at the head holds every round behind it, approved trades
// included. On 2026-09-11 one did, for six hours.
//
// So this clears the queue from its head, with the call that fits each state,
// simulating every finalize first so nothing doomed is broadcast. Anyone may
// finalize; the relayer pays the gas.

import { encodeFunctionData } from 'viem';
import { chains } from 'genlayer-js';

export const GL_STATUS = Object.freeze({
  PENDING: 1, PROPOSING: 2, COMMITTING: 3, REVEALING: 4, ACCEPTED: 5, UNDETERMINED: 6,
  FINALIZED: 7, CANCELED: 8, APPEAL_REVEALING: 9, APPEAL_COMMITTING: 10,
  READY_TO_FINALIZE: 11, VALIDATORS_TIMEOUT: 12, LEADER_TIMEOUT: 13,
});
const FINALIZABLE = new Set([GL_STATUS.READY_TO_FINALIZE, GL_STATUS.UNDETERMINED, GL_STATUS.VALIDATORS_TIMEOUT, GL_STATUS.LEADER_TIMEOUT]);
const IN_FLIGHT = new Set([GL_STATUS.PENDING, GL_STATUS.PROPOSING, GL_STATUS.COMMITTING, GL_STATUS.REVEALING]);
/** A round still mid-vote after this long has stopped progressing. */
export const IDLE_AFTER_MS = 15 * 60 * 1000;

/**
 * What to do with the round at the head of the queue:
 * 'finalize' (it finished), 'finalize-idle' (it stalled mid-vote: restart it
 * with a new leader), or 'wait' (appeal window open, or still voting).
 */
export function finalizationStep(status, createdAtSec, nowMs = Date.now()) {
  const s = Number(status);
  if (FINALIZABLE.has(s)) return 'finalize';
  if (IN_FLIGHT.has(s) && nowMs - Number(createdAtSec) * 1000 > IDLE_AFTER_MS) return 'finalize-idle';
  return 'wait';
}

export async function drainQueue({
  publicClient,
  walletClient,
  recipient,
  maxSteps = 8,
  now = () => Date.now(),
  consensus = chains.testnetBradbury,
}) {
  if (!walletClient) return { finalized: [], reason: 'no relayer key' };
  const { consensusDataContract: data, consensusMainContract: main } = consensus;
  const read = (functionName, args) => publicClient.readContract({ address: data.address, abi: data.abi, functionName, args });
  const finalized = [];

  for (let step = 0; step < maxSteps; step += 1) {
    const [done, accepted] = await Promise.all([
      read('getLatestFinalizedTxCount', [recipient]),
      read('getLatestAcceptedTxCount', [recipient]),
    ]);
    if (BigInt(done) >= BigInt(accepted)) return { finalized, reason: 'queue clear' };

    const [head] = await read('getLatestAcceptedTransactions', [recipient, BigInt(done), 1n]);
    if (!head) return { finalized, reason: 'queue head unreadable' };

    const action = finalizationStep(head.status, head.createdTimestamp, now());
    if (action === 'wait') return { finalized, stoppedAt: head.txId, reason: `head round is status ${Number(head.status)}` };

    const functionName = action === 'finalize' ? 'finalizeTransaction' : 'finalizeIdlenessTxs';
    const callData = encodeFunctionData({ abi: main.abi, functionName, args: action === 'finalize' ? [head.txId] : [[head.txId]] });
    try {
      await publicClient.call({ account: walletClient.account.address, to: main.address, data: callData });
    } catch (err) {
      return { finalized, stoppedAt: head.txId, reason: `not finalizable yet (${err?.shortMessage || err?.message || 'refused'})` };
    }
    try {
      // ConsensusMain's gas use moves from block to block (it draws
      // validators), so the estimate alone is not enough of a limit.
      const gas = await publicClient.estimateGas({ account: walletClient.account, to: main.address, data: callData });
      const hash = await walletClient.sendTransaction({ to: main.address, data: callData, gas: (gas * 13n) / 10n });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== 'success') return { finalized, stoppedAt: head.txId, reason: `${functionName} reverted (${hash})` };
      finalized.push({ txId: head.txId, how: functionName, hash });
    } catch (err) {
      return { finalized, stoppedAt: head.txId, reason: err?.shortMessage || err?.message || 'finalize failed' };
    }
  }
  return { finalized, reason: 'step limit' };
}
