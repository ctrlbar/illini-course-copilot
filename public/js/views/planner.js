// Schedule Planner: build a request (natural language or form), generate ranked schedules,
// and view each one on a weekly calendar with score breakdown, sections, and backup plans.
import { api, store, esc, fmtTime, parseTimeInput, DAY_NAMES, COLORS, availTag, availLevel, gpaHtml, toast, download, profile, load, persist } from '../lib.js';
import { openCourse, watchSection } from './course.js';

const DAYS = ['M', 'T', 'W', 'R', 'F'];
let root;
let req;

const defaultReq = () => ({
  courses: [], genEds: [], groups: [],
  constraints: { earliestStart: null, latestEnd: null, daysOff: [], blocked: [], onlyOpen: false, avoidRestricted: true },
  weights: { ...store.meta.weights },
  prefs: { preferMornings: false },
});

export function initPlanner(el) {
  root = el;
  req = { ...defaultReq(), ...load('icc.plannerReq', {}) };
  req.weights = { ...store.meta.weights, ...(req.weights || {}) };
  root.innerHTML = `
    <div class="planner">
      <div class="panel builder" id="builder"></div>
      <div id="results"></div>
    </div>`;
  renderBuilder();
  renderResults();
  store.on('planner-add-course', (code) => { if (!req.courses.includes(code)) req.courses.push(code); save(); renderBuilder(); toast(`${code} added to planner`, 'ok'); });
  store.on('planner-load', ({ request, result }) => {
    req = { ...defaultReq(), ...request, constraints: { ...defaultReq().constraints, ...(request.constraints || {}), ...(result.constraints || {}) }, weights: { ...store.meta.weights, ...(request.weights || {}) } };
    delete req.profile;
    save(); renderBuilder();
    store.planner = { request, result, selected: 0, pinned: [] };
    renderResults();
  });
  store.on('planner-set-courses', (codes) => { req.courses = [...new Set(codes)]; save(); renderBuilder(); });
}

const save = () => persist('icc.plannerReq', { ...req, profile: undefined });
const timeVal = (m) => (m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);

// ------------------------------------------------------------------ builder
function renderBuilder() {
  const cats = store.meta.genEdCategories;
  const b = root.querySelector('#builder');
  b.innerHTML = `
    <button class="btn primary" id="recommend" style="width:100%;justify-content:center;margin-bottom:6px">🎯 Recommend my ${esc(store.meta.termLabel)} schedule</button>
    <div class="muted small" style="margin-bottom:12px">Builds a full-time schedule from your degree roadmap${store.profile?.audit ? ' and degree audit' : ''}, then ranks every valid combination.</div>
    <h3>Describe your ideal schedule</h3>
    <div class="nl-box">
      <textarea id="nl" placeholder="e.g. I need CS 225, MATH 241 and a humanities gen ed. Nothing before 10am, Fridays free."></textarea>
      <div class="row" style="margin-top:6px">
        <button class="btn" id="nl-go">✨ Understand${store.meta.grok ? ' with Grok' : ''}</button>
        <span class="muted small">fills in the form below</span>
      </div>
    </div>

    <h3>Courses</h3>
    <div class="chip-input" id="course-chips">
      ${req.courses.map((c, i) => `<span class="chip">${esc(c)}<button data-rm-course="${i}">×</button></span>`).join('')}
      <input id="course-add" placeholder="Add course, e.g. CS 225" />
    </div>
    ${req.groups.map((g, i) => `<div class="chip" style="margin-top:6px">One of: ${g.options.map(esc).join(' / ')} <button data-rm-group="${i}">×</button></div>`).join('')}
    <div class="row small" style="margin-top:4px"><a href="#" id="add-group">+ "one of these" group</a></div>

    <h3>Gen Ed slots</h3>
    <div class="geneds-list">
      ${req.genEds.map((g, i) => `
        <div class="row">
          <select data-ge-cat="${i}">${Object.entries(cats).map(([k, v]) => `<option value="${k}" ${g.category === k ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>
          <select data-ge-sub="${i}"><option value="">Any</option>${Object.entries(cats[g.category]?.subs || {}).map(([k, v]) => `<option value="${k}" ${g.sub === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
          <button class="btn sm ghost" data-rm-ge="${i}">×</button>
        </div>`).join('')}
      <button class="btn sm" id="add-ge">+ Add gen ed</button>
      <div class="muted small" style="margin-top:4px">Picks eligible courses that fit your schedule, favoring high GPA and courses that count for 2+ gen eds.</div>
    </div>

    <h3>Constraints</h3>
    <div class="grid2">
      <label>No class before<input type="time" id="c-start" value="${timeVal(req.constraints.earliestStart)}" step="1800" /></label>
      <label>No class after<input type="time" id="c-end" value="${timeVal(req.constraints.latestEnd)}" step="1800" /></label>
    </div>
    <label>Days off</label>
    <div class="days">${DAYS.map((d) => `<label><input type="checkbox" data-dayoff="${d}" ${req.constraints.daysOff.includes(d) ? 'checked' : ''}/><span>${DAY_NAMES[d]}</span></label>`).join('')}</div>
    <div class="blocked-list" style="margin-top:10px">
      <label>Blocked times (work, practice, RSO…)</label>
      ${req.constraints.blocked.map((x, i) => `
        <div class="row">
          <input value="${esc(x.label)}" data-bl-label="${i}" placeholder="label" style="max-width:90px" />
          <input value="${x.days.join('')}" data-bl-days="${i}" placeholder="TR" style="max-width:56px" />
          <input type="time" value="${timeVal(x.start)}" data-bl-start="${i}" />
          <input type="time" value="${timeVal(x.end)}" data-bl-end="${i}" />
          <button class="btn sm ghost" data-rm-bl="${i}">×</button>
        </div>`).join('')}
      <button class="btn sm" id="add-bl">+ Block a time</button>
    </div>
    <label class="check" style="margin-top:10px"><input type="checkbox" id="c-open" ${req.constraints.onlyOpen ? 'checked' : ''}/> Only sections with open seats</label>
    <label class="check"><input type="checkbox" id="c-restr" ${req.constraints.avoidRestricted !== false ? 'checked' : ''}/> Hide sections restricted for my major/year</label>

    <h3>What matters to you?</h3>
    ${Object.entries(store.meta.weightLabels).map(([k, label]) => `
      <div class="slider-row"><span>${esc(label)}</span><input type="range" min="0" max="3" step="0.5" value="${req.weights[k] ?? 1}" data-w="${k}" /><span id="wv-${k}">${req.weights[k] ?? 1}</span></div>`).join('')}
    <label class="check" style="margin-top:6px"><input type="checkbox" id="p-morning" ${req.prefs.preferMornings ? 'checked' : ''}/> I'm a morning person (prefer early classes)</label>

    <div class="row" style="margin-top:14px">
      <button class="btn primary" id="generate" style="flex:1;justify-content:center">Generate schedules</button>
      <button class="btn ghost" id="reset" title="Clear the form">Reset</button>
    </div>`;

  const $ = (s) => b.querySelector(s);
  const $$ = (s) => b.querySelectorAll(s);

  $('#nl-go').addEventListener('click', async () => {
    const text = $('#nl').value.trim();
    if (!text) return;
    $('#nl-go').disabled = true;
    $('#nl-go').innerHTML = '<span class="spinner"></span> Reading…';
    try {
      const parsed = await api('/api/schedules/parse', { method: 'POST', body: { text, profile: profile() } });
      if (parsed.recommended) {
        req.courses = [];
        store.planner.info = parsed.info;
      }
      req.courses = [...new Set([...req.courses, ...(parsed.courses || [])])];
      if (parsed.genEds?.length) req.genEds = parsed.genEds.map((g) => ({ category: g.category, sub: g.sub || '', count: g.count || 1 }));
      if (parsed.groups?.length) req.groups = parsed.groups;
      req.constraints = { ...req.constraints, ...Object.fromEntries(Object.entries(parsed.constraints || {}).filter(([, v]) => v != null)) };
      if (parsed.weights) req.weights = { ...req.weights, ...parsed.weights };
      if (parsed.prefs) req.prefs = { ...req.prefs, ...parsed.prefs };
      save(); renderBuilder();
      toast(`Understood via ${parsed.parser === 'grok' ? 'Grok' : 'rules'} — generating…`);
      generate();
    } catch (e) { toast(esc(e.message), 'bad'); renderBuilder(); }
  });

  const addCourse = (val) => {
    const codes = (val.toUpperCase().match(/[A-Z]{2,4}\s?\d{3}/g) || []).map((c) => c.replace(/([A-Z]+)\s?(\d+)/, '$1 $2'));
    codes.forEach((c) => { if (!req.courses.includes(c)) req.courses.push(c); });
    save(); renderBuilder(); root.querySelector('#course-add').focus();
  };
  $('#course-add').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addCourse(e.target.value); } });
  $('#course-add').addEventListener('blur', (e) => { if (e.target.value.trim()) addCourse(e.target.value); });
  $$('[data-rm-course]').forEach((x) => x.addEventListener('click', () => { req.courses.splice(+x.dataset.rmCourse, 1); save(); renderBuilder(); }));
  $$('[data-rm-group]').forEach((x) => x.addEventListener('click', () => { req.groups.splice(+x.dataset.rmGroup, 1); save(); renderBuilder(); }));
  $('#add-group').addEventListener('click', (e) => {
    e.preventDefault();
    const v = prompt('Courses you would take ONE of (comma separated), e.g. STAT 200, STAT 212, CS 361');
    const opts = (v || '').toUpperCase().match(/[A-Z]{2,4}\s?\d{3}/g)?.map((c) => c.replace(/([A-Z]+)\s?(\d+)/, '$1 $2'));
    if (opts?.length > 1) { req.groups.push({ options: opts }); save(); renderBuilder(); }
  });
  $('#add-ge').addEventListener('click', () => { req.genEds.push({ category: 'HUM', sub: '', count: 1 }); save(); renderBuilder(); });
  $$('[data-ge-cat]').forEach((x) => x.addEventListener('change', () => { req.genEds[+x.dataset.geCat] = { category: x.value, sub: '', count: 1 }; save(); renderBuilder(); }));
  $$('[data-ge-sub]').forEach((x) => x.addEventListener('change', () => { req.genEds[+x.dataset.geSub].sub = x.value; save(); }));
  $$('[data-rm-ge]').forEach((x) => x.addEventListener('click', () => { req.genEds.splice(+x.dataset.rmGe, 1); save(); renderBuilder(); }));
  $('#c-start').addEventListener('change', (e) => { req.constraints.earliestStart = parseTimeInput(e.target.value); save(); });
  $('#c-end').addEventListener('change', (e) => { req.constraints.latestEnd = parseTimeInput(e.target.value); save(); });
  $$('[data-dayoff]').forEach((x) => x.addEventListener('change', () => {
    req.constraints.daysOff = [...$$('[data-dayoff]')].filter((c) => c.checked).map((c) => c.dataset.dayoff); save();
  }));
  $('#add-bl').addEventListener('click', () => { req.constraints.blocked.push({ label: 'Work', days: ['T', 'R'], start: 780, end: 900 }); save(); renderBuilder(); });
  $$('[data-rm-bl]').forEach((x) => x.addEventListener('click', () => { req.constraints.blocked.splice(+x.dataset.rmBl, 1); save(); renderBuilder(); }));
  const blUpdate = (attr, fn) => $$(`[data-bl-${attr}]`).forEach((x) => x.addEventListener('change', () => { fn(req.constraints.blocked[+x.getAttribute(`data-bl-${attr}`)], x.value); save(); }));
  blUpdate('label', (o, v) => { o.label = v; });
  blUpdate('days', (o, v) => { o.days = (v.toUpperCase().match(/[MTWRF]/g) || []); });
  blUpdate('start', (o, v) => { o.start = parseTimeInput(v); });
  blUpdate('end', (o, v) => { o.end = parseTimeInput(v); });
  $('#c-open').addEventListener('change', (e) => { req.constraints.onlyOpen = e.target.checked; save(); });
  $('#c-restr').addEventListener('change', (e) => { req.constraints.avoidRestricted = e.target.checked; save(); });
  $$('[data-w]').forEach((x) => x.addEventListener('input', () => { req.weights[x.dataset.w] = Number(x.value); root.querySelector(`#wv-${x.dataset.w}`).textContent = x.value; save(); }));
  $('#p-morning').addEventListener('change', (e) => { req.prefs.preferMornings = e.target.checked; save(); });
  $('#generate').addEventListener('click', generate);
  $('#recommend').addEventListener('click', recommend);
  $('#reset').addEventListener('click', () => { req = defaultReq(); store.planner.info = null; save(); renderBuilder(); });
}

async function recommend() {
  if (!store.profile?.major) { toast('Set up your profile (major + completed courses) first', 'bad'); document.getElementById('profile-btn').click(); return; }
  const btn = root.querySelector('#recommend');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Reading your degree plan…';
  root.querySelector('#results').innerHTML = `<div class="panel empty"><span class="spinner"></span><p>Picking the courses you still need for ${esc(store.meta.termLabel)}, then checking every section combination…</p></div>`;
  try {
    const r = await api('/api/schedules/recommend', { method: 'POST', body: { profile: profile(), constraints: req.constraints, weights: req.weights, prefs: req.prefs } });
    req.courses = r.request.courses;
    req.genEds = r.request.genEds.map((g) => ({ category: g.category, sub: g.sub || '', count: 1 }));
    save(); renderBuilder();
    store.planner = { request: r.request, result: r, selected: 0, pinned: [], info: r.info };
    renderResults();
  } catch (e) {
    root.querySelector('#results').innerHTML = `<div class="banner bad">${esc(e.message)}</div>`;
    renderBuilder();
  }
}

async function generate() {
  if (!req.courses.length && !req.genEds.length && !req.groups.length) { toast('Add at least one course or gen ed', 'bad'); return; }
  const btn = root.querySelector('#generate');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Searching every combination…';
  root.querySelector('#results').innerHTML = `<div class="panel empty"><span class="spinner"></span><p>Checking sections, linked labs/discussions, restrictions and live seats…</p></div>`;
  try {
    const body = { ...req, profile: profile(), limit: 40 };
    const result = await api('/api/schedules', { method: 'POST', body });
    store.planner = { request: body, result, selected: 0, pinned: [], info: store.planner.info };
    if (result.constraints) {
      // reflect any constraint the server had to ignore (e.g. an impossible start time)
      req.constraints = { ...req.constraints, earliestStart: result.constraints.earliestStart, latestEnd: result.constraints.latestEnd };
      save(); renderBuilder();
    }
    renderResults();
  } catch (e) {
    root.querySelector('#results').innerHTML = `<div class="banner bad">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Generate schedules';
  }
}

// ------------------------------------------------------------------ results
function courseColors(schedule) {
  const map = {};
  (schedule?.bundles || []).forEach((b, i) => { map[b.courseCode] = COLORS[i % COLORS.length]; });
  return map;
}

export function renderCalendar(schedule, { compact = false, blocked = [] } = {}) {
  const colors = courseColors(schedule);
  const meetings = schedule.bundles.flatMap((b) => b.sections.flatMap((s) => s.meetings.map((m) => ({ ...m, b, s }))));
  const timed = meetings.filter((m) => m.start != null && m.days.length);
  const online = schedule.bundles.flatMap((b) => b.sections.filter((s) => s.meetings.every((m) => m.start == null)).map((s) => `${b.courseCode} ${s.number} (${s.type})`));
  const starts = [...timed.map((m) => m.start), ...blocked.map((x) => x.start)];
  const ends = [...timed.map((m) => m.end), ...blocked.map((x) => x.end)];
  const startH = Math.min(8, Math.floor(Math.min(...starts, 600) / 60));
  const endH = Math.max(17, Math.ceil(Math.max(...ends, 1020) / 60));
  const ppm = compact ? 0.55 : 0.9; // pixels per minute
  const height = (endH - startH) * 60 * ppm;
  const y = (m) => (m - startH * 60) * ppm;

  const hours = [];
  for (let h = startH; h <= endH; h++) hours.push(h);
  const col = (d) => {
    const blocks = timed.filter((m) => m.days.includes(d)).map((m) => {
      const lvl = availLevel(m.s.availability);
      const ins = m.instructors?.map((i) => i.name).join(', ');
      const pot = m.s.partOfTerm === 'A' ? '1st 8wk' : m.s.partOfTerm === 'B' ? '2nd 8wk' : '';
      return `<div class="cal-block ${lvl === 'closed' ? 'closed' : ''}" style="top:${y(m.start)}px;height:${Math.max((m.end - m.start) * ppm, 14)}px;background:${colors[m.b.courseCode]}"
        title="${esc(`${m.b.courseCode} ${m.s.number} · ${m.s.type}\n${fmtTime(m.start)}–${fmtTime(m.end)}\n${m.room} ${m.building}\n${ins || ''}\nCRN ${m.s.crn} · ${m.s.availability}`)}">
        ${pot ? `<span class="pot">${pot}</span>` : ''}
        <b>${esc(m.b.courseCode)}</b>${compact ? '' : `${esc(m.s.number)} · ${esc(m.typeCode || m.s.typeCode)}<br>${fmtTime(m.start)}–${fmtTime(m.end)}<br>${esc(m.building)}`}
      </div>`;
    }).join('');
    const blk = blocked.filter((x) => x.days.includes(d) && x.start != null && x.end != null)
      .map((x) => `<div class="cal-block blocked" style="top:${y(x.start)}px;height:${(x.end - x.start) * ppm}px">${esc(x.label || 'Blocked')}</div>`).join('');
    return `<div class="cal-col" style="height:${height}px">${hours.map((h) => `<div class="hour-line" style="top:${y(h * 60)}px"></div>`).join('')}${blk}${blocks}</div>`;
  };
  return `
    <div class="calendar ${compact ? 'compact' : ''}">
      <div class="cal-head"></div>${DAYS.map((d) => `<div class="cal-head">${DAY_NAMES[d]}</div>`).join('')}
      <div class="cal-times" style="height:${height}px">${hours.map((h) => `<div class="hour-label" style="top:${y(h * 60)}px">${fmtTime(h * 60).replace(':00', '')}</div>`).join('')}</div>
      ${DAYS.map(col).join('')}
      ${online.length ? `<div class="cal-online">🖥 Online / no set meeting time: ${online.map(esc).join(', ')}</div>` : ''}
    </div>`;
}

function scoreRing(score) { return `<div class="score-ring" style="--p:${score}"><span>${Math.round(score)}</span></div>`; }

function renderResults() {
  const box = root.querySelector('#results');
  const { result, selected, pinned } = store.planner;
  if (!result) {
    box.innerHTML = `<div class="panel empty"><div class="big">🗓️</div><h2>Build your perfect week</h2>
      <p>Add courses and gen eds, set your constraints, and the planner checks <b>every</b> valid combination of lectures,
      discussions and labs, then ranks them by what matters to you.</p>
      <p class="small">Tip: try typing “I need CS 225, MATH 241 and a humanities gen ed, nothing before 10am” in the box on the left.</p></div>`;
    return;
  }
  const diag = (result.diagnostics || []).map((d) => `
    <div class="banner ${result.schedules.length ? 'info' : 'bad'} small"><b>${esc(d.slot)}:</b> ${esc(d.message)}${Object.keys(d.dropped || {}).length ? ` (removed: ${Object.entries(d.dropped).map(([k, v]) => `${v} × ${esc(k)}`).join(', ')})` : ''}</div>`).join('');
  const errs = (result.errors || []).map((e) => `<div class="banner bad small">${esc(e)}</div>`).join('')
    + (result.warnings || []).map((w) => `<div class="banner warn small">⚠ ${esc(w)}</div>`).join('');
  const missing = Object.entries(result.eligibility || {}).filter(([, v]) => v.status === 'missing')
    .map(([k, v]) => `<div class="banner warn small"><b>${esc(k)}:</b> ${esc(v.reasons.join('; '))} — based on your profile's completed courses.</div>`).join('');

  if (!result.schedules.length) {
    box.innerHTML = `<div class="panel"><h2>No schedule fits all of that 😕</h2><p class="muted">Here's what got in the way. Try relaxing a constraint.</p>${errs}${diag}${missing}</div>`;
    return;
  }
  const s = result.schedules[selected] || result.schedules[0];
  const info = store.planner.info || result.info;
  const infoHtml = info ? `
    <div class="panel" style="margin-bottom:12px">
      <h3>Why these courses <span class="tag orange">from your ${info.auditUsed ? 'degree audit + ' : ''}roadmap</span></h3>
      <ul class="small" style="margin:0;padding-left:18px">
        ${info.picks.map((p) => `<li><a href="#" data-course="${esc(p.code)}"><b>${esc(p.code)}</b></a> (${p.credits} cr): ${esc(p.why)}</li>`).join('')}
        ${info.genEds.map((g) => `<li><b>${esc(store.meta.genEdCategories[g.category]?.subs?.[g.sub] || store.meta.genEdCategories[g.category]?.name || g.category)} gen ed</b> (3 cr): picked to fit your week, favoring high GPA</li>`).join('')}
      </ul>
      ${info.notes.map((n) => `<div class="banner warn small">${esc(n)}</div>`).join('')}
    </div>` : '';
  box.innerHTML = `${infoHtml}
    <div class="results-head">
      <h2 style="margin:0">${result.total.toLocaleString()}${result.truncated ? '+' : ''} valid schedules</h2>
      <span class="muted small">ranked by your preferences · ${result.ms} ms</span>
      <span class="spacer"></span>
      ${pinned.length ? `<button class="btn sm" id="compare-clear">Clear compare (${pinned.length})</button>` : ''}
    </div>
    ${errs}${missing}
    <details ${result.schedules.length ? '' : 'open'}><summary class="small muted">How the options were filtered</summary>${diag || '<p class="small muted">Nothing was filtered out.</p>'}</details>
    ${pinned.length === 2 ? renderCompare(pinned.map((i) => result.schedules[i])) : ''}
    <div class="results" style="margin-top:10px">
      <div class="rank-list">${result.schedules.map((x, i) => `
        <div class="rank-card ${i === selected ? 'active' : ''}" data-sel="${i}">
          ${scoreRing(x.score)}
          <div>
            <div class="row"><b>#${x.rank}</b> <span class="meta">${x.credits} cr</span><span class="spacer"></span>
              <span class="pin">${pinned.includes(i) ? '📌' : ''}</span></div>
            <div class="meta">${esc(x.highlights.slice(0, 2).join(' · ') || x.bundles.map((b) => b.courseCode).join(', '))}</div>
            <div class="mini-days">${DAYS.map((d) => `<i class="${x.bundles.some((b) => b.sections.some((sec) => sec.meetings.some((m) => m.days.includes(d)))) ? 'on' : ''}" title="${DAY_NAMES[d]}"></i>`).join('')}</div>
          </div>
        </div>`).join('')}
      </div>
      <div class="detail">${renderDetail(s, selected)}</div>
    </div>`;

  box.querySelectorAll('.panel [data-course]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openCourse(a.dataset.course); }));
  box.querySelectorAll('[data-sel]').forEach((c) => c.addEventListener('click', () => { store.planner.selected = +c.dataset.sel; renderResults(); }));
  box.querySelector('#compare-clear')?.addEventListener('click', () => { store.planner.pinned = []; renderResults(); });
  wireDetail(box, s, selected);
}

function renderDetail(s, idx) {
  const colors = courseColors(s);
  const closed = s.bundles.flatMap((b) => b.sections.filter((x) => availLevel(x.availability) === 'closed').map((x) => ({ code: b.courseCode, crn: x.crn })));
  return `
    <div class="panel">
      <div class="detail-head">
        ${scoreRing(s.score)}
        <div>
          <h2 style="margin:0">Schedule #${s.rank} <span class="muted small">${s.credits} credit hours</span></h2>
          <div class="highlights">${s.highlights.map((h) => `<span class="tag ok">${esc(h)}</span>`).join('')}${s.warnings.map((w) => `<span class="tag warn" title="${esc(w)}">⚠ ${esc(w.length > 60 ? w.slice(0, 57) + '…' : w)}</span>`).join('')}</div>
        </div>
        <span class="spacer"></span>
        <div class="row">
          <button class="btn sm" id="copy-crns" title="${s.crns.join(', ')}">📋 Copy CRNs</button>
          <button class="btn sm" id="dl-ics">📅 Export .ics</button>
          <button class="btn sm" id="pin">${store.planner.pinned.includes(idx) ? '📌 Unpin' : '📌 Compare'}</button>
          ${closed.length ? `<button class="btn sm" id="watch-closed">🔔 Watch ${closed.length} closed</button>` : ''}
        </div>
      </div>
    </div>
    ${renderCalendar(s, { blocked: store.planner.request?.constraints?.blocked || [] })}
    <div class="panel">
      <h3>Why it ranks here</h3>
      <div class="breakdown">${Object.entries(s.components).filter(([, c]) => c.weight).map(([, c]) => `
        <div class="bar-row"><div class="row"><span>${esc(c.label)}</span><span class="spacer"></span><span class="muted">${esc(c.detail)}</span></div>
          <div class="bar"><i style="width:${Math.round(c.score * 100)}%"></i></div></div>`).join('')}
      </div>
    </div>
    <div class="panel">
      <h3>Sections to register for</h3>
      <div style="overflow:auto"><table>
        <thead><tr><th>Course</th><th>Section</th><th>CRN</th><th>When</th><th>Where</th><th>Instructor</th><th>Seats</th><th>GPA</th></tr></thead>
        <tbody>${s.bundles.map((b) => b.sections.map((x, i) => `
          <tr>
            ${i === 0 ? `<td rowspan="${b.sections.length}"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${colors[b.courseCode]}"></span>
              <a href="#" data-course="${esc(b.courseCode)}"><b>${esc(b.courseCode)}</b></a><div class="small muted">${esc(b.title)}</div>
              ${b.slot !== b.courseCode ? `<div class="small"><span class="tag orange">${esc(b.slot)}</span></div>` : ''}
              ${b.restriction === 'unknown' ? `<div class="small"><span class="tag warn" title="${esc(b.restrictionReasons.join('; '))}">check restriction</span></div>` : ''}</td>` : ''}
            <td>${esc(x.number)} <span class="muted small">${esc(x.type)}</span></td>
            <td><code>${x.crn}</code></td>
            <td class="small">${x.meetings.map((m) => (m.start == null ? 'Online / arranged' : `${m.days.join('')} ${m.startLabel}–${m.endLabel}`)).join('<br>')}</td>
            <td class="small">${x.meetings.map((m) => esc(`${m.room} ${m.building}`.trim() || '—')).join('<br>')}</td>
            <td class="small">${[...new Set(x.meetings.flatMap((m) => m.instructors.map((n) => n.name)))].map(esc).join(', ') || '—'}</td>
            <td>${availTag(x.availability)}</td>
            ${i === 0 ? `<td rowspan="${b.sections.length}">${b.gpa ? `${gpaHtml(b.gpa.avg)}<div class="small muted">${esc(b.gpa.source)}</div>` : '<span class="muted">n/a</span>'}</td>` : ''}
          </tr>`).join('')).join('')}
        </tbody></table></div>
    </div>
    ${s.backups.length ? `
    <div class="panel">
      <h3>Backup plan if a section fills up</h3>
      <table><thead><tr><th>Course</th><th>If this fills…</th><th>Switch to</th><th>CRNs</th><th>Effect</th></tr></thead>
      <tbody>${s.backups.map((x) => `<tr><td>${esc(x.courseCode)}</td><td>${esc(x.ifFull)}</td><td><b>${esc(x.switchTo)}</b></td><td><code>${x.crns.join(', ')}</code></td>
        <td class="small">${x.sameTime ? '<span class="tag ok">same time</span>' : x.scoreDelta >= 0 ? '<span class="tag ok">no change</span>' : `<span class="tag warn">score ${x.scoreDelta}</span>`}</td></tr>`).join('')}
      </tbody></table>
    </div>` : ''}`;
}

function wireDetail(box, s, idx) {
  box.querySelector('#copy-crns')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(s.crns.join(', ')); toast(`Copied ${s.crns.length} CRNs: ${s.crns.join(', ')}`, 'ok'); }
    catch { prompt('Copy these CRNs:', s.crns.join(', ')); }
  });
  box.querySelector('#dl-ics')?.addEventListener('click', () => download('/api/ics', { schedule: s }, `uiuc-schedule-${s.rank}.ics`));
  box.querySelector('#pin')?.addEventListener('click', () => {
    const p = store.planner.pinned;
    if (p.includes(idx)) p.splice(p.indexOf(idx), 1); else { p.push(idx); if (p.length > 2) p.shift(); }
    if (p.length === 1) toast('Pinned. Pin one more schedule to compare side by side.');
    renderResults();
  });
  box.querySelector('#watch-closed')?.addEventListener('click', async () => {
    for (const b of s.bundles) for (const x of b.sections) if (availLevel(x.availability) === 'closed') await watchSection(b.courseCode, x.crn);
  });
  box.querySelectorAll('[data-course]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openCourse(a.dataset.course); }));
}

function renderCompare([a, b]) {
  const keys = Object.keys(a.components).filter((k) => a.components[k].weight);
  return `
    <div class="panel" style="margin-top:10px">
      <h3>Side-by-side: #${a.rank} vs #${b.rank}</h3>
      <div class="compare">
        ${[a, b].map((s) => `<div><div class="row" style="margin-bottom:6px">${scoreRing(s.score)}<b>#${s.rank}</b><span class="muted small">${s.highlights.join(' · ')}</span></div>${renderCalendar(s, { compact: true })}</div>`).join('')}
      </div>
      <table style="margin-top:10px"><thead><tr><th></th><th>#${a.rank}</th><th>#${b.rank}</th></tr></thead><tbody>
        ${keys.map((k) => `<tr><td>${esc(a.components[k].label)}</td>
          <td ${a.components[k].score > b.components[k].score ? 'style="font-weight:600"' : ''}>${esc(a.components[k].detail)}</td>
          <td ${b.components[k].score > a.components[k].score ? 'style="font-weight:600"' : ''}>${esc(b.components[k].detail)}</td></tr>`).join('')}
      </tbody></table>
    </div>`;
}
