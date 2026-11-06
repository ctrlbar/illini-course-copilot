// Shared helpers: API calls, state, formatting.

export const clientId = (() => {
  try {
    let id = localStorage.getItem('icc.clientId');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('icc.clientId', id); }
    return id;
  } catch { return 'anon-' + Math.random().toString(36).slice(2); }
})();

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export async function download(path, body, filename) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const blob = await res.blob();
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- tiny pub/sub store ----
const listeners = {};
export const store = {
  meta: null,
  profile: load('icc.profile', null),
  planner: { request: null, result: null, selected: 0, pinned: [] },
  on(evt, fn) { (listeners[evt] ||= []).push(fn); },
  emit(evt, data) { (listeners[evt] || []).forEach((fn) => fn(data)); },
};
export function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
export function persist(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
export const profile = () => store.profile || {};

// ---- formatting ----
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtTime = (m) => {
  if (m == null) return 'TBA';
  const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0');
  return `${((h + 11) % 12) + 1}:${mm}${h < 12 ? 'am' : 'pm'}`;
};
export const parseTimeInput = (v) => { if (!v) return null; const [h, m] = v.split(':').map(Number); return h * 60 + m; };
export const DAY_NAMES = { M: 'Mon', T: 'Tue', W: 'Wed', R: 'Thu', F: 'Fri' };
export const COLORS = ['#1f6feb', '#e8590c', '#2b8a3e', '#9c36b5', '#c2255c', '#0b7285', '#5f3dc4', '#a35d00', '#364fc7', '#087f5b'];

export function availLevel(a = '') {
  const s = a.toLowerCase();
  if (s.includes('closed')) return 'closed';
  if (s.includes('restricted')) return 'restricted';
  if (s.includes('open')) return 'open';
  return 'unknown';
}
export function availTag(a) {
  const l = availLevel(a);
  const cls = { open: 'ok', restricted: 'warn', closed: 'bad', unknown: '' }[l];
  return `<span class="tag ${cls}" title="${esc(a)}">${esc(a || 'Unknown')}</span>`;
}
export function gpaClass(g) { return g == null ? '' : g >= 3.5 ? 'hi' : g >= 3.0 ? 'mid' : 'lo'; }
export const gpaHtml = (g) => (g == null ? '<span class="muted">n/a</span>' : `<span class="gpa ${gpaClass(g)}">${g.toFixed(2)}</span>`);

export function toast(msg, kind = '') {
  const el = Object.assign(document.createElement('div'), { className: `toast ${kind}`, innerHTML: msg });
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}

/** Minimal, safe markdown: **bold**, _italic_, `code`, bullet lists, paragraphs. */
export function md(text) {
  const lines = esc(text || '').split('\n');
  let html = '', inList = false;
  for (const line of lines) {
    const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\W)_(.+?)_(?=\W|$)/g, '$1<i>$2</i>').replace(/`(.+?)`/g, '<code>$1</code>');
    const li = line.match(/^\s*[-*•]\s+(.*)/) || line.match(/^\s*\d+\.\s+(.*)/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

export function genEdTags(cats = {}) {
  return Object.entries(cats).map(([k, v]) => `<span class="tag info" title="${esc(k)}">${esc(k)}${v && v !== k ? ':' + esc(v) : ''}</span>`).join(' ');
}

export function switchTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  store.emit('tab', name);
  try { history.replaceState(null, '', `#${name}`); } catch { /* ignore */ }
}
