// Side drawer showing the driver code a model wrote.
import type { EntryInfo } from './data';
import type { CarResult } from '../sim/race';

const KEYWORDS =
  /^(const|let|var|function|return|if|else|for|while|do|break|continue|new|typeof|of|in|true|false|null|undefined|this|switch|case|default|throw|try|catch)$/;
const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?(?:e-?\d+)?\b)|([A-Za-z_$][\w$]*)/g;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function highlight(code: string): string {
  let out = '';
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    out += escapeHtml(code.slice(last, m.index));
    const [tok, com, str, numb, word] = m;
    const esc = escapeHtml(tok);
    if (com) out += `<span class="tk-c">${esc}</span>`;
    else if (str) out += `<span class="tk-s">${esc}</span>`;
    else if (numb) out += `<span class="tk-n">${esc}</span>`;
    else if (word && KEYWORDS.test(word)) out += `<span class="tk-k">${esc}</span>`;
    else if (word === 'Math' || word === 'TRACK' || word === 'state' || word === 'drive') out += `<span class="tk-b">${esc}</span>`;
    else out += esc;
    last = m.index! + tok.length;
  }
  return out + escapeHtml(code.slice(last));
}

const SOURCE_LABEL: Record<string, string> = {
  llm: 'Written by the model',
  fallback: 'Fallback driver (model failed)',
  house: 'House bot (hand-written)',
};

export class CodeViewer {
  private el = document.getElementById('code-drawer')!;
  private onClose: () => void = () => {};

  constructor() {
    this.el.querySelector('.drawer-close')!.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  }

  open(entry: EntryInfo, result: CarResult | null, onClose: () => void) {
    this.onClose = onClose;
    const bytes = new TextEncoder().encode(entry.code).length;
    const lines = entry.code.split('\n').length;
    this.el.querySelector('.drawer-head')!.innerHTML = `
      <span class="swatch" style="background:${entry.color}"></span>
      <div>
        <div class="drawer-name">${escapeHtml(entry.name)}</div>
        <div class="drawer-model">${escapeHtml(entry.model)}</div>
      </div>`;
    const crash = result?.crashReason
      ? `<div class="crash-box"><b>Crashed${result.crashTime ? ` at ${result.crashTime.toFixed(1)}s` : ''}:</b> ${escapeHtml(result.crashReason)}</div>`
      : '';
    this.el.querySelector('.drawer-meta')!.innerHTML = `
      <span class="badge badge-${entry.source}">${SOURCE_LABEL[entry.source] ?? entry.source}</span>
      <span>${lines} lines · ${(bytes / 1024).toFixed(1)} KB</span>
      ${entry.createdAt ? `<span>written ${new Date(entry.createdAt).toLocaleString()}</span>` : ''}
      ${crash}`;
    this.el.querySelector('code')!.innerHTML = highlight(entry.code);
    const copy = this.el.querySelector<HTMLButtonElement>('.copy-btn')!;
    copy.textContent = 'Copy';
    copy.onclick = async () => {
      await navigator.clipboard.writeText(entry.code);
      copy.textContent = 'Copied ✓';
    };
    this.el.classList.add('open');
  }

  close() {
    if (!this.el.classList.contains('open')) return;
    this.el.classList.remove('open');
    this.onClose();
  }
}
