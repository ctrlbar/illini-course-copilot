// Seat Alerts + registration reminders.
import { api, store, esc, clientId, availTag, availLevel, toast, download, load, persist } from '../lib.js';
import { openCourse } from './course.js';

let root;
let state = { alerts: [], reminders: [], pollMinutes: 5, email: false };

export function initAlerts(el) {
  root = el;
  store.on('alerts-changed', refreshAlerts);
  store.on('tab', (t) => { if (t === 'alerts') refreshAlerts(); });
  refreshAlerts();
}

export async function refreshAlerts() {
  try { state = await api(`/api/alerts?clientId=${encodeURIComponent(clientId)}`); } catch { /* offline */ }
  const badge = document.getElementById('alert-count');
  badge.textContent = state.alerts.length;
  badge.classList.toggle('hidden', !state.alerts.length);
  render();
}

const historyBar = (h = []) => `<div class="history" title="status changes">${h.slice(-24).map((x) => {
  const l = availLevel(x.status);
  return `<i title="${esc(x.status)} · ${new Date(x.at).toLocaleString()}" style="background:var(--${l === 'open' ? 'ok' : l === 'closed' ? 'bad' : 'warn'})"></i>`;
}).join('')}</div>`;

function render() {
  if (!root) return;
  const ch = load('icc.channels', {});
  const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  root.innerHTML = `
    <div class="alerts-grid">
      <div>
        <div class="panel">
          <div class="row">
            <h2 style="margin:0">Watched sections</h2><span class="spacer"></span>
            <span class="muted small">checked every ${state.pollMinutes} min</span>
            <button class="btn sm" id="check-now">↻ Check now</button>
          </div>
          <p class="muted small">Watch a closed section from any course page or schedule. You'll be notified the moment it opens.</p>
          ${state.alerts.length ? `<table>
            <thead><tr><th>Course</th><th>Section</th><th>CRN</th><th>Status</th><th>History</th><th>Last checked</th><th></th></tr></thead>
            <tbody>${state.alerts.map((a) => `
              <tr>
                <td><a href="#" data-course="${esc(a.courseCode)}"><b>${esc(a.courseCode)}</b></a><div class="small muted">${esc(a.title)}</div></td>
                <td>${esc(a.section)} <span class="small muted">${esc(a.type)}</span></td>
                <td><code>${a.crn}</code></td>
                <td>${availTag(a.lastStatus)}${a.triggered.length ? `<div class="small muted">opened ${a.triggered.length}×</div>` : ''}</td>
                <td>${historyBar(a.history)}</td>
                <td class="small muted">${a.lastChecked ? new Date(a.lastChecked).toLocaleTimeString() : '—'}</td>
                <td><button class="btn sm ghost" data-rm="${a.id}">Remove</button></td>
              </tr>`).join('')}</tbody></table>`
            : '<div class="empty"><div class="big">🔔</div>No watched sections yet.</div>'}
        </div>
      </div>
      <div>
        <div class="panel" style="margin-bottom:16px">
          <h3>Where to notify me</h3>
          <label class="check"><span>Browser notifications:</span> <b>${perm}</b></label>
          ${perm === 'default' ? '<button class="btn sm" id="perm">Enable browser notifications</button>' : ''}
          <label style="margin-top:10px">Discord webhook URL <span class="muted small">(optional)</span>
            <input type="url" id="discord" value="${esc(ch.discordWebhook || '')}" placeholder="https://discord.com/api/webhooks/…" /></label>
          ${state.email ? `<label>Email <input type="email" id="email" value="${esc(ch.email || '')}" placeholder="netid@illinois.edu" /></label>` : '<p class="muted small">Email alerts are available when the server has SMTP configured.</p>'}
          <button class="btn sm" id="save-ch">Save channels</button>
        </div>
        <div class="panel">
          <h3>Registration reminders</h3>
          <p class="muted small">Add your time ticket from Student Self-Service. We'll remind you 1 hour before and right when it opens.</p>
          <label>When<input type="datetime-local" id="rem-when" /></label>
          <label>Label<input id="rem-label" value="Registration time ticket opens" /></label>
          <div class="row"><button class="btn sm primary" id="rem-add">Add reminder</button><button class="btn sm" id="rem-ics">📅 Add to calendar</button></div>
          ${state.reminders.map((r) => `<div class="row small" style="margin-top:8px"><span>⏰ <b>${esc(r.label)}</b><br>${new Date(r.when).toLocaleString()}</span><span class="spacer"></span><button class="btn sm ghost" data-rm-rem="${r.id}">×</button></div>`).join('')}
        </div>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  root.querySelectorAll('[data-course]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openCourse(a.dataset.course); }));
  root.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/alerts/${b.dataset.rm}?clientId=${encodeURIComponent(clientId)}`, { method: 'DELETE' });
    refreshAlerts();
  }));
  $('#check-now').addEventListener('click', async () => {
    $('#check-now').innerHTML = '<span class="spinner"></span>';
    const r = await api('/api/alerts/check', { method: 'POST' }).catch(() => ({ changes: 0 }));
    toast(r.changes ? `${r.changes} section(s) just opened!` : 'No changes yet. Still watching.');
    refreshAlerts();
  });
  $('#perm')?.addEventListener('click', async () => { await Notification.requestPermission(); render(); });
  $('#save-ch').addEventListener('click', async () => {
    const channels = { discordWebhook: $('#discord').value.trim(), email: $('#email')?.value.trim() || '' };
    if (channels.discordWebhook && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(channels.discordWebhook)) { toast('That does not look like a Discord webhook URL', 'bad'); return; }
    persist('icc.channels', channels);
    await api('/api/alerts/channels', { method: 'POST', body: { clientId, ...channels } });
    toast('Notification channels saved', 'ok');
  });
  $('#rem-add').addEventListener('click', async () => {
    const when = $('#rem-when').value;
    if (!when) { toast('Pick a date and time', 'bad'); return; }
    const c = load('icc.channels', {});
    await api('/api/reminders', { method: 'POST', body: { clientId, when: new Date(when).toISOString(), label: $('#rem-label').value, ...c } });
    toast('Reminder set', 'ok');
    refreshAlerts();
  });
  $('#rem-ics').addEventListener('click', () => {
    const when = $('#rem-when').value;
    if (!when) { toast('Pick a date and time', 'bad'); return; }
    download('/api/ics/reminder', { when: new Date(when).toISOString(), label: $('#rem-label').value }, 'registration-reminder.ics');
  });
  root.querySelectorAll('[data-rm-rem]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/reminders/${b.dataset.rmRem}?clientId=${encodeURIComponent(clientId)}`, { method: 'DELETE' });
    refreshAlerts();
  }));
}
