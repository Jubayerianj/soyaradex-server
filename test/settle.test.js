import test from 'node:test';
import assert from 'node:assert/strict';
import { settleTrade, outcomeOfRevert, withRetry } from '../src/settle.js';
import { entry, hash } from './helpers.js';

const EXECUTOR = '0x1BCBad3da718690fa60289DcBF15835e5C79021f';

function clients({ used = false, live = true, expiry = 0, allowance = 10n ** 30n, balance = 10n ** 30n, simulate, write, receipt = 'success' } = {}) {
  const calls = [];
  const publicClient = {
    readContract: async ({ functionName }) => ({
      commitmentUsed: used, isVerdictLive: live, verdictExpiry: expiry, allowance, balanceOf: balance,
    })[functionName],
    simulateContract: async (c) => { if (simulate) await simulate(); calls.push('simulate'); return { request: { ...c } }; },
    estimateContractGas: async () => 100_000n,
    waitForTransactionReceipt: async () => ({ status: receipt, blockNumber: 7n }),
  };
  const walletClient = {
    account: { address: '0x23D542DCEFb00b1f4268E67a0EC1EF4de0A58fe2' },
    writeContract: async (req) => { if (write) await write(req); calls.push(['write', req.functionName, req.gas]); return hash('5'); },
  };
  return { publicClient, walletClient, calls };
}

test('a live verdict settles through executeSwap, with gas headroom', async () => {
  const c = clients();
  const r = await settleTrade(entry('1'), { ...c, executor: EXECUTOR });
  assert.deepEqual(r, { success: true, execTxHash: hash('5'), blockNumber: '7' });
  assert.deepEqual(c.calls, ['simulate', ['write', 'executeSwap', 120_000n]]);
});

test('an already spent commitment is settled, and nothing is sent', async () => {
  const c = clients({ used: true });
  assert.deepEqual(await settleTrade(entry('1'), { ...c, executor: EXECUTOR }), { success: true, alreadySettled: true });
  assert.deepEqual(c.calls, []);
});

test('no live verdict, nothing sent', async () => {
  const c = clients({ live: false });
  const r = await settleTrade(entry('1'), { ...c, executor: EXECUTOR });
  assert.equal(r.success, false);
  assert.deepEqual(c.calls, []);
});

test('a lapsed verdict expires the trade', async () => {
  const c = clients({ expiry: Math.floor(Date.now() / 1000) - 10 });
  assert.equal((await settleTrade(entry('1'), { ...c, executor: EXECUTOR })).verdictExpired, true);
});

test('a missing approval is reported as such, before anything is sent', async () => {
  const c = clients({ allowance: 0n });
  const r = await settleTrade(entry('1'), { ...c, executor: EXECUTOR });
  assert.equal(r.needsApproval, true);
  assert.deepEqual(c.calls, []);
});

test('a short balance is a plain failure, not an approval prompt', async () => {
  const c = clients({ balance: 1n });
  const r = await settleTrade(entry('1'), { ...c, executor: EXECUTOR });
  assert.equal(r.needsApproval, undefined);
  assert.match(r.error, /Insufficient balance/);
});

test('a reverted receipt is a failure', async () => {
  const c = clients({ receipt: 'reverted' });
  assert.equal((await settleTrade(entry('1'), { ...c, executor: EXECUTOR })).success, false);
});

test('without a relayer key nothing is attempted', async () => {
  const c = clients();
  assert.equal((await settleTrade(entry('1'), { publicClient: c.publicClient, walletClient: null, executor: EXECUTOR })).success, false);
});

test('what a refusal means', () => {
  assert.deepEqual(outcomeOfRevert(new Error('reverted with CommitmentAlreadyUsed(0x..)')), { success: true, alreadySettled: true });
  assert.equal(outcomeOfRevert(new Error('DeadlineExpired()')).verdictExpired, true);
  assert.equal(outcomeOfRevert(new Error('VerdictExpired()')).verdictExpired, true);
  assert.equal(outcomeOfRevert(new Error('SlippageExceeded()')).error, 'SlippageExceeded');
});

test('a nonce clash with the app is retried with a fresh send', async () => {
  let n = 0;
  const c = clients({ write: async () => { n += 1; if (n === 1) throw new Error('nonce too low'); } });
  const waits = [];
  const r = await withRetry(() => c.walletClient.writeContract({ functionName: 'executeSwap' }), { wait: async (ms) => waits.push(ms) });
  assert.equal(r, hash('5'));
  assert.equal(waits.length, 1);
});

test('a real refusal is not retried', async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n += 1; throw new Error('SlippageExceeded()'); }, { wait: async () => {} }));
  assert.equal(n, 1);
});
