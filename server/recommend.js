// "Recommend my schedule": turns the student's roadmap + degree audit into a full-time
// schedule request (required courses for next term, pulled-forward courses if there's room,
// then gen-ed slots for unmet categories) and generates ranked schedules from it.
// Used by the planner's text box, the Recommend button, and the Grok chat agent, so every
// path gives the same, degree-aware answer.
import { buildRoadmap } from './roadmap.js';
import { getCourse, normalizeCode } from './courseExplorer.js';
import { checkPrereqs } from './eligibility.js';
import { generateSchedules } from './scheduler.js';
import { termLabel } from './config.js';

const GENED_FROM_TITLE = [
  [/advanced comp/i, { category: 'ACP' }],
  [/non-?western/i, { category: 'CS', sub: 'NW' }],
  [/minority/i, { category: 'CS', sub: 'US' }],
  [/western|comparative/i, { category: 'CS', sub: 'WCC' }],
  [/humanit|literature|the arts/i, { category: 'HUM' }],
  [/social|behavioral/i, { category: 'SBS' }],
  [/natural sci|life sci|physical sci/i, { category: 'NAT' }],
  [/quantitative/i, { category: 'QR' }],
];

export const wantsRecommendation = (text = '') =>
  /recommend|suggest|ideal|best schedule|what should i take|what (classes|courses) should|plan (my|out)|build (me )?(a|my) schedule|make (me )?(a|my) schedule|for me/i.test(text);

function unmetGenEds(profile, plan) {
  const out = [];
  const add = (spec) => { if (!out.some((g) => g.category === spec.category && (g.sub || '') === (spec.sub || ''))) out.push(spec); };
  for (const r of profile.audit?.requirements || []) {
    if (r.status !== 'incomplete') continue;
    for (const [re, spec] of GENED_FROM_TITLE) if (re.test(r.title)) { add(spec); break; }
  }
  for (const c of plan.terms[0]?.courses || []) {
    if (c.kind !== 'gened' || c.code) continue;
    for (const [re, spec] of GENED_FROM_TITLE) if (re.test(c.title)) { add(spec); break; }
  }
  for (const d of ['HUM', 'SBS', 'NAT']) add({ category: d }); // sensible defaults
  return out;
}

/** Build a full-time schedule request from the student's degree plan. */
export async function recommendRequest(profile = {}, { targetCredits, extraCourses = [], avoidCourses = [] } = {}) {
  if (!profile.major) throw new Error('Set your major in your profile so I can recommend courses.');
  const target = targetCredits || Math.min(Math.max(Number(profile.maxCredits) || 15, 12), 17);
  const plan = await buildRoadmap(profile, { ai: false });
  if (plan.error) throw new Error(plan.error);

  const done = [...(profile.completed || []), ...(profile.audit?.completed || []), ...(profile.audit?.inProgress || [])];
  const avoid = new Set(avoidCourses.map(normalizeCode));
  const picked = [];
  const notes = [];
  const fullCourses = [];
  let credits = 0;

  const tryAdd = async (code, why, { checkPrereq = false } = {}) => {
    code = normalizeCode(String(code).split(' & ')[0]);
    if (!code || avoid.has(code) || picked.some((p) => p.code === code) || credits >= target) return;
    const course = await getCourse(code);
    if (!course) return;
    if (checkPrereq && checkPrereqs(course.prereqText || course.description, done).status === 'missing') return;
    if (course.sections.length && course.sections.every((s) => /closed/i.test(s.availability || ''))) {
      fullCourses.push(code);
      return;
    }
    const cr = course.credits.min || course.credits.max || 3;
    if (credits + cr > target + 2) return;
    picked.push({ code, why, credits: cr });
    credits += cr;
  };

  for (const code of extraCourses) await tryAdd(code, 'you asked for it');
  // 1) what the roadmap schedules for next term (required first, then picked electives)
  const next = plan.terms[0]?.courses || [];
  for (const c of next.filter((x) => x.code && x.kind === 'required')) await tryAdd(c.code, 'required, planned for this term');
  for (const c of next.filter((x) => x.code && x.kind !== 'required')) await tryAdd(c.code, c.kind === 'gened' ? 'gen ed' : 'elective for your career goals');
  // 2) pull required courses forward from later terms if prerequisites are already met
  for (const t of plan.terms.slice(1)) {
    for (const c of t.courses.filter((x) => x.code && x.kind === 'required')) await tryAdd(c.code, `required (pulled forward from ${t.name})`, { checkPrereq: true });
  }
  // 3) audit requirements with specific course options
  for (const r of profile.audit?.requirements || []) {
    if (r.status !== 'incomplete') continue;
    for (const o of r.options || []) await tryAdd(o, `audit: ${r.title}`, { checkPrereq: true });
  }
  // 4) fill the rest with gen eds the student still needs
  const genEds = [];
  for (const g of unmetGenEds(profile, plan)) {
    if (credits >= target - 1 || genEds.length >= 3) break;
    genEds.push({ ...g, count: 1 });
    credits += 3;
  }
  if (fullCourses.length) notes.push(`${fullCourses.join(', ')} ${fullCourses.length > 1 ? 'are' : 'is'} full right now, so I left ${fullCourses.length > 1 ? 'them' : 'it'} out. Open the course and click Watch to get a seat alert.`);
  if (credits < 12) notes.push(`Only about ${credits} credits fit from your plan. Add electives to reach full-time (12+).`);

  return {
    request: { courses: picked.map((p) => p.code), genEds, groups: [], constraints: {}, prefs: {} },
    info: { term: termLabel(), program: plan.program.title, estCredits: credits, target, picks: picked, genEds, notes, fullCourses, auditUsed: Boolean(profile.audit) },
  };
}

/** Recommend + generate, retrying once without any course that blocks every schedule. */
export async function recommendSchedules(profile, opts = {}) {
  const { request, info } = await recommendRequest(profile, opts);
  const full = { ...request, constraints: { ...(opts.constraints || {}) }, weights: opts.weights, prefs: opts.prefs || {}, profile, limit: 40 };
  let result = await generateSchedules(full);
  if (!result.schedules.length) {
    const blocking = new Set(result.diagnostics.filter((d) => /No section/.test(d.message)).map((d) => d.slot));
    if (blocking.size) {
      full.courses = full.courses.filter((c) => !blocking.has(c));
      full.genEds = [...full.genEds, ...[...blocking].slice(0, 2).map(() => ({ category: 'HUM', count: 1 }))];
      info.notes.push(`Dropped ${[...blocking].join(', ')} because no section fits; added gen ed slots instead.`);
      result = await generateSchedules(full);
    }
  }
  return { request: { ...full, profile: undefined }, info, ...result };
}
