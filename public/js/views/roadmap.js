// Degree Roadmap: semester-by-semester plan to graduation for the student's (intended) major.
import { api, store, esc, profile, toast, switchTab, md, gpaHtml } from '../lib.js';
import { openCourse } from './course.js';

let root;
let last = null;

export function initRoadmap(el) {
  root = el;
  render();
  store.on('profile', () => { last = null; render(); });
}

function render() {
  const p = store.profile;
  if (!p) {
    root.innerHTML = `<div class="panel empty"><div class="big">🎓</div><h2>Your path to graduation</h2><p>Set up your profile (major, year, career goal) to build a roadmap.</p>
      <button class="btn primary" onclick="document.getElementById('profile-btn').click()">Set up profile</button></div>`;
    return;
  }
  root.innerHTML = `
    <div class="roadmap-head">
      <div>
        <h2 style="margin:0">Degree roadmap</h2>
        <div class="muted small">${esc(p.intendedMajor ? `${p.major} → ${p.intendedMajor}` : p.major)} · ${esc(p.standing)} · ${p.gradTerm ? `graduating ${esc(p.gradTerm)}` : 'standard timeline'}${p.career ? ` · goal: ${esc(p.career)}` : ''}</div>
      </div>
      <span class="spacer"></span>
      <button class="btn primary" id="build">${last ? '↻ Rebuild roadmap' : 'Build my roadmap'}</button>
    </div>
    <div id="roadmap-body">${last ? '' : `<div class="panel empty"><div class="big">🗺️</div>
      <p>We read your major's official requirements and recommended sequence from the UIUC catalog, check prerequisite chains,
      and lay out every semester until graduation, with electives matched to your career goal.</p></div>`}</div>`;
  root.querySelector('#build').addEventListener('click', build);
  if (last) renderPlan(last);
}

async function build() {
  const body = root.querySelector('#roadmap-body');
  body.innerHTML = `<div class="panel empty"><span class="spinner"></span><p>Reading the catalog, checking prerequisites${store.meta.grok ? ' and asking Grok for career-aligned electives' : ''}…</p></div>`;
  try {
    last = await api('/api/roadmap', { method: 'POST', body: { profile: profile() } });
    if (last.error) throw new Error(last.error);
    render();
  } catch (e) {
    last = null;
    body.innerHTML = `<div class="banner bad">${esc(e.message)}</div>`;
  }
}

function renderPlan(r) {
  const body = root.querySelector('#roadmap-body');
  const total = r.requirements.total;
  const done = r.requirements.done.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  body.innerHTML = `
    <div class="panel" style="margin-bottom:14px">
      <div class="row">
        <div>
          <h3 style="margin:0"><a href="${esc(r.program.url)}" target="_blank" rel="noopener">${esc(r.program.title)}</a> ${r.ai ? '<span class="tag orange">Grok-enhanced</span>' : ''}</h3>
          <div class="muted small">${r.program.totalHours ? `${r.program.totalHours} hours to graduate · ` : ''}target ${esc(r.gradTerm)}</div>
        </div>
        <span class="spacer"></span>
        <div><div class="small">${done}/${total} required courses done (${pct}%)</div><div class="progress"><i style="width:${pct}%"></i></div></div>
      </div>
      ${r.summary ? `<p>${esc(r.summary)}</p>` : ''}
      ${r.warnings.map((w) => `<div class="banner warn small">${esc(w)}</div>`).join('')}
    </div>

    ${r.transfer ? `
    <div class="panel" style="margin-bottom:14px">
      <h3>Transferring from ${esc(r.transfer.from)} into ${esc(r.transfer.to)}</h3>
      ${r.transfer.advice ? `<div class="banner info">${md(r.transfer.advice)}</div>` : ''}
      <p class="small"><b>Already counts toward the new major:</b> ${r.transfer.countsTowardNew.length ? r.transfer.countsTowardNew.map(esc).join(', ') : 'none yet'}</p>
      ${r.transfer.catalogNotes ? `<details><summary class="small">What the catalog says about admission/transfer</summary><p class="small muted">${esc(r.transfer.catalogNotes)}</p></details>` : ''}
      <p class="small muted">Transfer (ICT) admission has GPA and course requirements set by the department. Check the department's ICT page and meet with an advisor.</p>
    </div>` : ''}

    <div class="row" style="margin-bottom:10px">
      <div class="legend"><span><i style="background:var(--navy-2)"></i>Required</span><span><i style="background:var(--orange)"></i>Major elective</span><span><i style="background:#8a5cd1"></i>Gen Ed</span><span><i style="background:var(--muted)"></i>Free elective</span></div>
      <span class="spacer"></span>
      <button class="btn" id="plan-next">Plan ${esc(r.terms[0]?.name || 'next semester')} in the scheduler →</button>
    </div>
    <div class="terms">
      ${r.terms.map((t, i) => `
        <div class="term ${i === 0 ? 'next' : ''}">
          <div class="term-head"><b>${esc(t.name)}</b><span class="muted small">${t.credits} cr${i === 0 ? ' · registering now' : ''}</span></div>
          ${t.courses.map((c) => `
            <div class="course-pill ${c.kind}" ${c.code ? `data-course="${esc(c.code)}"` : ''} title="${esc(c.prereqText ? 'Prereq: ' + c.prereqText : c.title)}">
              <b>${esc(c.code || '')}</b> ${c.code ? esc(c.suggestion || c.title || '') : `<span>${esc(c.title)}</span>`}
              ${c.options ? `<div class="why">or ${c.options.filter((o) => o !== c.code).slice(0, 4).map(esc).join(', ')}</div>` : ''}
              ${c.code && c.kind !== 'required' ? `<div class="why">for: ${esc(c.title)}${c.why ? ` — ${esc(c.why)}` : ''}${c.by === 'grok' ? ' ✨' : ''}</div>` : ''}
            </div>`).join('') || '<div class="muted small">Light term: room for electives, research or internships.</div>'}
        </div>`).join('')}
    </div>

    <div class="grid2" style="margin-top:14px">
      <div class="panel">
        <h3>Advice ${r.ai ? 'from Grok ✨' : ''}</h3>
        ${r.advice.length ? `<ul>${r.advice.map((a) => `<li>${md(a).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul>` : '<p class="muted">—</p>'}
      </div>
      <div class="panel">
        <h3>Elective options</h3>
        ${r.pools.length ? r.pools.map((p) => `
          <details><summary><b>${esc(p.heading)}</b> <span class="muted small">${p.count} courses${p.hours ? ` · ${esc(p.hours)} hrs` : ''}</span></summary>
            <div class="chips" style="margin-top:6px">${p.options.map((o) => `<span class="chip click" data-course="${esc(o.code)}" title="${esc(o.title)}">${esc(o.code)} ${o.gpa ? gpaHtml(o.gpa) : ''}</span>`).join('')}</div>
          </details>`).join('') : '<p class="muted small">No elective lists found on the catalog page.</p>'}
      </div>
    </div>
    <p class="muted small" style="margin-top:12px">Built from the official <a href="${esc(r.program.url)}" target="_blank" rel="noopener">catalog page</a> and Course Explorer. Course offerings for future terms are estimated. Always confirm with your advisor and your DARS audit.</p>`;

  body.querySelectorAll('[data-course]').forEach((el) => el.addEventListener('click', () => openCourse(el.dataset.course)));
  body.querySelector('#plan-next').addEventListener('click', () => {
    const codes = (r.terms[0]?.courses || []).filter((c) => c.code && c.kind === 'required').map((c) => c.code);
    store.emit('planner-set-courses', codes);
    switchTab('planner');
    toast(`Loaded ${codes.length} required courses for ${r.terms[0].name}. Add gen eds/electives, then Generate.`);
  });
}
