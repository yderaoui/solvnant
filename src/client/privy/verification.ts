export class VerificationTimeout extends Error {
  constructor() {
    super('Wallet approval did not finish. Close the Privy window if visible, then reload this page to retry. No coins were bought.');
    this.name = 'VerificationTimeout';
  }
}

/** Free message signing only. Late results cannot continue to a purchase review. */
export async function waitForVerification<T>(request: Promise<T>, timeoutMs = 60_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new VerificationTimeout()), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
