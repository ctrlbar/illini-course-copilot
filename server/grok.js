// Grok (xAI) integration. xAI's API is OpenAI-compatible: POST /v1/chat/completions.
// Grok is used for language, never as the source of truth: it calls our tools, which
// answer from real Course Explorer / catalog data.
// Without XAI_API_KEY everything still works through rule-based fallbacks ("demo mode").
import { config, termLabel } from './config.js';
import { normalizeCode, getCourse } from './courseExplorer.js';
import { searchCourses } from './search.js';
import { generateSchedules } from './scheduler.js';
import { courseEligibility } from './eligibility.js';
import { describeLinking } from './sections.js';
import { courseGpa } from './datasets.js';
import { buildRoadmap } from './roadmap.js';

export const grokEnabled = () => Boolean(config.grok.apiKey);

export async function chat(messages, { tools, temperature = 0.3, json = false } = {}) {
  if (!grokEnabled()) throw new Error('XAI_API_KEY is not set');
  const body = { model: config.grok.model, messages, temperature };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  if (json) body.response_format = { type: 'json_object' };
  const res = await fetch(`${config.grok.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.grok.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`Grok API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices[0].message;
}

export function parseJson(text) {
  const t = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return null;
}

export async function askJson(system, user) {
  const msg = await chat([{ role: 'system', content: system }, { role: 'user', content: user }], { json: true });
  return parseJson(msg.content);
}

// ---------------- natural-language schedule requests ----------------

const DAY_WORDS = { monday: 'M', mon: 'M', tuesday: 'T', tue: 'T', tues: 'T', wednesday: 'W', wed: 'W', thursday: 'R', thu: 'R', thur: 'R', thurs: 'R', friday: 'F', fri: 'F' };
const GENED_WORDS = [
  [/humanit|\bhum\b/i, { category: 'HUM' }],
  [/literature|\barts?\b/i, { category: 'HUM', sub: 'LA' }],
  [/histor|philosoph/i, { category: 'HUM', sub: 'HP' }],
  [/social (?:&|and )?behav|\bsbs\b|social science/i, { category: 'SBS' }],
  [/natural science|\bnat\b|science gen/i, { category: 'NAT' }],
  [/non-?western/i, { category: 'CS', sub: 'NW' }],
  [/(?<!non-?)western|comparative/i, { category: 'CS', sub: 'WCC' }],
  [/us minority|minority/i, { category: 'CS', sub: 'US' }],
  [/cultural stud/i, { category: 'CS' }],
  [/quantitative|\bqr\b/i, { category: 'QR' }],
  [/advanced comp/i, { category: 'ACP' }],
];

function parseClock(h, m, ap) {
  let hour = Number(h) % 12;
  const pm = ap ? /p/i.test(ap) : Number(h) < 8; // "before 9" means 9am, "after 5" means 5pm
  if (pm) hour += 12;
  return hour * 60 + Number(m || 0);
}

/** Rule-based parser used in demo mode (and as a safety net). */
export function parseScheduleRequestFallback(text) {
  const courses = [...new Set((text.match(/\b[A-Za-z]{2,4}\s?\d{3}\b/g) || []).map(normalizeCode))];
  const constraints = {};
  const before = text.match(/(?:nothing|no class(?:es)?|not?)\s+(?:before|earlier than)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (before) constraints.earliestStart = parseClock(before[1], before[2], before[3] || 'am');
  const after = text.match(/(?:nothing|no class(?:es)?|not?)\s+(?:after|later than)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (after) constraints.latestEnd = parseClock(after[1], after[2], after[3]);
  const daysOff = new Set();
  for (const m of text.matchAll(/(monday|tuesday|wednesday|thursday|friday|mon|tues?|wed|thur?s?|fri)s?\s+(?:free|off)|no\s+(monday|tuesday|wednesday|thursday|friday|mon|tues?|wed|thur?s?|fri)s?/gi)) {
    daysOff.add(DAY_WORDS[(m[1] || m[2]).toLowerCase()]);
  }
  if (daysOff.size) constraints.daysOff = [...daysOff].filter(Boolean);
  if (/only open|open sections|seats? available/i.test(text)) constraints.onlyOpen = true;
  const genEds = [];
  for (const [re, spec] of GENED_WORDS) {
    if (re.test(text) && /gen ?ed|course|class|requirement/i.test(text)) {
      if (!genEds.some((g) => g.category === spec.category)) genEds.push(spec);
    }
  }
  const prefs = { preferMornings: /morning person|early classes|prefer mornings/i.test(text) };
  return { courses, genEds, constraints, prefs };
}

const SCHEDULE_PARSE_PROMPT = `You convert a UIUC student's scheduling request into JSON.
Return ONLY JSON: {"courses": ["CS 225"], "groups": [{"label": "...", "options": ["STAT 200","STAT 212"]}],
"genEds": [{"category": "HUM|SBS|NAT|QR|ACP|CS", "sub": "LA|HP|SS|BSC|LS|PS|US|NW|WCC|QR1|QR2 (optional)", "count": 1}],
"constraints": {"earliestStart": minutes after midnight or null, "latestEnd": minutes or null, "daysOff": ["M","T","W","R","F"], "onlyOpen": bool,
"blocked": [{"days": ["T","R"], "start": minutes, "end": minutes, "label": "work"}]},
"prefs": {"preferMornings": bool}, "weights": {"seats":1.5,"lateStart":1,"daysOff":1,"compact":1,"gpa":1,"walking":1,"lunch":0.5,"endEarly":0.5}}
Day letters: M T W R(Thursday) F. Adjust weights only if the student states priorities (e.g. "easy A" -> gpa 3).
Course codes look like "CS 225". "CS" category means Cultural Studies.`;

export async function parseScheduleRequest(text) {
  const fallback = parseScheduleRequestFallback(text);
  if (!grokEnabled()) return { ...fallback, parser: 'rules' };
  try {
    const out = await askJson(SCHEDULE_PARSE_PROMPT, text);
    if (out && (out.courses?.length || out.genEds?.length || out.groups?.length)) {
      out.courses = (out.courses || []).map(normalizeCode).filter(Boolean);
      return { ...out, parser: 'grok' };
    }
  } catch (e) { console.warn('[grok] parse failed, using rules:', e.message); }
  return { ...fallback, parser: 'rules' };
}

// ---------------- chat agent with tools ----------------

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_degree_plan',
      description: "Get the student's degree plan from their major's official requirements and their imported degree audit (DARS): what they still need, and the recommended courses for the NEXT term (the one being registered for). ALWAYS call this before recommending courses or a schedule.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_courses',
      description: 'Search courses offered this term by keyword, subject, gen-ed category, level or minimum average GPA.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }, subject: { type: 'string', description: 'e.g. CS, MATH' },
          genEd: { type: 'string', enum: ['HUM', 'SBS', 'NAT', 'QR', 'ACP', 'CS'] },
          sub: { type: 'string', description: 'gen-ed sub-attribute e.g. LA, HP, SS, BSC, LS, PS, US, NW, WCC' },
          level: { type: 'integer', enum: [100, 200, 300, 400] }, minGpa: { type: 'number' }, limit: { type: 'integer' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_course',
      description: 'Get details for one course: description, prerequisites, whether THIS student is eligible, sections with times and live seat availability, average GPA.',
      parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_schedules',
      description: 'Generate and rank conflict-free schedules. The UI shows the full ranked schedules on a calendar.',
      parameters: {
        type: 'object',
        properties: {
          courses: { type: 'array', items: { type: 'string' } },
          groups: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } } } },
          genEds: { type: 'array', items: { type: 'object', properties: { category: { type: 'string' }, sub: { type: 'string' }, count: { type: 'integer' } } } },
          constraints: {
            type: 'object',
            properties: {
              earliestStart: { type: 'integer', description: 'minutes after midnight' },
              latestEnd: { type: 'integer' }, daysOff: { type: 'array', items: { type: 'string' } }, onlyOpen: { type: 'boolean' },
            },
          },
          weights: { type: 'object', additionalProperties: { type: 'number' } },
        },
      },
    },
  },
];

function summarizeCourse(course, profile) {
  if (!course) return { error: 'Not offered this term' };
  const elig = courseEligibility(course, profile);
  return {
    code: course.code, title: course.title, credits: course.credits.text, description: course.description.slice(0, 600),
    prerequisites: course.prereqText, eligibility: { status: elig.status, summary: elig.summary },
    genEds: course.genEds.map((g) => g.name), avgGpa: courseGpa(course.code)?.avg ?? null,
    linking: describeLinking(course),
    sections: course.sections.slice(0, 40).map((s) => ({
      crn: s.crn, section: s.number, type: s.type, availability: s.availability,
      restriction: elig.sections.find((x) => x.crn === s.crn)?.reasons?.[0],
      meetings: s.meetings.map((m) => `${m.days.join('') || 'Online'} ${m.startText}-${m.endText} ${m.building}`.trim()),
      instructors: [...new Set(s.meetings.flatMap((m) => m.instructors.map((i) => i.name)))],
    })),
  };
}

async function degreePlanForAgent(profile) {
  const r = await buildRoadmap(profile, { ai: false });
  if (r.error) return { error: r.error };
  const next = r.terms[0];
  return {
    program: r.program.title,
    nextTerm: next?.name,
    recommendedNextTerm: (next?.courses || []).map((c) => ({
      code: c.code, title: c.code ? (c.suggestion || c.title) : c.title, credits: c.hours, kind: c.kind, alternatives: c.options,
    })),
    nextTermCredits: next?.credits,
    stillRequired: r.requirements.remaining.slice(0, 25).map((x) => `${x.code} ${x.title}${x.offeredNow ? '' : ' (not offered next term)'}`),
    auditUnmet: r.audit?.requirements.filter((q) => q.status === 'incomplete').map((q) => ({ requirement: q.title, needs: q.needs, options: q.options?.slice(0, 15) })) || null,
    warnings: r.warnings,
    howToUse: 'Use recommendedNextTerm courses that have a code as generate_schedules.courses. For slots without a code: Gen Ed slots -> genEds (pick categories the audit says are unmet), electives -> pick a code from auditUnmet options or search_courses. Aim for 15-16 credits.',
  };
}

async function runTool(name, args, profile, actions) {
  if (name === 'get_degree_plan') return degreePlanForAgent(profile);
  if (name === 'search_courses') return searchCourses({ ...args, limit: args.limit || 12 });
  if (name === 'get_course') return summarizeCourse(await getCourse(args.code), profile);
  if (name === 'generate_schedules') {
    const request = { ...args, profile, limit: 30 };
    const result = await generateSchedules(request);
    actions.push({ type: 'schedules', request, result });
    return {
      total: result.total, errors: result.errors, diagnostics: result.diagnostics, warnings: result.warnings,
      credits: result.schedules[0]?.credits,
      hint: result.schedules.length ? undefined
        : `No schedule fits. Blocking slots: ${result.diagnostics.filter((d) => /No section/.test(d.message)).map((d) => d.slot).join(', ') || 'see diagnostics'}${result.errors.length ? '; ' + result.errors.join('; ') : ''}. Retry without or swapping them.`,
      top: result.schedules.slice(0, 3).map((s) => ({
        rank: s.rank, score: s.score, highlights: s.highlights, warnings: s.warnings,
        daysWithClass: [...new Set(s.bundles.flatMap((b) => b.sections.flatMap((x) => x.meetings.flatMap((m) => m.days))))].join(''),
        sections: s.bundles.flatMap((b) => b.sections.map((x) => ({
          course: b.courseCode, section: x.number, type: x.type, crn: x.crn, seats: x.availability,
          meets: x.meetings.map((m) => (m.start == null ? 'online/arranged' : `${m.days.join('')} ${m.startLabel}-${m.endLabel} @ ${m.building}`)).join('; '),
        }))),
      })),
    };
  }
  return { error: `unknown tool ${name}` };
}

function auditSummary(profile) {
  const a = profile.audit;
  if (!a) return 'No degree audit imported.';
  return `Degree audit imported: ${a.completed?.length || 0} completed, in progress: ${(a.inProgress || []).join(', ') || 'none'}. Unmet: ${(a.requirements || []).filter((r) => r.status === 'incomplete').map((r) => `${r.title}${r.needs ? ` (${r.needs})` : ''}`).join('; ') || 'none'}.`;
}

function systemPrompt(profile) {
  return `You are Illini Course Copilot, a friendly, concise course-planning assistant for University of Illinois Urbana-Champaign students.
Term being registered for: ${termLabel()}.
Student profile: ${JSON.stringify({ standing: profile.standing, major: profile.major, intendedMajor: profile.intendedMajor, careers: profile.careers || profile.career, gradTerm: profile.gradTerm, completed: profile.completed })}.
${auditSummary(profile)}
Rules:
- When the student asks what to take or for a recommended schedule, FIRST call get_degree_plan, then call generate_schedules with its next-term courses plus gen-ed/elective slots so the schedule totals 15-16 credits (never fewer than 12 unless the student asks).
- Only pass time constraints (earliestStart/latestEnd in minutes after midnight, e.g. 10am = 600), daysOff or onlyOpen if the student explicitly asked for them.
- If generate_schedules returns 0 schedules, read diagnostics/errors, drop or swap the course that blocks it (e.g. one with no fitting sections), and call generate_schedules again. Never end with 0 schedules without retrying at least once. Suggest watching closed sections for seat alerts.
- ALWAYS use tools for facts about courses, sections, seats, prerequisites and schedules. Never invent CRNs, times or seat counts.
- When the student wants a schedule, call generate_schedules; the app will render the ranked calendars, so just summarize the best option and why.
- Copy meeting days/times, CRNs, seat status and total credits EXACTLY from tool results (generate_schedules returns "credits"). Never compute or guess them. Day letters: M T W R(Thursday) F.
- Point out restrictions, missing prerequisites and closed sections. Suggest watching closed sections for seat alerts.
- Remind students to confirm degree requirements with their advisor / DARS when giving degree advice.
- Keep answers short, use bullet points, and use course codes like "CS 225".`;
}

/** messages: [{role:'user'|'assistant', content}] */
export async function agentReply(messages, profile = {}) {
  const actions = [];
  if (!grokEnabled()) return demoReply(messages, profile, actions);

  const convo = [{ role: 'system', content: systemPrompt(profile) }, ...messages.slice(-12)];
  for (let step = 0; step < 6; step++) {
    const msg = await chat(convo, { tools: TOOLS });
    convo.push(msg);
    if (!msg.tool_calls?.length) return { reply: msg.content, actions, mode: 'grok' };
    for (const call of msg.tool_calls) {
      let result;
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        console.log(`[grok] tool ${call.function.name}`, JSON.stringify(args).slice(0, 400));
        result = await runTool(call.function.name, args, profile, actions);
      }
      catch (e) { result = { error: e.message }; }
      convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12000) });
    }
  }
  return { reply: 'I gathered the data above — check the results in the app.', actions, mode: 'grok' };
}

async function demoReply(messages, profile, actions) {
  const text = messages[messages.length - 1]?.content || '';
  const parsed = parseScheduleRequestFallback(text);
  const note = '\n\n_Demo mode: add `XAI_API_KEY` to `.env` for full Grok conversations._';
  if (parsed.courses.length >= 2 || (parsed.courses.length && (parsed.genEds.length || Object.keys(parsed.constraints).length))) {
    const request = { ...parsed, profile, limit: 30 };
    const result = await generateSchedules(request);
    actions.push({ type: 'schedules', request, result });
    const best = result.schedules[0];
    const reply = best
      ? `I found **${result.total}${result.truncated ? '+' : ''}** valid schedules. The top one scores **${best.score}/100**: ${best.highlights.join(', ') || 'balanced week'}.\n\n${best.bundles.map((b) => `- **${b.courseCode}** ${b.label}, CRNs ${b.crns.join(', ')}`).join('\n')}`
      : `No schedule fits those constraints.\n${result.diagnostics.map((d) => `- ${d.message} (${Object.entries(d.dropped).map(([k, v]) => `${v} ${k}`).join(', ')})`).join('\n')}${result.errors.map((e) => `\n- ${e}`).join('')}`;
    return { reply: reply + note, actions, mode: 'demo' };
  }
  if (parsed.courses.length === 1) {
    const c = summarizeCourse(await getCourse(parsed.courses[0]), profile);
    if (c.error) return { reply: `${parsed.courses[0]} isn't offered this term.${note}`, actions, mode: 'demo' };
    const open = c.sections.filter((s) => /open/i.test(s.availability) && !/closed/i.test(s.availability)).length;
    return {
      reply: `**${c.code}: ${c.title}** (${c.credits})\n- Eligibility: ${c.eligibility.summary}\n- Avg GPA: ${c.avgGpa ?? 'n/a'}\n- ${open}/${c.sections.length} sections open\n- ${c.linking}${note}`,
      actions: [{ type: 'course', code: c.code }], mode: 'demo',
    };
  }
  const { results } = await searchCourses({ query: text, limit: 6 });
  return {
    reply: results.length
      ? `Here are some matching courses:\n${results.map((r) => `- **${r.code}** ${r.title}${r.gpa ? ` (avg GPA ${r.gpa})` : ''}`).join('\n')}${note}`
      : `Try something like "I need CS 225, MATH 241 and a humanities gen ed, nothing before 10am, Fridays free".${note}`,
    actions, mode: 'demo',
  };
}
