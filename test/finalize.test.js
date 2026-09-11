import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizationStep, drainQueue, GL_STATUS, IDLE_AFTER_MS } from '../src/finalize.js';
import { hash } from './helpers.js';

const now = Date.now();
const created = Math.floor(now / 1000) - 60;

test('each head state gets the call that fits it', () => {
  assert.equal(finalizationStep(GL_STATUS.READY_TO_FINALIZE, created, now), 'finalize');
  assert.equal(finalizationStep(GL_STATUS.UNDETERMINED, created, now), 'finalize');
  assert.equal(finalizationStep(GL_STATUS.LEADER_TIMEOUT, created, now), 'finalize');
  assert.equal(finalizationStep(GL_STATUS.VALIDATORS_TIMEOUT, created, now), 'finalize');
  assert.equal(finalizationStep(GL_STATUS.ACCEPTED, created, now), 'wait');
  assert.equal(finalizationStep(GL_STATUS.PROPOSING, created, now), 'wait');
  assert.equal(finalizationStep(GL_STATUS.PROPOSING, Math.floor((now - IDLE_AFTER_MS) / 1000) - 5, now), 'finalize-idle');
});

/** A queue of heads, as ConsensusData reports them. */
function chain(heads) {
  let done = 0;
  const sent = [];
  const consensus = {
    consensusDataContract: { address: '0xd', abi: [] },
    consensusMainContract: {
      address: '0xm',
      abi: [
        { type: 'function', name: 'finalizeTransaction', inputs: [{ name: 'txId', type: 'bytes32' }], outputs: [], stateMutability: 'nonpayable' },
        { type: 'function', name: 'finalizeIdlenessTxs', inputs: [{ name: 'txIds', type: 'bytes32[]' }], outputs: [], stateMutability: 'nonpayable' },
      ],
    },
  };
  const publicClient = {
    readContract: async ({ functionName }) => {
      if (functionName === 'getLatestFinalizedTxCount') return BigInt(done);
      if (functionName === 'getLatestAcceptedTxCount') return BigInt(heads.length);
      return [heads[done]];
    },
    call: async () => ({}),
    estimateGas: async () => 1_000_000n,
    waitForTransactionReceipt: async () => { done += 1; return { status: 'success' }; },
  };
  const walletClient = {
    account: { address: '0x23D542DCEFb00b1f4268E67a0EC1EF4de0A58fe2' },
    sendTransaction: async (tx) => { sent.push(tx); return hash(String(sent.length)); },
  };
  return { publicClient, walletClient, consensus, sent };
}

test('it clears undecided heads, oldest first, and stops at a round still in its window', async () => {
  const c = chain([
    { txId: hash('1'), status: GL_STATUS.UNDETERMINED, createdTimestamp: created },
    { txId: hash('2'), status: GL_STATUS.LEADER_TIMEOUT, createdTimestamp: created },
    { txId: hash('3'), status: GL_STATUS.ACCEPTED, createdTimestamp: created },
  ]);
  const r = await drainQueue({ ...c, recipient: '0xd1D809A1210cc039AEdBF5cD04628416Ad0e6a92', now: () => now });
  assert.deepEqual(r.finalized.map((f) => f.txId), [hash('1'), hash('2')]);
  assert.equal(r.stoppedAt, hash('3'));
});

test('every finalize is sent with gas headroom', async () => {
  const c = chain([{ txId: hash('1'), status: GL_STATUS.READY_TO_FINALIZE, createdTimestamp: created }]);
  await drainQueue({ ...c, recipient: '0xd1D809A1210cc039AEdBF5cD04628416Ad0e6a92', now: () => now });
  assert.equal(c.sent[0].gas, 1_300_000n);
});

test('a finalize the chain refuses in simulation is never broadcast', async () => {
  const c = chain([{ txId: hash('1'), status: GL_STATUS.READY_TO_FINALIZE, createdTimestamp: created }]);
  c.publicClient.call = async () => { throw new Error('FinalizationNotAllowed()'); };
  const r = await drainQueue({ ...c, recipient: '0xd1D809A1210cc039AEdBF5cD04628416Ad0e6a92', now: () => now });
  assert.equal(c.sent.length, 0);
  assert.match(r.reason, /not finalizable yet/);
});

test('an empty queue sends nothing', async () => {
  const c = chain([]);
  assert.equal((await drainQueue({ ...c, recipient: '0xd1D809A1210cc039AEdBF5cD04628416Ad0e6a92' })).reason, 'queue clear');
  assert.equal(c.sent.length, 0);
});
