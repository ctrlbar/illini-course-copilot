// Course search across every course offered this term, enriched with GPA + gen-ed data.
import { getCourseIndex, normalizeCode } from './courseExplorer.js';
import { courseGpa, genEdsFor, genEdCount } from './datasets.js';

/**
 * opts = { query, subject, genEd: 'HUM', sub: 'LA', minGpa, level: 100|200|300|400, limit }
 */
export async function searchCourses(opts = {}) {
  const index = await getCourseIndex();
  const q = (opts.query || '').trim().toLowerCase();
  const code = normalizeCode(q);
  const words = q.split(/\s+/).filter(Boolean);
  const limit = Math.min(opts.limit || 30, 100);

  const results = [];
  for (const c of index) {
    if (opts.subject && !c.code.startsWith(opts.subject.toUpperCase() + ' ')) continue;
    const num = Number(c.code.split(' ')[1]);
    if (opts.level && Math.floor(num / 100) * 100 !== Number(opts.level)) continue;
    const ge = genEdsFor(c.code);
    if (opts.genEd && !ge[opts.genEd]) continue;
    if (opts.sub && !Object.values(ge).includes(opts.sub)) continue;
    const g = courseGpa(c.code);
    if (opts.minGpa && (!g || g.avg < opts.minGpa)) continue;

    let score = 0;
    if (q) {
      const hay = `${c.code} ${c.title} ${c.subjectName}`.toLowerCase();
      if (code && c.code === code) score = 100;
      else if (code && c.code.startsWith(code.slice(0, -1))) score = 40;
      else if (hay.includes(q)) score = 50;
      else {
        const hits = words.filter((w) => hay.includes(w)).length;
        if (!hits) continue;
        score = (hits / words.length) * 30;
      }
    }
    score += genEdCount(c.code) * 2 + (g ? (g.avg - 3) * 5 : 0);
    results.push({
      code: c.code, title: c.title, subjectName: c.subjectName,
      gpa: g?.avg ?? null, gpaN: g?.n ?? 0,
      genEds: ge,
      score,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return { total: results.length, results: results.slice(0, limit) };
}
