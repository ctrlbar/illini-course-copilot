// Schedule generator: finds every conflict-free combination of section bundles that
// satisfies the student's constraints, scores each against their preferences, and
// returns them ranked — plus backup plans for when a section fills up.
import { getCourse, normalizeCode, availabilityLevel } from './courseExplorer.js';
import { buildBundles } from './sections.js';
import { checkRestrictions, checkPrereqs } from './eligibility.js';
import { courseGpa, instructorGpa, genEdCourses, genEdCount, GENED_CATEGORIES } from './datasets.js';
import { walkMinutes } from './buildings.js';
import { mapLimit } from './http.js';

const DAYS = ['M', 'T', 'W', 'R', 'F'];
const MAX_RESULTS = 25000;
const TIME_BUDGET_MS = 3000;

export const DEFAULT_WEIGHTS = {
  seats: 1.5,     // sections actually have room
  lateStart: 1,   // fewer early mornings
  daysOff: 1,     // free weekdays
  compact: 1,     // fewer long gaps between classes
  gpa: 1,         // historically generous instructors/courses
  walking: 1,     // feasible walks between back-to-back classes
  lunch: 0.5,     // a lunch break on class days
  endEarly: 0.5,  // done earlier in the day
};

export const COMPONENT_LABELS = {
  seats: 'Seat availability', lateStart: 'Start times', daysOff: 'Days off', compact: 'Compactness',
  gpa: 'Avg GPA', walking: 'Walking time', lunch: 'Lunch breaks', endEarly: 'End times',
};

const clamp = (x) => Math.max(0, Math.min(1, x));
export const fmtTime = (m) => {
  if (m == null) return 'TBA';
  const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0');
  return `${((h + 11) % 12) + 1}:${mm}${h < 12 ? 'am' : 'pm'}`;
};

const termsOverlap = (a, b) => a === '1' || b === '1' || a === b;

function meetingsConflict(a, b) {
  if (a.start == null || b.start == null) return false;
  if (!a.days.some((d) => b.days.includes(d))) return false;
  return a.start < b.end && b.start < a.end;
}

function bundlesConflict(x, y) {
  if (!termsOverlap(x.partOfTerm, y.partOfTerm)) return false;
  for (const a of x.meetings) for (const b of y.meetings) if (meetingsConflict(a, b)) return true;
  return false;
}

// ---------------- constraint sanitizing ----------------

/** Accepts minutes, hours ("10"), "10:30", "10am", "2:30pm"; returns minutes after midnight or null. */
export function toMinutes(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 24 ? Math.round(v * 60) : Math.round(v);
  const m = String(v).trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return Number.isFinite(Number(v)) ? toMinutes(Number(v)) : null;
  let h = Number(m[1]) % 12;
  if (m[3] === 'pm' || (!m[3] && Number(m[1]) === 12)) h += 12;
  else if (!m[3] && Number(m[1]) > 12) h = Number(m[1]);
  return h * 60 + Number(m[2] || 0);
}

/**
 * Drop constraints that can't be what a student meant (e.g. "no class before 6:11pm",
 * which silently removes every in-person section). Returns notes explaining any change.
 */
export function sanitizeConstraints(c = {}) {
  const out = { ...c };
  const notes = [];
  out.earliestStart = toMinutes(c.earliestStart);
  out.latestEnd = toMinutes(c.latestEnd);
  if (out.earliestStart != null && (out.earliestStart < 360 || out.earliestStart > 840)) {
    notes.push(`Ignored "no class before ${fmtTime(out.earliestStart)}" because it would rule out almost every class.`);
    out.earliestStart = null;
  }
  if (out.latestEnd != null && (out.latestEnd < 660 || out.latestEnd > 1440)) {
    notes.push(`Ignored "no class after ${fmtTime(out.latestEnd)}" because it would rule out almost every class.`);
    out.latestEnd = null;
  }
  if (out.earliestStart != null && out.latestEnd != null && out.latestEnd - out.earliestStart < 180) {
    notes.push('Ignored the start/end time window because it is shorter than 3 hours.');
    out.earliestStart = null; out.latestEnd = null;
  }
  const days = new Set(['M', 'T', 'W', 'R', 'F']);
  out.daysOff = [...new Set((c.daysOff || []).map((d) => String(d).toUpperCase()[0] === 'T' && /th|r/i.test(d) ? 'R' : String(d).toUpperCase()[0]))].filter((d) => days.has(d));
  if (out.daysOff.length >= 5) { notes.push('Ignored "all days off".'); out.daysOff = []; }
  out.blocked = (c.blocked || [])
    .map((b) => ({ ...b, start: toMinutes(b.start), end: toMinutes(b.end), days: (b.days || []).filter((d) => days.has(d)) }))
    .filter((b) => b.start != null && b.end != null && b.end > b.start && b.days.length);
  return { constraints: out, notes };
}

// ---------------- constraint filters ----------------

function violatesConstraints(bundle, c) {
  for (const m of bundle.meetings) {
    if (m.start == null) continue;
    if (c.earliestStart != null && m.start < c.earliestStart) return `starts before ${fmtTime(c.earliestStart)}`;
    if (c.latestEnd != null && m.end > c.latestEnd) return `ends after ${fmtTime(c.latestEnd)}`;
    if (c.daysOff?.length && m.days.some((d) => c.daysOff.includes(d))) return `meets on ${m.days.filter((d) => c.daysOff.includes(d)).join('')}`;
    for (const blk of c.blocked || []) {
      if (meetingsConflict(m, { days: blk.days, start: blk.start, end: blk.end })) return `overlaps "${blk.label || 'blocked time'}"`;
    }
  }
  if (c.onlyOpen && bundle.sections.some((s) => availabilityLevel(s.availability) === 'closed')) return 'a section is closed';
  if (c.noOnline && bundle.sections.some((s) => /online/i.test(s.type))) return 'online section';
  return null;
}

// ---------------- scoring ----------------

function bundleGpa(b) {
  const lec = b.sections.find((s) => /lec|lcd|olc/i.test(s.typeCode)) || b.sections[0];
  const ins = lec?.meetings.flatMap((m) => m.instructors) || [];
  for (const i of ins) {
    const g = instructorGpa(b.courseCode, i);
    if (g?.avg) return { avg: g.avg, source: `${g.name} (${g.n} students)` };
  }
  const cg = courseGpa(b.courseCode);
  return cg ? { avg: cg.avg, source: 'course average' } : null;
}

function analyze(bundles) {
  const byDay = Object.fromEntries(DAYS.map((d) => [d, []]));
  for (const b of bundles) {
    for (const m of b.meetings) {
      if (m.start == null) continue;
      for (const d of m.days) if (byDay[d]) byDay[d].push({ ...m, courseCode: b.courseCode });
    }
  }
  let gap = 0, tight = [], noLunch = 0, starts = [], ends = [];
  const classDays = DAYS.filter((d) => byDay[d].length);
  for (const d of classDays) {
    const list = byDay[d].sort((a, b) => a.start - b.start);
    starts.push(list[0].start);
    ends.push(Math.max(...list.map((m) => m.end)));
    for (let i = 1; i < list.length; i++) {
      const g = list[i].start - list[i - 1].end;
      if (g > 10) gap += g;
      if (g >= 0 && g <= 20) {
        const w = walkMinutes(list[i - 1].building, list[i].building);
        if (w != null && w > g) tight.push({ day: d, from: list[i - 1], to: list[i], gap: g, walk: w });
      }
    }
    // lunch: is there a free 30-minute window between 11:00 and 14:00?
    let free = false, cursor = 660;
    for (const m of list) {
      if (m.end <= 660 || m.start >= 840) continue;
      if (m.start - cursor >= 30) { free = true; break; }
      cursor = Math.max(cursor, m.end);
    }
    if (!free && 840 - cursor >= 30) free = true;
    if (!free) noLunch++;
  }
  return { byDay, classDays, gap, tight, noLunch, starts, ends };
}

export function scoreSchedule(bundles, weights = DEFAULT_WEIGHTS, prefs = {}) {
  const a = analyze(bundles);
  const n = Math.max(a.classDays.length, 1);
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const avgStart = avg(a.starts), avgEnd = avg(a.ends);
  const daysOff = 5 - a.classDays.length;

  const secLevels = bundles.flatMap((b) => b.sections.map((s) => availabilityLevel(s.availability)));
  const seatVal = { open: 1, restricted: 0.6, unknown: 0.5, closed: 0 };
  const gpas = bundles.map(bundleGpa).filter(Boolean);
  const avgGpa = avg(gpas.map((g) => g.avg));

  let late = avgStart == null ? 1 : clamp((avgStart - 480) / 240);
  if (prefs.preferMornings) late = 1 - late;
  const comps = {
    seats: { score: avg(secLevels.map((l) => seatVal[l])) ?? 0.5, detail: `${secLevels.filter((l) => l === 'open').length}/${secLevels.length} sections open` },
    lateStart: { score: late, detail: avgStart == null ? 'no timed meetings' : `avg first class ${fmtTime(Math.round(avgStart))}` },
    daysOff: { score: clamp(daysOff / 2), detail: daysOff ? `${daysOff} weekday${daysOff > 1 ? 's' : ''} off` : 'class every weekday' },
    compact: { score: 1 - clamp(a.gap / (n * 180)), detail: `${Math.round(a.gap / 60 * 10) / 10}h of gaps per week` },
    gpa: { score: avgGpa == null ? 0.5 : clamp((avgGpa - 2.8) / 1.1), detail: avgGpa == null ? 'no GPA data' : `avg GPA ${avgGpa.toFixed(2)}` },
    walking: { score: 1 - clamp(a.tight.length / 3), detail: a.tight.length ? `${a.tight.length} rushed walk${a.tight.length > 1 ? 's' : ''}` : 'all walks feasible' },
    lunch: { score: 1 - a.noLunch / n, detail: a.noLunch ? `no lunch break on ${a.noLunch} day(s)` : 'lunch break every day' },
    endEarly: { score: avgEnd == null ? 1 : clamp((1260 - avgEnd) / 360), detail: avgEnd == null ? '' : `avg last class ends ${fmtTime(Math.round(avgEnd))}` },
  };
  let total = 0, wsum = 0;
  for (const [k, w] of Object.entries(weights)) {
    if (!comps[k] || !w) continue;
    total += comps[k].score * w; wsum += w;
  }
  return { score: Math.round((total / (wsum || 1)) * 1000) / 10, components: comps, analysis: a };
}

function highlightsFor(s) {
  const h = [], w = [];
  const a = s.analysis;
  const off = DAYS.filter((d) => !a.classDays.includes(d));
  const names = { M: 'Mon', T: 'Tue', W: 'Wed', R: 'Thu', F: 'Fri' };
  if (off.length) h.push(`${off.map((d) => names[d]).join(' & ')} off`);
  if (a.starts.length && Math.min(...a.starts) >= 600) h.push(`Nothing before ${fmtTime(Math.min(...a.starts))}`);
  if (a.ends.length && Math.max(...a.ends) <= 960) h.push(`Done by ${fmtTime(Math.max(...a.ends))}`);
  if (s.components.gpa.score > 0.7) h.push(s.components.gpa.detail);
  if (s.components.seats.score === 1) h.push('All sections open');
  for (const t of a.tight) w.push(`${names[t.day]}: ${t.walk}-min walk ${t.from.building} → ${t.to.building} with ${t.gap} min between ${t.from.courseCode} and ${t.to.courseCode}`);
  if (a.noLunch) w.push(`No lunch break on ${a.noLunch} day(s)`);
  if (a.starts.length && Math.min(...a.starts) < 540) w.push(`Earliest class at ${fmtTime(Math.min(...a.starts))}`);
  return { highlights: h, warnings: w };
}

// ---------------- slot building ----------------

async function courseSlot(code, ctx) {
  const course = await getCourse(code);
  if (!course) return { error: `${code} isn't offered in this term` };
  return { label: code, kind: 'course', courses: [course] };
}

async function genEdSlot(spec, ctx) {
  const exclude = new Set([...ctx.required, ...(ctx.profile.completed || []).map(normalizeCode)]);
  let cands = genEdCourses(spec.category, spec.sub).filter((c) => !exclude.has(c.code));
  // prefer courses that cover multiple gen-eds, then high GPA
  cands.sort((x, y) => (genEdCount(y.code) - genEdCount(x.code)) * 0.3 + ((y.gpa ?? 3) - (x.gpa ?? 3)));
  cands = cands.slice(0, spec.pool || 14);
  const courses = (await mapLimit(cands, 4, (c) => getCourse(c.code))).filter(Boolean)
    .filter((c) => checkPrereqs(c.prereqText || c.description, ctx.profile.completed || []).status !== 'missing');
  const cat = GENED_CATEGORIES[spec.category];
  const label = `${cat?.subs[spec.sub] || cat?.name || spec.category} Gen Ed`;
  if (!courses.length) return { error: `No eligible ${label} courses found` };
  return { label, kind: 'gened', courses };
}

async function groupSlot(group, ctx) {
  const courses = (await mapLimit(group.options, 4, (c) => getCourse(c))).filter(Boolean);
  if (!courses.length) return { error: `None of ${group.options.join(', ')} are offered` };
  return { label: group.label || `One of ${group.options.join('/')}`, kind: 'group', courses };
}

// ---------------- main entry ----------------

/**
 * request = {
 *   courses: ['CS 225', 'MATH 241'],
 *   groups: [{ label, options: ['STAT 200','STAT 212'] }],   // pick one of
 *   genEds: [{ category: 'HUM', sub?: 'LA', count?: 1 }],
 *   constraints: { earliestStart, latestEnd, daysOff: ['F'], blocked: [{days, start, end, label}], onlyOpen, avoidRestricted },
 *   weights, prefs: { preferMornings }, profile: { standing, major, completed }, limit
 * }
 */
export async function generateSchedules(request) {
  const t0 = Date.now();
  const profile = request.profile || {};
  const { constraints, notes: constraintNotes } = sanitizeConstraints(request.constraints || {});
  const weights = { ...DEFAULT_WEIGHTS, ...(request.weights || {}) };
  const required = (request.courses || []).map(normalizeCode).filter(Boolean);
  const ctx = { profile, required };

  const slotPromises = [
    ...required.map((c) => courseSlot(c, ctx)),
    ...(request.groups || []).map((g) => groupSlot(g, ctx)),
    ...(request.genEds || []).flatMap((g) => Array.from({ length: g.count || 1 }, () => genEdSlot(g, ctx))),
  ];
  const slots = await Promise.all(slotPromises);
  const errors = slots.filter((s) => s.error).map((s) => s.error);
  const good = slots.filter((s) => !s.error);
  if (!good.length) return { schedules: [], total: 0, errors, diagnostics: [], warnings: constraintNotes, constraints };

  // Build + filter bundles per slot, tracking why options were dropped.
  const diagnostics = [];
  const eligibility = {};
  for (const slot of good) {
    slot.options = [];
    const dropped = {};
    for (const original of slot.courses) {
      eligibility[original.code] = checkPrereqs(original.prereqText || original.description, profile.completed || []);
      // Drop sections this student can't register for *before* bundling, so restricted
      // cross-listed twins (e.g. a non-majors lecture) never show up as alternatives.
      let course = original;
      if (constraints.avoidRestricted !== false) {
        const allowed = original.sections.filter((s) => checkRestrictions(s, profile).status !== 'restricted');
        const n = original.sections.length - allowed.length;
        if (n) dropped['restricted sections'] = (dropped['restricted sections'] || 0) + n;
        course = { ...original, sections: allowed };
      }
      if (constraints.onlyOpen) {
        const allowed = course.sections.filter((s) => availabilityLevel(s.availability) !== 'closed');
        const n = course.sections.length - allowed.length;
        if (n) dropped['closed sections'] = (dropped['closed sections'] || 0) + n;
        course = { ...course, sections: allowed };
      }
      for (const b of buildBundles(course)) {
        const restr = b.sections.map((s) => checkRestrictions(s, profile));
        b.restriction = restr.some((r) => r.status === 'restricted') ? 'restricted' : restr.some((r) => r.status === 'unknown') ? 'unknown' : 'ok';
        b.restrictionReasons = [...new Set(restr.flatMap((r) => r.reasons))];
        const why = violatesConstraints(b, constraints);
        if (why) { const k = why.replace(/\s+\d.*$/, '').trim() || why; dropped[k] = (dropped[k] || 0) + 1; continue; }
        b.gpa = bundleGpa(b);
        // quick heuristic so DFS explores the most promising options first
        b.quick = b.availRank + (b.gpa?.avg || 3) - (Math.min(...b.meetings.map((m) => m.start ?? 720)) < 540 ? 1 : 0);
        slot.options.push(b);
      }
    }
    slot.options.sort((x, y) => y.quick - x.quick);
    const totalBundles = slot.options.length + Object.entries(dropped).filter(([k]) => !k.endsWith('sections')).reduce((a, [, b]) => a + b, 0);
    if (!slot.options.length) {
      diagnostics.push({ slot: slot.label, message: `No section combination of ${slot.label} fits`, dropped, totalBundles });
    } else if (Object.keys(dropped).length) {
      diagnostics.push({ slot: slot.label, message: `${slot.options.length} of ${totalBundles} section combinations fit`, dropped, totalBundles });
    }
  }
  if (good.some((s) => !s.options.length)) {
    return { schedules: [], total: 0, errors, diagnostics, eligibility, warnings: constraintNotes, constraints };
  }

  // DFS over slots, fewest options first.
  const order = good.map((s, i) => i).sort((a, b) => good[a].options.length - good[b].options.length);
  const results = [];
  const picked = new Array(good.length);
  let truncated = false;
  const dfs = (depth) => {
    if (results.length >= MAX_RESULTS || Date.now() - t0 > TIME_BUDGET_MS) { truncated = true; return; }
    if (depth === order.length) { results.push(picked.slice()); return; }
    const si = order[depth];
    for (let oi = 0; oi < good[si].options.length; oi++) {
      const b = good[si].options[oi];
      let ok = true;
      for (let d = 0; d < depth; d++) {
        const other = good[order[d]].options[picked[order[d]]];
        if (other.courseCode === b.courseCode || bundlesConflict(other, b)) { ok = false; break; }
      }
      if (!ok) continue;
      picked[si] = oi;
      dfs(depth + 1);
      if (truncated) return;
    }
  };
  dfs(0);

  // Score everything, rank, and compute backups.
  const prefs = request.prefs || {};
  const scored = results.map((p) => {
    const bundles = p.map((oi, si) => good[si].options[oi]);
    const s = scoreSchedule(bundles, weights, prefs);
    return { picks: p, bundles, ...s };
  });
  scored.sort((a, b) => b.score - a.score);

  const limit = request.limit || 30;
  const top = scored.slice(0, limit);
  const backupIndex = new Map();
  for (const s of scored) {
    for (let si = 0; si < s.picks.length; si++) {
      const key = si + ':' + s.picks.map((x, j) => (j === si ? '*' : x)).join(',');
      const list = backupIndex.get(key) || [];
      if (list.length < 3) { list.push(s); backupIndex.set(key, list); }
    }
  }

  const schedules = top.map((s, rank) => {
    const { highlights, warnings } = highlightsFor(s);
    const backups = s.picks.flatMap((oi, si) => {
      const b = s.bundles[si];
      const out = b.alternatives.map((alt) => ({
        courseCode: b.courseCode, ifFull: b.label, switchTo: alt.label, crns: alt.crns, sameTime: true, scoreDelta: 0,
      }));
      const key = si + ':' + s.picks.map((x, j) => (j === si ? '*' : x)).join(',');
      for (const alt of backupIndex.get(key) || []) {
        if (alt === s || out.length >= 3) continue;
        const ab = alt.bundles[si];
        out.push({ courseCode: ab.courseCode, ifFull: b.label, switchTo: `${ab.courseCode !== b.courseCode ? ab.courseCode + ' ' : ''}${ab.label}`, crns: ab.crns, sameTime: false, scoreDelta: Math.round((alt.score - s.score) * 10) / 10 });
      }
      return out;
    });
    return {
      rank: rank + 1,
      score: s.score,
      components: Object.fromEntries(Object.entries(s.components).map(([k, v]) => [k, { ...v, label: COMPONENT_LABELS[k], weight: weights[k] }])),
      credits: s.bundles.reduce((sum, b) => sum + (b.credits?.min || b.credits?.max || 0), 0),
      highlights, warnings, backups,
      crns: s.bundles.flatMap((b) => b.crns),
      bundles: s.bundles.map((b, si) => ({
        slot: good[si].label,
        courseCode: b.courseCode,
        title: b.title,
        credits: b.credits,
        label: b.label,
        crns: b.crns,
        gpa: b.gpa,
        restriction: b.restriction,
        restrictionReasons: b.restrictionReasons,
        alternatives: b.alternatives,
        sections: b.sections.map((x) => ({
          crn: x.crn, number: x.number, type: x.type, typeCode: x.typeCode, availability: x.availability,
          partOfTerm: x.partOfTerm, startDate: x.startDate, endDate: x.endDate,
          meetings: x.meetings.map((m) => ({ ...m, startLabel: fmtTime(m.start), endLabel: fmtTime(m.end) })),
        })),
      })),
    };
  });

  const warnings = [...constraintNotes];
  const best = schedules[0]?.credits ?? 0;
  if (schedules.length && best < 12) {
    warnings.push(`These schedules are only ${best} credit hours. Full-time is at least 12 (most students take 15–16). Add more courses or gen eds.`);
  }
  return {
    schedules,
    warnings,
    constraints,
    total: results.length,
    truncated,
    errors,
    diagnostics,
    eligibility,
    slots: good.map((s) => ({ label: s.label, kind: s.kind, options: s.options.length, courses: s.courses.map((c) => c.code) })),
    weights,
    ms: Date.now() - t0,
  };
}
