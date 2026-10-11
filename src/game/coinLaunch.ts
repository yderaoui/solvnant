import type { GameConfig } from './config';

export const COIN_LOCK_MESSAGE = 'Coin purchases are paused while we prepare the official launch. No payment was made.';
export function coinActionProblem(cfg: GameConfig, revision: unknown): string | null {
  if (cfg.coinLaunch.status !== 'live') return COIN_LOCK_MESSAGE;
  if (revision !== cfg.coinLaunch.revision) return 'The game coin settings changed. Reload the page and review the new price before buying.';
  return null;
}

export interface StoredCoinLaunch {
  cluster: 'devnet' | 'mainnet-beta';
  mint: string;
  symbol: string;
  decimals: number;
  status: 'paused' | 'live';
  buyEnabled: boolean;
  revision: string;
  pausedAt?: number;
  mode?: 'test' | 'official';
  paidEnabled?: boolean;
}

/** Apply only coin identity; treasury, USD ticket price, RPC and payout rules stay in server settings. */
export function applyCoinLaunch(cfg: GameConfig, stored: StoredCoinLaunch) {
  if (!cfg.tickets) throw new Error('Configure the ticket network and treasury before preparing a coin.');
  if (cfg.tickets.cluster !== stored.cluster) throw new Error('Stored launch network differs from the configured network. Resolve the launch settings before starting.');
  cfg.tickets = { ...cfg.tickets, mint: stored.mint, symbol: stored.symbol, decimals: stored.decimals };
  cfg.coinLaunch = { status: stored.status, revision: stored.revision, buyEnabled: stored.buyEnabled, pausedAt: stored.pausedAt, mode: stored.mode ?? 'official', paidEnabled: stored.paidEnabled ?? true };
}
