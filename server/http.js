import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

// ---- polite fetching: limited concurrency + retries ----
const MAX_CONCURRENT = 4;
let active = 0;
const queue = [];

function acquire() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((resolve) => queue.push(resolve));
}
function release() {
  const next = queue.shift();
  if (next) next(); else active--;
}

export async function fetchText(url, { retries = 2 } = {}) {
  await acquire();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': config.userAgent },
          signal: AbortSignal.timeout(20000),
        });
        if (res.status === 404) { const e = new Error(`Not found: ${url}`); e.status = 404; throw e; }
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return await res.text();
      } catch (err) {
        if (err.status === 404 || attempt >= retries) throw err;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  } finally {
    release();
  }
}

// ---- two-level cache: memory + disk (survives restarts) ----
const mem = new Map();
const inflight = new Map();
const cacheDir = path.join(config.dataDir, 'cache');
fs.mkdirSync(cacheDir, { recursive: true });

const fileFor = (key) =>
  path.join(cacheDir, crypto.createHash('sha1').update(key).digest('hex') + '.json');

/**
 * cached(key, ttlMs, producer) — returns cached value if fresh, otherwise runs producer.
 * Concurrent callers for the same key share one in-flight request.
 */
export async function cached(key, ttlMs, producer, { force = false } = {}) {
  const now = Date.now();
  if (!force) {
    const m = mem.get(key);
    if (m && now - m.t < ttlMs) return m.v;
    try {
      const d = JSON.parse(fs.readFileSync(fileFor(key), 'utf8'));
      if (now - d.t < ttlMs) { mem.set(key, d); return d.v; }
    } catch { /* miss */ }
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const v = await producer();
      const entry = { t: Date.now(), v };
      mem.set(key, entry);
      fs.writeFile(fileFor(key), JSON.stringify(entry), () => {});
      return v;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** Run async fn over items with a concurrency cap; failures become null. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; }
    }
  }));
  return out;
}
