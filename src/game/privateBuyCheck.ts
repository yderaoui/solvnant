import { verifyWalletSignature } from './solana.js';

/** One temporary owner check. Never used by the public coin-launch configuration. */
export const PRIVATE_BUY_CHECK = {
  wallet: '4tWo1pQfrtFbw94HW9NScGmmWNH2Y8u7D9DGxPC6AGpH',
  mint: 'BJLoxTq2dkU46hXzL2UNjDPEHWs5ugKirFERYffpump',
  revision: 'owner-buy-check-2026-10-11-v1',
  inputSol: 0.001,
  maxTotalLamports: 5_000_000,
  expiresAt: Date.parse('2026-10-12T16:30:00Z'),
} as const;

export interface PrivateBuyProof { timestamp: number; signature: string }
export const PROOF_LIFETIME = 15 * 60_000;

export async function privateBuyMessage(token: string, timestamp: number): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const digest = Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
  return `PumpKart private coin-buy check\nSite: https://www.pumpkart.racing\nWallet: ${PRIVATE_BUY_CHECK.wallet}\nTest coin: ${PRIVATE_BUY_CHECK.mint}\nPurchase: 0.001 SOL\nMaximum estimated total: 0.005 SOL\nSession digest: ${digest}\nIssued: ${timestamp}\nSigning this message is free. It proves wallet ownership and does not move funds.`;
}

export async function validPrivateBuyProof(token: string, proof: unknown, now = Date.now()): Promise<boolean> {
  if (now >= PRIVATE_BUY_CHECK.expiresAt || !proof || typeof proof !== 'object') return false;
  const p = proof as PrivateBuyProof;
  if (!Number.isSafeInteger(p.timestamp) || p.timestamp > now + 30_000 || now - p.timestamp >= PROOF_LIFETIME || typeof p.signature !== 'string' || p.signature.length > 128) return false;
  return verifyWalletSignature(PRIVATE_BUY_CHECK.wallet, await privateBuyMessage(token, p.timestamp), p.signature);
}
