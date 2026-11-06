// iCalendar export: weekly recurring events for each meeting of a schedule,
// plus single events for reminders (e.g. registration time tickets).
const DAY_MAP = { M: 'MO', T: 'TU', W: 'WE', R: 'TH', F: 'FR', S: 'SA', U: 'SU' };
const JS_DAY = { M: 1, T: 2, W: 3, R: 4, F: 5, S: 6, U: 0 };

const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s || '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');

/** "01-19-27" -> Date (local) */
function parseCisDate(s) {
  const m = String(s || '').match(/(\d{2})-(\d{2})-(\d{2})/);
  return m ? new Date(2000 + Number(m[3]), Number(m[1]) - 1, Number(m[2])) : null;
}
const localStamp = (d, minutes) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(Math.floor(minutes / 60))}${pad(minutes % 60)}00`;
const utcStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const VTIMEZONE = `BEGIN:VTIMEZONE
TZID:America/Chicago
BEGIN:DAYLIGHT
TZOFFSETFROM:-0600
TZOFFSETTO:-0500
TZNAME:CDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0500
TZOFFSETTO:-0600
TZNAME:CST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE`;

export function scheduleToIcs(schedule, name = 'UIUC Schedule') {
  const events = [];
  const now = utcStamp(new Date());
  for (const b of schedule.bundles || []) {
    for (const s of b.sections) {
      const start = parseCisDate(s.startDate), end = parseCisDate(s.endDate);
      if (!start || !end) continue;
      for (const [i, m] of s.meetings.entries()) {
        if (m.start == null || !m.days.length) continue;
        // first date on/after the section start that falls on one of the meeting days
        const first = new Date(start);
        while (!m.days.some((d) => JS_DAY[d] === first.getDay())) first.setDate(first.getDate() + 1);
        const until = `${end.getFullYear()}${pad(end.getMonth() + 1)}${pad(end.getDate())}T235959Z`;
        const instructors = m.instructors?.map((x) => x.name).join(', ');
        events.push([
          'BEGIN:VEVENT',
          `UID:${s.crn}-${i}@illini-copilot`,
          `DTSTAMP:${now}`,
          `SUMMARY:${esc(`${b.courseCode} ${s.number} (${s.type || m.type})`)}`,
          `DTSTART;TZID=America/Chicago:${localStamp(first, m.start)}`,
          `DTEND;TZID=America/Chicago:${localStamp(first, m.end)}`,
          `RRULE:FREQ=WEEKLY;BYDAY=${m.days.map((d) => DAY_MAP[d]).join(',')};UNTIL=${until}`,
          `LOCATION:${esc(`${m.room} ${m.building}`.trim())}`,
          `DESCRIPTION:${esc(`${b.title}\nCRN ${s.crn}${instructors ? `\nInstructor: ${instructors}` : ''}`)}`,
          'END:VEVENT',
        ].join('\r\n'));
      }
    }
  }
  return wrap(events, name);
}

export function reminderToIcs({ when, label }) {
  const t = new Date(when);
  const end = new Date(t.getTime() + 30 * 60_000);
  const ev = [
    'BEGIN:VEVENT',
    `UID:${t.getTime()}@illini-copilot`,
    `DTSTAMP:${utcStamp(new Date())}`,
    `SUMMARY:${esc(label)}`,
    `DTSTART:${utcStamp(t)}`,
    `DTEND:${utcStamp(end)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', `DESCRIPTION:${esc(label)}`, 'END:VALARM',
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', `DESCRIPTION:${esc(label)}`, 'END:VALARM',
    'END:VEVENT',
  ].join('\r\n');
  return wrap([ev], label);
}

function wrap(events, name) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Illini Course Copilot//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(name)}`, VTIMEZONE.replace(/\n/g, '\r\n'), ...events, 'END:VCALENDAR'].join('\r\n');
}
