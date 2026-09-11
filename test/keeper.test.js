import test from 'node:test';
import assert from 'node:assert/strict';
import { keeperPass, NEEDS_APPROVAL_RETRY_MS, createKeeper } from '../src/keeper.js';
import { tempStore, entry, hash } from './helpers.js';

function world() {
  const { store } = tempStore();
  const chain = { used: new Set(), live: new Set(), expiry: new Map() };
  const sent = [];
  const deps = (over = {}) => ({
    list: store.list,
    update: store.update,
    readUsed: async (c) => chain.used.has(c),
    readLive: async (c) => chain.live.has(c),
    readExpiry: async (c) => chain.expiry.get(c) || 0,
    settle: async (e) => { sent.push(e.commitment); return { success: true, execTxHash: hash('9') }; },
    ...over,
  });
  return { store, chain, sent, deps };
}
const t0 = Date.now();

test('no verdict yet: it waits and sends nothing', async () => {
  const w = world();
  w.store.register(entry('1'));
  const s = await keeperPass({ ...w.deps(), now: t0 });
  assert.equal(s.waiting, 1);
  assert.deepEqual(w.sent, []);
});

test('verdict live: the server settles it and records the transaction', async () => {
  const w = world();
  w.store.register(entry('1'));
  w.chain.live.add(hash('1'));
  await keeperPass({ ...w.deps(), now: t0 });
  const e = w.store.get(hash('1'));
  assert.deepEqual([e.stage, e.settledBy, e.execTxHash], ['settled', 'server', hash('9')]);
});

test('settled from the user\'s tab first: nothing is sent', async () => {
  const w = world();
  w.store.register(entry('2'));
  w.chain.used.add(hash('2'));
  await keeperPass({ ...w.deps(), now: t0 });
  assert.deepEqual(w.sent, []);
  assert.deepEqual([w.store.get(hash('2')).stage, w.store.get(hash('2')).settledBy], ['settled', 'elsewhere']);
});

test('a trade settled in time reads settled, even when a pass first looks after its deadline', async () => {
  const w = world();
  w.store.register(entry('s', { deadline: Math.floor(t0 / 1000) - 60 }));
  w.chain.used.add(hash('s'));
  await keeperPass({ ...w.deps(), now: t0 });
  assert.equal(w.store.get(hash('s')).stage, 'settled');
});

test('past its deadline, or with a lapsed verdict, it expires unsent', async () => {
  const w = world();
  w.store.register(entry('3', { deadline: Math.floor(t0 / 1000) - 1 }));
  w.store.register(entry('4'));
  w.chain.expiry.set(hash('4'), Math.floor(t0 / 1000) - 5);
  await keeperPass({ ...w.deps(), now: t0 });
  assert.equal(w.store.get(hash('3')).stage, 'expired');
  assert.equal(w.store.get(hash('4')).stage, 'expired');
  assert.deepEqual(w.sent, []);
});

test('a missing token approval parks it, retried only every few minutes', async () => {
  const w = world();
  w.store.register(entry('5'));
  w.chain.live.add(hash('5'));
  const needs = w.deps({ settle: async (e) => { w.sent.push(e.commitment); return { success: false, needsApproval: true, error: 'approval missing' }; } });
  await keeperPass({ ...needs, now: t0 });
  await keeperPass({ ...needs, now: t0 + 60_000 });
  assert.equal(w.store.get(hash('5')).stage, 'needs-approval');
  assert.equal(w.sent.length, 1);
  await keeperPass({ ...w.deps(), now: t0 + NEEDS_APPROVAL_RETRY_MS + 1 });
  assert.equal(w.store.get(hash('5')).stage, 'settled');
});

test('a failure backs off instead of retrying every pass', async () => {
  const w = world();
  w.store.register(entry('6'));
  w.chain.live.add(hash('6'));
  const flaky = w.deps({ settle: async (e) => { w.sent.push(e.commitment); return { success: false, error: 'node busy' }; } });
  await keeperPass({ ...flaky, now: t0 });
  await keeperPass({ ...flaky, now: t0 + 1000 });
  assert.equal(w.sent.length, 1);
  assert.equal(w.store.get(hash('6')).attempts, 1);
});

test('a cancelled trade is never settled', async () => {
  const w = world();
  w.store.register(entry('7'));
  w.chain.live.add(hash('7'));
  w.store.cancel(hash('7'));
  await keeperPass({ ...w.deps(), now: t0 });
  assert.deepEqual(w.sent, []);
});

test('a relayer that cannot settle leaves live trades for the user\'s tab', async () => {
  const w = world();
  w.store.register(entry('8'));
  w.chain.live.add(hash('8'));
  const s = await keeperPass({ ...w.deps(), canSettle: () => false, now: t0 });
  assert.equal(s.blocked, 1);
  assert.equal(w.store.get(hash('8')).stage, 'waiting');
});

test('a sent settlement whose receipt timed out is credited to the server once spent', async () => {
  const w = world();
  w.store.register(entry('9'));
  w.chain.live.add(hash('9'));
  await keeperPass({ ...w.deps({ settle: async () => ({ success: false, execTxHash: hash('e'), error: 'receipt not seen yet' }) }), now: t0 });
  w.chain.used.add(hash('9'));
  await keeperPass({ ...w.deps(), now: t0 + 60_000 });
  const e = w.store.get(hash('9'));
  assert.deepEqual([e.stage, e.settledBy, e.execTxHash], ['settled', 'server', hash('e')]);
});

test('an unreadable chain is not a verdict', async () => {
  const w = world();
  w.store.register(entry('a'));
  const s = await keeperPass({ ...w.deps({ readUsed: async () => { throw new Error('rpc down'); } }), now: t0 });
  assert.equal(s.waiting, 1);
  assert.equal(w.store.get(hash('a')).stage, 'waiting');
});

test('passes never overlap', async () => {
  const w = world();
  let release;
  const slow = new Promise((r) => { release = r; });
  const keeper = createKeeper({
    store: w.store,
    reads: { readUsed: async () => false, readLive: async () => false, readExpiry: async () => 0 },
    settle: async () => ({ success: true }),
    drain: async () => { await slow; return { finalized: [] }; },
    canSettle: () => true,
    intervalMs: 60_000,
    log: { log() {}, warn() {} },
  });
  const first = keeper.runOnce();
  assert.deepEqual(await keeper.runOnce(), { skipped: true });
  release();
  await first;
});
