const { neon } = require("@netlify/neon");
const { hashPassword, verifyPassword } = require("./auth");
const {
  getTestPayloadFull,
  getTestPayloadForClient,
  OPEN_AT_UTC_MS: DEFAULT_OPEN_AT_UTC_MS,
  DURATION_SECONDS: DEFAULT_DURATION_SECONDS,
} = require("./test_config");

// Uses Netlify DB (Neon) by default. If you also set DATABASE_URL, we will use it as fallback.
const conn =
  process.env.NETLIFY_DATABASE_URL ||
  process.env.DATABASE_URL ||
  process.env.NETLIFY_DATABASE_URL_UNPOOLED ||
  "";

if (!conn) {
  throw new Error(
    "Postgres connection string missing. Set NETLIFY_DATABASE_URL (Netlify DB) or DATABASE_URL."
  );
}

// `neon(connectionString)` gives a tagged template function for queries.
const sql = neon(conn);

let _appConfig = null;

function makeToken(len = 10) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function initDb() {
  // Minimal schema (as requested)
  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      submitted BOOLEAN NOT NULL DEFAULT FALSE,
      grade REAL
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS app_config (
      id INT PRIMARY KEY CHECK (id = 1),
      open_at_utc_ms BIGINT NOT NULL,
      duration_seconds INT NOT NULL
    );
  `;

  const rows = await sql`
    SELECT open_at_utc_ms, duration_seconds
    FROM app_config
    WHERE id = 1
    LIMIT 1;
  `;

  if (!rows.length) {
    await sql`
      INSERT INTO app_config (id, open_at_utc_ms, duration_seconds)
      VALUES (1, ${DEFAULT_OPEN_AT_UTC_MS}, ${DEFAULT_DURATION_SECONDS});
    `;
    _appConfig = { openAtUtc: DEFAULT_OPEN_AT_UTC_MS, durationSeconds: DEFAULT_DURATION_SECONDS };
  } else {
    _appConfig = {
      openAtUtc: Number(rows[0].open_at_utc_ms),
      durationSeconds: Number(rows[0].duration_seconds),
    };
  }

  await sql`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL
    );
  `;

  const arows = await sql`SELECT id FROM admins LIMIT 1;`;
  if (!arows.length) {
    const a = { username: "admin", pass: "admin" };
    await sql`
      INSERT INTO admins (username, pass_hash)
      VALUES (${a.username}, ${hashPassword(a.pass)});
    `;
  }
}

async function createSession(name) {
  const token = makeToken(10);

  const ins = await sql`
    INSERT INTO sessions (token, name, submitted, grade)
    VALUES (${token}, ${String(name || "").trim() || "Candidate"}, FALSE, NULL)
    RETURNING id;
  `;

  return { token, sessionId: ins[0].id };
}

async function getSessionForExam(token) {
  const r = await sql`
    SELECT id, token, name, submitted, grade
    FROM sessions
    WHERE token = ${token}
    LIMIT 1;
  `;
  const s = r[0];
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
  const r = await sql`
    SELECT submitted
    FROM sessions
    WHERE token = ${token}
    LIMIT 1;
  `;
  const s = r[0];
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

      let ok = false;
      let earned = 0;

      if (item.type === "mcq") {
        const chosen = answers[item.id];
        ok = chosen === item.correct;
        earned = ok ? pts : 0;
      } else if (item.type === "gap") {
        const a = answers[item.id] || {};
        const expected = item.correct || {};
        ok = true;
        for (const k of Object.keys(expected)) {
          const got = String(a[k] ?? "").trim().toLowerCase();
          const exp = String(expected[k] ?? "").trim().toLowerCase();
          if (got !== exp) ok = false;
        }
        earned = ok ? pts : 0;
      } else if (item.type === "writing") {
        const s = String(answers[item.id] || "").trim().toLowerCase();
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
  const r = await sql`
    SELECT id, submitted
    FROM sessions
    WHERE token = ${token}
    LIMIT 1;
  `;
  const s = r[0];
  if (!s) return null;
  if (s.submitted) return { status: "submitted" };

  const normAnswers = normalizeAnswers(answers);
  const grade = await gradeAttempt(normAnswers);

  await sql`
    UPDATE sessions
    SET submitted = TRUE, grade = ${grade.percent}
    WHERE id = ${s.id};
  `;

  return {
    status: "submitted",
    score: grade.score,
    maxScore: grade.maxScore,
    grade: grade.percent,
    breakdown: grade.breakdown,
  };
}

async function listCandidates() {
  const r = await sql`
    SELECT
      id AS "sessionId",
      name AS "candidateName",
      token,
      submitted,
      grade
    FROM sessions
    ORDER BY id DESC
    LIMIT 5000;
  `;
  return r;
}

async function listResults() {
  const r = await sql`
    SELECT
      id AS "sessionId",
      name AS "candidateName",
      token,
      submitted,
      grade
    FROM sessions
    WHERE submitted = TRUE
    ORDER BY id DESC
    LIMIT 5000;
  `;
  return r;
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

  const row = await sql`
    SELECT pass_hash
    FROM admins
    WHERE username = ${u}
    LIMIT 1;
  `;

  if (!row.length) return false;
  return verifyPassword(p, row[0].pass_hash);
}

async function updateAppConfig(openAtUtcMs, durationSeconds) {
  const o = Number(openAtUtcMs);
  const d = Number(durationSeconds);

  await sql`
    UPDATE app_config
    SET open_at_utc_ms = ${o}, duration_seconds = ${d}
    WHERE id = 1;
  `;

  _appConfig = { openAtUtc: o, durationSeconds: d };
  return true;
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
