'use strict';
/* ==========================================================================
   purple dev — full-stack server
   Express 5 + PostgreSQL + Google Sign-In (admin panel at /admin)
   Everything backend lives in this one file.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------- optional local .env (Render uses real environment variables) ---------- */
try {
  const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) { /* no .env file, that's fine */ }

const express = require('express');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');

/* ---------- configuration ---------- */
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID ||
  '1053775974665-btmnduh399edehuvqmrjkimjc228rtcd.apps.googleusercontent.com').trim();
const OWNER_EMAIL = (process.env.DEFAULT_ADMIN_EMAIL || 'smartmind2910@gmail.com').trim().toLowerCase();
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 50;
const MAX_IMAGE_MB = 12;
const SESSION_DAYS = 7;
const COOKIE_NAME = 'pd_admin';

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[warn] SESSION_SECRET is not set — using a temporary one. Admins will be signed out on every restart.');
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add your PostgreSQL connection string (see README.md).');
  process.exit(1);
}

const isLocalDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb || process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000
});
pool.on('error', (e) => console.error('[pg] idle client error', e.message));
const q = (text, params) => pool.query(text, params);

/* ---------- small helpers ---------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; this.expose = true; }
}
const bad = (msg) => new HttpError(400, msg);
const str = (v, max) => (typeof v === 'string' ? v : '').trim().slice(0, max);
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pid = (v) => { const n = parseInt(v, 10); if (!Number.isInteger(n) || n < 1) throw bad('Bad id.'); return n; };

function cleanUrl(value, label, opts = {}) {
  let u = typeof value === 'string' ? value.trim() : '';
  if (!u) return '';
  if (opts.local && /^\/media\/[a-f0-9-]{36}$/i.test(u)) return u;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
  try {
    const p = new URL(u);
    if ((p.protocol === 'http:' || p.protocol === 'https:') && p.hostname.includes('.')) return p.toString();
  } catch (_) { /* fall through */ }
  throw bad(`${label} is not a valid link.`);
}

/* ---------- link platforms (icons are shared with both the site and the admin panel) ---------- */
const PLATFORMS = {
  x: { label: 'X (Twitter)', filled: true, svg: '<path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>' },
  instagram: { label: 'Instagram', svg: '<rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>' },
  linkedin: { label: 'LinkedIn', svg: '<path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/>' },
  github: { label: 'GitHub', svg: '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>' },
  youtube: { label: 'YouTube', svg: '<path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z"/><polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02"/>' },
  dribbble: { label: 'Dribbble', svg: '<circle cx="12" cy="12" r="10"/><path d="M8.56 2.75c4.37 6.03 6.02 9.42 8.03 17.72m2.54-15.38c-3.72 4.35-8.94 5.66-16.88 5.85m19.5 1.9c-5.25-1.36-9.04-.51-11.65 1.83"/>' },
  behance: { label: 'Behance', svg: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>' },
  facebook: { label: 'Facebook', svg: '<path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>' },
  twitch: { label: 'Twitch', svg: '<path d="M21 2H3v16h5v4l4-4h5l4-4V2zm-10 9V7m5 4V7"/>' },
  telegram: { label: 'Telegram', svg: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>' },
  whatsapp: { label: 'WhatsApp', svg: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' },
  discord: { label: 'Discord', svg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
  email: { label: 'Email', svg: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>' },
  website: { label: 'Website', svg: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>' },
  other: { label: 'Other link', svg: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' }
};

/* ---------- default content (only used until the admin changes it) ---------- */
const DEFAULT_SITE = {
  brand_name: 'purple dev',
  tagline: "We're a product design team based in India. We're very passionate about the work that we do.",
  site_url_label: 'purpledevs.qd.je',
  contact_email: 'hello@purpledev.com',
  location: 'India',
  availability_message: 'Available for new projects — starting next month ✦',
  about_heading: 'Product design, focused on the clean version of a hard problem.',
  about_description: 'We work with founders and small teams to take fuzzy product ideas into interfaces people actually enjoy using — from early research through to shipped, polished screens. Based in India, working with clients worldwide.'
};
const SITE_LIMITS = {
  brand_name: 40, tagline: 300, site_url_label: 60, contact_email: 120, location: 60, availability_message: 160,
  about_heading: 140, about_description: 400
};
const DEFAULT_FAQS = [
  { question: 'Can we switch plans later?', answer: 'Yes — upgrade or downgrade anytime, and changes apply from your next billing cycle.' },
  { question: 'Do you work with startups?', answer: 'Regularly — the Starter plan is built for early-stage teams shipping their first version.' },
  { question: "What's not included?", answer: 'Development and copywriting are handled separately, though we can recommend trusted partners.' }
];
const DEFAULT_SOCIALS = [
  { platform: 'x', label: '', url: 'https://x.com', enabled: true },
  { platform: 'dribbble', label: '', url: 'https://dribbble.com', enabled: true },
  { platform: 'instagram', label: '', url: 'https://instagram.com', enabled: true }
];
const DEFAULT_TEAM = [
  { name: 'Bhawishya', role: 'Cybersecurity', subtitle: 'B.Tech CSE', color: '#E4E1F8' },
  { name: 'Abhinav', role: 'Cybersecurity', subtitle: 'B.Tech CSE', color: '#EDF8E5' },
  { name: 'Yuvraj', role: 'AI & ML', subtitle: 'B.Tech CSE', color: '#FBE4EE' },
  { name: 'Aditya', role: 'AI & ML', subtitle: 'B.Tech CSE', color: '#E5F1FC' }
];

/* Pricing is in Indian rupees (whole numbers). The yearly price is the TOTAL for the year.
   These are only the starting cards on first run; edit everything in Admin -> Pricing. */
const DEFAULT_PLANS = [
  { name: 'Starter', description: 'For a single focused screen or flow', price_monthly: 50000, price_yearly: 480000,
    features: ['1 active project', '2 revision rounds', 'Figma source files'], color: '#E5F1FC' },
  { name: 'Studio', description: 'For an ongoing product partnership', price_monthly: 120000, price_yearly: 1152000,
    features: ['3 active projects', 'Unlimited revisions', 'Weekly check-ins'], color: '#E4E1F8', featured: true },
  { name: 'Enterprise', description: 'For teams needing full-time design', price_label: 'Custom',
    features: ['Unlimited projects', 'Dedicated designer', 'Priority support'], color: '#EDF8E5', button_text: 'Contact sales' }
];

/* ---------- database ---------- */
async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS admins (
      email      TEXT PRIMARY KEY,
      name       TEXT NOT NULL DEFAULT '',
      picture    TEXT NOT NULL DEFAULT '',
      added_by   TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS media (
      id         TEXT PRIMARY KEY,
      mime       TEXT NOT NULL,
      filename   TEXT NOT NULL DEFAULT '',
      size       INTEGER NOT NULL,
      data       BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS projects (
      id          SERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'General',
      short_desc  TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      cover       TEXT NOT NULL DEFAULT '',
      gallery     JSONB NOT NULL DEFAULT '[]',
      tech        JSONB NOT NULL DEFAULT '[]',
      live_url    TEXT NOT NULL DEFAULT '',
      github_url  TEXT NOT NULL DEFAULT '',
      client      TEXT NOT NULL DEFAULT '',
      year        TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'published',
      likes       INTEGER NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS team (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT '',
      subtitle   TEXT NOT NULL DEFAULT '',
      photo      TEXT NOT NULL DEFAULT '',
      color      TEXT NOT NULL DEFAULT '#E4E1F8',
      linkedin   TEXT NOT NULL DEFAULT '',
      github     TEXT NOT NULL DEFAULT '',
      visible    BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS plans (
      id                SERIAL PRIMARY KEY,
      name              TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      price_monthly     INTEGER,
      price_yearly      INTEGER,
      old_price_monthly INTEGER,
      old_price_yearly  INTEGER,
      price_label       TEXT NOT NULL DEFAULT '',
      features          JSONB NOT NULL DEFAULT '[]',
      button_text       TEXT NOT NULL DEFAULT '',
      color             TEXT NOT NULL DEFAULT '#E4E1F8',
      is_offer          BOOLEAN NOT NULL DEFAULT FALSE,
      badge             TEXT NOT NULL DEFAULT '',
      featured          BOOLEAN NOT NULL DEFAULT FALSE,
      visible           BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order        INTEGER NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS faqs (
      id         SERIAL PRIMARY KEY,
      question   TEXT NOT NULL,
      answer     TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      message    TEXT NOT NULL,
      is_read    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS projects_order_idx ON projects (sort_order, id);
    CREATE INDEX IF NOT EXISTS messages_created_idx ON messages (created_at DESC);
  `);
}

async function seed() {
  // The owner can always sign in, even if someone removes the row by hand.
  await q(`INSERT INTO admins (email, added_by) VALUES ($1, 'system') ON CONFLICT (email) DO NOTHING`, [OWNER_EMAIL]);

  // First run only: give the team section the original four members so the site isn't empty.
  const seeded = await getSetting('seeded', {});
  if (!seeded.team) {
    const { rows } = await q('SELECT count(*)::int AS n FROM team');
    if (rows[0].n === 0) {
      for (let i = 0; i < DEFAULT_TEAM.length; i++) {
        const t = DEFAULT_TEAM[i];
        await q('INSERT INTO team (name, role, subtitle, color, sort_order) VALUES ($1,$2,$3,$4,$5)',
          [t.name, t.role, t.subtitle, t.color, i + 1]);
      }
    }
    await setSetting('seeded', { ...seeded, team: true });
  }

  // First run only: start the pricing section with the three original cards (now in rupees).
  const seeded2 = await getSetting('seeded', {});
  if (!seeded2.plans) {
    const { rows } = await q('SELECT count(*)::int AS n FROM plans');
    if (rows[0].n === 0) {
      for (let i = 0; i < DEFAULT_PLANS.length; i++) {
        const d = DEFAULT_PLANS[i];
        await q(`INSERT INTO plans (name, description, price_monthly, price_yearly, price_label, features, button_text, color, featured, badge, sort_order)
                 VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
          [d.name, d.description, d.price_monthly || null, d.price_yearly || null, d.price_label || '', JSON.stringify(d.features),
           d.button_text || '', d.color, !!d.featured, d.featured ? 'Most popular' : '', i + 1]);
      }
    }
    await setSetting('seeded', { ...seeded2, plans: true });
  }

  // First run only: start the FAQ list with the three original questions.
  const seeded3 = await getSetting('seeded', {});
  if (!seeded3.faqs) {
    const { rows } = await q('SELECT count(*)::int AS n FROM faqs');
    if (rows[0].n === 0) {
      for (let i = 0; i < DEFAULT_FAQS.length; i++) {
        const f = DEFAULT_FAQS[i];
        await q('INSERT INTO faqs (question, answer, sort_order) VALUES ($1,$2,$3)', [f.question, f.answer, i + 1]);
      }
    }
    await setSetting('seeded', { ...seeded3, faqs: true });
  }
}

async function getSetting(key, fallback) {
  const { rows } = await q('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : fallback;
}
async function setSetting(key, value) {
  await q(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);
}
const getSite = async () => ({ ...DEFAULT_SITE, ...(await getSetting('site', {})) });
const getSocials = async () => getSetting('socials', DEFAULT_SOCIALS);

/* Remove uploaded files nobody references any more (24 h grace so in-progress edits are safe). */
async function cleanupMedia() {
  const refs = new Set();
  const collect = (s) => { for (const m of String(s || '').matchAll(/\/media\/([a-f0-9-]{36})/gi)) refs.add(m[1].toLowerCase()); };
  const [p, t, s] = await Promise.all([
    q('SELECT cover, gallery::text AS g FROM projects'),
    q('SELECT photo FROM team'),
    q('SELECT value::text AS v FROM settings')
  ]);
  p.rows.forEach((r) => { collect(r.cover); collect(r.g); });
  t.rows.forEach((r) => collect(r.photo));
  s.rows.forEach((r) => collect(r.v));
  await q(`DELETE FROM media WHERE created_at < now() - interval '24 hours' AND NOT (id = ANY($1::text[]))`, [[...refs]]);
}
const cleanupSoon = () => cleanupMedia().catch((e) => console.error('[cleanup]', e.message));

/* ---------- sessions (signed cookie, re-checked against the admins table on every request) ---------- */
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p && p.exp > Date.now() ? p : null;
  } catch (_) { return null; }
}
function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
const cookieOpts = (req) => ({ httpOnly: true, sameSite: 'lax', secure: IS_PROD || req.secure, path: '/' });

async function requireAdmin(req, res, next) {
  const s = verifyToken(readCookie(req, COOKIE_NAME));
  if (!s) throw new HttpError(401, 'Please sign in.');
  const { rows } = await q('SELECT email, name, picture FROM admins WHERE email = $1', [s.email]);
  if (!rows[0]) {
    res.clearCookie(COOKIE_NAME, cookieOpts(req));
    throw new HttpError(403, 'Your admin access was removed.');
  }
  req.admin = { ...rows[0], isOwner: rows[0].email === OWNER_EMAIL };
  next();
}
function requireOwner(req, res, next) {
  if (!req.admin.isOwner) throw new HttpError(403, `Only the owner (${OWNER_EMAIL}) can manage admins.`);
  next();
}

/* ---------- tiny in-memory rate limiter ---------- */
const buckets = new Map();
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
    if (++b.n > max) throw new HttpError(429, 'Too many requests. Please try again later.');
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 10 * 60 * 1000).unref();

/* ---------- validation ---------- */
function cleanCategory(v) { return str(v, 30).replace(/\s+/g, ' ') || 'General'; }

function cleanGallery(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const m of list.slice(0, 30)) {
    if (!m || !['image', 'video', 'embed'].includes(m.type)) continue;
    const url = cleanUrl(m.url, 'A gallery link', { local: true });
    if (!url) continue;
    if (m.type === 'embed') {
      let host = '';
      try { host = new URL(url).hostname; } catch (_) { /* local path */ }
      if (!['www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com'].includes(host)) {
        throw bad('Only YouTube and Vimeo videos can be embedded.');
      }
    }
    out.push({ type: m.type, url });
  }
  return out;
}

async function cleanProject(b) {
  b = b || {};
  const title = str(b.title, 120);
  if (!title) throw bad('Project name is required.');
  let category = cleanCategory(b.category);
  const existing = await q('SELECT category FROM projects WHERE lower(category) = lower($1) LIMIT 1', [category]);
  if (existing.rows[0]) category = existing.rows[0].category; // reuse the exact spelling already in use
  const seen = new Set();
  const tech = (Array.isArray(b.tech) ? b.tech : []).map((t) => str(t, 30)).filter((t) => {
    const k = t.toLowerCase();
    if (!t || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 20);
  return {
    title,
    category,
    short_desc: str(b.short_desc, 240),
    description: str(b.description, 6000),
    cover: cleanUrl(b.cover, 'Cover image link', { local: true }),
    gallery: cleanGallery(b.gallery),
    tech,
    live_url: cleanUrl(b.live_url, 'Live site link'),
    github_url: cleanUrl(b.github_url, 'GitHub link'),
    client: str(b.client, 80),
    year: str(b.year, 20),
    status: b.status === 'draft' ? 'draft' : 'published'
  };
}

function cleanTeam(b) {
  b = b || {};
  const name = str(b.name, 80);
  if (!name) throw bad('Name is required.');
  return {
    name,
    role: str(b.role, 60),
    subtitle: str(b.subtitle, 80),
    photo: cleanUrl(b.photo, 'Photo link', { local: true }),
    color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#E4E1F8',
    linkedin: cleanUrl(b.linkedin, 'LinkedIn link'),
    github: cleanUrl(b.github, 'GitHub link'),
    visible: b.visible !== false
  };
}

function cleanPrice(v, label) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[₹,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) throw bad(`${label} must be a number, like 4999.`);
  if (n === 0) throw bad(`${label} can’t be 0. Leave it empty if there is no price.`);
  if (n > 100000000) throw bad(`${label} is too large.`);
  return Math.round(n);
}

function cleanPlan(b) {
  b = b || {};
  const name = str(b.name, 60);
  if (!name) throw bad('Plan name is required.');
  const is_offer = b.is_offer === true;
  const price_monthly = cleanPrice(b.price_monthly, 'Monthly price');
  const price_yearly = cleanPrice(b.price_yearly, 'Yearly price');
  const old_price_monthly = is_offer ? cleanPrice(b.old_price_monthly, 'Original monthly price') : null;
  const old_price_yearly = is_offer ? cleanPrice(b.old_price_yearly, 'Original yearly price') : null;
  if (old_price_monthly && price_monthly && old_price_monthly <= price_monthly) throw bad('The original monthly price should be higher than the offer price.');
  if (old_price_yearly && price_yearly && old_price_yearly <= price_yearly) throw bad('The original yearly price should be higher than the offer price.');
  const features = (Array.isArray(b.features) ? b.features : []).map((f) => str(f, 100)).filter(Boolean).slice(0, 12);
  return {
    name,
    description: str(b.description, 200),
    price_monthly, price_yearly, old_price_monthly, old_price_yearly,
    price_label: str(b.price_label, 30),
    features,
    button_text: str(b.button_text, 30),
    color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#E4E1F8',
    is_offer,
    badge: str(b.badge, 40),
    featured: b.featured === true,
    visible: b.visible !== false
  };
}

function cleanSite(b) {
  b = b || {};
  const out = {};
  for (const key of Object.keys(DEFAULT_SITE)) out[key] = str(b[key], SITE_LIMITS[key]);
  if (!out.brand_name) throw bad('Brand name can’t be empty.');
  if (out.contact_email && !EMAIL_RE.test(out.contact_email)) throw bad('Contact email doesn’t look right.');
  return out;
}

function cleanFaq(b) {
  b = b || {};
  const question = str(b.question, 200);
  const answer = str(b.answer, 600);
  if (!question) throw bad('Add a question first.');
  if (!answer) throw bad('Add an answer first.');
  return { question, answer };
}

function cleanSocials(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list.slice(0, 20)) {
    if (!s) continue;
    const platform = PLATFORMS[s.platform] ? s.platform : 'other';
    const raw = str(s.url, 300);
    if (!raw) continue; // blank rows are dropped
    let url;
    if (platform === 'email') {
      const addr = raw.replace(/^mailto:/i, '');
      if (!EMAIL_RE.test(addr)) throw bad('Email link needs a valid email address.');
      url = 'mailto:' + addr;
    } else {
      url = cleanUrl(raw, `${PLATFORMS[platform].label} link`);
    }
    out.push({ platform, label: str(s.label, 40), url, enabled: s.enabled !== false });
  }
  return out;
}

/* ---------- uploads: detect real file type from the first bytes ---------- */
function sniff(b) {
  if (b.length < 12) return null;
  const at = (i, n) => b.subarray(i, i + n).toString('latin1');
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image', mime: 'image/jpeg' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image', mime: 'image/png' };
  if (at(0, 4) === 'GIF8') return { type: 'image', mime: 'image/gif' };
  if (at(0, 4) === 'RIFF' && at(8, 4) === 'WEBP') return { type: 'image', mime: 'image/webp' };
  if (at(4, 4) === 'ftyp') {
    const brand = at(8, 4);
    if (brand === 'avif' || brand === 'avis') return { type: 'image', mime: 'image/avif' };
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return null; // HEIC photos aren't supported by most browsers
    if (brand === 'qt  ') return { type: 'video', mime: 'video/quicktime' };
    return { type: 'video', mime: 'video/mp4' };
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { type: 'video', mime: 'video/webm' };
  return null;
}

/* ==========================================================================
   App
   ========================================================================== */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render terminates HTTPS in front of the app

app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  if (IS_PROD) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});

/* reject cross-site writes (cookies are also SameSite=Lax) */
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch (_) { /* invalid */ }
    if (!ok) throw new HttpError(403, 'Request blocked (origin mismatch).');
  }
  next();
});
app.use('/api', express.json({ limit: '1mb' }));

/* ---------- pages ---------- */
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/admin', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY' });
  res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /admin\nDisallow: /api/\n'));
app.get('/healthz', async (req, res) => { await q('SELECT 1'); res.send('ok'); });

/* ---------- uploaded files (images / videos stored in PostgreSQL) ---------- */
app.get('/media/:id', async (req, res) => {
  const id = req.params.id.toLowerCase();
  if (!UUID_RE.test(id)) return res.status(404).end();
  const meta = (await q('SELECT mime, size FROM media WHERE id = $1', [id])).rows[0];
  if (!meta) return res.status(404).end();
  res.set({ 'Content-Type': meta.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable' });

  const range = req.headers.range;
  if (!range) {
    const { rows } = await q('SELECT data FROM media WHERE id = $1', [id]);
    res.set('Content-Length', String(meta.size));
    return res.end(rows[0].data);
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m || (m[1] === '' && m[2] === '')) return res.status(416).set('Content-Range', `bytes */${meta.size}`).end();
  let start, end;
  if (m[1] === '') { start = Math.max(0, meta.size - parseInt(m[2], 10)); end = meta.size - 1; }
  else { start = parseInt(m[1], 10); end = m[2] === '' ? meta.size - 1 : Math.min(parseInt(m[2], 10), meta.size - 1); }
  if (start > end || start >= meta.size) return res.status(416).set('Content-Range', `bytes */${meta.size}`).end();
  end = Math.min(end, start + 4 * 1024 * 1024 - 1); // serve in ≤4 MB slices; browsers ask for the rest
  const { rows } = await q('SELECT substring(data from $1::int for $2::int) AS chunk FROM media WHERE id = $3', [start + 1, end - start + 1, id]);
  res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${meta.size}`, 'Content-Length': String(end - start + 1) }).end(rows[0].chunk);
});

/* ---------- public API ---------- */
app.get('/api/site', async (req, res) => {
  const [site, socials, team, plans, projects, faqs] = await Promise.all([
    getSite(),
    getSocials(),
    q('SELECT id, name, role, subtitle, photo, color, linkedin, github FROM team WHERE visible ORDER BY sort_order, id'),
    q(`SELECT id, name, description, price_monthly, price_yearly, old_price_monthly, old_price_yearly, price_label,
              features, button_text, color, is_offer, badge, featured
         FROM plans WHERE visible ORDER BY sort_order, id`),
    q(`SELECT id, title, category, short_desc, description, cover, gallery, tech, live_url, github_url, client, year, likes
         FROM projects WHERE status = 'published' ORDER BY sort_order, id DESC`),
    q('SELECT id, question, answer FROM faqs ORDER BY sort_order, id')
  ]);
  res.set('Cache-Control', 'no-cache');
  res.json({
    site,
    socials: socials.filter((s) => s.enabled),
    platforms: PLATFORMS,
    team: team.rows,
    plans: plans.rows,
    projects: projects.rows,
    faqs: faqs.rows
  });
});

app.post('/api/contact', rateLimit('contact', 5, 60 * 60 * 1000), async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // honeypot: bots fill this in
  const name = str(b.name, 100), email = str(b.email, 160), message = str(b.message, 3000);
  if (!name || !EMAIL_RE.test(email) || !message) throw bad('Please fill in every field with a valid email.');
  await q('INSERT INTO messages (name, email, message) VALUES ($1,$2,$3)', [name, email, message]);
  res.json({ ok: true });
});

app.post('/api/projects/:id/like', rateLimit('like', 60, 60 * 60 * 1000), async (req, res) => {
  const id = pid(req.params.id);
  const delta = req.body && req.body.like === false ? -1 : 1;
  const { rows } = await q(`UPDATE projects SET likes = GREATEST(0, likes + $2) WHERE id = $1 AND status = 'published' RETURNING likes`, [id, delta]);
  if (!rows[0]) throw new HttpError(404, 'Project not found.');
  res.json({ likes: rows[0].likes });
});

/* ---------- auth ---------- */
const oauth = new OAuth2Client(GOOGLE_CLIENT_ID);

app.get('/api/auth/config', (req, res) => res.json({ clientId: GOOGLE_CLIENT_ID }));

app.post('/api/auth/google', rateLimit('login', 30, 10 * 60 * 1000), async (req, res) => {
  const credential = req.body && req.body.credential;
  if (typeof credential !== 'string' || credential.length > 4000) throw bad('Missing Google credential.');
  let payload;
  try {
    const ticket = await oauth.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (e) {
    console.warn('[auth] token verification failed:', e.message);
    throw new HttpError(401, 'Google sign-in could not be verified. Please try again.');
  }
  if (!payload || !payload.email || !payload.email_verified) throw new HttpError(401, 'Your Google email is not verified.');
  const email = payload.email.toLowerCase();
  const { rows } = await q('SELECT email FROM admins WHERE email = $1', [email]);
  if (!rows[0]) throw new HttpError(403, `${email} doesn’t have admin access. Ask the owner to add it.`);
  await q('UPDATE admins SET name = $2, picture = $3, last_login = now() WHERE email = $1', [email, str(payload.name, 120), str(payload.picture, 500)]);
  res.cookie(COOKIE_NAME, sign({ email, exp: Date.now() + SESSION_DAYS * 864e5 }), { ...cookieOpts(req), maxAge: SESSION_DAYS * 864e5 });
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, cookieOpts(req));
  res.json({ ok: true });
});

/* ---------- admin API ---------- */
const admin = express.Router();
admin.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
admin.use(requireAdmin);

admin.get('/me', (req, res) => res.json({
  email: req.admin.email, name: req.admin.name, picture: req.admin.picture, isOwner: req.admin.isOwner,
  ownerEmail: OWNER_EMAIL, maxUploadMb: MAX_UPLOAD_MB, platforms: PLATFORMS
}));

admin.get('/dashboard', async (req, res) => {
  const [c, msgs, projs] = await Promise.all([
    q(`SELECT
        (SELECT count(*) FROM projects WHERE status = 'published')::int AS published,
        (SELECT count(*) FROM projects WHERE status = 'draft')::int AS drafts,
        (SELECT count(*) FROM team)::int AS team,
        (SELECT count(*) FROM messages WHERE NOT is_read)::int AS unread,
        (SELECT count(*) FROM messages)::int AS messages,
        (SELECT count(*) FROM admins)::int AS admins,
        (SELECT COALESCE(sum(likes), 0) FROM projects)::int AS likes,
        (SELECT COALESCE(sum(size), 0) FROM media)::float8 AS media_bytes,
        (SELECT count(*) FROM media)::int AS media_count,
        pg_database_size(current_database())::float8 AS db_bytes`),
    q('SELECT id, name, email, message, is_read, created_at FROM messages ORDER BY created_at DESC LIMIT 5'),
    q('SELECT id, title, category, cover, gallery, status, likes, updated_at FROM projects ORDER BY updated_at DESC LIMIT 5')
  ]);
  res.json({ counts: c.rows[0], recentMessages: msgs.rows, recentProjects: projs.rows });
});

/* --- uploads --- */
admin.post('/upload', express.raw({ type: () => true, limit: `${MAX_UPLOAD_MB}mb` }), async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('No file received.');
  const kind = sniff(buf);
  if (!kind) throw new HttpError(415, 'Unsupported file. Use JPG, PNG, WebP, GIF, AVIF, MP4, WebM or MOV.');
  if (kind.type === 'image' && buf.length > MAX_IMAGE_MB * 1024 * 1024) throw new HttpError(413, `Images can be up to ${MAX_IMAGE_MB} MB.`);
  const id = crypto.randomUUID();
  await q('INSERT INTO media (id, mime, filename, size, data) VALUES ($1,$2,$3,$4,$5)',
    [id, kind.mime, str(req.query.name, 120), buf.length, buf]);
  res.json({ id, url: `/media/${id}`, type: kind.type, mime: kind.mime, size: buf.length });
});

/* --- projects --- */
const PROJECT_COLS = 'id, title, category, short_desc, description, cover, gallery, tech, live_url, github_url, client, year, status, likes, sort_order, created_at, updated_at';

admin.get('/projects', async (req, res) => {
  res.json((await q(`SELECT ${PROJECT_COLS} FROM projects ORDER BY sort_order, id DESC`)).rows);
});

admin.post('/projects', async (req, res) => {
  const d = await cleanProject(req.body);
  const { rows } = await q(
    `INSERT INTO projects (title, category, short_desc, description, cover, gallery, tech, live_url, github_url, client, year, status, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,(SELECT COALESCE(MIN(sort_order), 0) - 1 FROM projects))
     RETURNING ${PROJECT_COLS}`,
    [d.title, d.category, d.short_desc, d.description, d.cover, JSON.stringify(d.gallery), JSON.stringify(d.tech), d.live_url, d.github_url, d.client, d.year, d.status]);
  res.status(201).json(rows[0]);
});

admin.post('/projects/reorder', async (req, res) => {
  const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
  if (ids.length) await q('UPDATE projects p SET sort_order = t.ord FROM unnest($1::int[]) WITH ORDINALITY AS t(id, ord) WHERE p.id = t.id', [ids]);
  res.json({ ok: true });
});

admin.put('/projects/:id', async (req, res) => {
  const id = pid(req.params.id);
  const d = await cleanProject(req.body);
  const { rows } = await q(
    `UPDATE projects SET title=$2, category=$3, short_desc=$4, description=$5, cover=$6, gallery=$7::jsonb, tech=$8::jsonb,
       live_url=$9, github_url=$10, client=$11, year=$12, status=$13, updated_at=now()
     WHERE id=$1 RETURNING ${PROJECT_COLS}`,
    [id, d.title, d.category, d.short_desc, d.description, d.cover, JSON.stringify(d.gallery), JSON.stringify(d.tech), d.live_url, d.github_url, d.client, d.year, d.status]);
  if (!rows[0]) throw new HttpError(404, 'Project not found.');
  cleanupSoon();
  res.json(rows[0]);
});

admin.patch('/projects/:id', async (req, res) => {
  const status = req.body && req.body.status === 'draft' ? 'draft' : 'published';
  const { rows } = await q(`UPDATE projects SET status=$2, updated_at=now() WHERE id=$1 RETURNING ${PROJECT_COLS}`, [pid(req.params.id), status]);
  if (!rows[0]) throw new HttpError(404, 'Project not found.');
  res.json(rows[0]);
});

admin.delete('/projects/:id', async (req, res) => {
  const r = await q('DELETE FROM projects WHERE id = $1', [pid(req.params.id)]);
  if (!r.rowCount) throw new HttpError(404, 'Project not found.');
  cleanupSoon();
  res.json({ ok: true });
});

/* --- team --- */
const TEAM_COLS = 'id, name, role, subtitle, photo, color, linkedin, github, visible, sort_order';

admin.get('/team', async (req, res) => {
  res.json((await q(`SELECT ${TEAM_COLS} FROM team ORDER BY sort_order, id`)).rows);
});

admin.post('/team', async (req, res) => {
  const d = cleanTeam(req.body);
  const { rows } = await q(
    `INSERT INTO team (name, role, subtitle, photo, color, linkedin, github, visible, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,(SELECT COALESCE(MAX(sort_order), 0) + 1 FROM team)) RETURNING ${TEAM_COLS}`,
    [d.name, d.role, d.subtitle, d.photo, d.color, d.linkedin, d.github, d.visible]);
  res.status(201).json(rows[0]);
});

admin.post('/team/reorder', async (req, res) => {
  const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
  if (ids.length) await q('UPDATE team t SET sort_order = o.ord FROM unnest($1::int[]) WITH ORDINALITY AS o(id, ord) WHERE t.id = o.id', [ids]);
  res.json({ ok: true });
});

admin.put('/team/:id', async (req, res) => {
  const d = cleanTeam(req.body);
  const { rows } = await q(
    `UPDATE team SET name=$2, role=$3, subtitle=$4, photo=$5, color=$6, linkedin=$7, github=$8, visible=$9
     WHERE id=$1 RETURNING ${TEAM_COLS}`,
    [pid(req.params.id), d.name, d.role, d.subtitle, d.photo, d.color, d.linkedin, d.github, d.visible]);
  if (!rows[0]) throw new HttpError(404, 'Team member not found.');
  cleanupSoon();
  res.json(rows[0]);
});

admin.delete('/team/:id', async (req, res) => {
  const r = await q('DELETE FROM team WHERE id = $1', [pid(req.params.id)]);
  if (!r.rowCount) throw new HttpError(404, 'Team member not found.');
  cleanupSoon();
  res.json({ ok: true });
});

/* --- pricing plans + offers --- */
const PLAN_COLS = 'id, name, description, price_monthly, price_yearly, old_price_monthly, old_price_yearly, price_label, features, button_text, color, is_offer, badge, featured, visible, sort_order';
const MAX_PLANS = 12;

admin.get('/plans', async (req, res) => {
  res.json((await q(`SELECT ${PLAN_COLS} FROM plans ORDER BY sort_order, id`)).rows);
});

admin.post('/plans', async (req, res) => {
  const d = cleanPlan(req.body);
  const n = (await q('SELECT count(*)::int AS n FROM plans')).rows[0].n;
  if (n >= MAX_PLANS) throw bad(`You can have up to ${MAX_PLANS} plans and offers. Remove one first.`);
  const { rows } = await q(
    `INSERT INTO plans (name, description, price_monthly, price_yearly, old_price_monthly, old_price_yearly, price_label, features, button_text, color, is_offer, badge, featured, visible, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,(SELECT COALESCE(MAX(sort_order), 0) + 1 FROM plans)) RETURNING ${PLAN_COLS}`,
    [d.name, d.description, d.price_monthly, d.price_yearly, d.old_price_monthly, d.old_price_yearly, d.price_label, JSON.stringify(d.features), d.button_text, d.color, d.is_offer, d.badge, d.featured, d.visible]);
  res.status(201).json(rows[0]);
});

admin.post('/plans/reorder', async (req, res) => {
  const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
  if (ids.length) await q('UPDATE plans p SET sort_order = o.ord FROM unnest($1::int[]) WITH ORDINALITY AS o(id, ord) WHERE p.id = o.id', [ids]);
  res.json({ ok: true });
});

admin.put('/plans/:id', async (req, res) => {
  const d = cleanPlan(req.body);
  const { rows } = await q(
    `UPDATE plans SET name=$2, description=$3, price_monthly=$4, price_yearly=$5, old_price_monthly=$6, old_price_yearly=$7, price_label=$8,
       features=$9::jsonb, button_text=$10, color=$11, is_offer=$12, badge=$13, featured=$14, visible=$15
     WHERE id=$1 RETURNING ${PLAN_COLS}`,
    [pid(req.params.id), d.name, d.description, d.price_monthly, d.price_yearly, d.old_price_monthly, d.old_price_yearly, d.price_label, JSON.stringify(d.features), d.button_text, d.color, d.is_offer, d.badge, d.featured, d.visible]);
  if (!rows[0]) throw new HttpError(404, 'Plan not found.');
  res.json(rows[0]);
});

admin.delete('/plans/:id', async (req, res) => {
  const r = await q('DELETE FROM plans WHERE id = $1', [pid(req.params.id)]);
  if (!r.rowCount) throw new HttpError(404, 'Plan not found.');
  res.json({ ok: true });
});

/* --- site settings + social links --- */
admin.get('/settings', async (req, res) => {
  res.json({ site: await getSite(), socials: await getSocials() });
});

admin.put('/settings', async (req, res) => {
  const b = req.body || {};
  const site = cleanSite(b.site);
  const socials = cleanSocials(b.socials);
  await setSetting('site', site);
  await setSetting('socials', socials);
  res.json({ site, socials });
});

/* --- FAQ (common questions, shown under Pricing) --- */
const MAX_FAQS = 30;
admin.get('/faqs', async (req, res) => {
  res.json((await q('SELECT id, question, answer FROM faqs ORDER BY sort_order, id')).rows);
});

admin.post('/faqs', async (req, res) => {
  const { rows: countRows } = await q('SELECT count(*)::int AS n FROM faqs');
  if (countRows[0].n >= MAX_FAQS) throw bad(`You can have up to ${MAX_FAQS} questions.`);
  const d = cleanFaq(req.body);
  const { rows } = await q(
    `INSERT INTO faqs (question, answer, sort_order)
     VALUES ($1,$2,(SELECT COALESCE(MAX(sort_order), 0) + 1 FROM faqs)) RETURNING id, question, answer`,
    [d.question, d.answer]);
  res.status(201).json(rows[0]);
});

admin.post('/faqs/reorder', async (req, res) => {
  const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
  if (ids.length) await q('UPDATE faqs f SET sort_order = o.ord FROM unnest($1::int[]) WITH ORDINALITY AS o(id, ord) WHERE f.id = o.id', [ids]);
  res.json({ ok: true });
});

admin.put('/faqs/:id', async (req, res) => {
  const d = cleanFaq(req.body);
  const { rows } = await q('UPDATE faqs SET question=$2, answer=$3 WHERE id=$1 RETURNING id, question, answer', [pid(req.params.id), d.question, d.answer]);
  if (!rows[0]) throw new HttpError(404, 'Question not found.');
  res.json(rows[0]);
});

admin.delete('/faqs/:id', async (req, res) => {
  const r = await q('DELETE FROM faqs WHERE id = $1', [pid(req.params.id)]);
  if (!r.rowCount) throw new HttpError(404, 'Question not found.');
  res.json({ ok: true });
});

/* --- admins (owner only) --- */
admin.get('/admins', async (req, res) => {
  const { rows } = await q('SELECT email, name, picture, added_by, created_at, last_login FROM admins ORDER BY (email = $1) DESC, created_at', [OWNER_EMAIL]);
  res.json(rows.map((r) => ({ ...r, isOwner: r.email === OWNER_EMAIL })));
});
admin.post('/admins', requireOwner, async (req, res) => {
  const email = str(req.body && req.body.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) throw bad('Enter a valid Google email address.');
  const r = await q('INSERT INTO admins (email, added_by) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING', [email, req.admin.email]);
  if (!r.rowCount) throw new HttpError(409, `${email} is already an admin.`);
  res.status(201).json({ ok: true });
});
admin.delete('/admins/:email', requireOwner, async (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  if (email === OWNER_EMAIL) throw bad('The owner can’t be removed.');
  const r = await q('DELETE FROM admins WHERE email = $1', [email]);
  if (!r.rowCount) throw new HttpError(404, 'Admin not found.');
  res.json({ ok: true });
});

/* --- messages --- */
admin.get('/messages', async (req, res) => {
  res.json((await q('SELECT id, name, email, message, is_read, created_at FROM messages ORDER BY created_at DESC LIMIT 300')).rows);
});
admin.post('/messages/read-all', async (req, res) => {
  await q('UPDATE messages SET is_read = TRUE WHERE NOT is_read');
  res.json({ ok: true });
});
admin.patch('/messages/:id', async (req, res) => {
  const { rows } = await q('UPDATE messages SET is_read = $2 WHERE id = $1 RETURNING id, is_read', [pid(req.params.id), !!(req.body && req.body.is_read)]);
  if (!rows[0]) throw new HttpError(404, 'Message not found.');
  res.json(rows[0]);
});
admin.delete('/messages/:id', async (req, res) => {
  await q('DELETE FROM messages WHERE id = $1', [pid(req.params.id)]);
  res.json({ ok: true });
});

app.use('/api/admin', admin);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

/* ---------- 404 + errors ---------- */
app.use((req, res) => {
  res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found</title><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#E4DBF8;color:#1a1a1a"><div style="text-align:center"><h1 style="font-size:64px;margin:0">404</h1><p>That page doesn’t exist.</p><a href="/" style="color:#755BB4;font-weight:600">Back to the site</a></div>');
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.too.large') return res.status(413).json({ error: `That file is too large (limit ${MAX_UPLOAD_MB} MB).` });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body.' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.expose ? err.message : 'Bad request.' });
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

/* ---------- start ---------- */
async function boot() {
  for (let attempt = 1; ; attempt++) {
    try { await initDb(); break; }
    catch (e) {
      if (attempt >= 10) throw e;
      console.warn(`[db] not ready (${e.message}). Retrying in 3s… (${attempt}/10)`);
      await sleep(3000);
    }
  }
  await seed();
  setInterval(cleanupSoon, 6 * 60 * 60 * 1000).unref();
  const server = app.listen(PORT, '0.0.0.0', () => console.log(`purple dev is running on port ${PORT} (admin: /admin, owner: ${OWNER_EMAIL})`));
  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
boot().catch((e) => { console.error('Startup failed:', e); process.exit(1); });
