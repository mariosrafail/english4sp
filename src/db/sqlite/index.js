const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { hashPassword, verifyPassword } = require("../../auth");

const {
  getTestPayloadFull,
  OPEN_AT_UTC_MS: DEFAULT_OPEN_AT_UTC_MS,
  DURATION_MINUTES: DEFAULT_DURATION_MINUTES,
} = require("../../test_config");
const { createSqliteAdminTestHelpers } = require("./admin-test");
const { createSqliteProctoringHelpers } = require("./proctoring");
const { createSqliteSessionFlowHelpers } = require("./session-flow");
const { createSqliteGradingHelpers } = require("./grading");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data.sqlite");
let _db = null;
let _appConfig = null;
let getConfig = () => ({
  serverNow: Date.now(),
  openAtUtc: _appConfig?.openAtUtc ?? DEFAULT_OPEN_AT_UTC_MS,
  durationMinutes: _appConfig?.durationMinutes ?? DEFAULT_DURATION_MINUTES,
  proctoring: getProctoringConfig(),
});
let normalizeAdminTestPayload = (payload) => payload;
let defaultAdminTestPayloadFromConfig = () => getTestPayloadFull();
let coerceLegacyAdminTestToPayload = () => null;
let adminTestHasAnyRealItems = () => false;
let getAdminTest = async () => defaultAdminTestPayloadFromConfig();
let setAdminTest = async () => ({ ok: true, updatedAtUtcMs: Date.now() });
let updateAppConfig = async () => getConfig();
let listExamPeriods = async () => [];
let issueListeningTicket = async () => null;
let verifyListeningTicket = async () => null;
let hasProctoringAck = async () => false;
let recordProctoringAck = async () => null;
let addSessionSnapshot = async () => null;
let listSessionSnapshots = async () => [];
let getSessionSnapshotById = async () => null;
let deleteSessionSnapshotById = async () => false;
let listSnapshotSessions = async () => [];
let presencePing = async () => true;
let createSession = async () => ({ token: "", sessionId: 0 });
let importCandidatesAndCreateSessions = async () => ({ sessions: [] });
let getGateForToken = async () => null;
let getSessionForExam = async () => null;
let startSession = async () => null;
let ensureSessionAssignedExaminer = async () => "";
let normalizeAnswers = (answers) => (answers && typeof answers === "object" ? answers : {});
let answerToText = () => "";
let buildStoredAnswers = () => ({});
let payloadForClientFromFull = (full) => JSON.parse(JSON.stringify(full || {}));
let gradeAttempt = async () => ({ score: 0, maxScore: 0, percent: 0, breakdown: [] });
let submitAnswers = async () => null;
let listCandidates = async () => [];
let listCandidatesForExaminer = async () => [];
let setExaminerGrades = async () => null;
let listResults = async () => [];
let getQuestionGrades = async () => null;
let verifyAdmin = async () => false;
let verifyExaminer = async () => false;
let deleteAllCoreData = async () => ({ ok: true });
let deleteCandidateBySessionId = async () => ({ ok: false, deleted: 0 });
let deleteSessionById = async () => ({ ok: false, deleted: 0 });

function parseBoolEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return !!defaultValue;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return !!defaultValue;
}

function getProctoringConfig() {
  const modeRaw = String(process.env.PROCTORING_MODE || "presence").trim().toLowerCase();
  const mode = (modeRaw === "recording" || modeRaw === "record") ? "recording" : "presence";
  const noticeVersion = String(process.env.PROCTORING_NOTICE_VERSION || "2026-02-26_v1").trim() || "2026-02-26_v1";
  const retentionDaysNum = Number(process.env.PROCTORING_RETENTION_DAYS || "30");
  const retentionDays = Number.isFinite(retentionDaysNum) && retentionDaysNum > 0 ? Math.round(retentionDaysNum) : 30;
  const controllerName = String(process.env.EXAM_CONTROLLER_NAME || "").trim();
  const privacyNoticeUrl = String(process.env.PROCTORING_PRIVACY_NOTICE_URL || "").trim();
  const requireAck = parseBoolEnv("REQUIRE_PROCTORING_ACK", true);
  return { mode, noticeVersion, retentionDays, controllerName, privacyNoticeUrl, requireAck };
}

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

// Domain helpers are initialized early so initDb can reuse the same
// normalization/config logic when seeding or migrating data.
({
  getConfig,
  normalizeAdminTestPayload,
  defaultAdminTestPayloadFromConfig,
  coerceLegacyAdminTestToPayload,
  adminTestHasAnyRealItems,
  getAdminTest,
  setAdminTest,
  updateAppConfig,
  listExamPeriods,
} = createSqliteAdminTestHelpers({
  get,
  run,
  all,
  getTestPayloadFull,
  getProctoringConfig,
  getAppConfig: () => _appConfig,
  setAppConfig: (value) => { _appConfig = value; },
  defaultOpenAtUtcMs: DEFAULT_OPEN_AT_UTC_MS,
  defaultDurationMinutes: DEFAULT_DURATION_MINUTES,
}));

({
  issueListeningTicket,
  verifyListeningTicket,
  hasProctoringAck,
  recordProctoringAck,
  addSessionSnapshot,
  listSessionSnapshots,
  getSessionSnapshotById,
  deleteSessionSnapshotById,
  listSnapshotSessions,
  presencePing,
} = createSqliteProctoringHelpers({
  get,
  run,
  all,
  getProctoringConfig,
}));

({
  createSession,
  importCandidatesAndCreateSessions,
  getGateForToken,
  getSessionForExam,
  startSession,
  ensureSessionAssignedExaminer,
  normalizeAnswers,
  answerToText,
  buildStoredAnswers,
  payloadForClientFromFull,
  gradeAttempt,
  submitAnswers,
  listCandidates,
  listCandidatesForExaminer,
} = createSqliteSessionFlowHelpers({
  run,
  get,
  all,
  getTestPayloadFull,
  getAdminTest: (examPeriodId) => getAdminTest(examPeriodId),
  getAppConfig: () => _appConfig,
  defaultOpenAtUtcMs: DEFAULT_OPEN_AT_UTC_MS,
  defaultDurationMinutes: DEFAULT_DURATION_MINUTES,
}));

({
  setExaminerGrades,
  listResults,
  getQuestionGrades,
  verifyAdmin,
  verifyExaminer,
  deleteAllCoreData,
  deleteCandidateBySessionId,
  deleteSessionById,
} = createSqliteGradingHelpers({
  run,
  get,
  all,
  db,
  verifyPassword,
  getAdminTest: (examPeriodId) => getAdminTest(examPeriodId),
  answerToText: (item, raw) => answerToText(item, raw),
}));

// SQLite schema setup and one-time migrations stay centralized here.
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

  // Proctoring acknowledgements (one per session attempt)
  await run(`
    CREATE TABLE IF NOT EXISTS proctoring_acks (
      session_id INTEGER PRIMARY KEY,
      token TEXT NOT NULL,
      notice_version TEXT NOT NULL,
      acked_at_utc_ms INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_proctoring_acks_token ON proctoring_acks (token);`);

  // Exam snapshots (max N per session enforced in code)
  await run(`
    CREATE TABLE IF NOT EXISTS session_snapshots (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      reason TEXT NOT NULL,
      remote_path TEXT NOT NULL,
      created_at_utc_ms INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_session_snapshots_session_id ON session_snapshots (session_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_session_snapshots_token ON session_snapshots (token);`);

  // Listening "play once" enforcement (server-side)
  await run(`
    CREATE TABLE IF NOT EXISTS session_listening_access (
      session_id INTEGER PRIMARY KEY,
      play_count INTEGER NOT NULL DEFAULT 0,
      ticket TEXT,
      ticket_expires_utc_ms INTEGER,
      updated_at_utc_ms INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_session_listening_access_ticket ON session_listening_access (ticket);`);

  // Fixed server config stored in DB (single row, no UI to edit)
  await run(`
    CREATE TABLE IF NOT EXISTS app_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      open_at_utc_ms INTEGER NOT NULL,
      duration_minutes INTEGER
    );
  `);

  // Admin-managed tests (MCQ builder). Stored per exam period.
  await run(`
    CREATE TABLE IF NOT EXISTS admin_tests_by_period (
      exam_period_id INTEGER PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at_utc_ms INTEGER NOT NULL,
      FOREIGN KEY (exam_period_id) REFERENCES exam_periods(id) ON DELETE CASCADE
    );
  `);

  // Migration: if legacy admin_tests(scope='global') exists, copy into period 1 (best-effort).
  try {
    const hasLegacy = await get(
      `SELECT 1 FROM pragma_table_info('admin_tests') WHERE name = 'scope' LIMIT 1;`
    );
    if (hasLegacy) {
      const existing = await get(`SELECT 1 FROM admin_tests_by_period LIMIT 1;`);
      if (!existing) {
        const legacy = await get(`SELECT payload_json AS payloadJson, updated_at_utc_ms AS updatedAtUtcMs FROM admin_tests WHERE scope = 'global' LIMIT 1;`);
        if (legacy && legacy.payloadJson) {
          await run(
            `INSERT OR IGNORE INTO admin_tests_by_period (exam_period_id, payload_json, updated_at_utc_ms)
             VALUES (1, ?, ?);`,
            [String(legacy.payloadJson), Number(legacy.updatedAtUtcMs || Date.now())]
          );
        }
      }
    }
  } catch {}

  // Seed per-exam-period tests (non-destructive).
  // Goal: keep the full "default" test for the first January period, and smaller tests for other periods.
  try {
    const eps = await all(`SELECT id, name FROM exam_periods ORDER BY id ASC;`);
    const existingRows = await all(`SELECT exam_period_id AS id FROM admin_tests_by_period;`);
    const existing = new Set((existingRows || []).map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0));

    const isJanuaryName = (name) => {
      const s = String(name || "").toLowerCase();
      return s.includes("january") || s.includes("jan") || s.includes("ιαν") || s.includes("ιανου");
    };

    const januaryId = (() => {
      const jan = (eps || []).find((r) => isJanuaryName(r.name));
      const first = (eps || [])[0];
      return Number(jan?.id || first?.id || 1) || 1;
    })();

    const uniqPreserve = (arr) => {
      const out = [];
      const seen = new Set();
      for (const x of arr || []) {
        const v = String(x || "").trim();
        if (!v) continue;
        const k = v.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(v);
      }
      return out;
    };

    const convertLegacyWritingToDragWords = (payload) => {
      const p = JSON.parse(JSON.stringify(payload || {}));
      if (!p || typeof p !== "object") return payload;
      p.sections = Array.isArray(p.sections) ? p.sections : [];
      const writing = p.sections.find((s) => String(s?.id || "") === "writing") || null;
      if (!writing) return p;
      writing.items = Array.isArray(writing.items) ? writing.items : [];
      if (writing.items.some((it) => String(it?.type || "") === "drag-words")) return p;

      const w1 = writing.items.find((it) => String(it?.id || "") === "w1");
      const w2 = writing.items.find((it) => String(it?.id || "") === "w2");
      const w3 = writing.items.find((it) => String(it?.id || "") === "w3");
      const w4 = writing.items.find((it) => String(it?.id || "") === "w4");
      const gaps = [w1, w2, w3, w4].filter(Boolean);
      if (gaps.length !== 4) return p;

      const bank = Array.isArray(w1?.choices) ? w1.choices.map((x) => String(x || "").trim()).filter(Boolean) : [];
      const idxs = [
        Number(w1?.correctIndex ?? 0),
        Number(w2?.correctIndex ?? 0),
        Number(w3?.correctIndex ?? 0),
        Number(w4?.correctIndex ?? 0),
      ];
      const words = idxs.map((i) => (Number.isFinite(i) && i >= 0 && i < bank.length ? String(bank[i]) : "")).filter(Boolean);
      if (words.length !== 4) return p;

      const usedLower = new Set(words.map((w) => w.toLowerCase()));
      const extras = bank.filter((w) => !usedLower.has(String(w || "").toLowerCase()));
      const extraFmt = extras.map((w) => `*${w}*`).join(" ");

      const dragText =
        `Rain makes the **${words[0]}** shine. The air smells clean and **${words[1]}**. ` +
        `I put on my **${words[2]}** and boots. I feel calm and happy. ` +
        `I like rain because it helps **${words[3]}** grow and makes trees look fresh.`;

      const bankWords = uniqPreserve([...words, ...extras]).slice(0, 40);
      const dragId = "drag1";
      const dragItem = {
        id: dragId,
        type: "drag-words",
        title: "Task 1: Drag the correct words into the gaps.",
        instructions: "",
        text: dragText,
        extraWords: extraFmt,
        bankWords: bankWords.slice(),
        pointsPerGap: 1,
        points: 0,
      };

      const gapItems = words.map((w, i) => {
        const correctIndex = bankWords.findIndex((x) => x.toLowerCase() === String(w || "").toLowerCase());
        return {
          id: `${dragId}_g${i + 1}`,
          type: "mcq",
          prompt: `Gap ${i + 1}`,
          choices: bankWords.slice(),
          correctIndex: correctIndex >= 0 ? correctIndex : 0,
          points: 1,
        };
      });

      writing.items = (writing.items || []).filter((it) => {
        const id = String(it?.id || "");
        return id !== "w_intro" && id !== "w1" && id !== "w2" && id !== "w3" && id !== "w4";
      });
      writing.items.unshift(dragItem);
      writing.items.push(...gapItems);
      return p;
    };

    const full = normalizeAdminTestPayload(convertLegacyWritingToDragWords(defaultAdminTestPayloadFromConfig()));

    const makeSmall = (base) => {
      const p = JSON.parse(JSON.stringify(base || {}));
      p.sections = Array.isArray(p.sections) ? p.sections : [];
      const listening = p.sections.find((s) => String(s?.id || "") === "listening");
      if (listening && Array.isArray(listening.items)) listening.items = listening.items.filter(Boolean).slice(0, 2);
      const reading = p.sections.find((s) => String(s?.id || "") === "reading");
      if (reading && Array.isArray(reading.items)) reading.items = reading.items.filter(Boolean).slice(0, 4);

      const writing = p.sections.find((s) => String(s?.id || "") === "writing");
      if (writing) {
        const dragId = "drag1";
        const dragItem = {
          id: dragId,
          type: "drag-words",
          title: "Task 1: Drag the correct words into the gaps.",
          instructions: "Mark the correct gap-words in the text using **word**.",
          text: "This is a **sample** sentence with **gaps**.",
          extraWords: "*extra*",
          bankWords: ["sample", "gaps", "extra"],
          pointsPerGap: 1,
          points: 0,
        };
        const gapItems = [
          { id: `${dragId}_g1`, type: "mcq", prompt: "Gap 1", choices: dragItem.bankWords.slice(), correctIndex: 0, points: 1 },
          { id: `${dragId}_g2`, type: "mcq", prompt: "Gap 2", choices: dragItem.bankWords.slice(), correctIndex: 1, points: 1 },
        ];
        const q4 = (writing.items || []).find((it) => String(it?.id || "") === "q4") || {
          id: "q4",
          type: "writing",
          prompt: "Write a short paragraph (50–80 words) about your last holiday.",
          points: 0,
        };
        writing.items = [dragItem, ...gapItems, q4];
      }
      return normalizeAdminTestPayload(p);
    };

    const small = makeSmall(full);
    const now = Date.now();
    for (const epRow of eps || []) {
      const id = Number(epRow?.id || 0);
      if (!Number.isFinite(id) || id <= 0) continue;
      if (existing.has(id)) continue;
      const payload = id === januaryId ? full : small;
      await run(
        `INSERT OR IGNORE INTO admin_tests_by_period (exam_period_id, payload_json, updated_at_utc_ms)
         VALUES (?, ?, ?);`,
        [id, JSON.stringify(payload || {}), now]
      );
    }
  } catch {}

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
  if (!qgNames.has("total_grade")) {
    try { await run(`ALTER TABLE question_grades ADD COLUMN total_grade INTEGER CHECK (total_grade IS NULL OR (total_grade >= 0 AND total_grade <= 100));`); } catch {}
  }
}

module.exports = {
  initDb,
  db,
  createSession,
  importCandidatesAndCreateSessions,
  getSessionForExam,
  getGateForToken,
  startSession,
  submitAnswers,
  listResults,
  listCandidates,
  listCandidatesForExaminer,
  setExaminerGrades,
  ensureSessionAssignedExaminer,
  presencePing,
  hasProctoringAck,
  recordProctoringAck,
  addSessionSnapshot,
  listSessionSnapshots,
  listSnapshotSessions,
  getSessionSnapshotById,
  deleteSessionSnapshotById,
  getConfig,
  getAdminTest,
  setAdminTest,
  verifyAdmin,
  verifyExaminer,
  updateAppConfig,
  listExamPeriods,
  getQuestionGrades,
  deleteCandidateBySessionId,
  deleteSessionById,
  deleteAllCoreData,
  issueListeningTicket,
  verifyListeningTicket,
};
