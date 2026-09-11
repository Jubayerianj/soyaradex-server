// src/order.js
//
// An order as the Soyara app hands it over: the exact settlement surface its
// consensus round judged, with the numbers as decimal strings.

import { isAddress, isHex, keccak256, zeroAddress } from 'viem';

const ADDRESS_FIELDS = ['user', 'tokenIn', 'tokenOut', 'router', 'feeCollector'];
const NUMBER_FIELDS = ['amountIn', 'minAmountOut', 'quotedAmountOut', 'slippageBps', 'deadline', 'feeBps', 'nonce'];

export const isCommitment = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);

/** What is wrong with an order and its route program, or null. */
export function orderProblem(raw, program) {
  if (!raw || typeof raw !== 'object') return 'order is missing';
  for (const f of ADDRESS_FIELDS) if (!isAddress(String(raw[f] || ''))) return `order.${f} is not an address`;
  for (const f of NUMBER_FIELDS) if (!/^\d+$/.test(String(raw[f] ?? ''))) return `order.${f} is not a whole number`;
  if (!isCommitment(raw.routeHash)) return 'order.routeHash is not a 32-byte hash';
  // AgentExecutor takes native GEN from the settling transaction, which this
  // server sends: holding such a trade would mean paying for it.
  if (String(raw.tokenIn).toLowerCase() === zeroAddress) return 'native GEN input: the user wraps it to WGEN first; the relayer never pays for a trade';
  if (!isHex(program) || program.length < 4) return 'program is not hex bytes';
  if (keccak256(program).toLowerCase() !== raw.routeHash.toLowerCase()) return 'program does not hash to order.routeHash';
  return null;
}

/** The order as AgentExecutor takes it. */
export function toExecutorOrder(raw) {
  return {
    user: raw.user,
    tokenIn: raw.tokenIn,
    tokenOut: raw.tokenOut,
    amountIn: BigInt(raw.amountIn),
    minAmountOut: BigInt(raw.minAmountOut),
    quotedAmountOut: BigInt(raw.quotedAmountOut),
    slippageBps: BigInt(raw.slippageBps),
    deadline: BigInt(raw.deadline),
    router: raw.router,
    feeBps: BigInt(raw.feeBps),
    feeCollector: raw.feeCollector,
    routeHash: raw.routeHash,
    nonce: BigInt(raw.nonce),
  };
}
