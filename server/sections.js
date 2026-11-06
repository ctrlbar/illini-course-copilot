// Linked-section logic: turns a course's raw sections into valid registration "bundles"
// (e.g. one lecture + one matching discussion), the way UIUC actually requires.
//
// Rules, derived from how Course Explorer numbers sections:
//  1. Section types are grouped into roles. You need exactly one section per role.
//     LEC / LCD / OLC / ONL are all "lecture" (so an online lecture is an *alternative*
//     to the in-person one); DIS / OD / Q / LBD / OLB are "discussion"; LAB is its own role.
//  2. Sections are linked by their first letter ("AL1" goes with "ADA", "BL1" with "BDC"),
//     but only when that letter is used by both roles. Otherwise any combination works
//     (e.g. PHYS 211's "A1" lecture with any "D2x" discussion and "L2x" lab).
import { availabilityLevel } from './courseExplorer.js';

const ROLE = {
  LEC: 'lecture', LCD: 'lecture', OLC: 'lecture', ONL: 'lecture', LEL: 'lecture', OLL: 'lecture',
  DIS: 'discussion', OD: 'discussion', Q: 'discussion', OQ: 'discussion', LBD: 'discussion', OLB: 'discussion', ODS: 'discussion',
  LAB: 'lab', OLA: 'lab',
};
const roleOf = (typeCode) => ROLE[typeCode] || typeCode || 'other';
const keyOf = (section) => section.number?.[0] || '';

// Two sections of the same bundle can't meet at the same time (e.g. a lecture and its lab).
function sectionsOverlap(a, b) {
  if (a.partOfTerm !== '1' && b.partOfTerm !== '1' && a.partOfTerm !== b.partOfTerm) return false;
  return a.meetings.some((m) => b.meetings.some((n) =>
    m.start != null && n.start != null && m.days.some((d) => n.days.includes(d)) && m.start < n.end && n.start < m.end));
}

const AVAIL_RANK = { open: 3, restricted: 2, unknown: 1, closed: 0 };

export function meetingSignature(meetings) {
  return meetings
    .map((m) => `${m.days.join('')}${m.start ?? 'x'}-${m.end ?? 'x'}@${m.building}`)
    .sort()
    .join('|');
}

/**
 * Build all valid bundles for a course.
 * Returns [{ id, courseCode, sections:[...], crns, meetings, partOfTerm, alternatives }]
 * where identical-time bundles are collapsed and listed in `alternatives`.
 */
export function buildBundles(course, { maxBundles = 3000 } = {}) {
  const sections = course.sections.filter((s) => s.meetings.length);
  if (!sections.length) return [];

  const byRole = new Map();
  for (const s of sections) {
    const r = roleOf(s.typeCode);
    if (!byRole.has(r)) byRole.set(r, []);
    byRole.get(r).push(s);
  }
  const ORDER = ['lecture', 'discussion', 'lab'];
  const rank = (r) => (ORDER.includes(r) ? ORDER.indexOf(r) : 9);
  const roles = [...byRole.keys()].sort((a, b) => rank(a) - rank(b));
  const roleKeys = new Map(roles.map((r) => [r, new Set(byRole.get(r).map(keyOf))]));

  const compatible = (a, b) => {
    const ra = roleOf(a.typeCode), rb = roleOf(b.typeCode);
    const ka = keyOf(a), kb = keyOf(b);
    if (roleKeys.get(rb).has(ka) && roleKeys.get(ra).has(kb)) return ka === kb;
    return true;
  };

  const raw = [];
  const walk = (i, picked) => {
    if (raw.length >= maxBundles) return;
    if (i === roles.length) { raw.push([...picked]); return; }
    for (const s of byRole.get(roles[i])) {
      if (picked.every((p) => compatible(p, s) && !sectionsOverlap(p, s))) {
        picked.push(s); walk(i + 1, picked); picked.pop();
      }
    }
  };
  walk(0, []);

  // Collapse bundles that meet at identical times/places; keep the most available as primary.
  const groups = new Map();
  for (const secs of raw) {
    const meetings = secs.flatMap((s) => s.meetings.map((m) => ({ ...m, sectionNumber: s.number, crn: s.crn })));
    const sig = meetingSignature(meetings) + '#' + secs.map((s) => s.partOfTerm).join('');
    const level = Math.min(...secs.map((s) => AVAIL_RANK[availabilityLevel(s.availability || '')]));
    const b = {
      courseCode: course.code,
      title: course.title,
      credits: course.credits,
      sections: secs,
      crns: secs.map((s) => s.crn),
      label: secs.map((s) => s.number).join(' + '),
      meetings,
      partOfTerm: secs.find((s) => s.partOfTerm !== '1')?.partOfTerm || '1',
      availRank: level,
    };
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(b);
  }
  return [...groups.values()].map((list, idx) => {
    list.sort((a, b) => b.availRank - a.availRank);
    const [primary, ...rest] = list;
    return {
      ...primary,
      id: `${course.code}#${idx}`,
      alternatives: rest.map((r) => ({ crns: r.crns, label: r.label, availRank: r.availRank })),
    };
  });
}

/** Human description of the linking for the UI. */
export function describeLinking(course) {
  const roles = {};
  for (const s of course.sections) (roles[roleOf(s.typeCode)] ||= new Set()).add(s.type || s.typeCode);
  const parts = Object.entries(roles).map(([r, types]) => `one ${r} (${[...types].join(' or ')})`);
  return parts.length > 1 ? `Register for ${parts.join(' + ')}.` : 'Register for one section.';
}
