// Game server settings, read from Worker vars/secrets (wrangler.toml [vars], `wrangler secret put`,
// or .dev.vars locally). Everything has a safe default so `npm run game` works with no setup.
//
// Points are PLAY MONEY. There are no real-money pots in the game server. The optional on-chain
// pots (onchain/) run on Solana DEVNET only.

export interface XConfig {
  clientId: string;
  clientSecret: string;
  minAccountDays: number;
  minFollowers: number;
}

export interface GateConfig {
  mint: string; // SPL token mint (the coin is the ticket)
  minUsd: number; // hold at least this much (USD) to race
  rpcUrl: string; // read-only balance lookups
}

export interface PointsConfig {
  signup: number;
  daily: number;
  entryFee: number; // live race entry, into the prize pot
  priorityFee: number; // guaranteed seat, can't be bumped
  maxPriority: number; // per race
  betMin: number;
  betMax: number;
  rakePct: number; // taken from betting pools (burned)
}

/** Race tickets bought with the game coin: an SPL token transfer to the treasury wallet. */
export interface TicketConfig {
  cluster: 'devnet' | 'mainnet-beta';
  rpcUrl: string;
  mint: string; // the coin (SPL token mint)
  decimals: number;
  treasury: string; // wallet that receives ticket payments
  price: number; // coins per ticket
  symbol: string; // shown in the UI, e.g. $TRACK
}

export interface GameConfig {
  sessionSecret: string;
  devSecret: boolean; // true when no SESSION_SECRET was set (fine locally, never in production)
  x: XConfig | null;
  allowGuests: boolean;
  siteUrl: string; // where to send people back after X login
  gate: GateConfig | null;
  tickets: TicketConfig | null;
  points: PointsConfig;
  supabase: { url: string; key: string } | null;
  betsCloseAt: number; // live races: bets close when the leader has done this fraction of the distance
}

type Env = Record<string, string | undefined>;

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export function readConfig(env: Env): GameConfig {
  const x = env.X_CLIENT_ID && env.X_CLIENT_SECRET
    ? {
        clientId: env.X_CLIENT_ID,
        clientSecret: env.X_CLIENT_SECRET,
        minAccountDays: num(env.X_MIN_ACCOUNT_DAYS, 30),
        minFollowers: num(env.X_MIN_FOLLOWERS, 5),
      }
    : null;
  const mint = (env.TOKEN_MINT ?? '').trim();
  return {
    sessionSecret: env.SESSION_SECRET || 'dev-only-session-secret-change-me',
    devSecret: !env.SESSION_SECRET,
    x,
    // Guest login exists for local testing and until X is configured.
    allowGuests: env.ALLOW_GUESTS ? env.ALLOW_GUESTS === 'true' : !x,
    siteUrl: (env.SITE_URL || 'http://localhost:5173').replace(/\/+$/, ''),
    gate: mint
      ? { mint, minUsd: num(env.MIN_HOLD_USD, 20), rpcUrl: env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com' }
      : null,
    tickets:
      env.TICKET_MINT && env.TICKET_TREASURY
        ? {
            cluster: env.TICKET_CLUSTER === 'mainnet-beta' ? 'mainnet-beta' : 'devnet',
            rpcUrl: env.TICKET_RPC_URL || (env.TICKET_CLUSTER === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com'),
            mint: env.TICKET_MINT.trim(),
            decimals: num(env.TICKET_DECIMALS, 6),
            treasury: env.TICKET_TREASURY.trim(),
            price: num(env.TICKET_PRICE, 100),
            symbol: env.TICKET_SYMBOL || '$TRACK',
          }
        : null,
    points: {
      signup: num(env.POINTS_SIGNUP, 1000),
      daily: num(env.POINTS_DAILY, 100),
      entryFee: num(env.POINTS_ENTRY_FEE, 50),
      priorityFee: num(env.POINTS_PRIORITY_FEE, 200),
      maxPriority: num(env.MAX_PRIORITY_PER_RACE, 3),
      betMin: num(env.BET_MIN, 10),
      betMax: num(env.BET_MAX, 5000),
      rakePct: num(env.BET_RAKE_PCT, 5),
    },
    supabase: env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? { url: env.SUPABASE_URL.replace(/\/+$/, ''), key: env.SUPABASE_SERVICE_ROLE_KEY } : null,
    betsCloseAt: num(env.BETS_CLOSE_AT, 0.4),
  };
}

/** What the browser may know about the setup (no secrets). */
export function publicConfig(c: GameConfig) {
  return {
    x: !!c.x,
    guests: c.allowGuests,
    gate: c.gate ? { mint: c.gate.mint, minUsd: c.gate.minUsd } : null,
    tickets: c.tickets,
    points: c.points,
    betsCloseAt: c.betsCloseAt,
    leagueBets: !!c.supabase,
  };
}
export type PublicConfig = ReturnType<typeof publicConfig>;
