import { FLAG } from '../sim/race';
import type { CarVisual } from './renderer';
import './finishLine.css';

/** Presentation only: observes race finishes from the existing race state. */
class FinishFeedback {
  private previous: boolean[] = [];
  private banner: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  reset() {
    this.previous = [];
    clearTimeout(this.timer);
    this.banner?.remove();
    this.banner = null;
  }

  observe(cars: CarVisual[], focus: number): boolean {
    let crossed = false;
    cars.forEach((car, i) => {
      const finished = (car.flags & FLAG.finished) !== 0;
      // Joining a completed race / changing the followed car must not replay the effect.
      if (finished && this.previous[i] === false) {
        crossed = true;
        if (i === focus) this.show();
      }
      this.previous[i] = finished;
    });
    return crossed;
  }

  private show() {
    const host = document.getElementById('view-stage');
    if (!host) return;
    clearTimeout(this.timer);
    this.banner?.remove();
    const el = document.createElement('div');
    el.className = 'pk-finish-banner';
    el.setAttribute('role', 'status');
    el.innerHTML = `<svg class="pk-finish-flag" viewBox="0 0 100 100" aria-hidden="true"><defs><pattern id="pk-finish-checks" width="20" height="20" patternUnits="userSpaceOnUse"><rect width="20" height="20" fill="#fff"/><path d="M0 0h10v10H0zM10 10h10v10H10z" fill="#080808"/></pattern></defs><path d="M24 94V12" stroke="#fff" stroke-width="5" stroke-linecap="round"/><path d="M27 13C48 3 64 27 90 15V65C64 77 48 53 27 63Z" fill="url(#pk-finish-checks)" stroke="#fff" stroke-width="2"/></svg><div><span>FINISHED</span><i aria-hidden="true"></i></div>`;
    host.appendChild(el);
    this.banner = el;
    this.timer = setTimeout(() => {
      el.remove();
      if (this.banner === el) this.banner = null;
    }, 1100);
  }
}

// Both views observe the same race, so changing between map and 3D cannot replay the banner.
export const finishFeedback = new FinishFeedback();
