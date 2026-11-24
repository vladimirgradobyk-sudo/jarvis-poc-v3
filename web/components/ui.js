// Design-system primitives (design-system.md §6.1).
//
// These take props and emit callbacks. They do not fetch, do not read application state, and
// contain no literal colour, size or duration value — tokens only (repo-scaffold, components
// CLAUDE.md). Colour is NEVER the sole carrier of meaning (UX-A11Y-003): every status carries a
// glyph or a word as well.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    f.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return f;
};

export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

/**
 * Append children, DISCARDING null / undefined / false.
 *
 * Use this instead of `el.append(...)` anywhere a child is produced by a conditional. The DOM's
 * own `append` stringifies a falsy value, so `parent.append(cond && node)` renders the literal
 * text "false" when `cond` is false — which is exactly the kind of state-is-not-honest defect
 * design-system §1.3 is about. `h()` and `frag()` already filter; this closes the gap for
 * direct appends.
 */
export function mount(parent, ...children) {
  parent.append(frag(...children));
  return parent;
}

// ── Button ───────────────────────────────────────────────────────────────────────────────────

export function Button({ label, variant = 'secondary', size = '', onClick, disabled = false,
                         busy = false, title = null, type = 'button', block = false, id = null }) {
  return h('button', {
    type, id, class: `btn btn-${variant}${size ? ` btn-${size}` : ''}${block ? ' btn-block' : ''}`,
    disabled: disabled || busy, 'aria-busy': busy ? 'true' : null, title,
    onclick: onClick,
  }, label);
}

// ── Chip / Badge ─────────────────────────────────────────────────────────────────────────────

export function Chip({ label, tone = '', overline = false, title = null, glyph = null }) {
  return h('span', { class: `chip${tone ? ` chip-${tone}` : ''}${overline ? ' chip-overline' : ''}`, title },
    glyph && h('span', { 'aria-hidden': 'true' }, glyph), label);
}

export function Badge({ label, tone = '' }) {
  return h('span', { class: `badge${tone ? ` badge-${tone}` : ''}` }, label);
}

// ── Banner ───────────────────────────────────────────────────────────────────────────────────

const GLYPHS = { info: 'i', warning: '!', danger: '✕', success: '✓', provisional: '!' };

/** Blocking problems use a Banner, never a Toast (§10). Every message names cause AND action. */
export function Banner({ tone = 'info', title = null, message, actions = [], requirementId = null }) {
  return h('div', { class: `banner banner-${tone}`, role: tone === 'danger' ? 'alert' : 'status' },
    h('span', { class: 'banner-glyph', 'aria-hidden': 'true' }, GLYPHS[tone] ?? 'i'),
    h('div', { class: 'grow stack stack-2' },
      title && h('strong', {}, title),
      h('div', {}, message),
      requirementId && h('span', { class: 'caption mono' }, requirementId),
      actions.length > 0 && h('div', { class: 'row' }, actions),
    ),
  );
}

// ── Score tile + rubric meter ────────────────────────────────────────────────────────────────

export function band(score) {
  if (score == null) return '';
  return score >= 80 ? 'score-high' : score >= 60 ? 'score-mid' : 'score-low';
}

/** §2.4: a score is shown NUMERICALLY and coloured. Colour is never the only carrier. */
export function ScoreTile({ value, label, caption, tone = null }) {
  return h('div', { class: 'score-tile' },
    h('div', { class: `score-value ${tone ?? band(value)}` }, value == null ? '—' : String(value)),
    label && h('div', { class: 'small' }, label),
    caption && h('div', { class: 'caption' }, caption),
  );
}

export function RubricMeter({ label, value, max = 100 }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return h('div', { class: 'meter' },
    h('span', {}, label),
    h('span', { class: `num ${band(value)}` }, value == null ? 'not measured' : String(value)),
    h('div', { class: 'meter-track' },
      h('div', { class: `meter-fill ${band(value)}`, style: `width:${pct}%` })),
  );
}

export function Progress({ value, max, tone = '' }) {
  const pct = max ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return h('div', { class: `progress ${tone}`, role: 'progressbar',
                    'aria-valuenow': String(Math.round(pct)), 'aria-valuemin': '0', 'aria-valuemax': '100' },
    h('div', { style: `width:${pct}%` }));
}

// ── Modal (focus-trapped; Esc blocked while a run is active) ─────────────────────────────────

export function Modal({ title, subtitle = null, headerExtra = [], body, footer = null,
                        onClose, closable = true, size = 'lg', labelledBy = 'modal-title' }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const modal = h('div', { class: `modal${size === 'md' ? ' modal-md' : ''}`,
                           role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelledBy });

  mount(modal,
    h('div', { class: 'modal-head' },
      h('div', { class: 'stack stack-1 grow' },
        h('h2', { id: labelledBy }, title),
        subtitle && h('div', { class: 'small muted' }, subtitle)),
      ...headerExtra,
      closable
        ? Button({ label: '✕', variant: 'ghost', size: 'sm', onClick: onClose, title: 'Close' })
        : h('span', { class: 'caption muted', title: 'A run is in progress — closing is blocked to prevent accidental loss' }, 'Run in progress'),
    ),
    h('div', { class: 'modal-body' }, body),
    footer && h('div', { class: 'modal-foot' }, footer),
  );
  backdrop.append(modal);

  // Focus trap. Esc closes ONLY when closable (design-system §7.2).
  const onKey = (e) => {
    if (e.key === 'Escape' && closable) { e.preventDefault(); onClose?.(); return; }
    if (e.key !== 'Tab') return;
    const f = [...modal.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')]
      .filter((x) => !x.disabled && x.offsetParent !== null);
    if (f.length === 0) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  backdrop.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && closable) onClose?.(); });

  return backdrop;
}

// ── Tabs ─────────────────────────────────────────────────────────────────────────────────────

export function Tabs({ tabs, active, onSelect }) {
  return h('div', { class: 'tabs', role: 'tablist' },
    tabs.map((t) => h('button', {
      class: 'tab', role: 'tab', type: 'button',
      'aria-selected': t.id === active ? 'true' : 'false',
      disabled: t.disabled,
      // A disabled future phase says WHY, rather than being inert and unexplained.
      title: t.disabled ? 'Not yet reached in this run' : null,
      onclick: () => !t.disabled && onSelect(t.id),
    }, t.label)),
  );
}

// ── Field ────────────────────────────────────────────────────────────────────────────────────

export function Field({ id, label, required = false, help = null, error = null, control }) {
  const describedBy = [help && `${id}-help`, error && `${id}-err`].filter(Boolean).join(' ');
  if (describedBy) control.setAttribute('aria-describedby', describedBy);
  if (error) control.setAttribute('aria-invalid', 'true');
  return h('div', { class: 'field' },
    h('label', { for: id }, label, required && h('span', { class: 'required', 'aria-hidden': 'true' }, ' *')),
    required && h('span', { class: 'visually-hidden' }, ' (required)'),
    control,
    help && h('div', { class: 'field-help', id: `${id}-help` }, help),
    // UX-A11Y-010: errors are programmatically associated AND announced.
    error && h('div', { class: 'field-error', id: `${id}-err`, role: 'alert' }, error),
  );
}

export function EmptyState({ title, message, action = null }) {
  // §6.1: an EmptyState must offer the NEXT ACTION, not merely explain absence.
  return h('div', { class: 'empty stack stack-3' },
    h('strong', {}, title), message && h('div', { class: 'small' }, message), action);
}

export function StatusDot({ kind, label }) {
  return h('span', { class: 'row', style: 'gap:var(--space-2)' },
    h('span', { class: `dot dot-${kind}`, 'aria-hidden': 'true' }),
    h('span', { class: 'caption' }, label));
}

export function KV(pairs) {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v] of pairs) {
    if (v === undefined) continue;
    dl.append(h('dt', {}, k));
    // §6.4 InputSummary: an empty value renders an explicit em dash, NEVER blank.
    dl.append(h('dd', {}, v === null || v === '' ? '—' : v));
  }
  return dl;
}

// ── Toasts (non-blocking only) ───────────────────────────────────────────────────────────────

let toastStack = null;
export function toast(message, tone = 'success', ms = 5000) {
  if (!toastStack) {
    toastStack = h('div', { class: 'toast-stack', 'aria-live': 'polite' });
    document.body.append(toastStack);
  }
  const el = h('div', { class: `banner banner-${tone} toast` },
    h('span', { class: 'banner-glyph', 'aria-hidden': 'true' }, GLYPHS[tone] ?? 'i'),
    h('div', { class: 'grow' }, message));
  toastStack.append(el);
  setTimeout(() => el.remove(), ms);
}

// ── Markdown rendering (sanitised) ───────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Minimal markdown → HTML. Deliberately NOT a general-purpose renderer: it escapes first and
 * only then introduces a fixed set of tags, so model output — which is untrusted data — cannot
 * inject markup (non-negotiable 5).
 *
 * Unresolved placeholders are rendered as a marked span so FR-GEN-005 is visible in the prose
 * itself, not only in the banner above it.
 */
export function renderMarkdown(md) {
  const lines = String(md ?? '').split('\n');
  const out = [];
  let inList = false;

  const inline = (s) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/TBD \[UNKNOWN[^\]]*\]/g, '<span class="placeholder-mark">$&</span>')
    .replace(/\[Source:\s*([^\]]+)\]/g, '<span class="citation" title="Cited source">[Source: $1]</span>');

  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const isRow = (s) => /^\s*\|.*\|\s*$/.test(s);
  const isSep = (s) => { const t = s.trim(); return /^\|?[\s:|-]+$/.test(t) && t.includes('-') && t.includes('|'); };
  const cells = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.replace(/\\\|/g, '|').trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');

    // GitHub-style pipe tables: a header row, a separator row, then body rows.
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      closeList();
      const header = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isRow(lines[i])) { rows.push(cells(lines[i])); i++; }
      i--;
      out.push('<table><thead><tr>' + header.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + header.map((_, ci) => `<td>${inline(r[ci] ?? '')}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>');
      continue;
    }

    if (/^\s*$/.test(line)) { closeList(); continue; }
    if (/^### /.test(line)) { closeList(); out.push(`<h3>${inline(line.slice(4))}</h3>`); continue; }
    if (/^## /.test(line))  { closeList(); out.push(`<h2>${inline(line.slice(3))}</h2>`); continue; }
    if (/^# /.test(line))   { closeList(); out.push(`<h1>${inline(line.slice(2))}</h1>`); continue; }
    if (/^> /.test(line))   { closeList(); out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`); continue; }
    if (/^[-*] /.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

export function DocumentView(body, { compare = false } = {}) {
  return h('div', { class: `doc${compare ? ' compare-pane' : ''}`, html: renderMarkdown(body) });
}

// ── Diff ─────────────────────────────────────────────────────────────────────────────────────

/** Unified line diff, adequate for a review-facing view. */
export function DiffView(before, after) {
  const b = (before ?? '').split('\n');
  const a = (after ?? '').split('\n');
  const bset = new Set(b);
  const aset = new Set(a);
  const wrap = h('div', { class: 'difflines' });

  if (before === null || before === undefined) {
    a.forEach((l, i) => wrap.append(h('div', { class: 'diffline add' },
      h('span', { class: 'ln' }, String(i + 1)), h('span', {}, `+ ${l}`))));
    return wrap;
  }

  let bi = 0, ai = 0, shown = 0;
  while (bi < b.length || ai < a.length) {
    const bl = b[bi], al = a[ai];
    if (bl === al) {
      // Context lines, trimmed so a large unchanged file stays readable.
      if (shown < 400) wrap.append(h('div', { class: 'diffline' },
        h('span', { class: 'ln' }, String(ai + 1)), h('span', {}, `  ${al ?? ''}`)));
      bi++; ai++; shown++;
      continue;
    }
    if (al !== undefined && !bset.has(al)) {
      wrap.append(h('div', { class: 'diffline add' },
        h('span', { class: 'ln' }, String(ai + 1)), h('span', {}, `+ ${al}`)));
      ai++; shown++;
      continue;
    }
    if (bl !== undefined && !aset.has(bl)) {
      wrap.append(h('div', { class: 'diffline del' },
        h('span', { class: 'ln' }, '—'), h('span', {}, `- ${bl}`)));
      bi++; shown++;
      continue;
    }
    bi++; ai++;
  }
  return wrap;
}
