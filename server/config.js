import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  root,
  dataDir: path.join(root, 'data'),
  port: Number(process.env.PORT) || 3000,
  // The term students are registering for right now.
  term: {
    year: process.env.TERM_YEAR || '2027',
    season: (process.env.TERM_SEASON || 'spring').toLowerCase(),
  },
  grok: {
    apiKey: process.env.XAI_API_KEY || '',
    model: process.env.GROK_MODEL || 'grok-4',
    baseUrl: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
  },
  alerts: {
    pollMinutes: Number(process.env.ALERT_POLL_MINUTES) || 5,
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
  },
  userAgent: 'IlliniCourseCopilot/0.1 (student hackathon project)',
};

export const termLabel = (t = config.term) =>
  `${t.season[0].toUpperCase()}${t.season.slice(1)} ${t.year}`;
