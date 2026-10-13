// Accept purchases issued before the PumpKart rebrand as well as new ones. Exact memo ownership,
// quoted price, mint and transaction reuse are still checked by the Hub before crediting a payment.
export function isPurchaseMemo(memo: string): boolean {
  return /^(?:PumpKart|RaceTrench) (?:ticket|skin) /.test(memo) || isLeagueBetMemo(memo);
}

export function skinFromMemo(memo: string): string | null {
  return /^(?:PumpKart|RaceTrench) skin ([a-z0-9]+) /.exec(memo)?.[1] ?? null;
}

/** The RPC's memo includes a length prefix, e.g. "[28] PumpKart ticket …". */
export function hasPurchaseMemo(memo: string | null): boolean {
  return memo !== null && (/(?:PumpKart|RaceTrench) (?:ticket|skin) /.test(memo) || /PumpKart league bet /.test(memo));
}

export const isLeagueBetMemo = (memo: string) => /^PumpKart league bet [A-Za-z0-9_-]+$/.test(memo);
