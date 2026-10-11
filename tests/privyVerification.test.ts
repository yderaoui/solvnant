import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  signTransaction: vi.fn(), directSign: vi.fn(), send: vi.fn(), state: null as any,
  embedded: { address: 'fixture-embedded', standardWallet: { name: 'Privy' }, signMessage: vi.fn() },
}));
vi.mock('react', async original => ({ ...await original<object>(), useEffect: (fn: () => void) => fn() }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: (element: any) => {
  const bridge = element.props.children;
  bridge.type(bridge.props);
} }) }));
vi.mock('@privy-io/react-auth', () => ({
  PrivyProvider: () => null,
  usePrivy: () => ({ ready: true, authenticated: true, user: null, login: vi.fn(), logout: vi.fn(), getAccessToken: vi.fn() }),
}));
vi.mock('@privy-io/react-auth/solana', () => ({
  useWallets: () => ({ wallets: [{ address: 'fixture-external', standardWallet: { name: 'External' }, signMessage: sdk.directSign, signAndSendTransaction: sdk.send }, sdk.embedded] }),
  useSignTransaction: () => ({ signTransaction: sdk.signTransaction }),
}));
vi.mock('@solana/kit', () => ({ createSolanaRpc: vi.fn(), createSolanaRpcSubscriptions: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); sdk.state = null;
  vi.stubGlobal('document', { createElement: () => ({}), body: { appendChild: vi.fn() } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function wallet() {
  const { mountPrivy } = await import('../src/client/privy/island');
  mountPrivy('fixture-app', 'solana:mainnet', state => { sdk.state = state; });
  return sdk.state.wallet;
}

it('opens visible cancellable transaction approval for the selected embedded wallet without broadcasting', async () => {
  const transaction = new Uint8Array([1,2,3]);
  sdk.signTransaction.mockResolvedValue({ signedTransaction: transaction });
  const selected = await wallet();
  expect(await selected.sign(transaction)).toBe(transaction);
  expect(sdk.signTransaction).toHaveBeenCalledWith({ transaction, wallet: sdk.embedded, chain: 'solana:mainnet', options: { uiOptions: {
    showWalletUIs: true, isCancellable: true, description: 'Review your PumpKart payment before signing.', buttonText: 'Approve payment',
    successHeader: 'Approval signed',
    successDescription: 'Click Close now to finish your payment in PumpKart. Signing alone does not send it. Wait for confirmation on the PumpKart page.',
  } } });
  expect(sdk.directSign).not.toHaveBeenCalled(); expect(sdk.send).not.toHaveBeenCalled();
});
it('propagates cancelled purchase approval without retry or submission', async () => {
  sdk.signTransaction.mockRejectedValue(new Error('User cancelled'));
  const selected = await wallet();
  await expect(selected.sign(new Uint8Array([1]))).rejects.toThrow('User cancelled');
  expect(sdk.signTransaction).toHaveBeenCalledOnce(); expect(sdk.send).not.toHaveBeenCalled();
});
