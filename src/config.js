// src/config.js
//
// Everything comes from the environment. The defaults are the live GenLayer
// Bradbury deployment; override them only when it moves.

import { isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const read = (env, name, fallback = '') => String(env[name] ?? fallback).trim();

function relayerFrom(raw) {
  if (!raw) return null;
  const hex = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error('RELAYER_PRIVATE_KEY is not a 32-byte hex key');
  return privateKeyToAccount(hex);
}

function address(env, name, fallback) {
  const v = read(env, name, fallback);
  if (!isAddress(v)) throw new Error(`${name} is not an address: ${v}`);
  return v;
}

export function loadConfig(env = process.env) {
  const interval = Number(read(env, 'KEEPER_INTERVAL_MS', '30000'));
  return {
    port: Number(read(env, 'PORT', '4000')),
    rpcUrl: read(env, 'RPC_URL', 'https://rpc-bradbury.genlayer.com'),
    executor: address(env, 'EXECUTOR_ADDRESS', '0x1BCBad3da718690fa60289DcBF15835e5C79021f'),
    validator: address(env, 'VALIDATOR_ADDRESS', '0xd1D809A1210cc039AEdBF5cD04628416Ad0e6a92'),
    storePath: read(env, 'STORE_PATH', './data/settlements.json'),
    apiKey: read(env, 'SERVER_API_KEY'),
    // Never faster than every 10 seconds: the chain does not change that fast.
    keeperIntervalMs: Number.isFinite(interval) && interval >= 10_000 ? interval : 30_000,
    relayer: relayerFrom(read(env, 'RELAYER_PRIVATE_KEY')),
  };
}
