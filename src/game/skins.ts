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
  rainbow?: boolean; // exhaust flames cycle through the rainbow
  rig: Rig;
}

/**
 * Where the moving parts are, so a single-piece model can be animated in the shader (the models have
 * no skeleton). Model units after the yaw: x forward, y up, z sideways; measured from side/front views.
 */
export interface Rig {
  head: [number, number, number, number]; // head centre x, y, z and radius
  neck: number; // y of the neck: the head turns about it
  body: [number, number, number, number]; // hip x, hip y, torso half-length (x), half-width (z)
  wheels: [number, number, number][]; // axle x, y and radius of each pair of wheels (both sides)
  extra?: [number, number, number, number, number, number]; // a part that bobbles: centre x, y, z, radius, pivot x, y
  face?: number; // rad: turns a head that the model has looking sideways back to the front
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
    rig: { head: [-0.045, 0.87, 0, 0.1], neck: 0.755, face: -0.8, body: [-0.08, 0.48, 0.17, 0.27], wheels: [[-0.15, 0.12, 0.125], [0.22, 0.07, 0.065]] },
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
    rig: { head: [-0.05, 0.41, 0, 0.065], neck: 0.355, body: [-0.05, 0.26, 0.1, 0.15], wheels: [[-0.225, 0.14, 0.12], [0.24, 0.105, 0.095]] },
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
    rig: { head: [-0.06, 0.8, 0, 0.085], neck: 0.72, body: [-0.12, 0.33, 0.15, 0.25], wheels: [[-0.32, 0.12, 0.12], [0.345, 0.12, 0.12]] },
  },
  {
    id: 'kimchi',
    name: 'Kimchi',
    tagline: 'Giant head car, roof open, full send',
    price: 500,
    file: 'kimchi',
    yaw: Math.PI / 2,
    length: 4,
    exhaust: [
      [-0.49, 0.1, -0.12],
      [-0.49, 0.1, 0.12],
    ],
    rig: { head: [-0.02, 0.46, 0, 0.055], neck: 0.4, body: [-0.02, 0.29, 0.08, 0.13], wheels: [[-0.33, 0.075, 0.075], [0.265, 0.075, 0.07]], extra: [0.4, 0.2, 0, 0.13, 0.33, 0.1] },
  },
  {
    id: 'ansem',
    name: 'Ansem',
    tagline: 'Rides the bull. Literally. On monster truck wheels',
    price: 500,
    file: 'ansem',
    yaw: Math.PI,
    length: 3.4,
    exhaust: [
      [-0.45, 0.42, -0.22],
      [-0.45, 0.42, 0.22],
    ],
    rig: { head: [-0.075, 0.79, 0, 0.075], neck: 0.71, body: [-0.1, 0.5, 0.12, 0.2], wheels: [[-0.27, 0.13, 0.13], [0.19, 0.13, 0.13]], extra: [0.42, 0.42, 0, 0.09, 0.33, 0.4] },
  },
  {
    id: 'elon',
    name: 'Elon Musk',
    tagline: 'Chrome cyber buggy, next stop Mars',
    price: 500,
    file: 'elon',
    yaw: Math.PI,
    length: 3.4,
    exhaust: [
      [-0.49, 0.25, -0.15],
      [-0.49, 0.25, 0.15],
    ],
    rig: { head: [-0.1, 0.7, 0, 0.075], neck: 0.615, body: [-0.1, 0.42, 0.14, 0.22], wheels: [[-0.275, 0.1, 0.105], [0.335, 0.1, 0.11]] },
  },
  {
    id: 'brez',
    name: 'Brezscales',
    tagline: 'Rides on the hood, steers with chains',
    price: 500,
    file: 'brez',
    yaw: Math.PI / 2,
    length: 3.8,
    exhaust: [
      [-0.49, 0.12, -0.15],
      [-0.49, 0.12, 0.15],
    ],
    rig: { head: [0.04, 0.54, 0, 0.06], neck: 0.47, body: [0.03, 0.3, 0.09, 0.15], wheels: [[-0.325, 0.1, 0.09], [0.255, 0.1, 0.085]] },
  },
  {
    id: 'jack',
    name: 'Jack Duval',
    tagline: 'Land yacht, twin outboard motors',
    price: 500,
    file: 'jack',
    yaw: Math.PI / 2,
    length: 3.8,
    exhaust: [
      [-0.48, 0.2, -0.16],
      [-0.48, 0.2, 0.16],
    ],
    rig: { head: [-0.18, 0.5, 0, 0.07], neck: 0.42, body: [-0.17, 0.28, 0.12, 0.2], wheels: [[-0.35, 0.035, 0.035], [0.115, 0.035, 0.035]] },
  },
  {
    id: 'vitalik',
    name: 'Vitalik',
    tagline: 'Pink unicorn toy car, rainbow exhaust',
    price: 500,
    file: 'vitalik',
    yaw: Math.PI / 2,
    length: 3,
    exhaust: [
      [-0.47, 0.15, -0.12],
      [-0.47, 0.15, 0.12],
    ],
    rainbow: true,
    rig: { head: [0.04, 0.87, 0, 0.11], neck: 0.76, body: [-0.07, 0.38, 0.17, 0.28], wheels: [[-0.26, 0.1, 0.115], [0.31, 0.095, 0.1]] },
  },
  {
    id: 'rowdy',
    name: 'Rowdy',
    tagline: 'Black supercar, RETIRED plates, finger guns out',
    price: 500,
    file: 'rowdy',
    yaw: Math.PI / 2,
    length: 3.8,
    exhaust: [
      [-0.49, 0.15, -0.15],
      [-0.49, 0.15, 0.15],
    ],
    rig: { head: [-0.15, 0.53, 0, 0.075], neck: 0.455, body: [-0.15, 0.3, 0.12, 0.2], wheels: [[-0.285, 0.095, 0.095], [0.26, 0.095, 0.095]] },
  },
];

export const DEFAULT_SKIN = SKINS[0].id;
/** What a racer costs in the game coin: catalog prices are in units where a ticket is 100 (500 = 5 tickets). */
export const skinPrice = (s: Skin, ticketPrice: number): number => (s.price ? Math.round((s.price / 100) * ticketPrice * 1e6) / 1e6 : 0);
export const skinById = (id: string | null | undefined): Skin => SKINS.find((s) => s.id === id) ?? SKINS[0];
export const isSkin = (id: unknown): id is string => SKINS.some((s) => s.id === id);
/** Bots and AI drivers show off the whole range, so everyone sees the paid skins in races. */
export const botSkin = (i: number): string => SKINS[((i % SKINS.length) + SKINS.length) % SKINS.length].id;
