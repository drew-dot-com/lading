#!/usr/bin/env node
/**
 * Operator tool: put the broker's Filecoin Pay account in a state where the
 * filecoin door can quote deliverable. Prints balances and what the SDK says
 * is needed; with `--yes` it sends the one deposit-plus-approval transaction.
 *
 *   LADING_FILECOIN_PRIVATE_KEY=0x... npm run fund:filecoin -- [--usdfc 5] [--yes]
 *
 * The wallet must already hold USDFC (bridge via Squid, or mint against FIL at
 * app.usdfc.net) and a little FIL for gas. Per-object fees are relayed by the
 * storage provider and paid out of the deposit, so this is the only on-chain
 * transaction the operator signs; uploads sign typed data only.
 */
import { Synapse, TOKENS, formatUnits, parseUnits } from '@filoz/synapse-sdk';
import { epochsToDays } from '@filoz/synapse-core/utils';
import { privateKeyToAccount } from 'viem/accounts';
import { filecoinChain, runwayText, FILECOIN_MIN_BYTES } from './filecoin.js';

const flag = (name: string) => process.argv.includes(`--${name}`);
const opt = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

async function main() {
  const key = process.env.LADING_FILECOIN_PRIVATE_KEY as `0x${string}` | undefined;
  if (!key) throw new Error('LADING_FILECOIN_PRIVATE_KEY is required');
  const chain = filecoinChain(process.env.LADING_FILECOIN_CHAIN);
  const copies = Number(process.env.LADING_FILECOIN_COPIES ?? 2);
  const maxBytes = Number(process.env.MAX_BODY_BYTES ?? 3 * 1024 * 1024);
  const account = privateKeyToAccount(key);
  const synapse = Synapse.create({ account, chain, source: 'lading' });

  const [fil, usdfc, summary] = await Promise.all([
    synapse.payments.walletBalance({ token: TOKENS.FIL }),
    synapse.payments.walletBalance({ token: TOKENS.USDFC }),
    synapse.payments.accountSummary(),
  ]);
  console.log(`${chain.name} (${chain.id})  ${account.address}`);
  console.log(`wallet      ${formatUnits(fil)} FIL, ${formatUnits(usdfc)} USDFC`);
  console.log(`filecoin pay funds ${formatUnits(summary.funds)} USDFC, available ${formatUnits(summary.availableFunds)}, locked ${formatUnits(summary.totalLockup)}, rate ${formatUnits(summary.lockupRatePerMonth)}/month, runway ${runwayText(epochsToDays(summary.runwayInEpochs))} days`);

  const prep = await synapse.storage.prepare({ pieceSizes: Array.from({ length: copies }, () => BigInt(Math.max(maxBytes, FILECOIN_MIN_BYTES))) });
  const c = prep.costs;
  console.log(`one ${maxBytes}-byte piece x${copies}: fees ${formatUnits(c.fees.total)} USDFC one-time, rate ${formatUnits(c.rates.perMonth)} USDFC/month, lockups ${formatUnits(c.lockups.total)}, deposit needed ${formatUnits(c.depositNeeded)}, approval needed ${c.needsFwssMaxApproval}, ready ${c.ready}`);

  const want = opt('usdfc');
  const amount = want ? parseUnits(want) : c.depositNeeded;
  if (c.ready && !want) {
    console.log('account is ready; nothing to do (pass --usdfc N to top up anyway)');
    return;
  }
  if (amount > usdfc) throw new Error(`wallet holds ${formatUnits(usdfc)} USDFC, deposit wants ${formatUnits(amount)}`);
  if (!flag('yes')) {
    console.log(`would deposit ${formatUnits(amount)} USDFC${c.needsFwssMaxApproval ? ' and approve warm storage' : ''}; re-run with --yes to send it`);
    return;
  }
  const { hash } = await synapse.payments.fundSync({ amount, needsFwssMaxApproval: c.needsFwssMaxApproval });
  console.log(`sent ${hash}`);
  const after = await synapse.payments.accountSummary();
  console.log(`filecoin pay funds now ${formatUnits(after.funds)} USDFC, runway ${runwayText(epochsToDays(after.runwayInEpochs))} days`);
}

main().catch((e) => {
  console.error('error:', e?.message ?? e);
  process.exit(1);
});
