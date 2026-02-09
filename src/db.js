const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { hashPassword, verifyPassword } = require("./auth");

const {
  getTestPayloadFull,
  getTestPayloadForClient,
  OPEN_AT_UTC_MS: DEFAULT_OPEN_AT_UTC_MS,
  DURATION_MINUTES: DEFAULT_DURATION_MINUTES,
} = require("./test_config");

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

  // Exam periods
  await run(`
    CREATE TABLE IF NOT EXISTS exam_periods (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      created_at_utc_ms INTEGER NOT NULL
    );
  `);

  // Seed default exam period (id=1) if empty
  const eprows = await all(`SELECT id FROM exam_periods LIMIT 1;`);
  if (!eprows.length) {
    await run(
      `INSERT INTO exam_periods (id, name, created_at_utc_ms) VALUES (1, ?, ?);`,
      ["Default Exam Period", Date.now()]
    );
  }

  // Candidates (unique by email)
  await run(`
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY,
      name TEXT,
      email TEXT NOT NULL UNIQUE,
      country TEXT,
      created_at_utc_ms INTEGER NOT NULL
    );
  `);

  // Sessions
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY,
      exam_period_id INTEGER NOT NULL DEFAULT 1,
      candidate_id INTEGER,
      token TEXT NOT NULL,
      name TEXT NOT NULL,
      submitted INTEGER NOT NULL DEFAULT 0,
      disqualified INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (exam_period_id) REFERENCES exam_periods(id)
    );
  `);

  // Migrate older schema (add exam_period_id if missing)
  try { await run(`ALTER TABLE sessions ADD COLUMN exam_period_id INTEGER;`); } catch {}
  try { await run(`ALTER TABLE sessions ADD COLUMN candidate_id INTEGER;`); } catch {}
  try { await run(`ALTER TABLE sessions ADD COLUMN disqualified INTEGER NOT NULL DEFAULT 0;`); } catch {}
  try { await run(`UPDATE sessions SET exam_period_id = COALESCE(exam_period_id, 1);`); } catch {}


  // Migration: remove deprecated sessions.grade column (grades moved to question_grades.total_grade)
  try {
    const sCols = await all(`PRAGMA table_info(sessions);`);
    const sNames = new Set((sCols || []).map((c)=> String(c.name || "")));
    if (sNames.has("grade")) {
      await run(`PRAGMA foreign_keys = OFF;`);
      await run(`
        CREATE TABLE IF NOT EXISTS sessions_new (
          id INTEGER PRIMARY KEY,
          exam_period_id INTEGER NOT NULL DEFAULT 1,
          candidate_id INTEGER,
          token TEXT NOT NULL,
          name TEXT NOT NULL,
          submitted INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (exam_period_id) REFERENCES exam_periods(id)
        );
      `);
      await run(`
        INSERT INTO sessions_new (id, exam_period_id, candidate_id, token, name, submitted)
        SELECT id, exam_period_id, candidate_id, token, name, submitted
        FROM sessions;
      `);
      await run(`DROP TABLE sessions;`);
      await run(`ALTER TABLE sessions_new RENAME TO sessions;`);
      await run(`PRAGMA foreign_keys = ON;`);
    }
  } catch {}
  await run(`CREATE INDEX IF NOT EXISTS idx_sessions_exam_period ON sessions (exam_period_id);`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_sessions_exam_token ON sessions (exam_period_id, token);`);

  // Fixed server config stored in DB (single row, no UI to edit)
  await run(`
    CREATE TABLE IF NOT EXISTS app_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      open_at_utc_ms INTEGER NOT NULL,
      duration_minutes INTEGER
    );
  `);

  // Migrate older schema (duration_seconds -> duration_minutes)
  try { await run(`ALTER TABLE app_config ADD COLUMN duration_minutes INTEGER;`); } catch {}
  const hasDurSeconds = await get(
    `SELECT 1 FROM pragma_table_info('app_config') WHERE name = 'duration_seconds' LIMIT 1;`
  );
  if (hasDurSeconds) {
    await run(
      `UPDATE app_config
       SET duration_minutes = COALESCE(duration_minutes, MAX(1, ROUND(duration_seconds / 60.0)))
       WHERE id = 1;`
    );
  }

  const rows = await all(`SELECT open_at_utc_ms, duration_minutes FROM app_config WHERE id = 1 LIMIT 1;`);
  if (!rows.length) {
    await run(
      `INSERT INTO app_config (id, open_at_utc_ms, duration_minutes) VALUES (1, ?, ?);`,
      [DEFAULT_OPEN_AT_UTC_MS, DEFAULT_DURATION_MINUTES]
    );
    _appConfig = { openAtUtc: DEFAULT_OPEN_AT_UTC_MS, durationMinutes: DEFAULT_DURATION_MINUTES };
  } else {
    _appConfig = {
      openAtUtc: Number(rows[0].open_at_utc_ms),
      durationMinutes: Number(rows[0].duration_minutes),
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
      { username: "admin1", pass: "AS8549D1ASD0" },
      { username: "admin2", pass: "A8S97D401AS0" },
      { username: "admin3", pass: "ASD129AS5D04" },
      { username: "admin4", pass: "AS1D0AS8D40D" },
      { username: "admin5", pass: "ASD410A85SD0" },
    ];
    for (const a of seed) {
      await run(`INSERT INTO admins (username, pass_hash) VALUES (?, ?)`, [
        a.username,
        hashPassword(a.pass),
      ]);
    }
  }

  // Examiners accounts (DB-driven, same as admins)
  await run(`
    CREATE TABLE IF NOT EXISTS examiners (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL
    );
  `);

  const exrows = await all(`SELECT id FROM examiners LIMIT 1;`);
  if (!exrows.length) {
    const seedExaminers = [
      { username: "examiner1", pass: "6NR7UYNUJH7U" },
      { username: "examiner2", pass: "SD789F6HSDF9" },
      { username: "examiner3", pass: "Y6UH75Y65GHH" },
      { username: "examiner4", pass: "Y56HYU56HY67" },
      { username: "examiner5", pass: "65YTUH67H67J" },
    ];
    for (const u of seedExaminers) {
      await run(`INSERT INTO examiners (username, pass_hash) VALUES (?, ?)`, [
        u.username,
        hashPassword(u.pass),
      ]);
    }
  }

  // Per-question grades (minimal: 3 questions A,B,C)
  await run(`
    CREATE TABLE IF NOT EXISTS question_grades (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      q_writing TEXT,
      answers_json TEXT,
      speaking_grade INTEGER CHECK (speaking_grade IS NULL OR (speaking_grade >= 0 AND speaking_grade <= 100)),
      writing_grade INTEGER CHECK (writing_grade IS NULL OR (writing_grade >= 0 AND writing_grade <= 100)),
      total_grade INTEGER CHECK (total_grade IS NULL OR (total_grade >= 0 AND total_grade <= 100)),
      created_at_utc_ms INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_qg_session_id ON question_grades (session_id);`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_qg_session_id ON question_grades (session_id);`);

  // Migration: add newer columns if this DB was created before they existed
  const qgCols = await all(`PRAGMA table_info(question_grades);`);
  const qgNames = new Set((qgCols || []).map((c)=> String(c.name || "")));
  // Best-effort cleanup for old columns (SQLite versions vary in ALTER support).
  if (qgNames.has("q_a")) { try { await run(`ALTER TABLE question_grades DROP COLUMN q_a;`); } catch {} }
  if (qgNames.has("q_b")) { try { await run(`ALTER TABLE question_grades DROP COLUMN q_b;`); } catch {} }
  if (qgNames.has("q_c")) { try { await run(`ALTER TABLE question_grades DROP COLUMN q_c;`); } catch {} }
  if (!qgNames.has("q_writing")) await run(`ALTER TABLE question_grades ADD COLUMN q_writing TEXT;`);
  if (!qgNames.has("answers_json")) await run(`ALTER TABLE question_grades ADD COLUMN answers_json TEXT;`);
  if (!qgNames.has("speaking_grade")) await run(`ALTER TABLE question_grades ADD COLUMN speaking_grade INTEGER;`);
  if (!qgNames.has("writing_grade")) await run(`ALTER TABLE question_grades ADD COLUMN writing_grade INTEGER;`);
}

  if (!qgNames.has("total_grade")) {
    try { await run(`ALTER TABLE question_grades ADD COLUMN total_grade INTEGER CHECK (total_grade IS NULL OR (total_grade >= 0 AND total_grade <= 100));`); } catch {}
  }

function makeToken() {
  return (
    Math.random().toString(36).slice(2, 8).toUpperCase() +
    Math.random().toString(36).slice(2, 6).toUpperCase()
  );
}

async function createSession({ candidateName, examPeriodId = 1 }) {
  const token = makeToken();
  const name = String(candidateName || "Candidate").trim() || "Candidate";
  const ep = Number(examPeriodId) || 1;

  const r = await run(
    `INSERT INTO sessions (exam_period_id, token, name, submitted) VALUES (?, ?, ?, 0)`,
    [ep, token, name]
  );
  const sessionId = r && (r.lastID ?? r.lastId);
    return {
    status: "submitted"
  };
  return { status: "started" };
}

async function presencePing(_token, _status) {
  return true;
}

function normalizeAnswers(answers) {
  if (!answers || typeof answers !== "object") return {};
  return answers;
}

function answerToText(item, raw) {
  if (!item) return "";

  if (item.type === "mcq" || item.type === "listening-mcq") {
    const idx = Number(raw);
    if (!Number.isFinite(idx) || idx < 0) return "";
    const max = Array.isArray(item.choices) ? item.choices.length : Infinity;
    if (idx >= max) return "";
    return String.fromCharCode("a".charCodeAt(0) + idx);
  }

  if (item.type === "tf") {
    if (raw === "" || raw === null || raw === undefined) return "";
    const val = raw === true || raw === "true" || raw === "True" || raw === 1 || raw === "1";
    return val ? "true" : "false";
  }

  if (item.type === "short") {
    return String(raw ?? "").trim();
  }

  return String(raw ?? "").trim();
}

function buildStoredAnswers(payload, normAnswers) {
  const out = {};
  for (const sec of payload.sections || []) {
    for (const item of sec.items || []) {
      if (!item || !item.id || item.type === "info") continue;
      out[item.id] = answerToText(item, normAnswers?.[item.id]);
    }
  }
  return out;
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
  const s = await get(`SELECT id, submitted FROM sessions WHERE token = ? ORDER BY s.id DESC LIMIT 1`, [token]);
  if (!s) return null;
  if (s.submitted) return { status: "submitted" };

  const normAnswers = normalizeAnswers(answers);

  await run(`UPDATE sessions SET submitted = 1 WHERE id = ?`, [s.id]);

  const payload = getTestPayloadFull();

  // Writing (free text) if present in payload
  let wVal = "";
  try {
    for (const sec of payload.sections || []) {
      for (const item of sec.items || []) {
        if (item && item.id === "q4") {
          wVal = answerToText(item, normAnswers?.[item.id]);
        }
      }
    }
  } catch {}

  const storedAnswers = buildStoredAnswers(payload, normAnswers);
  const answersJson = JSON.stringify(storedAnswers);

  const existing = await get(`SELECT id FROM question_grades WHERE session_id = ? LIMIT 1;`, [s.id]);
  if (existing) {
    await run(
      `UPDATE question_grades
       SET token = ?, q_writing = ?, answers_json = ?, created_at_utc_ms = ?
       WHERE session_id = ?`,
      [token, wVal, answersJson, Date.now(), s.id]
    );
  } else {
    await run(
      `INSERT INTO question_grades (session_id, token, q_writing, answers_json, created_at_utc_ms)
       VALUES (?, ?, ?, ?, ?)`,
      [s.id, token, wVal, answersJson, Date.now()]
    );
  }

  return { status: "submitted" };
}

async function listCandidates({ examPeriodId } = {}) {
  const ep = examPeriodId ? Number(examPeriodId) : null;
  const rows = await all(
    ep
      ? `SELECT s.id AS sessionId, s.exam_period_id AS examPeriodId, s.name AS candidateName, s.token, s.submitted,
               q.total_grade AS totalGrade, COALESCE(s.disqualified, 0) AS disqualified,
               '' AS assignedExaminer
         FROM sessions s
         LEFT JOIN question_grades q ON q.session_id = s.id
         WHERE s.exam_period_id = ?
         ORDER BY s.id DESC
         LIMIT 5000`
      : `SELECT s.id AS sessionId, s.exam_period_id AS examPeriodId, s.name AS candidateName, s.token, s.submitted,
               q.total_grade AS totalGrade, COALESCE(s.disqualified, 0) AS disqualified,
               '' AS assignedExaminer
         FROM sessions s
         LEFT JOIN question_grades q ON q.session_id = s.id
         ORDER BY s.id DESC
         LIMIT 5000`,
    ep ? [ep] : []
  );
  return rows;
}

async function listCandidatesForExaminer({ examPeriodId } = {}) {
  const ep = examPeriodId ? Number(examPeriodId) : null;
  const sql = ep
    ? `SELECT
         s.id AS sessionId,
         s.exam_period_id AS examPeriodId,
         COALESCE(epd.name, 'Exam Period ' || s.exam_period_id) AS examPeriodName,
         s.token,
         s.submitted,
         COALESCE(q.q_writing, '') AS qWriting,
         q.speaking_grade AS speakingGrade,
         q.writing_grade AS writingGrade
       FROM sessions s
       LEFT JOIN question_grades q ON q.session_id = s.id
       LEFT JOIN exam_periods epd ON epd.id = s.exam_period_id
       WHERE s.exam_period_id = ?
       ORDER BY s.id DESC
       LIMIT 5000`
     : `SELECT
         s.id AS sessionId,
         s.exam_period_id AS examPeriodId,
         COALESCE(epd.name, 'Exam Period ' || s.exam_period_id) AS examPeriodName,
         s.token,
         s.submitted,
         COALESCE(q.q_writing, '') AS qWriting,
         q.speaking_grade AS speakingGrade,
         q.writing_grade AS writingGrade
       FROM sessions s
       LEFT JOIN question_grades q ON q.session_id = s.id
       LEFT JOIN exam_periods epd ON epd.id = s.exam_period_id
       ORDER BY s.id DESC
       LIMIT 5000`;

  return await all(sql, ep ? [ep] : []);
}

async function setExaminerGrades({ sessionId, speakingGrade, writingGrade }) {
  const sid = Number(sessionId);
  if (!Number.isFinite(sid)) return null;

  const sp = speakingGrade === null || speakingGrade === undefined || speakingGrade === "" ? null : Number(speakingGrade);
  const wr = writingGrade === null || writingGrade === undefined || writingGrade === "" ? null : Number(writingGrade);

  function clamp100(n){
    if (n === null) return null;
    if (!Number.isFinite(n)) return null;
    const v = Math.round(n);
    if (v < 0) return 0;
    if (v > 100) return 100;
    return v;
  }

  const spV = clamp100(sp);
  const wrV = clamp100(wr);

  const s = await get(`SELECT id, token FROM sessions WHERE id = ? LIMIT 1;`, [sid]);
  if (!s) return null;

  // Ensure row exists in question_grades
  const qg = await get(`SELECT id FROM question_grades WHERE session_id = ? LIMIT 1;`, [sid]);
  if (qg) {
    await run(
      `UPDATE question_grades
       SET speaking_grade = ?, writing_grade = ?, created_at_utc_ms = ?
       WHERE session_id = ?`,
      [spV, wrV, Date.now(), sid]
    );
  } else {
    await run(
      `INSERT INTO question_grades (session_id, token, q_writing, answers_json, speaking_grade, writing_grade, created_at_utc_ms)
       VALUES (?, ?, '', '{}', ?, ?, ?)`,
      [sid, String(s.token || ""), spV, wrV, Date.now()]
    );
  }

  // Load stored answers from JSON
  const q = await get(`SELECT COALESCE(answers_json,'{}') AS answers_json FROM question_grades WHERE session_id = ? LIMIT 1;`, [sid]);
  let ansObj = {};
  try { ansObj = JSON.parse(String(q?.answers_json || "{}")); } catch {}

  // Compute objective score from all auto-gradable items.
  const payload = getTestPayloadFull();
  let objectiveEarned = 0;
  let objectiveMax = 0;
  for (const sec of payload.sections || []) {
    for (const item of sec.items || []) {
      if (!item || !item.id || item.type === "info") continue;
      const pts = Number(item.points || 0);
      if (pts <= 0) continue;

      let expected = "";
      if (item.type === "mcq" || item.type === "listening-mcq") expected = answerToText(item, item.correctIndex);
      else if (item.type === "tf") expected = answerToText(item, item.correct);
      else if (item.type === "short") expected = answerToText(item, item.correctText);
      if (!expected) continue;

      const got = String(ansObj[item.id] ?? "").trim().toLowerCase();
      objectiveMax += pts;
      if (got === String(expected).trim().toLowerCase()) objectiveEarned += pts;
    }
  }
  const objectivePercent = objectiveMax > 0 ? (objectiveEarned / objectiveMax) * 100 : 0;
  const spCalc = spV === null ? 0 : spV;
  const wrCalc = wrV === null ? 0 : wrV;

  // Final weighting: Objective 60%, Writing 20%, Speaking 20%.
  const total = Math.round((objectivePercent * 0.6) + (wrCalc * 0.2) + (spCalc * 0.2));

  await run(
    `UPDATE question_grades
     SET total_grade = ?, created_at_utc_ms = ?
     WHERE session_id = ?`,
    [total, Date.now(), sid]
  );

  return {
    sessionId: sid,
    objectiveEarned,
    objectiveMax,
    objectivePercent: Math.round(objectivePercent * 10) / 10,
    speakingGrade: spV,
    writingGrade: wrV,
    totalGrade: total
  };
}

async function listResultsasync function listResults({ examPeriodId } = {}) {
  const ep = examPeriodId ? Number(examPeriodId) : null;
  const rows = await all(
    ep
      ? `SELECT s.id AS sessionId, s.exam_period_id AS examPeriodId, s.name AS candidateName, s.token, s.submitted, q.total_grade AS totalGrade
         FROM sessions s
         LEFT JOIN question_grades q ON q.session_id = s.id
         WHERE submitted = 1 AND exam_period_id = ?
         ORDER BY s.id DESC
         LIMIT 5000`
      : `SELECT s.id AS sessionId, s.exam_period_id AS examPeriodId, s.name AS candidateName, s.token, s.submitted, q.total_grade AS totalGrade
         FROM sessions s
         LEFT JOIN question_grades q ON q.session_id = s.id
         WHERE submitted = 1
         ORDER BY s.id DESC
         LIMIT 5000`,
    ep ? [ep] : []
  );
  return rows;
}

async function getQuestionGrades(sessionId) {
  const sid = Number(sessionId);
  if (!Number.isFinite(sid)) return null;
  return await get(
    `SELECT session_id AS sessionId, token,
            COALESCE(q_writing,'') AS qWriting, COALESCE(answers_json,'{}') AS answersJson,
            speaking_grade AS speakingGrade, writing_grade AS writingGrade,
            created_at_utc_ms AS createdAtUtcMs
     FROM question_grades
     WHERE session_id = ?
     LIMIT 1;`,
    [sid]
  );
}

function getConfig() {
  return {
    serverNow: Date.now(),
    openAtUtc: _appConfig?.openAtUtc ?? DEFAULT_OPEN_AT_UTC_MS,
    durationMinutes: _appConfig?.durationMinutes ?? DEFAULT_DURATION_MINUTES,
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

async function verifyExaminer(username, password) {
  const u = String(username || "");
  const p = String(password || "");
  if (!u || !p) return false;
  const row = await get(`SELECT pass_hash FROM examiners WHERE username = ? LIMIT 1;`, [u]);
  if (!row) return false;
  return verifyPassword(p, row.pass_hash);
}

async function updateAppConfig({ openAtUtc, durationMinutes, durationSeconds }) {
  const o = Number(openAtUtc);
  const m = Number(durationMinutes ?? Number(durationSeconds || 0) / 60);
  const mInt = Math.round(m);
  if (!Number.isFinite(o) || !Number.isFinite(mInt)) throw new Error("Invalid config");
  if (o < 0 || mInt <= 0) throw new Error("Invalid config values");

  await run(`UPDATE app_config SET open_at_utc_ms = ?, duration_minutes = ? WHERE id = 1;`, [o, mInt]);
  try { await run(`UPDATE app_config SET duration_seconds = ? WHERE id = 1;`, [mInt * 60]); } catch {}

  _appConfig = { openAtUtc: o, durationMinutes: mInt };
  return getConfig();
}

async function listExamPeriods() {
  return await all(
    `SELECT id, name, created_at_utc_ms AS createdAtUtcMs
     FROM exam_periods
     ORDER BY s.id DESC
     LIMIT 200;`
  );
}

async function deleteAllCoreData() {
  await ensureDb();
  await run("BEGIN;");
  try {
    // Order matters due to foreign keys.
    await run("DELETE FROM question_grades;");
    await run("DELETE FROM sessions;");
    await run("DELETE FROM candidates;");
    // Reset autoincrement counters (best-effort).
    try {
      await run(
        "DELETE FROM sqlite_sequence WHERE name IN ('question_grades','sessions','candidates');"
      );
    } catch {}
    await run("COMMIT;");
    return { ok: true };
  } catch (e) {
    try { await run("ROLLBACK;"); } catch {}
    throw e;
  }
}

// Delete a candidate completely (candidate row + all their sessions + grades)
// Identified via a session id (row in admin candidates table).
async function deleteCandidateBySessionId(sessionId) {
  const sid = Number(sessionId);
  if (!Number.isFinite(sid) || sid <= 0) throw new Error("Invalid session id");

  await run("BEGIN;");
  try {
    const sr = await get(`SELECT id, candidate_id FROM sessions WHERE id = ? LIMIT 1;`, [sid]);
    if (!sr) {
      await run("ROLLBACK;");
      return { ok: false, deleted: 0 };
    }

    const candidateId = sr.candidate_id;

    if (candidateId) {
      await run(
        `DELETE FROM question_grades WHERE session_id IN (SELECT id FROM sessions WHERE candidate_id = ?);`,
        [candidateId]
      );
      const sdel = await run(`DELETE FROM sessions WHERE candidate_id = ?;`, [candidateId]);
      await run(`DELETE FROM candidates WHERE id = ?;`, [candidateId]);
      await run("COMMIT;");
      return { ok: true, deleted: Number(sdel?.changes || 0) };
    }

    // Fallback: delete only the session + its grades
    await run(`DELETE FROM question_grades WHERE session_id = ?;`, [sid]);
    const sdel = await run(`DELETE FROM sessions WHERE id = ?;`, [sid]);
    await run("COMMIT;");
    return { ok: true, deleted: Number(sdel?.changes || 0) };
  } catch (e) {
    try { await run("ROLLBACK;"); } catch {}
    throw e;
  }
}

module.exports = {
  initDb,
  db,
  createSession,
  importCandidatesAndCreateSessions,
  getSessionForExam,
  startSession,
  submitAnswers,
  listResults,
  listCandidates,
  listCandidatesForExaminer,
  setExaminerGrades,
  presencePing,
  getConfig,
  verifyAdmin,
  verifyExaminer,
  updateAppConfig,
  listExamPeriods,
  getQuestionGrades,
  deleteCandidateBySessionId,
  deleteAllCoreData,
};
