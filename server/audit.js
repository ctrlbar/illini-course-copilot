// Degree audit import (UIUC DARS / uAchieve).
// Students upload the audit PDF or paste its text. We pull out:
//   - courses taken (completed, in progress, failed/withdrawn ignored)
//   - requirements the audit marks as NOT satisfied, with "NEEDS" and "SELECT FROM" course lists
// Personal identifiers (UIN, name lines, emails) are stripped before anything is sent to Grok.
// Nothing from the audit is stored on the server.
import { normalizeCode } from './courseExplorer.js';
import { grokEnabled, askJson } from './grok.js';

export async function pdfToText(buffer) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join('\n') : text;
}

export function redact(text) {
  return String(text)
    .split('\n')
    .filter((l) => !/\b(UIN|student id|student name|name\s*:|prepared for|prepared on|e-?mail|address|date of birth)\b/i.test(l))
    .join('\n')
    .replace(/\b\d{9}\b/g, '[ID]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]');
}

const NOT_EARNED = new Set(['W', 'F', 'AU', 'NR', 'U', 'I', 'DFR', 'ABS', 'X', 'NC', 'WF']);
const IN_PROGRESS = new Set(['IP', 'PR', 'RG', 'REG', '']);
const TERM = '(?:FA|SP|SU|WI|F|S|U)\\s?\\d{2}';
const COURSE_LINE = new RegExp(`\\b(${TERM})\\s+([A-Z]{2,4})\\s{0,3}(\\d{3})\\s+(\\d{1,2}(?:\\.\\d)?)\\s+([A-Z]{1,3}[+-]?|>?[A-Z]{1,2})?`, 'g');
const CODE = /\b([A-Z]{2,4})\s{1,3}(\d{3})\b/g;

/** Rule-based DARS parser (works offline). */
export function parseAuditRules(text) {
  const courses = new Map();
  for (const m of text.matchAll(COURSE_LINE)) {
    const code = normalizeCode(`${m[2]} ${m[3]}`);
    const grade = (m[5] || '').replace('>', '').toUpperCase();
    if (!code || NOT_EARNED.has(grade)) continue;
    const status = IN_PROGRESS.has(grade) ? 'inProgress' : 'completed';
    const prev = courses.get(code);
    if (!prev || (prev.status === 'inProgress' && status === 'completed')) {
      courses.set(code, { code, term: m[1].replace(/\s/g, ''), hours: Number(m[4]), grade: grade || 'IP', status });
    }
  }

  const requirements = [];
  let cur = null;
  let collecting = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const needsFirst = line.match(/^[-+]?\s*NEEDS?:\s*(.+)/i);
    if (needsFirst && cur) { cur.needs = (cur.needs ? cur.needs + '; ' : '') + needsFirst[1].trim(); collecting = false; continue; }
    const head = line.match(/^(NO|OK|IP|\+|-)\s+([A-Z0-9][A-Z0-9 &,/:()'+.-]{4,})$/);
    if (head && line === line.toUpperCase() && !/^(NO|OK|IP) (COURSES|HOURS)\b/.test(line)) {
      const status = { NO: 'incomplete', '-': 'incomplete', OK: 'complete', '+': 'complete', IP: 'in-progress' }[head[1]];
      cur = { title: head[2].trim(), status, needs: '', options: [] };
      requirements.push(cur);
      collecting = false;
      continue;
    }
    if (!cur) continue;
    const needs = line.match(/NEEDS?:\s*(.+)/i);
    if (needs) { cur.needs = (cur.needs ? cur.needs + '; ' : '') + needs[1].trim(); collecting = false; continue; }
    if (/SELECT FROM:|COURSE LIST:|CHOOSE FROM:/i.test(line)) collecting = true;
    if (collecting) {
      for (const m of line.matchAll(CODE)) {
        const code = normalizeCode(`${m[1]} ${m[2]}`);
        if (code && !cur.options.includes(code)) cur.options.push(code);
      }
    }
  }
  const earned = text.match(/EARNED:?\s*(\d{1,3}(?:\.\d)?)\s*HOURS/i)?.[1];
  return {
    courses: [...courses.values()],
    requirements: requirements.filter((r) => r.status !== 'complete'),
    earnedHours: earned ? Number(earned) : null,
  };
}

const AUDIT_PROMPT = `You read a University of Illinois Urbana-Champaign degree audit (DARS) and return ONLY JSON:
{"program": "major name if shown",
 "earnedHours": number or null,
 "courses": [{"code": "CS 124", "term": "FA24", "grade": "A", "hours": 3, "status": "completed|inProgress"}],
 "requirements": [{"title": "requirement name", "status": "incomplete|in-progress", "needs": "what is still needed, e.g. 2 courses / 6 hours", "count": number of courses still needed or null, "options": ["CS 341", "CS 357"]}]}
Rules: include every course taken (AP/transfer credit counts as completed; IP/registered = inProgress); skip W, F, NR, AU grades.
List ONLY requirements that are NOT yet satisfied. "options" = specific course codes from the audit's select-from list (may be empty).
Course codes are "SUBJ 123". Do not invent anything not in the audit.`;

/** Parse an audit; Grok when available (more robust to formatting), rules as a fallback and cross-check. */
export async function parseAudit(text) {
  const clean = redact(text);
  const rules = parseAuditRules(clean);
  let result = { ...rules, source: 'rules' };
  if (grokEnabled() && clean.length > 200) {
    try {
      const g = await askJson(AUDIT_PROMPT, clean.slice(0, 60000));
      if (g?.courses?.length) {
        const byCode = new Map(rules.courses.map((c) => [c.code, c]));
        for (const c of g.courses) {
          const code = normalizeCode(c.code);
          if (!code) continue;
          if (!byCode.has(code) || (byCode.get(code).status === 'inProgress' && c.status === 'completed')) {
            byCode.set(code, { code, term: c.term || '', grade: c.grade || '', hours: Number(c.hours) || null, status: c.status === 'inProgress' ? 'inProgress' : 'completed' });
          }
        }
        result = {
          program: g.program || null,
          courses: [...byCode.values()],
          requirements: (g.requirements?.length ? g.requirements : rules.requirements).map((r) => ({
            title: r.title, status: r.status || 'incomplete', needs: r.needs || '', count: r.count ?? null,
            options: (r.options || []).map(normalizeCode).filter(Boolean),
          })),
          earnedHours: g.earnedHours ?? rules.earnedHours,
          source: 'grok',
        };
      }
    } catch (e) { console.warn('[audit] Grok parse failed, using rules:', e.message); }
  }
  const warnings = [];
  if (!result.courses.length) warnings.push("Couldn't find any courses. Make sure you uploaded the full DARS audit (PDF or the copied text).");
  return {
    ...result,
    completed: result.courses.filter((c) => c.status === 'completed').map((c) => c.code),
    inProgress: result.courses.filter((c) => c.status === 'inProgress').map((c) => c.code),
    warnings,
  };
}

/** How many courses a requirement still needs ("NEEDS: 2 COURSES" -> 2). */
export function neededCount(req) {
  if (Number.isFinite(req.count) && req.count > 0) return req.count;
  const m = String(req.needs || '').match(/(\d+)\s*(?:COURSES?|CLASSES)/i);
  if (m) return Number(m[1]);
  const h = String(req.needs || '').match(/(\d+(?:\.\d)?)\s*(?:HOURS?|HRS?|CREDITS?)/i);
  if (h) return Math.max(1, Math.round(Number(h[1]) / 3));
  return 1;
}
