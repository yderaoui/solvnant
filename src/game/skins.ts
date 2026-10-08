// Racer skins: the 3D character a player drives. Shared by the game server (ownership, prices) and
// the browser (models, garage). The first skin is free; the others are bought once with the game coin.
//
// Adding one: optimise the GLB into public/assets/characters/<file>.glb + <file>-far.glb (see
// characters/README.md), add an entry here, and render a thumbnail (public/assets/characters/<file>.webp).

export interface Skin {
  id: string;
  name: string;
  tagline: string;
  price: number; // in the game coin; 0 = free for everyone
  file: string; // public/assets/characters/<file>.glb (+ -far.glb, .webp thumbnail)
  yaw: number; // turns the model to face +X (the way cars drive)
  length: number; // m, nose to tail once scaled
  exhaust: [number, number, number][]; // flame spots, model units, after the yaw (x back = negative)
}

export const SKINS: Skin[] = [
  {
    id: 'orangie',
    name: 'Orangie',
    tagline: 'Turbo wheelchair, powered by tacos',
    price: 0,
    file: 'orangie',
    yaw: Math.PI,
    length: 3.1,
    exhaust: [
      [-0.5, 0.24, -0.1],
      [-0.5, 0.24, 0.1],
    ],
  },
  {
    id: 'tjr',
    name: 'TJR',
    tagline: 'Up only. Blown hypercar, cash on the seat',
    price: 500,
    file: 'tjr',
    yaw: Math.PI / 2,
    length: 3.6,
    exhaust: [
      [-0.33, 0.33, -0.2],
      [-0.33, 0.33, 0.2],
    ],
  },
  {
    id: 'rasmr',
    name: 'Rasmr',
    tagline: 'Motorized shopping cart, glass of red in hand',
    price: 500,
    file: 'cart',
    yaw: Math.PI,
    length: 3.3,
    exhaust: [
      [-0.49, 0.28, -0.1],
      [-0.49, 0.28, 0.1],
    ],
  },
];

export const DEFAULT_SKIN = SKINS[0].id;
export const skinById = (id: string | null | undefined): Skin => SKINS.find((s) => s.id === id) ?? SKINS[0];
export const isSkin = (id: unknown): id is string => SKINS.some((s) => s.id === id);
/** Bots and AI drivers show off the whole range, so everyone sees the paid skins in races. */
export const botSkin = (i: number): string => SKINS[((i % SKINS.length) + SKINS.length) % SKINS.length].id;
