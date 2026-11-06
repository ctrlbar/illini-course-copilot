// Data layer for the public UIUC Course Explorer (courses.illinois.edu).
// - XML API (cisapp/explorer) for courses, sections, meetings, restrictions, gen eds
// - The public schedule web page for live seat availability (not in the XML API)
import { XMLParser } from 'fast-xml-parser';
import { config } from './config.js';
import { fetchText, cached, mapLimit, MIN, HOUR, DAY } from './http.js';

const BASE = 'https://courses.illinois.edu/cisapp/explorer';
const ARRAYS = new Set([
  'detailedSection', 'meeting', 'instructor', 'category', 'genEdAttribute',
  'subject', 'course', 'section',
]);
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  textNodeName: '#text',
  isArray: (name, jpath) => ARRAYS.has(name) && jpath.includes('.'),
});

const txt = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return String(v['#text'] ?? '').trim();
  return String(v).trim();
};

export function normalizeCode(input) {
  const m = String(input).toUpperCase().match(/([A-Z]{2,4})\s*(\d{3})/);
  return m ? `${m[1]} ${m[2]}` : null;
}

export const termPath = (t = config.term) => `${t.year}/${t.season}`;

/** "11:00AM" -> minutes after midnight */
export function parseTime(s) {
  const m = String(s || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  return h * 60 + Number(m[2]);
}

function parseCredits(s) {
  const nums = (String(s).match(/\d+(\.\d+)?/g) || []).map(Number);
  if (!nums.length) return { min: 0, max: 0, text: s };
  return { min: Math.min(...nums), max: Math.max(...nums), text: s };
}

// ---------------- subjects & course lists ----------------

export function getSubjects(term = config.term) {
  return cached(`subjects:${termPath(term)}`, DAY, async () => {
    const x = parser.parse(await fetchText(`${BASE}/schedule/${termPath(term)}.xml`));
    const subs = x.term?.subjects?.subject || [];
    return subs.map((s) => ({ id: s['@id'], label: txt(s) }));
  });
}

export function getSubjectCourses(subject, term = config.term) {
  return cached(`subjectCourses:${termPath(term)}:${subject}`, DAY, async () => {
    const x = parser.parse(await fetchText(`${BASE}/schedule/${termPath(term)}/${subject}.xml`));
    const courses = x.subject?.courses?.course || [];
    return courses.map((c) => ({ code: `${subject} ${c['@id']}`, title: txt(c) }));
  });
}

/** Index of every course offered this term (built lazily, cached for a day). */
let indexPromise = null;
export function getCourseIndex(term = config.term) {
  if (!indexPromise) {
    indexPromise = cached(`courseIndex:${termPath(term)}`, DAY, async () => {
      const subjects = await getSubjects(term);
      const lists = await mapLimit(subjects, 4, (s) => getSubjectCourses(s.id, term));
      return lists.flatMap((l, i) => (l || []).map((c) => ({ ...c, subjectName: subjects[i].label })));
    }).catch((e) => { indexPromise = null; throw e; });
  }
  return indexPromise;
}

// ---------------- course detail ----------------

function parseSection(ds) {
  const meetings = (ds.meetings?.meeting || []).map((m) => {
    const days = txt(m.daysOfTheWeek).replace(/\s/g, '');
    return {
      typeCode: m.type?.['@code'] || '',
      type: txt(m.type),
      start: parseTime(txt(m.start)),
      end: parseTime(txt(m.end)),
      startText: txt(m.start),
      endText: txt(m.end),
      days: days ? days.split('') : [],
      building: txt(m.buildingName),
      room: txt(m.roomNumber),
      instructors: (m.instructors?.instructor || []).map((i) => ({
        last: String(i['@lastName'] || '').trim(),
        first: String(i['@firstName'] || '').trim(),
        name: txt(i),
      })),
    };
  });
  return {
    crn: String(ds['@id']),
    number: txt(ds.sectionNumber),
    typeCode: meetings[0]?.typeCode || '',
    type: meetings[0]?.type || '',
    statusCode: txt(ds.sectionStatusCode) || txt(ds.statusCode),
    partOfTerm: txt(ds.partOfTerm) || '1',
    startDate: txt(ds.startDate).replace('Z', ''),
    endDate: txt(ds.endDate).replace('Z', ''),
    text: txt(ds.sectionText),
    notes: txt(ds.sectionNotes),
    cappArea: txt(ds.sectionCappArea),
    title: txt(ds.sectionTitle),
    meetings,
    availability: null,
  };
}

function parseCourse(x, subject, number) {
  const c = x.course;
  const genEds = (c.genEdCategories?.category || []).flatMap((cat) =>
    (cat.genEdAttributes?.genEdAttribute || [{}]).map((a) => ({
      category: cat['@id'],
      categoryName: txt(cat.description),
      code: a['@code'] || '',
      name: txt(a),
    })),
  );
  return {
    code: `${subject} ${number}`,
    subject,
    number,
    title: txt(c.label),
    description: txt(c.description),
    credits: parseCredits(txt(c.creditHours)),
    prereqText: txt(c.courseSectionInformation),
    scheduleInfo: txt(c.classScheduleInformation),
    degreeAttributes: txt(c.sectionDegreeAttributes),
    genEds,
    sections: (c.detailedSections?.detailedSection || [])
      .map(parseSection)
      .filter((s) => !s.statusCode || s.statusCode === 'A'),
  };
}

/** Full course with sections + live availability. Returns null if not offered this term. */
export async function getCourse(code, { term = config.term, fresh = false } = {}) {
  const norm = normalizeCode(code);
  if (!norm) return null;
  const [subject, number] = norm.split(' ');
  let course;
  try {
    course = await cached(`course:${termPath(term)}:${norm}`, 6 * HOUR, async () => {
      const xml = await fetchText(`${BASE}/schedule/${termPath(term)}/${subject}/${number}.xml?mode=detail`);
      return parseCourse(parser.parse(xml), subject, number);
    });
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
  const avail = await getAvailability(norm, { term, fresh }).catch(() => ({}));
  return {
    ...course,
    offered: true,
    sections: course.sections.map((s) => ({ ...s, availability: avail[s.crn] || 'Unknown' })),
  };
}

/** Catalog info (description + prereqs) — works even if the course isn't offered this term. */
export async function getCatalogCourse(code, term = config.term) {
  const norm = normalizeCode(code);
  if (!norm) return null;
  const [subject, number] = norm.split(' ');
  try {
    return await cached(`catalog:${termPath(term)}:${norm}`, 7 * DAY, async () => {
      const x = parser.parse(await fetchText(`${BASE}/catalog/${termPath(term)}/${subject}/${number}.xml`));
      const c = x.course;
      return {
        code: norm,
        title: txt(c.label),
        description: txt(c.description),
        credits: parseCredits(txt(c.creditHours)),
        prereqText: txt(c.courseSectionInformation) || txt(c.description),
      };
    });
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// ---------------- live availability (scraped from public schedule page) ----------------

export function parseAvailabilityHtml(html) {
  const out = {};
  const parts = html.split('/userredirect/favorite/');
  for (let i = 1; i < parts.length; i++) {
    const crn = parts[i].match(/^\d{4}\/[a-z]+\/[A-Z]+\/\d+\/(\d+)/)?.[1];
    const avail = parts[i].match(/<dt>Availability:<\/dt>\s*<dd>([^<]+)<\/dd>/)?.[1];
    if (crn && avail && !out[crn]) out[crn] = avail.trim();
  }
  return out;
}

export function getAvailability(code, { term = config.term, fresh = false } = {}) {
  const [subject, number] = normalizeCode(code).split(' ');
  return cached(`avail:${termPath(term)}:${subject} ${number}`, 5 * MIN, async () => {
    const html = await fetchText(`https://courses.illinois.edu/schedule/${termPath(term)}/${subject}/${number}`);
    return parseAvailabilityHtml(html);
  }, { force: fresh });
}

/** Simplify the many availability strings into open / restricted / closed / unknown. */
export function availabilityLevel(a = '') {
  const s = a.toLowerCase();
  if (s.includes('closed')) return 'closed';
  if (s.includes('restricted')) return 'restricted';
  if (s.includes('open')) return 'open';
  return 'unknown';
}
