// Privy (sign-in + embedded Solana wallet) as a small React island. The rest of the site is plain
// TypeScript, so this mounts an invisible React root that only hosts Privy's provider and its modal,
// and hands the vanilla code a bridge: login/logout, an access token, and a Solana wallet that can
// sign + send the coin-ticket transaction. Loaded on demand (first sign-in / page with a session).
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, type User } from '@privy-io/react-auth';
import { toSolanaWalletConnectors, useWallets } from '@privy-io/react-auth/solana';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';

export type SolanaChain = 'solana:devnet' | 'solana:mainnet';

export interface PrivyState {
  ready: boolean;
  authenticated: boolean;
  user: User | null;
  login: () => void;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  /** The player's Solana wallet: Privy's embedded one if there is one, else a connected external one. */
  wallet: { address: string; embedded: boolean; signAndSend: (tx: Uint8Array) => Promise<Uint8Array> } | null;
}

function Bridge({ chain, onState }: { chain: SolanaChain; onState: (s: PrivyState) => void }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  useEffect(() => {
    const pick = wallets.find((w) => /privy/i.test(w.standardWallet.name)) ?? wallets[0];
    onState({
      ready,
      authenticated,
      user: user ?? null,
      login,
      logout,
      getAccessToken,
      wallet: pick
        ? {
            address: pick.address,
            embedded: /privy/i.test(pick.standardWallet.name),
            signAndSend: async (tx) => (await pick.signAndSendTransaction({ transaction: tx, chain })).signature,
          }
        : null,
    });
  }, [ready, authenticated, user, wallets, login, logout, getAccessToken, onState, chain]);
  return null;
}

export function mountPrivy(appId: string, chain: SolanaChain, onState: (s: PrivyState) => void) {
  const host = document.createElement('div');
  host.id = 'privy-root';
  document.body.appendChild(host);
  const http = chain === 'solana:devnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com';
  createRoot(host).render(
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['twitter', 'email', 'google', 'wallet'],
        appearance: { theme: 'dark', accentColor: '#8cff2e', walletChainType: 'solana-only', landingHeader: 'Sign in to TrackLab 3D' },
        embeddedWallets: { solana: { createOnLogin: 'users-without-wallets' } },
        externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
        solana: {
          rpcs: {
            [chain]: { rpc: createSolanaRpc(http), rpcSubscriptions: createSolanaRpcSubscriptions(http.replace(/^https/, 'wss')) },
          },
        },
      }}
    >
      <Bridge chain={chain} onState={onState} />
    </PrivyProvider>,
  );
}
