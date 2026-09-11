// src/api.js
//
//   GET  /health                              up, and able to settle?
//   GET  /v1/settlements/:commitment          where a trade stands
//   GET  /v1/settlements?round=0x...          the same, found by its consensus round
//   POST /v1/settlements                      hand a trade over        (key)
//   POST /v1/settlements/:commitment/cancel   the user let it go       (key)
//   POST /v1/keeper                           run a keeper pass now    (key)
//
// Reads are open: a trade's stage is public on chain anyway. Writes need the
// shared key, so only the Soyara app can hand trades over.

import http from 'node:http';
import crypto from 'node:crypto';
import { isCommitment, orderProblem, toExecutorOrder } from './order.js';

const MAX_BODY_BYTES = 64 * 1024;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'body is not JSON')); }
    });
    req.on('error', reject);
  });
}

function hasKey(req, apiKey) {
  const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(apiKey);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

/** What anyone may see about a trade. The order itself is not repeated. */
const view = (e) => ({
  commitment: e.commitment,
  stage: e.stage,
  execTxHash: e.execTxHash || null,
  settledBy: e.settledBy || null,
  error: e.error || null,
  label: e.label || null,
  updatedAt: e.updatedAt || null,
});

export function createApi({ store, keeper, apiKey, readCommitment, health }) {
  async function register(req, res) {
    const { commitment, order, program, validationTxHash = null, label = null } = await readJson(req);
    if (!isCommitment(commitment)) return send(res, 400, { error: 'commitment must be a 32-byte hash' });
    if (validationTxHash !== null && !isCommitment(validationTxHash)) return send(res, 400, { error: 'validationTxHash must be a 32-byte hash' });
    const problem = orderProblem(order, program);
    if (problem) return send(res, 400, { error: problem });

    // Hold only the exact order consensus judges: the executor derives the
    // commitment from it, and it has to be this one.
    let derived;
    try {
      derived = await readCommitment(toExecutorOrder(order));
    } catch (err) {
      return send(res, 503, { error: `could not check the order on chain: ${err?.shortMessage || err?.message}` });
    }
    if (String(derived).toLowerCase() !== commitment.toLowerCase()) return send(res, 400, { error: 'order does not hash to this commitment' });

    const e = store.register({
      commitment,
      order,
      program,
      validationTxHash,
      user: order.user,
      deadline: Number(order.deadline),
      label: typeof label === 'string' ? label.slice(0, 80) : null,
    });
    return send(res, 201, view(e));
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, { name: 'soyaradex-server', ok: true });
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, await health());

      const isSettlements = parts[0] === 'v1' && parts[1] === 'settlements';
      if (req.method === 'GET' && isSettlements && parts.length === 2) {
        const round = url.searchParams.get('round');
        if (!isCommitment(round)) return send(res, 400, { error: 'round=0x... is required' });
        const e = store.findByRound(round);
        return e ? send(res, 200, view(e)) : send(res, 404, { stage: null });
      }
      if (req.method === 'GET' && isSettlements && parts.length === 3) {
        if (!isCommitment(parts[2])) return send(res, 400, { error: 'not a commitment' });
        const e = store.get(parts[2]);
        return e ? send(res, 200, view(e)) : send(res, 404, { stage: null });
      }

      if (req.method === 'POST' && parts[0] === 'v1') {
        if (!apiKey) return send(res, 503, { error: 'SERVER_API_KEY is not set, so this server accepts no writes' });
        if (!hasKey(req, apiKey)) return send(res, 401, { error: 'unauthorised' });
        if (isSettlements && parts.length === 2) return await register(req, res);
        if (isSettlements && parts.length === 4 && parts[3] === 'cancel') {
          if (!isCommitment(parts[2])) return send(res, 400, { error: 'not a commitment' });
          const e = store.cancel(parts[2]);
          return e ? send(res, 200, view(e)) : send(res, 404, { stage: null });
        }
        if (parts[1] === 'keeper' && parts.length === 2) return send(res, 200, await keeper.runOnce());
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (!(err instanceof HttpError)) console.error('[api]', err);
      return send(res, err.status || 500, { error: err instanceof HttpError ? err.message : 'server error' });
    }
  });
}
