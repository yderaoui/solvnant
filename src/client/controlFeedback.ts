import './controls.css';

/** Delegation also covers controls rendered after sign-in or a page change. */
export function initControlFeedback() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const live = new Set<HTMLSpanElement>();
  document.addEventListener('click', event => {
    if (reduced.matches || !(event.target instanceof Element)) return;
    const control = event.target.closest<HTMLElement>('button, a.btn, a.chip, .hero-link, .topbar nav > a, summary, .race-choice');
    if (!control?.isConnected || control.matches(':disabled, [aria-disabled="true"]')) return;
    if (control.closest('[inert]')) return;
    control.querySelector('.pk-control-flare')?.remove();
    if (getComputedStyle(control).position === 'static') control.classList.add('pk-positioned');
    if (live.size >= 32) {
      const first = live.values().next().value;
      first?.remove();
      if (first) live.delete(first);
    }
    const flare = document.createElement('span');
    flare.className = 'pk-control-flare';
    flare.setAttribute('aria-hidden', 'true');
    const box = control.getBoundingClientRect();
    const x = event.detail ? (event as MouseEvent).clientX - box.left : box.width / 2;
    const y = event.detail ? (event as MouseEvent).clientY - box.top : box.height / 2;
    flare.style.setProperty('--press-x', `${Math.max(0, Math.min(box.width, x))}px`);
    flare.style.setProperty('--press-y', `${Math.max(0, Math.min(box.height, y))}px`);
    control.append(flare);
    live.add(flare);
    setTimeout(() => { flare.remove(); live.delete(flare); }, 600);
  }, true);
}
