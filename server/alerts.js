// Seat alerts + registration reminders.
// A poller re-checks watched sections every few minutes and notifies on Closed -> Open
// via browser (Server-Sent Events), Discord webhook, and/or email (if SMTP is configured).
// It also keeps a status history so students can see how often a section opens up.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { getCourse, availabilityLevel, normalizeCode } from './courseExplorer.js';

const FILE = path.join(config.dataDir, 'alerts.json');
let db = { alerts: [], reminders: [], history: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* first run */ }
const save = () => fs.writeFile(FILE, JSON.stringify(db, null, 2), () => {});

// ---------------- browser push via SSE ----------------
const clients = new Map(); // clientId -> Set(res)

export function sseHandler(req, res) {
  const clientId = String(req.query.clientId || '');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`event: hello\ndata: {}\n\n`);
  if (!clients.has(clientId)) clients.set(clientId, new Set());
  clients.get(clientId).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.get(clientId)?.delete(res); });
}

function pushToClient(clientId, event) {
  for (const res of clients.get(clientId) || []) res.write(`event: notify\ndata: ${JSON.stringify(event)}\n\n`);
}

// ---------------- notification channels ----------------
let mailer = null;
async function getMailer() {
  if (!config.smtp.host) return null;
  if (!mailer) {
    const nodemailer = (await import('nodemailer')).default;
    mailer = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return mailer;
}

async function notify(target, { title, body, url }) {
  const results = [];
  pushToClient(target.clientId, { title, body, url });
  results.push('browser');
  if (target.discordWebhook && /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(target.discordWebhook)) {
    try {
      await fetch(target.discordWebhook, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `**${title}**\n${body}${url ? `\n${url}` : ''}` }),
      });
      results.push('discord');
    } catch (e) { console.warn('[alerts] discord failed', e.message); }
  }
  if (target.email) {
    const m = await getMailer();
    if (m) {
      try {
        await m.sendMail({ from: config.smtp.from || config.smtp.user, to: target.email, subject: title, text: `${body}\n${url || ''}` });
        results.push('email');
      } catch (e) { console.warn('[alerts] email failed', e.message); }
    }
  }
  return results;
}

// ---------------- alerts CRUD ----------------
export function listAlerts(clientId) {
  return db.alerts.filter((a) => a.clientId === clientId).map((a) => ({ ...a, history: (db.history[a.crn] || []).slice(-20) }));
}

export async function addAlert({ clientId, courseCode, crn, discordWebhook, email }) {
  const code = normalizeCode(courseCode);
  if (!clientId || !code || !/^\d{5}$/.test(String(crn))) throw new Error('clientId, courseCode and a 5-digit CRN are required');
  const existing = db.alerts.find((a) => a.clientId === clientId && a.crn === String(crn));
  if (existing) return existing;
  const course = await getCourse(code, { fresh: true });
  const section = course?.sections.find((s) => s.crn === String(crn));
  if (!section) throw new Error(`CRN ${crn} not found in ${code}`);
  const alert = {
    id: crypto.randomUUID(), clientId, courseCode: code, crn: String(crn), section: section.number, type: section.type,
    title: course.title, lastStatus: section.availability, createdAt: new Date().toISOString(),
    discordWebhook: discordWebhook || '', email: email || '', triggered: [],
  };
  db.alerts.push(alert);
  recordHistory(alert.crn, section.availability);
  save();
  return alert;
}

export function removeAlert(clientId, id) {
  const before = db.alerts.length;
  db.alerts = db.alerts.filter((a) => !(a.clientId === clientId && a.id === id));
  save();
  return before !== db.alerts.length;
}

export function updateChannels(clientId, { discordWebhook, email }) {
  for (const a of db.alerts) if (a.clientId === clientId) { a.discordWebhook = discordWebhook ?? a.discordWebhook; a.email = email ?? a.email; }
  for (const r of db.reminders) if (r.clientId === clientId) { r.discordWebhook = discordWebhook ?? r.discordWebhook; r.email = email ?? r.email; }
  save();
}

function recordHistory(crn, status) {
  const h = (db.history[crn] ||= []);
  if (!h.length || h[h.length - 1].status !== status) h.push({ status, at: new Date().toISOString() });
  if (h.length > 200) h.splice(0, h.length - 200);
}

// ---------------- reminders (registration time tickets etc.) ----------------
export function listReminders(clientId) { return db.reminders.filter((r) => r.clientId === clientId); }
export function addReminder({ clientId, when, label, discordWebhook, email }) {
  const t = new Date(when);
  if (!clientId || Number.isNaN(t.getTime())) throw new Error('clientId and a valid date/time are required');
  const r = { id: crypto.randomUUID(), clientId, when: t.toISOString(), label: label || 'Registration time ticket opens', discordWebhook: discordWebhook || '', email: email || '', sent: [] };
  db.reminders.push(r);
  save();
  return r;
}
export function removeReminder(clientId, id) {
  db.reminders = db.reminders.filter((r) => !(r.clientId === clientId && r.id === id));
  save();
}

// ---------------- pollers ----------------
export async function pollOnce() {
  const byCourse = new Map();
  for (const a of db.alerts) {
    if (!byCourse.has(a.courseCode)) byCourse.set(a.courseCode, []);
    byCourse.get(a.courseCode).push(a);
  }
  let changes = 0;
  for (const [code, alerts] of byCourse) {
    let course;
    try { course = await getCourse(code, { fresh: true }); } catch (e) { console.warn('[alerts] poll failed', code, e.message); continue; }
    if (!course) continue;
    for (const a of alerts) {
      const s = course.sections.find((x) => x.crn === a.crn);
      if (!s) continue;
      const prev = availabilityLevel(a.lastStatus);
      const now = availabilityLevel(s.availability);
      recordHistory(a.crn, s.availability);
      if (prev === 'closed' && now !== 'closed' && now !== 'unknown') {
        const via = await notify(a, {
          title: `Seat open: ${a.courseCode} ${a.section} (CRN ${a.crn})`,
          body: `${a.title} is now "${s.availability}". Register fast!`,
          url: `https://courses.illinois.edu/schedule/${config.term.year}/${config.term.season}/${code.replace(' ', '/')}`,
        });
        a.triggered.push({ at: new Date().toISOString(), status: s.availability, via });
        changes++;
      }
      a.lastStatus = s.availability;
      a.lastChecked = new Date().toISOString();
    }
  }
  save();
  return changes;
}

async function checkReminders() {
  const now = Date.now();
  for (const r of db.reminders) {
    const t = new Date(r.when).getTime();
    for (const [label, offset] of [['1 hour', 3600_000], ['now', 0]]) {
      if (r.sent.includes(label) || now < t - offset || now > t + 3600_000) continue;
      r.sent.push(label);
      await notify(r, { title: label === 'now' ? `⏰ ${r.label} — now!` : `⏰ ${r.label} in 1 hour`, body: 'Have your CRNs ready (copy them from your saved schedule).' });
      save();
    }
  }
}

export function startPollers() {
  const ms = config.alerts.pollMinutes * 60_000;
  setInterval(() => pollOnce().catch((e) => console.warn('[alerts]', e.message)), ms);
  setInterval(() => checkReminders().catch((e) => console.warn('[reminders]', e.message)), 30_000);
  console.log(`[alerts] polling watched sections every ${config.alerts.pollMinutes} min`);
}
