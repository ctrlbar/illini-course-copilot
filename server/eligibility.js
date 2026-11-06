// Can this student take this course / section?
//  - Prerequisites: parsed from the catalog text ("Prerequisite: CS 126 or CS 128; One of CS 173, MATH 213")
//  - Restrictions: parsed from section notes ("Restricted to Computer Science major(s)", "Restricted to Juniors")
// Results are 'ok' | 'missing' | 'restricted' | 'unknown' with human-readable reasons.
// Free-text edge cases (consent of instructor, placement exams) come back as 'unknown'
// and can be explained further by Grok.
import { normalizeCode } from './courseExplorer.js';

const CODE_RE = /\b([A-Z]{2,4})\s?(\d{3})\b|(?<=(?:,|\bor|\band)\s)(\d{3})\b/g;

/** Extract course codes from a phrase, inheriting the subject for bare numbers ("MATH 221 or 220"). */
function codesIn(text) {
  const out = [];
  let lastSubj = null;
  for (const m of text.matchAll(CODE_RE)) {
    if (m[1]) { lastSubj = m[1]; out.push(`${m[1]} ${m[2]}`); }
    else if (lastSubj) out.push(`${lastSubj} ${m[3]}`);
  }
  return [...new Set(out)];
}

export function parsePrereqs(text = '') {
  const m = text.match(/Prerequisites?:\s*([\s\S]*?)(?:\.\s+(?=[A-Z][a-z])|$)/);
  if (!m) return { raw: '', clauses: [], hasPrereq: false };
  const raw = m[1].trim().replace(/\.$/, '');
  const clauses = [];
  for (const part of raw.split(/;/)) {
    const codes = codesIn(part);
    if (!codes.length) {
      if (part.trim()) clauses.push({ type: 'text', text: part.trim() });
      continue;
    }
    const soft = /equivalent|consent|experience|approval|permission/i.test(part);
    const isOneOf = /\bor\b|one of|either/i.test(part);
    if (soft) clauses.push({ type: 'oneOf', courses: codes, text: part.trim(), soft: true });
    else if (isOneOf) clauses.push({ type: 'oneOf', courses: codes, text: part.trim() });
    else codes.forEach((c) => clauses.push({ type: 'allOf', courses: [c], text: c }));
  }
  return {
    raw,
    clauses,
    hasPrereq: true,
    concurrentOk: /concurrent/i.test(raw),
    consent: /consent of/i.test(raw),
  };
}

/** completed: array of course codes the student has passed (or is taking now). */
export function checkPrereqs(text, completed = []) {
  const done = new Set(completed.map(normalizeCode).filter(Boolean));
  const p = parsePrereqs(text);
  if (!p.hasPrereq) return { status: 'ok', reasons: [], parsed: p };
  const missing = [];
  let unknown = false;
  for (const c of p.clauses) {
    if (c.type === 'text') { unknown = true; continue; }
    if (!c.courses.some((x) => done.has(x))) {
      if (c.soft) unknown = true; // "CS 101 or equivalent experience" — can't verify, don't block
      else missing.push(c);
    }
  }
  if (missing.length) {
    return {
      status: 'missing',
      reasons: missing.map((c) => (c.courses.length > 1 ? `Need one of ${c.courses.join(', ')}` : `Need ${c.courses[0]}`)),
      missing,
      parsed: p,
      note: p.concurrentOk ? 'Some prerequisites may be taken concurrently.' : undefined,
    };
  }
  if (unknown || p.consent) return { status: 'unknown', reasons: [`Check: ${p.raw}`], parsed: p };
  return { status: 'ok', reasons: ['All listed prerequisites met'], parsed: p };
}

// ---------------- restrictions ----------------

const STANDINGS = ['freshman', 'sophomore', 'junior', 'senior', 'graduate'];
const STANDING_WORDS = {
  freshman: /freshm[ae]n|first[- ]year/i,
  sophomore: /sophomores?/i,
  junior: /juniors?/i,
  senior: /seniors?/i,
  graduate: /graduate students?|grad(uate)? - /i,
};

const cleanMajor = (s = '') =>
  s.toLowerCase()
    .replace(/,?\s*(bs|ba|bslas|balas|bfa|bmus|bsag|bs?ed)\b.*$/i, '')
    .replace(/&/g, ' and ')
    .replace(/\bsci\b/g, 'science')
    .replace(/\bcomputerscience/g, 'computer science')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function majorMatches(listed, major) {
  const a = cleanMajor(listed), b = cleanMajor(major);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function isCsLike(major) {
  const m = cleanMajor(major);
  return /computer science|computer engineering/.test(m);
}

/** profile: { standing: 'sophomore', major: 'Computer Science, BS', college?: string } */
export function checkRestrictions(section, profile = {}) {
  const text = [section.notes, section.cappArea, section.text].filter(Boolean).join(' ');
  if (!text) return { status: 'ok', reasons: [] };
  const reasons = [];
  let status = 'ok';
  const major = profile.major || '';
  const standing = (profile.standing || '').toLowerCase();

  // Major restrictions: "Restricted to A or B or C major(s)."
  for (const m of text.matchAll(/Restricted to ([^.]*?) major\(s\)/gi)) {
    const listed = m[1].split(/\s+or\s+/i);
    if (!major) { status = 'unknown'; reasons.push(`Major-restricted (${listed.length} majors) — add your major to check`); continue; }
    if (!listed.some((l) => majorMatches(l, major))) {
      status = 'restricted';
      reasons.push(`Restricted to: ${listed.slice(0, 4).join(', ')}${listed.length > 4 ? ` +${listed.length - 4} more` : ''}`);
    }
  }
  // Excluded majors: "Not intended for CS and blended CS majors"
  if (/not intended for (cs|computer science)/i.test(text) && major && isCsLike(major)) {
    status = 'restricted';
    reasons.push('This section is not intended for CS / blended-CS majors');
  }
  if (/restricted to (cs|computer science) and blended/i.test(text) && major && !isCsLike(major)) {
    status = 'restricted';
    reasons.push('Reserved for CS and CS+X majors');
  }
  // Class standing: "Restricted to Juniors or Seniors"
  for (const m of text.matchAll(/Restricted to ([^.]*)/g)) {
    const phrase = m[1];
    if (/major|college|program|campus|urbana/i.test(phrase)) continue;
    const allowed = STANDINGS.filter((s) => STANDING_WORDS[s].test(phrase));
    if (!allowed.length) continue;
    if (!standing) { if (status === 'ok') status = 'unknown'; reasons.push(`Restricted to ${allowed.join('/')} — add your year to check`); }
    else if (!allowed.includes(standing)) { status = 'restricted'; reasons.push(`Restricted to ${allowed.join(' / ')} standing`); }
  }
  // Honors / special programs we can't verify
  if (/James Scholar|Honors|Chancellor's Scholar/i.test(section.notes || '') && /restricted/i.test(section.notes || '')) {
    if (status === 'ok') status = 'unknown';
    reasons.push('Honors-program restriction');
  }
  if (/Restricted to .*College of/i.test(text) && status === 'ok') {
    const college = text.match(/Restricted to (?:students in )?(?:the )?([^.]*College of [^.]*)/i)?.[1];
    if (college) { status = 'unknown'; reasons.push(`Restricted to ${college}`); }
  }
  return { status, reasons };
}

const RANK = { ok: 0, unknown: 1, missing: 2, restricted: 3 };
export const worst = (...statuses) => statuses.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');

/** Full eligibility summary for a course for this student. */
export function courseEligibility(course, profile = {}) {
  const prereq = checkPrereqs(course.prereqText || course.description, profile.completed || []);
  const already = (profile.completed || []).map(normalizeCode).includes(course.code);
  const sections = course.sections.map((s) => ({ crn: s.crn, number: s.number, ...checkRestrictions(s, profile) }));
  // Course is restricted only if *every* section of some role is restricted — approximate by "all sections".
  const openSecs = sections.filter((s) => s.status !== 'restricted');
  const sectionStatus = !sections.length ? 'ok' : openSecs.length === 0 ? 'restricted' : 'ok';
  return {
    code: course.code,
    status: already ? 'completed' : worst(prereq.status, sectionStatus),
    alreadyTaken: already,
    prereq,
    sections,
    summary: already ? 'You already took this course'
      : prereq.status === 'missing' ? prereq.reasons.join('; ')
      : sectionStatus === 'restricted' ? 'Every section is restricted for your major/standing'
      : prereq.status === 'unknown' ? 'Prerequisites need a manual check'
      : 'You can take this course',
  };
}
