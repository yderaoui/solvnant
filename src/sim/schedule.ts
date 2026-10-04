// Race schedule shared by the scheduler and the client. Every 5 minutes is a "slot":
// [slot start] --45s countdown--> [lights out] --race (<=230s)--> results until the next slot.
export const SLOT_MS = 5 * 60_000;
export const COUNTDOWN_MS = 45_000;
export const MAX_RACE_SECONDS = 230;

export const slotAt = (ms: number) => Math.floor(ms / SLOT_MS);
export const slotStart = (slot: number) => slot * SLOT_MS;
export const raceStartAt = (slot: number) => slot * SLOT_MS + COUNTDOWN_MS;
