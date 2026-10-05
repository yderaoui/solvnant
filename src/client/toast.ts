// Short confirmation message at the bottom of the screen.
import { escapeHtml } from './codeViewer';
import { icon } from './icons';

export function toast(text: string) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.innerHTML = `${icon('check', 16)}${escapeHtml(text)}`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}
