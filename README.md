# Illini Course Copilot 🧡💙

A Grok-powered course-planning assistant for UIUC students. It turns the tedious registration process (cross-checking Course Explorer, restrictions, linked sections, seat availability and degree requirements) into a few clicks or one sentence.

> "I need CS 225, MATH 241 and a humanities gen ed. Nothing before 10am, Fridays free."
> → every valid, conflict-free schedule, ranked, on a weekly calendar, with CRNs ready to paste.

## Features

| | |
|---|---|
| **🎯 Recommend my schedule** | One click (or "recommend me a schedule" in the planner or chat) builds a full-time schedule from your roadmap + degree audit: courses required next term, required courses you can pull forward, then gen eds you still need. Full sections are skipped and flagged for seat alerts. Every pick comes with the reason. |
| **Smart schedule generator** | Checks *every* valid combination of lectures, discussions and labs, filters by your constraints (start/end times, days off, blocked times, open seats only) and **ranks** them by what you care about: seat availability, start times, days off, compactness, average GPA, walking time between buildings, lunch breaks. |
| **Calendar view + compare** | Each schedule on a Mon–Fri calendar. Pin two to compare side by side, with a score breakdown explaining the ranking. |
| **Linked sections done right** | Understands UIUC section linking (e.g. `AL1` + `ADx`, CHEM 102 online lecture + online quiz, PHYS 211 lecture + discussion + lab) and same-time alternatives. |
| **Eligibility checks** | Parses prerequisites ("CS 126 or CS 128; one of CS 173, MATH 213…") and section restrictions (major, class standing, CS-only sections) against your profile. |
| **Live seat availability** | Pulled from Course Explorer, shown on every section. |
| **Seat alerts** | Watch a closed section; get notified when it opens (browser notification, Discord webhook, or email). Keeps a history of how often each section opens. |
| **Backup plans** | For each schedule: "if AYC fills, switch to AYD (same time)" or the next-best swap. |
| **Degree roadmap** | Semester-by-semester plan to graduation from the official catalog requirements and recommended sequence, respecting prerequisite chains and what's offered next term. Electives matched to your career goal. Supports **planning to transfer majors**. |
| **Degree audit import** | Upload your DARS audit PDF (or paste its text). The app reads the courses you've taken and in progress plus every unmet requirement ("NEEDS: 2 COURSES, SELECT FROM: …"), and the roadmap plans exactly what you still need. UIN, name and email are stripped before parsing; nothing is stored server-side. |
| **Multiple career goals** | Pick any mix of career interests (e.g. ML + quant finance); electives and Grok's advice are tailored to all of them. |
| **Gen Ed optimizer** | Finds gen eds that fit your schedule, favoring high-GPA courses that count for two categories at once. |
| **GPA insights** | Grade distributions by course and instructor. |
| **Exports** | One-click copy of CRNs for registration, `.ics` calendar export, registration time-ticket reminders. |
| **Ask Grok** | Chat assistant that uses tool calls (search, course lookup, schedule generation) so answers come from real data, not hallucinations. |

## Quick start

```bash
npm install
npm run setup-data      # downloads GPA + gen-ed datasets (~12 MB, one time)
cp .env.example .env    # add your XAI_API_KEY (optional, demo mode works without it)
npm start               # http://localhost:3000
```

Requires Node 20.12+.

## How it works

```
public/                 vanilla JS single-page app (no build step)
server/
  index.js              Express API
  courseExplorer.js     Course Explorer XML API + live seat availability (cached, rate-limited)
  sections.js           linked-section bundling (lecture + discussion + lab)
  scheduler.js          constraint search (DFS) + weighted ranking + backup plans
  eligibility.js        prerequisite and restriction parsing
  catalog.js            degree requirements + recommended sequence from catalog.illinois.edu
  roadmap.js            semester planner (prereq-aware, audit-aware) + Grok elective picks
  recommend.js          full-time schedule recommendation from roadmap + audit (shared by planner and chat)
  audit.js              DARS degree-audit parsing (PDF/text, rules + Grok) with PII redaction
  grok.js               xAI Grok client, tool-calling agent, NL schedule parser (+ rule-based fallback)
  alerts.js             seat-alert poller, SSE/Discord/email notifications, reminders
  search.js, datasets.js, buildings.js, ics.js
scripts/setup-data.js   builds data/gpa.json and data/geneds.json
```

**Grok is never the source of truth.** It turns natural language into structured requests and calls tools; all course facts come from Course Explorer and the catalog.

## Data sources

- [UIUC Course Explorer](https://courses.illinois.edu) (public XML API + schedule pages)
- [UIUC Academic Catalog](https://catalog.illinois.edu)
- [Prof. Wade Fagen-Ulmschneider's datasets](https://github.com/wadefagen/datasets) (GPA, gen eds)

The app only uses public data. It never asks for NetID credentials and does not touch Student Self-Service. Always confirm degree plans with your advisor and DARS.

## Ideas / roadmap

- Saved schedules and accounts
- RateMyProfessor-style reviews
- Waitlist position tracking
- Mobile push notifications
