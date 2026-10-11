// Serialize wallet approvals in this tab and, where supported, across tabs.
const active = new Set<string>();
export async function withPaymentLock<T>(uid: string, action: () => Promise<T>): Promise<T> {
  if (active.has(uid)) throw new Error('Finish your current payment before starting another.');
  active.add(uid);
  try {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return await navigator.locks.request(`pumpkart-payment:${uid}`, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('A payment is open in another tab. Finish it before starting another.');
        return await action();
      });
    }
    return await action();
  } finally { active.delete(uid); }
}
