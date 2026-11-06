// Ask Grok: conversational assistant that calls the same tools as the rest of the app.
import { api, store, esc, md, profile, switchTab, load, persist } from '../lib.js';
import { openCourse } from './course.js';

let root;
let messages = load('icc.chat', []);
const actionsByIndex = {};

const SUGGESTIONS = [
  'I need CS 225, MATH 241 and a humanities gen ed. Nothing before 10am, Fridays free.',
  'Find an easy-A Western cultures gen ed that meets Tuesday/Thursday',
  'Can I take CS 374 next semester?',
  'What 400-level CS courses are good for machine learning?',
];

export function initChat(el) {
  root = el;
  root.innerHTML = `
    <div class="chat">
      <div class="messages" id="messages"></div>
      <div class="suggest" id="suggest">${SUGGESTIONS.map((s) => `<span class="chip click">${esc(s)}</span>`).join('')}</div>
      <div class="chat-input">
        <textarea id="input" placeholder="Ask about courses, prerequisites, schedules, gen eds…"></textarea>
        <button class="btn primary" id="send">Send</button>
        <button class="btn ghost" id="clear" title="Clear conversation">Clear</button>
      </div>
    </div>`;
  const input = root.querySelector('#input');
  root.querySelector('#send').addEventListener('click', () => send(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); } });
  root.querySelector('#suggest').addEventListener('click', (e) => { if (e.target.classList.contains('chip')) send(e.target.textContent); });
  root.querySelector('#clear').addEventListener('click', () => { messages = []; persist('icc.chat', messages); render(); });
  render();
}

function render(pending = false) {
  const box = root.querySelector('#messages');
  if (!messages.length) {
    box.innerHTML = `<div class="empty"><div class="big">💬</div><h2>Ask Grok anything about your classes</h2>
      <p>Grok looks up real Course Explorer data (sections, seats, prerequisites, GPA) before answering${store.meta.grok ? '' : '. Running in <b>demo mode</b>: add an <code>XAI_API_KEY</code> for full conversations'}.</p></div>`;
    return;
  }
  box.innerHTML = messages.map((m, i) => `
    <div class="msg ${m.role}">${m.role === 'user' ? esc(m.content) : md(m.content)}
      ${(actionsByIndex[i] || []).map((a, j) => a.type === 'schedules'
        ? `<div style="margin-top:8px"><button class="btn sm primary" data-open-sched="${i}:${j}">Open ${a.result.schedules.length} ranked schedules in planner →</button></div>`
        : a.type === 'course' ? `<div style="margin-top:8px"><button class="btn sm" data-open-course="${esc(a.code)}">View ${esc(a.code)}</button></div>` : '').join('')}
    </div>`).join('') + (pending ? '<div class="msg assistant"><span class="spinner"></span> Looking that up…</div>' : '');
  box.scrollTop = box.scrollHeight;
  box.querySelectorAll('[data-open-sched]').forEach((b) => b.addEventListener('click', () => {
    const [i, j] = b.dataset.openSched.split(':').map(Number);
    store.emit('planner-load', actionsByIndex[i][j]);
    switchTab('planner');
  }));
  box.querySelectorAll('[data-open-course]').forEach((b) => b.addEventListener('click', () => openCourse(b.dataset.openCourse)));
}

async function send(text) {
  text = text.trim();
  if (!text) return;
  root.querySelector('#input').value = '';
  messages.push({ role: 'user', content: text });
  render(true);
  try {
    const r = await api('/api/chat', { method: 'POST', body: { messages: messages.map(({ role, content }) => ({ role, content })), profile: profile() } });
    messages.push({ role: 'assistant', content: r.reply || '(no reply)' });
    actionsByIndex[messages.length - 1] = r.actions || [];
  } catch (e) {
    messages.push({ role: 'assistant', content: `Sorry, something went wrong: ${e.message}` });
  }
  persist('icc.chat', messages.slice(-30));
  render();
}
