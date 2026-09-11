// test/helpers.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keccak256 } from 'viem';
import { createStore } from '../src/store.js';

export const hash = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;

export function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soyaradex-'));
  const file = path.join(dir, 'settlements.json');
  return { store: createStore(file), file };
}

export const PROGRAM = '0x0258b6cd7891cd0a682226e25607b958a6479195a601ffff0055a5ff46cfb55dcf05d236a0fdde5a0c866b64be01000bb8';

/** An order in the shape the Soyara app hands over. */
export function order(extra = {}) {
  return {
    user: '0x23D542DCEFb00b1f4268E67a0EC1EF4de0A58fe2',
    tokenIn: '0x58B6CD7891cd0A682226E25607b958a6479195A6',
    tokenOut: '0x4B54235778c26Ee8ac27744A53d4c5BC4c9D46fc',
    amountIn: '1000000000000000000',
    minAmountOut: '992997559893555520',
    quotedAmountOut: '995985516442884173',
    slippageBps: '30',
    deadline: String(Math.floor(Date.now() / 1000) + 7200),
    router: '0x95feE6Cb918Ed9C621E36082EE8D998873031EaA',
    feeBps: '5',
    feeCollector: '0x48234eD645676b794a4CbC7483513e58cB04e22E',
    routeHash: keccak256(PROGRAM),
    nonce: '21750042223483',
    ...extra,
  };
}

export function entry(n, extra = {}) {
  return { commitment: hash(n), order: order(), program: PROGRAM, validationTxHash: hash(`f${n}`), deadline: Math.floor(Date.now() / 1000) + 7200, ...extra };
}
