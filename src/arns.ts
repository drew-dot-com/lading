/**
 * The name door: point an ArNS undername on the broker's ANT at a manifest
 * txId. Owner-only on the ANT, so the broker holds the ANT owner's Solana key.
 * This is the one leg that spends the broker's own chain funds per job (one
 * Solana transaction), which is why it is its own priced door.
 */
import { ANT } from '@ar.io/sdk';
import { createSolanaRpc, createSolanaRpcSubscriptions, createKeyPairSignerFromBytes } from '@solana/kit';
import type { NameReceipt } from './kinds.js';

export interface Namer {
  antId: string;
  baseName: string;
  gateway: string;
  setUndername(undername: string, txId: string): Promise<NameReceipt>;
}

/** ArNS undernames: lowercase alphanumerics and dashes, 1 to 61 chars, never `@`. */
export const UNDERNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,59}[a-z0-9])?$/;

/** The default undername for an object: the first 12 hex of its sha256, prefixed so it never collides with a human name. */
export const undernameFor = (sha256: string) => `l-${sha256.slice(0, 12)}`;

export async function solanaNamer(opts: {
  antId: string;
  baseName: string;
  gateway: string;
  secretKey: Uint8Array;
  rpcUrl: string;
  ttlSeconds?: number;
}): Promise<Namer> {
  const rpc = createSolanaRpc(opts.rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(opts.rpcUrl.replace(/^http/, 'ws'));
  const signer = await createKeyPairSignerFromBytes(opts.secretKey);
  const ttl = opts.ttlSeconds ?? 900;

  const ro = await ANT.init({ processId: opts.antId, rpc } as never);
  const owner = String(await (ro as { getOwner(): Promise<unknown> }).getOwner());
  if (owner !== String(signer.address)) {
    throw new Error(`ANT ${opts.antId} is owned by ${owner}, not this signer ${signer.address}`);
  }

  return {
    antId: opts.antId,
    baseName: opts.baseName,
    gateway: opts.gateway,
    async setUndername(undername, txId) {
      if (!UNDERNAME_RE.test(undername)) throw new Error(`bad undername ${undername}`);
      const ant = (await ANT.init({ processId: opts.antId, signer, rpc, rpcSubscriptions } as never)) as {
        setUndernameRecord?(a: { undername: string; transactionId: string; ttlSeconds: number }): Promise<unknown>;
        setRecord?(a: { undername: string; transactionId: string; ttlSeconds: number }): Promise<unknown>;
      };
      const args = { undername, transactionId: txId, ttlSeconds: ttl };
      if (ant.setUndernameRecord) await ant.setUndernameRecord(args);
      else if (ant.setRecord) await ant.setRecord(args);
      else throw new Error('ANT client exposes no record-set method');
      const name = `${undername}_${opts.baseName}`;
      return {
        undername,
        antId: opts.antId,
        manifestTxId: txId,
        name,
        url: `https://${name}.${opts.gateway}/`,
        at: Math.floor(Date.now() / 1000),
      };
    },
  };
}
