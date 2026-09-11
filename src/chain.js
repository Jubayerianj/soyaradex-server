// src/chain.js
//
// Clients for GenLayer Bradbury's EVM side, and the executor's ABI.

import fs from 'node:fs';
import { createPublicClient, createWalletClient, http } from 'viem';

export const AGENT_EXECUTOR_ABI = JSON.parse(
  fs.readFileSync(new URL('./abi/AgentExecutor.json', import.meta.url), 'utf8'),
);

export const ERC20_ABI = [
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];

export function bradbury(rpcUrl) {
  return {
    id: 4221,
    name: 'GenLayer Bradbury',
    nativeCurrency: { name: 'GEN', symbol: 'GEN', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

export function makeClients(cfg) {
  const chain = bradbury(cfg.rpcUrl);
  // Fail fast and let the next pass retry: a dead connection must not hold a
  // pass for minutes (viem's defaults wait 10s and retry 3 times with backoff).
  const transport = http(cfg.rpcUrl, { timeout: 15_000, retryCount: 1 });
  return {
    publicClient: createPublicClient({ chain, transport }),
    walletClient: cfg.relayer ? createWalletClient({ account: cfg.relayer, chain, transport }) : null,
  };
}

/** The three executor reads the keeper makes on every pass. */
export function executorReads(publicClient, executor) {
  const read = (functionName, args) => publicClient.readContract({ address: executor, abi: AGENT_EXECUTOR_ABI, functionName, args });
  return {
    readUsed: (commitment) => read('commitmentUsed', [commitment]),
    readLive: (commitment) => read('isVerdictLive', [commitment]),
    readExpiry: (commitment) => read('verdictExpiry', [commitment]),
    readCommitment: (order) => read('getSwapCommitment', [order]),
  };
}
