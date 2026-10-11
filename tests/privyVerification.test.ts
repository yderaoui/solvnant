import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VerificationTimeout, waitForVerification } from '../src/client/privy/verification';

const sdk = vi.hoisted(() => ({
  signMessage: vi.fn(), directSign: vi.fn(), send: vi.fn(), state: null as any,
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
  useSignMessage: () => ({ signMessage: sdk.signMessage }),
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

it('uses the selected embedded wallet and explicitly requests the Privy approval window', async () => {
  const signature = new Uint8Array(64);
  sdk.signMessage.mockResolvedValue({ signature });
  const selected = await wallet();
  const message = new TextEncoder().encode('Fixture free verification');
  expect(await selected.signMessage(message)).toBe(signature);
  expect(sdk.signMessage).toHaveBeenCalledWith({ message, wallet: sdk.embedded, options: { uiOptions: {
    showWalletUIs: true, title: 'Verify your PumpKart wallet',
    description: 'Free ownership check. This message does not spend SOL or buy coins.',
    buttonText: 'Verify wallet — free', isCancellable: true,
  } } });
  expect(sdk.embedded.signMessage).not.toHaveBeenCalled();
  expect(sdk.directSign).not.toHaveBeenCalled(); expect(sdk.send).not.toHaveBeenCalled();
});

it('propagates cancellation without retrying or requesting a transaction', async () => {
  sdk.signMessage.mockRejectedValue(new Error('User cancelled'));
  const selected = await wallet();
  await expect(selected.signMessage(new Uint8Array([1]))).rejects.toThrow('User cancelled');
  expect(sdk.signMessage).toHaveBeenCalledTimes(1); expect(sdk.send).not.toHaveBeenCalled();
});

it('stops a stalled verification and ignores a late signature', async () => {
  let finish!: (value: Uint8Array) => void;
  const request = new Promise<Uint8Array>(resolve => { finish = resolve; });
  const continueReview = vi.fn();
  const waiting = waitForVerification(request).then(continueReview);
  const failure = expect(waiting).rejects.toBeInstanceOf(VerificationTimeout);
  await vi.advanceTimersByTimeAsync(60_000); await failure;
  finish(new Uint8Array(64)); await vi.advanceTimersByTimeAsync(0);
  expect(continueReview).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it('clears the timeout after successful approval', async () => {
  const signature = new Uint8Array(64);
  await expect(waitForVerification(Promise.resolve(signature))).resolves.toBe(signature);
  expect(vi.getTimerCount()).toBe(0);
});

it('clears the timeout after cancellation', async () => {
  await expect(waitForVerification(Promise.reject(new Error('Cancelled')))).rejects.toThrow('Cancelled');
  expect(vi.getTimerCount()).toBe(0);
});
