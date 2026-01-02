const { Pool } = require("pg");
const { hashPassword, verifyPassword } = require("./auth");
const { getTestPayloadFull, getTestPayloadForClient, OPEN_AT_UTC_MS: DEFAULT_OPEN_AT_UTC_MS, DURATION_SECONDS: DEFAULT_DURATION_SECONDS } = require("./test_config");

let pool = null;
let _appConfig = null;

function getConnString() {
  return (
    process.env.DATABASE_URL ||
    process.env.NETLIFY_DATABASE_URL_UNPOOLED ||
    process.env.NETLIFY_DATABASE_URL ||
    ""
  );
}

function getPool() {
  if (pool) return pool;
  const cs = getConnString();
  if (!cs) throw new Error("Postgres connection string missing. Set DATABASE_URL (or NETLIFY_DATABASE_URL_UNPOOLED)." );
  pool = new Pool({
    connectionString: cs,
    ssl: cs.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
  });
  return pool;
}

async function q(text, params = []) {
  const p = getPool();
  return p.query(text, params);
}

function makeToken(len = 10) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function initDb() {
  // Minimal schema (as requested)
  await q(`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      submitted BOOLEAN NOT NULL DEFAULT FALSE,
      grade DOUBLE PRECISION
    );
  `);

  // Fixed server config stored in DB (single row, no UI to edit)
  await q(`
    CREATE TABLE IF NOT EXISTS app_config (
      id INT PRIMARY KEY CHECK (id = 1),
      open_at_utc_ms BIGINT NOT NULL,
      duration_seconds INT NOT NULL
    );
  `);

  const rows = await q(`SELECT open_at_utc_ms, duration_seconds FROM app_config WHERE id = 1 LIMIT 1;`);
  if (!rows.rows.length) {
    await q(
      `INSERT INTO app_config (id, open_at_utc_ms, duration_seconds) VALUES (1, $1, $2);`,
      [DEFAULT_OPEN_AT_UTC_MS, DEFAULT_DURATION_SECONDS]
    );
    _appConfig = { openAtUtc: DEFAULT_OPEN_AT_UTC_MS, durationSeconds: DEFAULT_DURATION_SECONDS };
  } else {
    _appConfig = {
      openAtUtc: Number(rows.rows[0].open_at_utc_ms),
      durationSeconds: Number(rows.rows[0].duration_seconds),
    };
  }

// Admin accounts (DB-driven)
await q(`
  CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL
  );
`);

const arows = await q(`SELECT id FROM admins LIMIT 1;`);
if (!arows.rows.length) {
  const seed = [
    { username: "admin1", pass: "R4f@il2026" },
    { username: "admin2", pass: "BananaBlade!26" },
    { username: "admin3", pass: "OutrageInk#26" },
    { username: "admin4", pass: "AthensExam$26" },
    { username: "admin5", pass: "DoubleZ%26" },
  ];
  for (const a of seed) {
    await q(`INSERT INTO admins (username, pass_hash) VALUES ($1, $2)`, [a.username, hashPassword(a.pass)]);
  }
}
}

async function createSession({ candidateName }) {
  const token = makeToken(10);
  const name = String(candidateName || "Candidate").trim() || "Candidate";
  const r = await q(
    `INSERT INTO public.sessions (token, name, submitted, grade)
     VALUES ($1, $2, FALSE, NULL)
     RETURNING id`,
    [token, name]
  );
  return { token, sessionId: r.rows[0].id };
}

async function getSessionForExam(token) {
  const r = await q(
    `SELECT id, token, name, submitted, grade FROM public.sessions WHERE token = $1`,
    [token]
  );
  const s = r.rows[0];
  if (!s) return null;
  return {
    session: {
      id: s.id,
      token: s.token,
      candidateName: s.name,
      submitted: !!s.submitted,
      grade: s.grade,
      durationSeconds: _appConfig?.durationSeconds ?? DEFAULT_DURATION_SECONDS,
    },
    test: {
      id: 1,
      title: "English Test",
      payload: getTestPayloadForClient(),
    },
  };
}

async function startSession(token) {
  const r = await q(`SELECT submitted FROM public.sessions WHERE token = $1`, [token]);
  const s = r.rows[0];
  if (!s) return null;
  if (s.submitted) return { status: "submitted" };
  return { status: "started" };
}

async function presencePing(_token, _status) {
  return true;
}

function normalizeAnswers(answers) {
  if (!answers || typeof answers !== "object") return {};
  return answers;
}

async function gradeAttempt(answers) {
  const payload = getTestPayloadFull();
  let score = 0;
  let maxScore = 0;
  const breakdown = [];

  for (const sec of payload.sections || []) {
    for (const item of sec.items || []) {
      const pts = Number(item.points || 0);
      maxScore += pts;

      const a = answers[item.id];
      let earned = 0;
      let ok = false;

      if (item.type === "mcq" || item.type === "listening-mcq") {
        const idx = Number(a);
        ok = Number.isFinite(idx) && idx === item.correctIndex;
        earned = ok ? pts : 0;
      } else if (item.type === "tf") {
        const val = a === true || a === "true" || a === "True";
        ok = val === item.correct;
        earned = ok ? pts : 0;
      } else if (item.type === "short") {
        const s = String(a || "").trim().toLowerCase();
        const expected = String(item.correctText || "").trim().toLowerCase();
        ok = expected.length > 0 && s === expected;
        earned = ok ? pts : 0;
      }

      score += earned;
      breakdown.push({ id: item.id, earned, pts, ok });
    }
  }

  const percent = maxScore > 0 ? Math.round((score / maxScore) * 1000) / 10 : 0;
  return { score, maxScore, percent, breakdown };
}

async function submitAnswers(token, answers /*, clientMeta */) {
  const r = await q(`SELECT id, submitted FROM public.sessions WHERE token = $1`, [token]);
  const s = r.rows[0];
  if (!s) return null;
  if (s.submitted) return { status: "submitted" };

  const normAnswers = normalizeAnswers(answers);
  const grade = await gradeAttempt(normAnswers);
  await q(`UPDATE public.sessions SET submitted = TRUE, grade = $1 WHERE id = $2`, [grade.percent, s.id]);

  return { status: "submitted", score: grade.score, maxScore: grade.maxScore, grade: grade.percent, breakdown: grade.breakdown };
}

async function listCandidates() {
  const r = await q(
    `SELECT id AS "sessionId", name AS "candidateName", token, submitted, grade
     FROM public.sessions
     ORDER BY id DESC
     LIMIT 5000`
  );
  return r.rows;
}

async function listResults() {
  const r = await q(
    `SELECT id AS "sessionId", name AS "candidateName", token, submitted, grade
     FROM public.sessions
     WHERE submitted = TRUE
     ORDER BY id DESC
     LIMIT 5000`
  );
  return r.rows;
}


function getConfig() {
  return {
    serverNow: Date.now(),
    openAtUtc: _appConfig?.openAtUtc ?? DEFAULT_OPEN_AT_UTC_MS,
    durationSeconds: _appConfig?.durationSeconds ?? DEFAULT_DURATION_SECONDS,
  };
}

async function verifyAdmin(username, password) {
  const u = String(username || "");
  const p = String(password || "");
  if (!u || !p) return false;
  const row = await q(`SELECT pass_hash FROM admins WHERE username = $1 LIMIT 1;`, [u]);
  if (!row.rows.length) return false;
  return verifyPassword(p, row.rows[0].pass_hash);
}

async function updateAppConfig({ openAtUtc, durationSeconds }) {
  const o = Number(openAtUtc);
  const d = Number(durationSeconds);
  if (!Number.isFinite(o) || !Number.isFinite(d)) throw new Error("Invalid config");
  if (o < 0 || d <= 0) throw new Error("Invalid config values");

  await q(`UPDATE app_config SET open_at_utc_ms = $1, duration_seconds = $2 WHERE id = 1;`, [o, d]);
  _appConfig = { openAtUtc: o, durationSeconds: d };
  return getConfig();
}

module.exports = {
  initDb,
  createSession,
  getSessionForExam,
  startSession,
  submitAnswers,
  listResults,
  listCandidates,
  presencePing,
  getConfig,
  verifyAdmin,
  updateAppConfig,
};
