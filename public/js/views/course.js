// Course detail drawer (shared by Explore, Planner, Roadmap, Chat).
import { api, esc, profile, availTag, gpaHtml, genEdTags, toast, clientId, store, switchTab, load } from '../lib.js';

const drawer = () => document.getElementById('drawer');
export function closeDrawer() { drawer().classList.remove('open'); drawer().setAttribute('aria-hidden', 'true'); }

const STATUS = {
  ok: ['ok', '✓ You can take this course'],
  completed: ['info', 'Already completed'],
  unknown: ['warn', 'Needs a manual check'],
  missing: ['bad', 'Missing prerequisites'],
  restricted: ['bad', 'Restricted for you'],
};

export async function watchSection(courseCode, crn) {
  try {
    const ch = load('icc.channels', {});
    await api('/api/alerts', { method: 'POST', body: { clientId, courseCode, crn, discordWebhook: ch.discordWebhook, email: ch.email } });
    toast(`Watching CRN ${crn}. You'll be notified when a seat opens.`, 'ok');
    store.emit('alerts-changed');
  } catch (e) { toast(esc(e.message), 'bad'); }
}

export async function openCourse(code) {
  const body = document.getElementById('drawer-body');
  drawer().classList.add('open');
  drawer().setAttribute('aria-hidden', 'false');
  body.innerHTML = `<div class="empty"><span class="spinner"></span> Loading ${esc(code)}…</div>`;
  let c;
  try { c = await api('/api/course', { method: 'POST', body: { code, profile: profile() } }); }
  catch (e) { body.innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; return; }

  const [cls, label] = STATUS[c.eligibility.status] || STATUS.unknown;
  const total = c.gpa ? c.gpa.dist.reduce((a, b) => a + b, 0) : 0;
  const max = c.gpa ? Math.max(...c.gpa.dist) : 1;
  const genEds = Object.fromEntries(c.genEds.map((g) => [g.category, g.code.replace(/^1/, '')]));

  body.innerHTML = `
    <div class="row"><h2>${esc(c.code)}: ${esc(c.title)}</h2></div>
    <div class="row small" style="margin-bottom:8px">
      <span class="tag">${esc(c.credits.text)}</span> ${genEdTags(genEds)}
      ${c.degreeAttributes ? `<span class="tag">${esc(c.degreeAttributes)}</span>` : ''}
    </div>
    <div class="banner ${cls}"><b>${label}.</b> ${esc(c.eligibility.summary)}
      ${c.eligibility.prereq?.note ? `<br><span class="small">${esc(c.eligibility.prereq.note)}</span>` : ''}
      ${!store.profile ? '<br><span class="small">Set up your profile to check prerequisites and restrictions.</span>' : ''}
    </div>
    <p>${esc(c.description)}</p>
    ${c.scheduleInfo ? `<div class="banner info small"><b>Registration:</b> ${esc(c.scheduleInfo)}</div>` : ''}
    <div class="banner info small"><b>Linked sections:</b> ${esc(c.linking)} (${c.bundleCount} valid combinations)</div>
    <div class="row" style="margin:12px 0">
      <button class="btn primary" id="add-planner">+ Add to schedule planner</button>
      <button class="btn" id="refresh-seats">↻ Refresh seats</button>
      <a class="btn ghost" href="https://courses.illinois.edu/schedule/${store.meta.term.year}/${store.meta.term.season}/${c.subject}/${c.number}" target="_blank" rel="noopener">Course Explorer ↗</a>
    </div>
    ${c.gpa ? `
      <h3>Grade distribution <span class="muted small">(${total.toLocaleString()} students, recent terms) · avg ${gpaHtml(c.gpa.avg)}</span></h3>
      <div class="dist">${c.gpa.dist.map((n, i) => `<div title="${c.gradeLabels[i]}: ${n}" style="height:${(n / max) * 100}%"></div>`).join('')}</div>
      <div class="dist-labels">${c.gradeLabels.map((g) => `<span>${g}</span>`).join('')}</div>
      ${c.instructorStats.length ? `<p class="small muted">By instructor: ${c.instructorStats.slice(0, 6).map((i) => `${esc(i.name)} ${gpaHtml(i.avg)}`).join(' · ')}</p>` : ''}` : ''}
    <h3 style="margin-top:16px">Sections</h3>
    <div style="overflow:auto"><table>
      <thead><tr><th>CRN</th><th>Type</th><th>Sec</th><th>Time</th><th>Location</th><th>Instructor</th><th>Seats</th><th></th></tr></thead>
      <tbody>${c.sections.map((s) => `
        <tr>
          <td>${s.crn}</td>
          <td>${esc(s.type)}</td>
          <td><b>${esc(s.number)}</b>${s.partOfTerm !== '1' ? ` <span class="tag">${s.partOfTerm === 'A' ? '1st 8wk' : s.partOfTerm === 'B' ? '2nd 8wk' : esc(s.partOfTerm)}</span>` : ''}</td>
          <td>${s.meetings.map((m) => m.start == null ? 'Online / arranged' : `${m.days.join('')} ${esc(m.startText)}–${esc(m.endText)}`).join('<br>')}</td>
          <td class="small">${s.meetings.map((m) => esc(`${m.room} ${m.building}`.trim())).join('<br>')}</td>
          <td class="small">${[...new Set(s.meetings.flatMap((m) => m.instructors.map((i) => i.name)))].map(esc).join(', ')}${s.instructorGpa ? `<br>${gpaHtml(s.instructorGpa.avg)}` : ''}</td>
          <td>${availTag(s.availability)}${s.restriction?.status === 'restricted' ? `<br><span class="tag bad" title="${esc(s.restriction.reasons.join('; '))}">restricted for you</span>` : s.restriction?.status === 'unknown' ? `<br><span class="tag warn" title="${esc(s.restriction.reasons.join('; '))}">check restriction</span>` : ''}</td>
          <td>${/closed/i.test(s.availability) ? `<button class="btn sm" data-watch="${s.crn}">🔔 Watch</button>` : ''}</td>
        </tr>
        ${s.notes || s.text ? `<tr><td></td><td colspan="7" class="small muted">${esc([s.text, s.notes].filter(Boolean).join(' '))}</td></tr>` : ''}`).join('')}
      </tbody></table></div>`;

  body.querySelector('#add-planner').addEventListener('click', () => {
    store.emit('planner-add-course', c.code);
    closeDrawer();
    switchTab('planner');
  });
  body.querySelector('#refresh-seats').addEventListener('click', async () => {
    await api('/api/course', { method: 'POST', body: { code, fresh: true, profile: profile() } });
    openCourse(code);
  });
  body.querySelectorAll('[data-watch]').forEach((b) => b.addEventListener('click', () => watchSection(c.code, b.dataset.watch)));
}
