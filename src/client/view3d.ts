// One 3D view + one audio engine for the whole page, shared by the live game and the AI League
// (only one of them drives the stage at a time). three.js and the assets load on first use.
import type { Chase3D } from './chase3d';
import { GameAudio } from './audio';

let view: Chase3D | null = null;
let loading: Promise<Chase3D> | null = null;

export const audio = new GameAudio();

export function get3d(): Chase3D | null {
  return view;
}

export function load3d(host: HTMLElement): Promise<Chase3D> {
  // The view is handed out only once its assets and shaders are ready; until then callers keep the map.
  loading ??= import('./chase3d').then(async ({ Chase3D }) => {
    const v = new Chase3D(host);
    await v.ready;
    return (view = v);
  });
  return loading;
}

// Dev builds only: lets the browser tests look inside the 3D view.
if (import.meta.env.DEV) (window as unknown as { __get3d: typeof get3d }).__get3d = get3d;
