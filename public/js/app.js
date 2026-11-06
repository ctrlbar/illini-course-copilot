import { api, store, persist, esc, toast, switchTab, clientId } from './lib.js';
import { initPlanner } from './views/planner.js';
import { initRoadmap } from './views/roadmap.js';
import { initExplore } from './views/explore.js';
import { initAlerts, refreshAlerts } from './views/alerts.js';
import { initChat } from './views/chat.js';
import { closeDrawer } from './views/course.js';

// ---------- chip input for completed courses ----------
function chipInput(container, initial = []) {
  let values = [...initial];
  const render = () => {
    container.innerHTML = values.map((v, i) => `<span class="chip">${esc(v)}<button type="button" data-i="${i}" aria-label="remove">×</button></span>`).join('')
      + '<input type="text" placeholder="Type a course code, e.g. CS 124, and press Enter" />';
    const input = container.querySelector('input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const codes = input.value.toUpperCase().match(/[A-Z]{2,4}\s?\d{3}/g) || [];
        for (const c of codes) {
          const norm = c.replace(/([A-Z]+)\s?(\d+)/, '$1 $2');
          if (!values.includes(norm)) values.push(norm);
        }
        render();
        container.querySelector('input').focus();
      } else if (e.key === 'Backspace' && !input.value && values.length) { values.pop(); render(); container.querySelector('input').focus(); }
    });
    container.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => { values.splice(Number(b.dataset.i), 1); render(); }));
  };
  render();
  return { get: () => { const pending = container.querySelector('input').value.toUpperCase().match(/[A-Z]{2,4}\s?\d{3}/g) || []; return [...new Set([...values, ...pending.map((c) => c.replace(/([A-Z]+)\s?(\d+)/, '$1 $2'))])]; }, set: (v) => { values = [...v]; render(); } };
}

// ---------- profile dialog ----------
const dialog = document.getElementById('profile-dialog');
const form = document.getElementById('profile-form');
const completed = chipInput(document.getElementById('completed-input'), store.profile?.completed || []);

function fillGradTerms() {
  const sel = document.getElementById('grad-term');
  const y = Number(store.meta?.term.year || new Date().getFullYear());
  const opts = [];
  for (let i = 0; i <= 5; i++) for (const s of ['Spring', 'Fall']) opts.push(`${s} ${y + i}`);
  sel.innerHTML = '<option value="">Standard (4 years)</option>' + opts.map((o) => `<option>${o}</option>`).join('');
}

function openProfile() {
  const p = store.profile || {};
  for (const el of form.elements) {
    if (!el.name || !(el.name in p)) continue;
    if (el.type === 'checkbox') el.checked = Boolean(p[el.name]); else el.value = p[el.name];
  }
  selectedCareers = new Set(p.careers || (p.career ? [p.career] : []));
  renderCareers();
  form.elements.careerOther.value = '';
  pendingAudit = null;
  showAuditSummary(p.audit);
  document.getElementById('audit-file').value = '';
  document.getElementById('transferring').checked = Boolean(p.intendedMajor);
  document.getElementById('intended-wrap').classList.toggle('hidden', !p.intendedMajor);
  completed.set(p.completed || []);
  dialog.showModal();
}

function profileSummary() {
  const p = store.profile;
  document.getElementById('profile-summary').textContent = p
    ? `${p.standing[0].toUpperCase()}${p.standing.slice(1)} · ${p.major.replace(/,\s*\w+$/, '')}${p.intendedMajor ? ' → ' + p.intendedMajor.replace(/,\s*\w+$/, '') : ''}`
    : 'Set up profile';
}

document.getElementById('profile-btn').addEventListener('click', openProfile);
document.getElementById('profile-cancel').addEventListener('click', () => dialog.close());
document.getElementById('transferring').addEventListener('change', (e) => document.getElementById('intended-wrap').classList.toggle('hidden', !e.target.checked));
// ---------- careers (multi-select) ----------
const CAREERS = ['Software engineer', 'Machine learning / AI', 'Data science', 'Quant finance', 'Cybersecurity', 'Product manager',
  'Game development', 'Hardware / embedded', 'Research / PhD', 'Pre-med / health', 'Consulting', 'Business / startups', 'Law / policy', 'Teaching'];
let selectedCareers = new Set();
function renderCareers() {
  const extra = [...selectedCareers].filter((c) => !CAREERS.includes(c));
  document.getElementById('career-chips').innerHTML = [...CAREERS, ...extra]
    .map((c) => `<span class="chip click ${selectedCareers.has(c) ? 'selected' : ''}" role="checkbox" aria-checked="${selectedCareers.has(c)}" tabindex="0">${esc(c)}</span>`).join('');
}
document.getElementById('career-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const c = chip.textContent;
  if (selectedCareers.has(c)) selectedCareers.delete(c); else selectedCareers.add(c);
  renderCareers();
});
document.getElementById('career-chips').addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.target.click(); } });

// ---------- degree audit import ----------
let pendingAudit = null;
const auditStatus = (html) => { document.getElementById('audit-status').innerHTML = html; };
function showAuditSummary(a) {
  if (!a) { auditStatus(''); document.getElementById('audit-clear').classList.add('hidden'); return; }
  const unmet = a.requirements.filter((r) => r.status === 'incomplete').length;
  auditStatus(`<span class="tag ok">✓ Audit loaded</span> ${a.completed.length} completed · ${a.inProgress.length} in progress · ${unmet} unmet requirement${unmet === 1 ? '' : 's'}${a.importedAt ? ` <span class="muted">(${new Date(a.importedAt).toLocaleDateString()})</span>` : ''}`);
  document.getElementById('audit-clear').classList.remove('hidden');
}
document.getElementById('audit-paste-toggle').addEventListener('click', () => document.getElementById('audit-text').classList.toggle('hidden'));
document.getElementById('audit-clear').addEventListener('click', () => { pendingAudit = { cleared: true }; showAuditSummary(null); });
document.getElementById('audit-import').addEventListener('click', async () => {
  const file = document.getElementById('audit-file').files[0];
  const text = document.getElementById('audit-text').value.trim();
  if (!file && !text) { auditStatus('<span class="tag bad">Choose a PDF or paste the audit text first</span>'); return; }
  auditStatus(`<span class="spinner"></span> Reading your audit${store.meta?.grok ? ' with Grok' : ''}…`);
  try {
    const res = file
      ? await fetch('/api/audit', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file })
      : await fetch('/api/audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const a = await res.json();
    if (!res.ok) throw new Error(a.error || 'Import failed');
    pendingAudit = {
      importedAt: new Date().toISOString(), source: a.source, program: a.program || null, earnedHours: a.earnedHours ?? null,
      completed: a.completed, inProgress: a.inProgress, requirements: a.requirements,
    };
    // merge audit courses into the completed list so prerequisite checks use them everywhere
    completed.set([...new Set([...completed.get(), ...a.completed, ...a.inProgress])].sort());
    showAuditSummary(pendingAudit);
    if (a.warnings?.length) auditStatus(document.getElementById('audit-status').innerHTML + `<br><span class="tag warn">${esc(a.warnings[0])}</span>`);
    document.getElementById('audit-text').value = '';
  } catch (e) { auditStatus(`<span class="tag bad">${esc(e.message)}</span>`); }
});
form.addEventListener('submit', () => {
  const f = new FormData(form);
  store.profile = {
    standing: f.get('standing'),
    gradTerm: f.get('gradTerm') || '',
    major: f.get('major').trim(),
    intendedMajor: document.getElementById('transferring').checked ? (f.get('intendedMajor') || '').trim() : '',
    careers: [...selectedCareers, ...String(f.get('careerOther') || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean)],
    audit: pendingAudit?.cleared ? null : (pendingAudit || store.profile?.audit || null),
    completed: completed.get(),
    maxCredits: Number(f.get('maxCredits')) || 16,
    includeSummer: f.get('includeSummer') === 'on',
  };
  store.profile.career = store.profile.careers.join('; ');
  persist('icc.profile', store.profile);
  profileSummary();
  store.emit('profile', store.profile);
  toast('Profile saved', 'ok');
});

// ---------- tabs ----------
document.getElementById('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) switchTab(b.dataset.tab);
});
document.getElementById('drawer-close').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ---------- live notifications (seat alerts + reminders) ----------
function connectEvents() {
  const es = new EventSource(`/api/events?clientId=${encodeURIComponent(clientId)}`);
  es.addEventListener('notify', (e) => {
    const n = JSON.parse(e.data);
    toast(`<b>${esc(n.title)}</b><br>${esc(n.body)}`, 'ok');
    try { if (Notification.permission === 'granted') new Notification(n.title, { body: n.body }); } catch { /* unsupported */ }
    refreshAlerts();
  });
}

// ---------- boot ----------
(async function boot() {
  try {
    store.meta = await api('/api/meta');
  } catch (e) {
    toast('Server not reachable: ' + esc(e.message), 'bad');
    return;
  }
  document.getElementById('term-label').textContent = store.meta.termLabel;
  const gs = document.getElementById('grok-status');
  gs.textContent = store.meta.grok ? `Grok: ${store.meta.model}` : 'Grok: demo mode';
  gs.classList.toggle('on', store.meta.grok);
  gs.title = store.meta.grok ? 'Grok API connected' : 'Set XAI_API_KEY in .env to enable Grok';
  fillGradTerms();
  profileSummary();

  initPlanner(document.getElementById('view-planner'));
  initRoadmap(document.getElementById('view-roadmap'));
  initExplore(document.getElementById('view-explore'));
  initAlerts(document.getElementById('view-alerts'));
  initChat(document.getElementById('view-chat'));
  connectEvents();

  const fromHash = () => {
    const hash = location.hash.slice(1);
    if (['planner', 'roadmap', 'explore', 'alerts', 'chat'].includes(hash)) switchTab(hash);
  };
  fromHash();
  window.addEventListener('hashchange', fromHash);
  if (!store.profile) openProfile();

  api('/api/programs').then((programs) => {
    document.getElementById('programs').innerHTML = programs.map((p) => `<option value="${esc(p.name)}"></option>`).join('');
  }).catch(() => {});
})();
