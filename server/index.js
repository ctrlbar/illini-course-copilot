import express from 'express';
import path from 'node:path';
import { config, termLabel } from './config.js';
import { getCourse, getCourseIndex, normalizeCode } from './courseExplorer.js';
import { buildBundles, describeLinking } from './sections.js';
import { courseEligibility } from './eligibility.js';
import { courseGpa, instructorGpa, instructorsFor, gradeLabels, GENED_CATEGORIES } from './datasets.js';
import { searchCourses } from './search.js';
import { generateSchedules, DEFAULT_WEIGHTS, COMPONENT_LABELS } from './scheduler.js';
import { listPrograms } from './catalog.js';
import { buildRoadmap } from './roadmap.js';
import { grokEnabled, agentReply, parseScheduleRequest } from './grok.js';
import * as alerts from './alerts.js';
import { scheduleToIcs, reminderToIcs } from './ics.js';
import { parseAudit, pdfToText } from './audit.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(config.root, 'public')));

const route = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (e) {
    console.error(`[api] ${req.method} ${req.path}:`, e.message);
    res.status(e.status === 404 ? 404 : 400).json({ error: e.message });
  }
};

app.get('/api/meta', route(() => ({
  term: config.term, termLabel: termLabel(), grok: grokEnabled(), model: grokEnabled() ? config.grok.model : null,
  genEdCategories: GENED_CATEGORIES, weights: DEFAULT_WEIGHTS, weightLabels: COMPONENT_LABELS,
})));

app.get('/api/programs', route(() => listPrograms()));

app.get('/api/search', route((req) => searchCourses({
  query: req.query.q, subject: req.query.subject, genEd: req.query.genEd, sub: req.query.sub,
  minGpa: req.query.minGpa ? Number(req.query.minGpa) : undefined, level: req.query.level, limit: Number(req.query.limit) || 40,
})));

app.post('/api/course', route(async (req) => {
  const code = normalizeCode(req.body.code);
  const course = await getCourse(code, { fresh: Boolean(req.body.fresh) });
  if (!course) { const e = new Error(`${code} is not offered in ${termLabel()}`); e.status = 404; throw e; }
  const profile = req.body.profile || {};
  const elig = courseEligibility(course, profile);
  return {
    ...course,
    linking: describeLinking(course),
    bundleCount: buildBundles(course).length,
    eligibility: elig,
    gpa: courseGpa(course.code),
    gradeLabels,
    instructorStats: instructorsFor(course.code).slice(0, 8),
    sections: course.sections.map((s) => ({
      ...s,
      restriction: elig.sections.find((x) => x.crn === s.crn),
      instructorGpa: s.meetings.flatMap((m) => m.instructors).map((i) => instructorGpa(course.code, i)).find(Boolean) || null,
    })),
  };
}));

app.post('/api/schedules/parse', route((req) => parseScheduleRequest(String(req.body.text || ''))));

app.post('/api/schedules', route(async (req) => {
  let request = req.body;
  if (request.text) {
    const parsed = await parseScheduleRequest(request.text);
    request = { ...parsed, ...request, courses: [...new Set([...(parsed.courses || []), ...(request.courses || [])])], constraints: { ...parsed.constraints, ...request.constraints } };
  }
  const result = await generateSchedules(request);
  return { request, ...result };
}));

// Degree audit import: PDF upload (application/pdf body) or { text } JSON. Nothing is stored server-side.
app.post('/api/audit', express.raw({ type: 'application/pdf', limit: '15mb' }), route(async (req) => {
  const text = req.is('application/pdf') ? await pdfToText(req.body) : String(req.body?.text || '');
  if (text.trim().length < 50) throw new Error('That audit looks empty. Upload the DARS PDF or paste the full audit text.');
  return parseAudit(text);
}));

app.post('/api/roadmap', route((req) => buildRoadmap(req.body.profile || {})));

app.post('/api/chat', route((req) => agentReply(req.body.messages || [], req.body.profile || {})));

app.post('/api/ics', (req, res) => {
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="uiuc-schedule.ics"');
  res.send(scheduleToIcs(req.body.schedule || {}, `UIUC ${termLabel()}`));
});
app.post('/api/ics/reminder', (req, res) => {
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="registration-reminder.ics"');
  res.send(reminderToIcs(req.body));
});

// ---- alerts & reminders (identified by an anonymous per-browser clientId) ----
app.get('/api/events', alerts.sseHandler);
app.get('/api/alerts', route((req) => ({ alerts: alerts.listAlerts(req.query.clientId), reminders: alerts.listReminders(req.query.clientId), pollMinutes: config.alerts.pollMinutes, email: Boolean(config.smtp.host) })));
app.post('/api/alerts', route((req) => alerts.addAlert(req.body)));
app.delete('/api/alerts/:id', route((req) => ({ ok: alerts.removeAlert(req.query.clientId, req.params.id) })));
app.post('/api/alerts/channels', route((req) => { alerts.updateChannels(req.body.clientId, req.body); return { ok: true }; }));
app.post('/api/alerts/check', route(async () => ({ changes: await alerts.pollOnce() })));
app.post('/api/reminders', route((req) => alerts.addReminder(req.body)));
app.delete('/api/reminders/:id', route((req) => { alerts.removeReminder(req.query.clientId, req.params.id); return { ok: true }; }));

app.listen(config.port, () => {
  console.log(`Illini Course Copilot running at http://localhost:${config.port}`);
  console.log(`  term: ${termLabel()} | Grok: ${grokEnabled() ? config.grok.model : 'off (demo mode — set XAI_API_KEY)'}`);
  alerts.startPollers();
  getCourseIndex().then((i) => console.log(`  course index ready: ${i.length} courses`)).catch((e) => console.warn('  course index failed:', e.message));
});
