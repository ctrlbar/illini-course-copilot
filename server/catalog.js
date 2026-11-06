// Degree requirements from the official Academic Catalog (catalog.illinois.edu).
// Every major page uses the same CourseLeaf markup:
//   table.sc_courselist  — requirement lists (rows; "orclass" rows are alternatives)
//   table.sc_plangrid    — the department's recommended semester-by-semester sequence
import * as cheerio from 'cheerio';
import { fetchText, cached, DAY } from './http.js';
import { normalizeCode } from './courseExplorer.js';

const ROOT = 'https://catalog.illinois.edu';

export function listPrograms() {
  return cached('catalog:programs', 7 * DAY, async () => {
    const $ = cheerio.load(await fetchText(`${ROOT}/undergraduate/`));
    const seen = new Set();
    const out = [];
    $('a[href^="/undergraduate/"]').each((_, a) => {
      const href = $(a).attr('href');
      const name = $(a).text().trim();
      if (!/^\/undergraduate\/[a-z_]+\/[a-z0-9_-]+\/$/.test(href) || !name || seen.has(href)) return;
      if (!/,\s*(BS|BA|BFA|BMUS|BSLAS|BALAS|BSAG|BSED|BDES|BLA|BSW|BSE|BS\w*|BA\w*)\b|undeclared/i.test(name)) return;
      seen.add(href);
      out.push({ name, url: ROOT + href, college: href.split('/')[2] });
    });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  });
}

const cleanText = (t) => t.replace(/\s+/g, ' ').trim();
const codesInText = (t) => [...new Set((t.match(/\b[A-Z]{2,4}\s\d{3}\b/g) || []).map(normalizeCode))];

function parseCourseList($, table) {
  const items = [];
  let subheading = null;
  let pool = null; // set after notes like "Select 6 hours from the following" — later rows are options, not requirements
  $(table).find('tbody tr').each((_, tr) => {
    const $tr = $(tr);
    const cls = $tr.attr('class') || '';
    if (cls.includes('listsum')) return;
    const codeCell = $tr.find('td.codecol');
    const hours = cleanText($tr.find('td.hourscol').text());
    if (cls.includes('areaheader')) {
      subheading = cleanText($tr.text());
      pool = /select|choose|elective|one of|from the following/i.test(subheading) ? subheading : null;
      items.push({ type: 'heading', text: subheading });
      return;
    }
    if (cls.includes('orclass') && items.length) {
      const last = [...items].reverse().find((i) => i.type === 'course');
      const code = normalizeCode(codeCell.text());
      if (last && code) { last.options.push(code); last.titles.push(cleanText($tr.find('td').eq(1).text())); }
      return;
    }
    if (codeCell.length) {
      const codes = codesInText(codeCell.text());
      if (!codes.length) return;
      items.push({
        type: 'course',
        // "MATH 221 & MATH 231" in one cell means both are needed together
        options: codeCell.text().includes('&') ? [codes.join(' & ')] : [codes[0]],
        bundle: codeCell.text().includes('&') ? codes : null,
        titles: [cleanText($tr.find('td').eq(1).text())],
        hours: Number(hours.match(/\d+/)?.[0]) || null,
        subheading,
        pool,
      });
      return;
    }
    const comment = cleanText($tr.text());
    if (comment && /select|choose|from the following|one of the following|chosen from|list below/i.test(comment)) pool = comment;
    else if (comment && !/^(or|and|&)\b/i.test(comment)) pool = null; // a new non-choice note starts a new block
    if (comment) items.push({ type: 'note', text: comment, hours: Number(hours.match(/\d+/)?.[0]) || null, codes: codesInText(comment) });
  });
  return items;
}

function headingBefore($, el) {
  let prev = $(el).prev();
  for (let i = 0; i < 6 && prev.length; i++, prev = prev.prev()) {
    const t = cleanText(prev.text());
    if (prev.is('h2,h3,h4') || (prev.is('p') && prev.find('strong').length && t.length < 120)) return t;
  }
  return null;
}

export function getProgram(url) {
  if (!url.startsWith(ROOT + '/undergraduate/')) throw new Error('Not a UIUC catalog program URL');
  return cached(`catalog:program:${url}`, 7 * DAY, async () => {
    const $ = cheerio.load(await fetchText(url));
    const title = cleanText($('h1.page-title').first().text() || $('h1').first().text());

    // Requirement groups
    const groups = [];
    $('table.sc_courselist').each((i, table) => {
      const items = parseCourseList($, table);
      if (!items.length) return;
      const total = cleanText($(table).find('tr.listsum td.hourscol').text());
      const heading = headingBefore($, table) || `Requirements ${i + 1}`;
      const isGenEd = /general education|gen ed/i.test(heading) || items.slice(0, 3).some((x) => /Composition I|Humanities/i.test(x.text || ''));
      const isElective = /elective|select|choose|focus|concentration|track/i.test(heading) ||
        items.some((x) => x.type === 'note' && /select|choose|from the following|hours from/i.test(x.text));
      groups.push({ heading, totalHours: total || null, kind: isGenEd ? 'gened' : isElective ? 'elective' : 'required', items });
    });

    // Recommended sequence (plan grid) — one table per semester, preceded by an <h3> year.
    const sequence = [];
    $('table.sc_plangrid').each((_, table) => {
      const caption = cleanText($(table).find('caption').text()) || 'Semester';
      let year = '';
      let prev = $(table).prev();
      for (let i = 0; i < 4 && prev.length; i++, prev = prev.prev()) {
        if (prev.is('h2,h3')) { year = cleanText(prev.text()); break; }
      }
      const courses = [];
      $(table).find('tbody tr').each((__, tr) => {
        const cell = $(tr).find('td.codecol');
        if (!cell.length) return;
        const text = cleanText(cell.text());
        courses.push({
          text,
          codes: codesInText(text),
          hours: Number(cleanText($(tr).find('td.hourscol').text()).match(/\d+/)?.[0]) || null,
        });
      });
      if (courses.length) sequence.push({ index: sequence.length + 1, name: year ? `${year}, ${caption}` : caption, courses });
    });

    const totalHours = cleanText($('body').text()).match(/(?:minimum|total) hours? required for (?:the )?(?:degree|graduation|major)[^\d]{0,30}(\d{3})/i)?.[1]
      || cleanText($('body').text()).match(/Total Hours\s+(1[0-3]\d)\b/)?.[1] || null;

    // Plain text for Grok, trimmed to the useful part (requirements + transfer/admission info).
    $('script,style,nav,header,footer').remove();
    const fullText = cleanText($('#content, main, body').first().text());
    const transferText = (fullText.match(/[^.]*\b(transfer|intercollegiate|ICT|admission)\b[^.]*\./gi) || []).slice(0, 12).join(' ');

    return {
      title, url, totalHours: totalHours ? Number(totalHours) : null,
      groups,
      sequence,
      text: fullText.slice(0, 24000),
      transferText,
    };
  });
}

/** Fuzzy-find a program by a student-typed major name ("cs", "computer science", "econ"). */
export async function findProgram(query) {
  if (!query) return null;
  if (query.startsWith('http')) return { url: query, name: query };
  const programs = await listPrograms();
  const ALIASES = { cs: 'computer science', ce: 'computer engineering', ece: 'electrical engineering', econ: 'economics', stats: 'statistics', psych: 'psychology', bio: 'biology', mcb: 'molecular and cellular biology', me: 'mechanical engineering', ie: 'industrial engineering', ae: 'aerospace engineering' };
  const q = (ALIASES[query.toLowerCase().trim()] || query).toLowerCase().replace(/[^a-z+ ]/g, ' ').trim();
  const score = (p) => {
    const n = p.name.toLowerCase();
    if (n.startsWith(q + ',')) return 100;
    if (n.startsWith(q)) return 80 - n.length / 10;
    if (n.includes(q)) return 60 - n.length / 10;
    const words = q.split(/\s+/);
    return words.filter((w) => n.includes(w)).length * 10 - n.length / 20;
  };
  const best = programs.map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s)[0];
  return best && best.s > 5 ? best.p : null;
}
