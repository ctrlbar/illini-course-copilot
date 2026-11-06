// Downloads public UIUC datasets (Prof. Wade Fagen-Ulmschneider, github.com/wadefagen/datasets)
// and condenses them into small JSON files the server loads at startup.
//   data/gpa.json     — average GPA + grade distribution per course and per instructor
//   data/geneds.json  — gen-ed categories for every course this term
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const GPA_URL = 'https://raw.githubusercontent.com/wadefagen/datasets/master/gpa/uiuc-gpa-dataset.csv';
const GENED_URL = 'https://raw.githubusercontent.com/wadefagen/datasets/master/geneds/gened-courses.csv';
const GRADES = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F'];
const POINTS = [4, 4, 3.67, 3.33, 3, 2.67, 2.33, 2, 1.67, 1.33, 1, 0.67, 0];

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

async function download(url) {
  process.stdout.write(`Downloading ${url} ... `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const t = await res.text();
  console.log(`${(t.length / 1e6).toFixed(1)} MB`);
  return t;
}

const instructorKey = (name) => {
  // "Erickson, Jeff G" -> "erickson|j"
  const [last, first = ''] = name.split(',').map((s) => s.trim().toLowerCase());
  return `${last}|${first[0] || ''}`;
};

async function buildGpa() {
  const rows = parseCsv(await download(GPA_URL));
  const minYear = new Date().getFullYear() - 6; // recent data only
  const courses = {};
  for (const r of rows) {
    if (Number(r.Year) < minYear) continue;
    const code = `${r.Subject} ${r.Number}`;
    const counts = GRADES.map((g) => Number(r[g]) || 0);
    const c = (courses[code] ||= { title: r['Course Title'], dist: GRADES.map(() => 0), instructors: {} });
    counts.forEach((n, i) => { c.dist[i] += n; });
    const key = instructorKey(r['Primary Instructor'] || '');
    const ins = (c.instructors[key] ||= { name: r['Primary Instructor'], dist: GRADES.map(() => 0), terms: new Set() });
    counts.forEach((n, i) => { ins.dist[i] += n; });
    ins.terms.add(r.YearTerm);
  }
  const avg = (dist) => {
    const n = dist.reduce((a, b) => a + b, 0);
    return n ? +(dist.reduce((s, k, i) => s + k * POINTS[i], 0) / n).toFixed(2) : null;
  };
  const out = {};
  for (const [code, c] of Object.entries(courses)) {
    const n = c.dist.reduce((a, b) => a + b, 0);
    if (!n) continue;
    out[code] = {
      title: c.title, avg: avg(c.dist), n, dist: c.dist,
      instructors: Object.fromEntries(Object.entries(c.instructors).map(([k, v]) => [k, {
        name: v.name, avg: avg(v.dist), n: v.dist.reduce((a, b) => a + b, 0), terms: v.terms.size,
      }])),
    };
  }
  fs.writeFileSync(path.join(dataDir, 'gpa.json'), JSON.stringify({ grades: GRADES, courses: out }));
  console.log(`  -> gpa.json (${Object.keys(out).length} courses)`);
}

async function buildGeneds() {
  const rows = parseCsv(await download(GENED_URL));
  const out = {};
  for (const r of rows) {
    const cats = {};
    for (const k of ['ACP', 'CS', 'HUM', 'NAT', 'QR', 'SBS']) if (r[k]) cats[k] = r[k];
    out[r.Course] = { title: r['Course Title'], term: r.TermYear, cats };
  }
  fs.writeFileSync(path.join(dataDir, 'geneds.json'), JSON.stringify(out));
  console.log(`  -> geneds.json (${Object.keys(out).length} courses)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildGpa();
  await buildGeneds();
  console.log('Done.');
}
