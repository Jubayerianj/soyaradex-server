import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api.js';
import { orderProblem } from '../src/order.js';
import { tempStore, order, PROGRAM, hash } from './helpers.js';

const KEY = 'test-key-0123456789';

async function serve({ apiKey = KEY, commitmentOnChain = hash('c') } = {}) {
  const { store } = tempStore();
  const passes = [];
  const server = createApi({
    store,
    apiKey,
    keeper: { runOnce: async () => { passes.push(1); return { checked: 0 }; } },
    readCommitment: async () => commitmentOnChain,
    health: async () => ({ ok: true }),
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { method = 'GET', body, key = apiKey } = {}) => fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  return { store, call, passes, close: () => new Promise((r) => server.close(r)) };
}

const trade = { commitment: hash('c'), order: order(), program: PROGRAM, validationTxHash: hash('f'), label: '1 USDC → USDT' };

test('the app hands a trade over, and anyone can see where it stands', async (t) => {
  const s = await serve();
  t.after(s.close);
  const put = await s.call('/v1/settlements', { method: 'POST', body: trade });
  assert.equal(put.status, 201);
  assert.equal(put.body.stage, 'waiting');
  assert.equal((await s.call(`/v1/settlements/${hash('c')}`, { key: null })).body.stage, 'waiting');
  assert.equal((await s.call(`/v1/settlements?round=${hash('f')}`, { key: null })).body.commitment, hash('c'));
});

test('status does not repeat the order', async (t) => {
  const s = await serve();
  t.after(s.close);
  await s.call('/v1/settlements', { method: 'POST', body: trade });
  const got = (await s.call(`/v1/settlements/${hash('c')}`, { key: null })).body;
  assert.equal(got.order, undefined);
  assert.equal(got.program, undefined);
});

test('writes need the key', async (t) => {
  const s = await serve();
  t.after(s.close);
  assert.equal((await s.call('/v1/settlements', { method: 'POST', body: trade, key: 'wrong' })).status, 401);
  assert.equal((await s.call('/v1/settlements', { method: 'POST', body: trade, key: null })).status, 401);
  assert.equal((await s.call(`/v1/settlements/${hash('c')}/cancel`, { method: 'POST', key: null })).status, 401);
  assert.equal((await s.call('/v1/keeper', { method: 'POST', key: null })).status, 401);
});

test('with no key configured, the server accepts no writes at all', async (t) => {
  const s = await serve({ apiKey: '' });
  t.after(s.close);
  assert.equal((await s.call('/v1/settlements', { method: 'POST', body: trade, key: 'anything' })).status, 503);
});

test('only the exact order consensus judges is held', async (t) => {
  const s = await serve({ commitmentOnChain: hash('d') });
  t.after(s.close);
  const r = await s.call('/v1/settlements', { method: 'POST', body: trade });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /does not hash to this commitment/);
  assert.equal(s.store.list().length, 0);
});

test('a malformed order is refused before any chain read', async (t) => {
  const s = await serve();
  t.after(s.close);
  assert.equal((await s.call('/v1/settlements', { method: 'POST', body: { ...trade, program: '0x1234' } })).status, 400);
  assert.equal((await s.call('/v1/settlements', { method: 'POST', body: { ...trade, commitment: '0x12' } })).status, 400);
  assert.match(orderProblem(order({ amountIn: '1.5' }), PROGRAM), /amountIn/);
  assert.match(orderProblem(order({ user: 'nope' }), PROGRAM), /user/);
});

test('the user letting a trade go cancels it', async (t) => {
  const s = await serve();
  t.after(s.close);
  await s.call('/v1/settlements', { method: 'POST', body: trade });
  assert.equal((await s.call(`/v1/settlements/${hash('c')}/cancel`, { method: 'POST' })).body.stage, 'cancelled');
});

test('unknown trades and paths are 404s, a keeper pass runs on demand', async (t) => {
  const s = await serve();
  t.after(s.close);
  assert.equal((await s.call(`/v1/settlements/${hash('9')}`)).status, 404);
  assert.equal((await s.call('/nope')).status, 404);
  assert.equal((await s.call('/v1/keeper', { method: 'POST' })).status, 200);
  assert.equal(s.passes.length, 1);
  assert.equal((await s.call('/health')).body.ok, true);
});
