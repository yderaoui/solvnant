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
  loading ??= import('./chase3d').then(({ Chase3D }) => (view = new Chase3D(host)));
  return loading;
}
