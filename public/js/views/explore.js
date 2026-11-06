// Explore: search every course offered this term, filter by gen ed / level / GPA.
import { api, store, esc, gpaHtml, genEdTags } from '../lib.js';
import { openCourse } from './course.js';

let root, timer;

export function initExplore(el) {
  root = el;
  const cats = store.meta.genEdCategories;
  root.innerHTML = `
    <div class="search-bar">
      <input id="q" placeholder="Search by code, title or topic (e.g. 'machine learning', 'CS 4', 'astronomy')" />
      <select id="ge"><option value="">Any gen ed</option>${Object.entries(cats).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('')}</select>
      <select id="sub"><option value="">Any sub-category</option></select>
      <select id="level"><option value="">Any level</option><option>100</option><option>200</option><option>300</option><option>400</option></select>
      <select id="gpa"><option value="">Any GPA</option><option value="3.0">GPA ≥ 3.0</option><option value="3.3">GPA ≥ 3.3</option><option value="3.5">GPA ≥ 3.5</option><option value="3.7">GPA ≥ 3.7</option></select>
    </div>
    <div class="muted small" id="count" style="margin-bottom:8px"></div>
    <div class="cards" id="cards"></div>`;
  const $ = (s) => root.querySelector(s);
  $('#ge').addEventListener('change', () => {
    const subs = cats[$('#ge').value]?.subs || {};
    $('#sub').innerHTML = '<option value="">Any sub-category</option>' + Object.entries(subs).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    search();
  });
  ['#sub', '#level', '#gpa'].forEach((s) => $(s).addEventListener('change', search));
  $('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
  $('#cards').addEventListener('click', (e) => { const c = e.target.closest('[data-course]'); if (c) openCourse(c.dataset.course); });
  search();
}

async function search() {
  const $ = (s) => root.querySelector(s);
  const params = new URLSearchParams();
  if ($('#q').value.trim()) params.set('q', $('#q').value.trim());
  if ($('#ge').value) params.set('genEd', $('#ge').value);
  if ($('#sub').value) params.set('sub', $('#sub').value);
  if ($('#level').value) params.set('level', $('#level').value);
  if ($('#gpa').value) params.set('minGpa', $('#gpa').value);
  params.set('limit', '60');
  $('#count').innerHTML = '<span class="spinner"></span> Searching… (the first search builds the course index, ~20 s)';
  try {
    const { total, results } = await api(`/api/search?${params}`);
    $('#count').textContent = `${total.toLocaleString()} courses match${total > results.length ? ` · showing top ${results.length}` : ''}. Click a course for sections, seats, prerequisites and grade distributions.`;
    $('#cards').innerHTML = results.map((r) => `
      <div class="course-card" data-course="${esc(r.code)}">
        <div class="row"><span class="code">${esc(r.code)}</span><span class="spacer"></span>${r.gpa != null ? `<span class="small muted">avg</span> ${gpaHtml(r.gpa)}` : ''}</div>
        <div>${esc(r.title)}</div>
        <div class="small muted">${esc(r.subjectName)}</div>
        <div style="margin-top:6px">${genEdTags(r.genEds)}</div>
      </div>`).join('') || '<div class="empty">No courses found.</div>';
  } catch (e) { $('#count').textContent = e.message; }
}
