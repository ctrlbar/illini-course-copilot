// GPA + gen-ed datasets (built by `npm run setup-data`).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(config.dataDir, name), 'utf8')); }
  catch {
    console.warn(`[datasets] data/${name} missing — run "npm run setup-data" for GPA / gen-ed features`);
    return fallback;
  }
}

const gpa = load('gpa.json', { grades: [], courses: {} });
const geneds = load('geneds.json', {});

export const GENED_CATEGORIES = {
  ACP: { name: 'Advanced Composition', subs: { ACP: 'Advanced Composition' } },
  CS: { name: 'Cultural Studies', subs: { US: 'US Minority Cultures', NW: 'Non-Western Cultures', WCC: 'Western/Comparative Cultures' } },
  HUM: { name: 'Humanities & the Arts', subs: { HP: 'Historical & Philosophical Perspectives', LA: 'Literature & the Arts' } },
  NAT: { name: 'Natural Sciences & Technology', subs: { LS: 'Life Sciences', PS: 'Physical Sciences' } },
  QR: { name: 'Quantitative Reasoning', subs: { QR1: 'Quantitative Reasoning I', QR2: 'Quantitative Reasoning II' } },
  SBS: { name: 'Social & Behavioral Sciences', subs: { SS: 'Social Sciences', BSC: 'Behavioral Sciences' } },
};

export const gradeLabels = gpa.grades;

export function courseGpa(code) {
  const c = gpa.courses[code];
  return c ? { avg: c.avg, n: c.n, dist: c.dist } : null;
}

/** GPA for a specific instructor teaching this course (matched by last name + first initial). */
export function instructorGpa(code, instructor) {
  const c = gpa.courses[code];
  if (!c || !instructor?.last) return null;
  const last = instructor.last.trim().toLowerCase();
  const fi = (instructor.first || '').trim().toLowerCase()[0] || '';
  const exact = c.instructors[`${last}|${fi}`];
  if (exact) return exact;
  const byLast = Object.entries(c.instructors).filter(([k]) => k.startsWith(`${last}|`));
  return byLast.length === 1 ? byLast[0][1] : null;
}

export function instructorsFor(code) {
  const c = gpa.courses[code];
  if (!c) return [];
  return Object.values(c.instructors).sort((a, b) => b.n - a.n);
}

export function genEdsFor(code) {
  return geneds[code]?.cats || {};
}

/** Every gen-ed course matching category (e.g. "HUM") and optional sub-attribute (e.g. "LA"). */
export function genEdCourses(category, sub) {
  return Object.entries(geneds)
    .filter(([, v]) => v.cats[category] && (!sub || v.cats[category] === sub))
    .map(([code, v]) => ({ code, title: v.title, cats: v.cats, gpa: gpa.courses[code]?.avg ?? null }));
}

/** How many gen-ed requirements a course knocks out at once. */
export const genEdCount = (code) => Object.keys(geneds[code]?.cats || {}).length;
