// Degree roadmap: semester-by-semester plan from now to graduation.
//  1. Requirements + recommended sequence come from the official catalog page for the major
//     (or the intended major, for students planning to transfer majors).
//  2. Prerequisite chains come from Course Explorer, so courses are never planned before their prereqs.
//  3. The first semester only includes courses actually offered in the term being registered for.
//  4. Grok picks electives that fit the student's career goal and writes advice (rule-based fallback otherwise).
import { config, termLabel } from './config.js';
import { findProgram, getProgram } from './catalog.js';
import { getCatalogCourse, getCourse, normalizeCode } from './courseExplorer.js';
import { parsePrereqs } from './eligibility.js';
import { genEdCourses, genEdCount, courseGpa } from './datasets.js';
import { mapLimit } from './http.js';
import { grokEnabled, askJson } from './grok.js';
import { neededCount } from './audit.js';

const STANDING_BASE = { freshman: 1, sophomore: 3, junior: 5, senior: 7 };

function termSequence(startSeason, startYear, gradTerm, includeSummer) {
  const out = [];
  let season = startSeason, year = Number(startYear);
  const [gSeason, gYear] = gradTerm ? gradTerm.toLowerCase().split(/\s+/) : [null, null];
  for (let i = 0; i < 16; i++) {
    if (season !== 'summer' || includeSummer) out.push({ season, year, name: `${season[0].toUpperCase()}${season.slice(1)} ${year}` });
    if (gSeason && season === gSeason && year === Number(gYear)) break;
    if (season === 'spring') season = 'summer';
    else if (season === 'summer') season = 'fall';
    else { season = 'spring'; year++; }
  }
  return out;
}

function defaultGradTerm(standing) {
  const { season, year } = config.term;
  const y = Number(year);
  const yearsLeft = { freshman: 3, sophomore: 2, junior: 1, senior: 0 }[standing] ?? 2;
  // Registering for spring: a freshman graduates in spring three years later.
  return season === 'spring' ? `Spring ${y + yearsLeft}` : `Spring ${y + yearsLeft + 1}`;
}

const levelIdx = (code) => ({ 1: 2, 2: 3, 3: 5, 4: 7, 5: 8 }[String(code).split(' ')[1]?.[0]] || 5);

const CAREER_KEYWORDS = {
  'machine learning|ai|artificial intelligence|data scien': ['machine learning', 'artificial intelligence', 'data', 'learning', 'statistic', 'vision', 'language', 'neural', 'mining'],
  'software|swe|developer|engineer': ['software', 'systems', 'programming', 'distributed', 'database', 'web', 'cloud', 'engineering'],
  'security|cyber': ['security', 'cryptograph', 'network', 'privacy', 'systems'],
  'game|graphics': ['graphics', 'game', 'visual', 'animation', 'rendering', 'interactive'],
  'finance|quant|trading': ['financ', 'probabilit', 'statistic', 'numerical', 'optimization', 'econom', 'stochastic'],
  'research|phd|academi': ['theory', 'algorithm', 'research', 'advanced', 'topics'],
  'med|health|bio': ['bio', 'health', 'medical', 'genom', 'neuro', 'clinical'],
  'business|consult|product|management': ['business', 'management', 'market', 'strategy', 'organization', 'econom'],
  'law|policy|government': ['law', 'policy', 'political', 'ethic', 'government', 'public'],
  'hardware|embedded|chip': ['architecture', 'embedded', 'circuit', 'digital', 'hardware', 'signal', 'vlsi'],
};

function careerKeywords(career = '') {
  const c = career.toLowerCase();
  const out = new Set(c.split(/[^a-z]+/).filter((w) => w.length > 3));
  for (const [re, words] of Object.entries(CAREER_KEYWORDS)) if (new RegExp(re).test(c)) words.forEach((w) => out.add(w));
  return [...out];
}

export async function buildRoadmap(profile = {}) {
  const warnings = [];
  const audit = profile.audit || null;
  // Courses in progress this term count as done by the time the next term starts.
  const completed = new Set([...(profile.completed || []), ...(audit?.completed || []), ...(audit?.inProgress || [])].map(normalizeCode).filter(Boolean));
  const standing = (profile.standing || 'sophomore').toLowerCase();
  const transferring = Boolean(profile.intendedMajor && profile.intendedMajor !== profile.major);
  const target = await findProgram(transferring ? profile.intendedMajor : profile.major);
  if (!target) return { error: `Couldn't find "${profile.intendedMajor || profile.major}" in the UIUC catalog. Pick it from the list.` };
  const program = await getProgram(target.url);
  const maxCredits = Number(profile.maxCredits) || 16;
  const gradTerm = profile.gradTerm || defaultGradTerm(standing);
  const terms = termSequence(config.term.season, config.term.year, gradTerm, profile.includeSummer);
  const currentIdx = (STANDING_BASE[standing] || 3) + (config.term.season === 'spring' ? 1 : 0);

  // ---- requirements ----
  const planIdx = new Map();
  for (const sem of program.sequence) for (const c of sem.courses) for (const code of c.codes) if (!planIdx.has(code)) planIdx.set(code, sem.index);

  const required = [];
  const pools = [];
  for (const g of program.groups) {
    if (g.kind === 'gened') continue;
    const electiveGroup = /elective/i.test(g.heading);
    const poolMap = new Map();
    for (const item of g.items) {
      if (item.type !== 'course') continue;
      if (electiveGroup || item.pool) {
        const key = electiveGroup ? g.heading : item.pool;
        if (!poolMap.has(key)) poolMap.set(key, { heading: key, group: g.heading, hours: g.totalHours, options: new Map() });
        item.options.forEach((o, i) => poolMap.get(key).options.set(o, item.titles[i] || item.titles[0]));
      } else {
        const done = item.options.some((o) => o.split(' & ').every((x) => completed.has(normalizeCode(x))));
        required.push({
          options: item.options, titles: item.titles, hours: item.hours, group: g.heading, done,
          code: item.options.find((o) => planIdx.has(o)) || item.options[0],
        });
      }
    }
    for (const p of poolMap.values()) pools.push({ ...p, options: [...p.options].map(([code, title]) => ({ code, title, gpa: courseGpa(code)?.avg ?? null, done: completed.has(code) })) });
  }

  // "Choose one of the following" lists inside required groups become one required slot.
  for (const p of pools) {
    if (/elective/i.test(p.group) || !/(choose|select) one|one of the following/i.test(p.heading)) continue;
    p.consumed = true;
    const opts = p.options.map((o) => o.code);
    const done = p.options.some((o) => o.code.split(' & ').every((x) => completed.has(normalizeCode(x))));
    required.push({
      options: opts, titles: p.options.map((o) => o.title), hours: null, group: p.group, done, choice: p.heading,
      code: opts.find((o) => planIdx.has(o)) || opts[0],
    });
  }
  for (let i = pools.length - 1; i >= 0; i--) if (pools[i].consumed) pools.splice(i, 1);

  // ---- degree audit: what DARS says is still unmet overrides guesses from the catalog ----
  const auditView = [];
  if (audit?.requirements?.length) {
    for (const req of audit.requirements) {
      if (req.status !== 'incomplete') { auditView.push({ ...req, need: 0, planned: [] }); continue; }
      const need = neededCount(req);
      const options = (req.options || []).filter((o) => !completed.has(o));
      if (/elective/i.test(req.title) && options.length) {
        // elective lists from the audit get priority when filling elective slots
        pools.unshift({ heading: req.title, group: 'Degree audit', hours: req.needs, fromAudit: true,
          options: options.map((code) => ({ code, title: pools.flatMap((p) => p.options).find((o) => o.code === code)?.title || code, gpa: courseGpa(code)?.avg ?? null, done: false })) });
        auditView.push({ ...req, need, planned: [], kind: 'elective' });
        continue;
      }
      const alreadyPlanned = required.filter((r) => !r.done && r.options.some((o) => options.includes(o))).map((r) => r.code);
      const extra = options
        .filter((o) => !required.some((r) => r.options.includes(o)))
        .sort((a, b) => (planIdx.get(a) ?? levelIdx(a)) - (planIdx.get(b) ?? levelIdx(b)))
        .slice(0, Math.max(0, need - alreadyPlanned.length));
      for (const code of extra) required.push({ options: [code], titles: [code], hours: null, group: `Audit: ${req.title}`, done: false, code, fromAudit: true });
      auditView.push({ ...req, need, planned: [...alreadyPlanned, ...extra], kind: 'required' });
    }
  }

  const remaining = required.filter((r) => !r.done);
  for (const r of remaining) r.ideal = planIdx.get(r.code) ?? levelIdx(r.code);

  // ---- prerequisites + credit hours ----
  const catalog = await mapLimit(remaining, 4, (r) => getCatalogCourse(r.code.split(' & ')[0]));
  const planned = new Set(remaining.map((r) => r.code));
  remaining.forEach((r, i) => {
    const c = catalog[i];
    r.title = c?.title || r.titles[0];
    r.hours = r.hours || c?.credits?.min || 3;
    const p = parsePrereqs(c?.prereqText || '');
    r.prereqClauses = p.clauses.filter((cl) => cl.courses?.length);
    r.prereqText = p.raw;
  });

  // Which courses are offered in the term being registered for?
  const offeredNow = await mapLimit(remaining, 4, async (r) => Boolean(await getCourse(r.code.split(' & ')[0])));
  remaining.forEach((r, i) => { r.offeredNow = offeredNow[i]; });

  // ---- greedy semester placement respecting prereqs ----
  const placedTerm = new Map(); // code -> term index
  const termPlans = terms.map((t) => ({ ...t, credits: 0, courses: [] }));
  const satisfiedBy = (code, k) => completed.has(code) || (placedTerm.has(code) && placedTerm.get(code) < k);
  const clauseOk = (cl, k) => {
    if (cl.courses.some((c) => satisfiedBy(c, k))) return true;
    // a prereq the plan never schedules (e.g. an alternative) — don't block, but warn
    return !cl.courses.some((c) => planned.has(c));
  };

  const queue = [...remaining].sort((a, b) => a.ideal - b.ideal);
  for (let k = 0; k < termPlans.length; k++) {
    const term = termPlans[k];
    const cap = term.season === 'summer' ? Math.min(8, maxCredits) : maxCredits;
    const planPos = currentIdx + termPlans.slice(0, k).filter((t) => t.season !== 'summer').length;
    for (const r of queue) {
      if (placedTerm.has(r.code)) continue;
      if (term.credits + r.hours > cap) continue;
      if (k === 0 && !r.offeredNow) continue;
      if (r.ideal > planPos + 2 && k < termPlans.length - 2) continue; // don't rush far ahead of the recommended pace
      if (!r.prereqClauses.every((cl) => clauseOk(cl, k))) continue;
      placedTerm.set(r.code, k);
      term.credits += r.hours;
      term.courses.push({ code: r.code, title: r.title, hours: r.hours, kind: 'required', group: r.group, prereqText: r.prereqText, ideal: r.ideal, options: r.options.length > 1 ? r.options : undefined });
    }
  }
  const unplaced = queue.filter((r) => !placedTerm.has(r.code));
  if (unplaced.length) {
    warnings.push(`${unplaced.length} required course(s) don't fit before ${gradTerm}: ${unplaced.map((r) => r.code).join(', ')}. Consider summer terms, ${maxCredits + 2} credits/term, or a later graduation term.`);
  }
  const notNow = remaining.filter((r) => !r.offeredNow && !r.done).map((r) => r.code);
  if (notNow.length) warnings.push(`Not offered in ${termLabel()}: ${notNow.slice(0, 8).join(', ')}${notNow.length > 8 ? '…' : ''} — planned for later terms.`);

  // ---- electives / gen-ed placeholders from the recommended sequence ----
  const placeholders = program.sequence
    .filter((s) => s.index >= currentIdx)
    .flatMap((s) => s.courses.filter((c) => !c.codes.length).map((c) => ({ text: c.text, hours: c.hours || 3, ideal: s.index })));
  const kw = careerKeywords(profile.career);
  const pickFor = (ph) => {
    const t = ph.text.toLowerCase();
    if (/general education|gen ed|composition|language other/i.test(t)) return { kind: 'gened' };
    if (/free elective/i.test(t)) return { kind: 'free' };
    const pool = pools.find((p) => p.heading.toLowerCase().split(/\W+/).filter((w) => w.length > 4 && w !== 'elective' && w !== 'electives').some((w) => t.includes(w)))
      || pools.find((p) => /elective/i.test(p.heading));
    return { kind: 'elective', pool };
  };
  const usedPicks = new Set(completed);
  let overflowHours = 0;
  const electiveSlots = [];
  for (const ph of placeholders) {
    const { kind, pool } = pickFor(ph);
    const start = Math.min(Math.max(0, ph.ideal - currentIdx), termPlans.length - 1);
    const fits = (t) => t.season !== 'summer' && t.credits + ph.hours <= maxCredits;
    let term = termPlans.slice(start).find(fits) || [...termPlans.slice(0, start)].reverse().find(fits);
    if (!term) { overflowHours += ph.hours; continue; }
    const slot = { code: null, title: ph.text, hours: ph.hours, kind, pool: pool?.heading || null };
    if (kind === 'elective' && pool) {
      const ranked = pool.options
        .filter((o) => !usedPicks.has(o.code))
        .map((o) => ({ ...o, fit: kw.filter((w) => o.title.toLowerCase().includes(w)).length * 2 + (o.gpa ? (o.gpa - 3) : 0) - (Number(o.code.split(' ')[1]) >= 500 ? 3 : 0) }))
        .sort((a, b) => b.fit - a.fit);
      if (ranked[0] && ranked[0].fit > 0) {
        usedPicks.add(ranked[0].code);
        Object.assign(slot, { code: ranked[0].code, suggestion: ranked[0].title, why: kw.length ? 'Matches your career keywords' : 'High average GPA' });
      }
    }
    term.credits += ph.hours;
    term.courses.push(slot);
    electiveSlots.push(slot);
  }

  if (overflowHours) warnings.push(`About ${overflowHours} elective/gen-ed credit hours don't fit at ${maxCredits} credits/term. AP/transfer credit may already cover some; otherwise add summer terms or take heavier semesters.`);

  // Gen-ed suggestions: courses that satisfy two categories at once, highest GPA first.
  const genEdPicks = Object.keys({ HUM: 1, SBS: 1, NAT: 1, CS: 1 })
    .flatMap((cat) => genEdCourses(cat))
    .filter((c, i, arr) => genEdCount(c.code) >= 2 && arr.findIndex((x) => x.code === c.code) === i && !completed.has(c.code))
    .sort((a, b) => (b.gpa || 0) - (a.gpa || 0))
    .slice(0, 8);
  let gi = 0;
  for (const slot of electiveSlots) if (slot.kind === 'gened' && genEdPicks[gi]) {
    const g = genEdPicks[gi++];
    Object.assign(slot, { code: g.code, suggestion: g.title, why: `Counts for ${Object.entries(g.cats).map(([k, v]) => `${k}:${v}`).join(' + ')}${g.gpa ? `, avg GPA ${g.gpa}` : ''}` });
  }

  const doneHours = required.filter((r) => r.done).reduce((s, r) => s + (r.hours || 3), 0);
  const result = {
    program: { title: program.title, url: program.url, totalHours: program.totalHours },
    transferring,
    currentMajor: profile.major,
    gradTerm,
    currentSemesterIndex: currentIdx,
    terms: termPlans,
    requirements: {
      total: required.length,
      done: required.filter((r) => r.done).map((r) => r.code),
      remaining: remaining.map((r) => ({ code: r.code, title: r.title, hours: r.hours, options: r.options, choice: r.choice, group: r.group, offeredNow: r.offeredNow, prereq: r.prereqText })),
      doneHours,
    },
    pools: pools.map((p) => ({ heading: p.heading, hours: p.hours, count: p.options.length, options: p.options.slice(0, 80) })),
    recommendedSequence: program.sequence,
    audit: audit ? { requirements: auditView, earnedHours: audit.earnedHours ?? null, importedAt: audit.importedAt || null } : null,
    warnings,
    advice: [],
    ai: false,
  };

  if (transferring) {
    result.transfer = {
      from: profile.major, to: program.title,
      catalogNotes: program.transferText,
      countsTowardNew: required.filter((r) => r.done).map((r) => r.code),
    };
  }

  if (grokEnabled()) {
    try { await enhanceWithGrok(result, profile, program); }
    catch (e) { result.warnings.push(`Grok advice unavailable: ${e.message}`); }
  } else {
    result.advice = ruleAdvice(result, profile);
  }
  return result;
}

function ruleAdvice(r, profile) {
  const out = [];
  const first = r.terms[0];
  if (first) out.push(`Next term (${first.name}): ${first.courses.filter((c) => c.code).map((c) => c.code).join(', ') || 'electives'} — ${first.credits} credits.`);
  if (profile.career) out.push(`Electives were matched to "${profile.career}" by course title keywords. Add an XAI_API_KEY for Grok-curated picks and career advice.`);
  if (r.transferring) out.push(`Planning to transfer into ${r.program.title}? Check the department's transfer (ICT) requirements and minimum GPA early; prioritize the courses its admission review looks at.`);
  out.push('Always confirm with your academic advisor and your DARS audit before registering.');
  return out;
}

async function enhanceWithGrok(result, profile, program) {
  const slots = result.terms.flatMap((t) => t.courses.filter((c) => c.kind === 'elective').map((c) => ({ term: t.name, pool: c.pool, current: c.code })));
  const payload = {
    student: { standing: profile.standing, major: profile.major, intendedMajor: profile.intendedMajor, career: profile.career, gradTerm: result.gradTerm, completed: profile.completed },
    program: result.program.title,
    remainingRequired: result.requirements.remaining.map((r) => `${r.code} ${r.title}`),
    electiveSlots: slots,
    electivePools: result.pools.map((p) => ({ heading: p.heading, options: p.options.map((o) => `${o.code} ${o.title}${o.gpa ? ` (GPA ${o.gpa})` : ''}`) })),
    draftPlan: result.terms.map((t) => ({ term: t.name, courses: t.courses.map((c) => c.code || c.title) })),
    transferNotes: result.transfer ? program.transferText.slice(0, 3000) : undefined,
    degreeAuditUnmet: result.audit?.requirements.filter((r) => r.status === 'incomplete').map((r) => ({ title: r.title, needs: r.needs, options: r.options })),
  };
  const out = await askJson(
    `You are a UIUC academic planning assistant. Given a student's degree data (from the official catalog), return ONLY JSON:
{"summary": "2 sentences", "electivePicks": [{"slotIndex": 0, "code": "CS 446", "why": "short reason tied to career"}],
 "careerAdvice": ["3-5 concise, specific tips: courses, RSOs, research, internships relevant to the career goal at UIUC"],
 "adjustments": ["optional changes to the draft plan, e.g. balance hard courses"],
 "transferAdvice": "only if intendedMajor differs from major: what to prioritize to be admitted, else empty string"}
Only pick elective codes that appear in the provided pools. electivePicks.slotIndex refers to the electiveSlots array. Don't invent requirements.`,
    JSON.stringify(payload),
  );
  if (!out) return;
  const allowed = new Set(result.pools.flatMap((p) => p.options.map((o) => o.code)));
  const slotRefs = result.terms.flatMap((t) => t.courses.filter((c) => c.kind === 'elective'));
  for (const p of out.electivePicks || []) {
    const slot = slotRefs[p.slotIndex];
    const code = normalizeCode(p.code);
    const inPlan = result.terms.some((t) => t.courses.some((c) => c !== slot && c.code === code));
    if (slot && code && allowed.has(code) && !inPlan) {
      const opt = result.pools.flatMap((x) => x.options).find((o) => o.code === code);
      Object.assign(slot, { code, suggestion: opt?.title, why: p.why, by: 'grok' });
    }
  }
  result.summary = out.summary;
  result.advice = [...(out.careerAdvice || []), ...(out.adjustments || []), 'Confirm with your advisor and DARS audit before registering.'];
  if (result.transfer && out.transferAdvice) result.transfer.advice = out.transferAdvice;
  result.ai = true;
}
