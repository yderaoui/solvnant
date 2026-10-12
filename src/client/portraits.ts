/** Shared versioned artwork for the shop, intro, racer picker and race page. */
const portraitFiles: Record<string, string> = { fomo: 'fomo-v2', pump: 'pump-v2' };
export const racerPortrait = (file: string): string => `${import.meta.env.BASE_URL}assets/characters/portraits/${portraitFiles[file] ?? file}.webp`;
