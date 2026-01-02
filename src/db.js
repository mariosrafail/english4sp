const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { hashPassword, verifyPassword } = require("./auth");

const { getTestPayloadFull, getTestPayloadForClient, OPEN_AT_UTC_MS: DEFAULT_OPEN_AT_UTC_MS, DURATION_SECONDS: DEFAULT_DURATION_SECONDS } = require("./test_config");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data.sqlite");
let _db = null;
let _appConfig = null;

function db() {
  if (!_db) throw new Error("DB not initialized");
  return _db;
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db().run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db().get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db().all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initDb() {
  _db = new sqlite3.Database(DB_PATH);
  await run(`PRAGMA foreign_keys = ON;`);

  // Minimal schema (as requested)
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      submitted INTEGER NOT NULL DEFAULT 0,
      grade REAL
    );
  `);

  // Fixed server config stored in DB (single row, no UI to edit)
  await run(`
    CREATE TABLE IF NOT EXISTS app_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      open_at_utc_ms INTEGER NOT NULL,
      duration_seconds INTEGER NOT NULL
    );
  `);

  const rows = await all(`SELECT open_at_utc_ms, duration_seconds FROM app_config WHERE id = 1 LIMIT 1;`);
  if (!rows.length) {
    await run(
      `INSERT INTO app_config (id, open_at_utc_ms, duration_seconds) VALUES (1, ?, ?);`,
      [DEFAULT_OPEN_AT_UTC_MS, DEFAULT_DURATION_SECONDS]
    );
    _appConfig = { openAtUtc: DEFAULT_OPEN_AT_UTC_MS, durationSeconds: DEFAULT_DURATION_SECONDS };
  } else {
    _appConfig = {
      openAtUtc: Number(rows[0].open_at_utc_ms),
      durationSeconds: Number(rows[0].duration_seconds),
    };
  }

  // Admin accounts (DB-driven)
  await run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL
    );
  `);

  const arows = await all(`SELECT id FROM admins LIMIT 1;`);
  if (!arows.length) {
    const seed = [
      { username: "admin1", pass: "R4f@il2026" },
      { username: "admin2", pass: "BananaBlade!26" },
      { username: "admin3", pass: "OutrageInk#26" },
      { username: "admin4", pass: "AthensExam$26" },
      { username: "admin5", pass: "DoubleZ%26" },
    ];
    for (const a of seed) {
      await run(`INSERT INTO admins (username, pass_hash) VALUES (?, ?)`, [
        a.username,
        hashPassword(a.pass),
      ]);
    }
  }

}

function makeToken() {
  // 10 chars, URL safe-ish
  return (
    Math.random().toString(36).slice(2, 8).toUpperCase() +
    Math.random().toString(36).slice(2, 6).toUpperCase()
  );
}

async function createSession({ candidateName }) {
  const token = makeToken();
  const name = String(candidateName || "Candidate").trim() || "Candidate";

  const r = await run(
    `INSERT INTO sessions (token, name, submitted, grade) VALUES (?, ?, 0, NULL)`,
    [token, name]
  );
  const sessionId = r && (r.lastID ?? r.lastId);
  return { token, sessionId };
}

async function getSessionForExam(token) {
  const s = await get(`SELECT id, token, name, submitted, grade FROM sessions WHERE token = ?`, [token]);
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
  const s = await get(`SELECT id, submitted FROM sessions WHERE token = ?`, [token]);
  if (!s) return null;
  if (s.submitted) return { status: "submitted" };
  return { status: "started" };
}

async function presencePing(_token, _status) {
  // Minimal mode: no persistence for proctor events
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
        const val = (a === true || a === "true" || a === "True");
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
  const s = await get(`SELECT id, submitted FROM sessions WHERE token = ?`, [token]);
  if (!s) return null;
  if (s.submitted) return { status: "submitted" };

  const normAnswers = normalizeAnswers(answers);
  const grade = await gradeAttempt(normAnswers);

  await run(`UPDATE sessions SET submitted = 1, grade = ? WHERE id = ?`, [grade.percent, s.id]);
  return {
    status: "submitted",
    score: grade.score,
    maxScore: grade.maxScore,
    grade: grade.percent,
    breakdown: grade.breakdown,
  };
}

async function listCandidates() {
  const rows = await all(
    `SELECT id AS sessionId, name AS candidateName, token, submitted, grade
     FROM sessions
     ORDER BY id DESC
     LIMIT 5000`
  );
  return rows;
}

async function listResults() {
  const rows = await all(
    `SELECT id AS sessionId, name AS candidateName, token, submitted, grade
     FROM sessions
     WHERE submitted = 1
     ORDER BY id DESC
     LIMIT 5000`
  );
  return rows;
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
  const row = await get(`SELECT pass_hash FROM admins WHERE username = ? LIMIT 1;`, [u]);
  if (!row) return false;
  return verifyPassword(p, row.pass_hash);
}

async function updateAppConfig({ openAtUtc, durationSeconds }) {
  const o = Number(openAtUtc);
  const d = Number(durationSeconds);
  if (!Number.isFinite(o) || !Number.isFinite(d)) throw new Error("Invalid config");
  if (o < 0 || d <= 0) throw new Error("Invalid config values");

  await run(`UPDATE app_config SET open_at_utc_ms = ?, duration_seconds = ? WHERE id = 1;`, [o, d]);
  _appConfig = { openAtUtc: o, durationSeconds: d };
  return getConfig();
}

module.exports = {
  initDb,
  db,
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
