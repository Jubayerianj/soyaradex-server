// src/settle.js
//
// Settle one held trade: AgentExecutor.executeSwap(order, program), the same
// call the Soyara app makes, with the same checks first.
//
// The executor re-derives the commitment from the order, checks the route
// program against the approved routeHash, and consumes GenLayer's verdict. A
// tampered order hashes to a commitment no verdict backs and is refused. The
// output goes straight to the user.

import { zeroAddress, BaseError, ContractFunctionRevertedError } from 'viem';
import { AGENT_EXECUTOR_ABI, ERC20_ABI } from './chain.js';
import { toExecutorOrder } from './order.js';

// Worth retrying at once: the node is throttling, or another sender from the
// same key took this nonce a moment ago.
const RETRYABLE = /-32005|gas rate limit|at capacity|exceeds defined limit|nonce too low|nonce has already been used|replacement transaction underpriced|already known/i;
const EXECUTOR_ERRORS = /\b(CommitmentAlreadyUsed|VerdictExpired|DeadlineExpired|NoConsensusVerdict|Unauthorized|ContractPaused|SlippageExceeded|QuoteInconsistent|RouteMismatch|RouterMismatch|RouterNotApproved|FeeTooHigh|TokenNotApproved|SafeERC20FailedOperation)\b/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withRetry(fn, { attempts = 5, wait = sleep } = {}) {
  for (let i = 0; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      const text = `${err?.shortMessage || ''} ${err?.message || ''} ${err?.details || ''}`;
      if (!RETRYABLE.test(text) || i >= attempts - 1) throw err;
      const hint = text.match(/retryAfterMs"?\s*:\s*(\d+)/);
      await wait(Math.min(8000, (hint ? Number(hint[1]) : 1500) + i * 500));
    }
  }
}

/** The executor's custom error name inside a viem error, if there is one. */
export function revertName(err) {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted?.data?.errorName) return reverted.data.errorName;
  }
  const m = `${err?.shortMessage || ''} ${err?.message || ''}`.match(EXECUTOR_ERRORS);
  return m ? m[1] : null;
}

/** What a refused settlement means for the trade. */
export function outcomeOfRevert(err) {
  const name = revertName(err);
  // Spent: which is what settling is.
  if (name === 'CommitmentAlreadyUsed') return { success: true, alreadySettled: true };
  if (name === 'VerdictExpired' || name === 'DeadlineExpired') return { success: false, verdictExpired: true, error: name };
  return { success: false, error: name || err?.shortMessage || err?.message || 'settlement failed' };
}

export async function settleTrade(entry, { publicClient, walletClient, executor, now = Date.now() }) {
  if (!walletClient) return { success: false, error: 'No relayer key configured' };
  const order = toExecutorOrder(entry.order);
  const read = (functionName, args, address = executor, abi = AGENT_EXECUTOR_ABI) =>
    publicClient.readContract({ address, abi, functionName, args });

  if (await read('commitmentUsed', [entry.commitment])) return { success: true, alreadySettled: true };
  const expiry = Number(await read('verdictExpiry', [entry.commitment]));
  if (expiry > 0 && expiry * 1000 < now) return { success: false, verdictExpired: true, error: 'The approval expired before settlement' };
  if (!(await read('isVerdictLive', [entry.commitment]))) return { success: false, error: 'No live verdict for this order yet' };

  // Never pay for a trade. With native GEN in, AgentExecutor would take the
  // input from this server's own transaction rather than the user's wallet.
  if (order.tokenIn.toLowerCase() === zeroAddress) {
    return { success: false, refused: true, error: 'native GEN input: the relayer never pays for a trade' };
  }

  // The token's own transferFrom would fail with an opaque SafeMath message.
  // Say plainly what is missing instead.
  const [allowance, balance] = await Promise.all([
    read('allowance', [order.user, executor], order.tokenIn, ERC20_ABI),
    read('balanceOf', [order.user], order.tokenIn, ERC20_ABI),
  ]);
  if (balance < order.amountIn) return { success: false, error: `Insufficient balance: the wallet holds ${balance}, the trade needs ${order.amountIn}` };
  if (allowance < order.amountIn) return { success: false, needsApproval: true, error: `Token approval missing for AgentExecutor ${executor}` };

  // No value, ever: the input comes from the user's wallet.
  const call = {
    account: walletClient.account,
    address: executor,
    abi: AGENT_EXECUTOR_ABI,
    functionName: 'executeSwap',
    args: [order, entry.program],
  };
  let hash;
  try {
    // Simulated first: a refusal costs nothing here, and names its reason.
    const { request } = await withRetry(() => publicClient.simulateContract(call));
    const gas = await withRetry(() => publicClient.estimateContractGas(call));
    hash = await withRetry(() => walletClient.writeContract({ ...request, gas: (gas * 12n) / 10n }));
  } catch (err) {
    return outcomeOfRevert(err);
  }

  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success') return { success: false, error: 'executeSwap reverted', execTxHash: hash };
    return { success: true, execTxHash: hash, blockNumber: receipt.blockNumber.toString() };
  } catch (err) {
    // Sent but not yet mined. The next pass sees the commitment spent.
    return { success: false, execTxHash: hash, error: `sent, receipt not seen yet (${err?.shortMessage || err?.message})` };
  }
}
