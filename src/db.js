const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { hashPassword, verifyPassword } = require("./auth");
const crypto = require("crypto");

const {
  getTestPayloadFull,
  getTestPayloadForClient,
  OPEN_AT_UTC_MS: DEFAULT_OPEN_AT_UTC_MS,
  DURATION_MINUTES: DEFAULT_DURATION_MINUTES,
} = require("./test_config");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data.sqlite");
let _db = null;
let _appConfig = null;

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
  const sessionId = Number(r && (r.lastID ?? r.lastId));
  return { token, sessionId };
}

async function importCandidatesAndCreateSessions({ rows, examPeriodId, assignmentStrategy = "batch_even", onProgress } = {}) {
  const ep = Number(examPeriodId) || 1;
  if (!Number.isFinite(ep) || ep <= 0) throw new Error("Invalid exam period");

  const inRows = Array.isArray(rows) ? rows : [];
  const workRows = inRows.filter((r) => String(r?.email || "").trim());

  // Dedupe by email (keep last occurrence so the spreadsheet "wins").
  const byEmail = new Map();
  for (const r of workRows) {
    const email = String(r?.email || "").trim().toLowerCase();
    if (!email) continue;
    byEmail.set(email, {
      email,
      name: String(r?.name || "").trim(),
      country: String(r?.country || "").trim(),
    });
  }
  const uniqRows = Array.from(byEmail.values());

  const total = uniqRows.length;
  let processed = 0;
  const report = (phase = "importing") => {
    if (typeof onProgress !== "function") return;
    try { onProgress({ processed, total, phase }); } catch {}
  };
  report("candidates");

  // Ensure exam period exists.
  await run(
    `INSERT OR IGNORE INTO exam_periods (id, name, created_at_utc_ms) VALUES (?, ?, ?);`,
    [ep, `Exam Period ${ep}`, Date.now()]
  );

  await run("BEGIN;");
  try {
    const created = [];

    if (!uniqRows.length) {
      await run("COMMIT;");
      report("done");
      return { sessions: created };
    }

    // Batch upsert candidates (much faster than per-row run + select).
    const CHUNK = 200; // keep under SQLite variable limit (999)
    for (let i = 0; i < uniqRows.length; i += CHUNK) {
      const chunk = uniqRows.slice(i, i + CHUNK);
      const now = Date.now();
      const valuesSql = chunk.map(() => "(?, ?, ?, ?)").join(",");
      const params = [];
      for (const r of chunk) params.push(r.name || null, r.email, r.country || null, now);
      await run(
        `INSERT INTO candidates (name, email, country, created_at_utc_ms)
         VALUES ${valuesSql}
         ON CONFLICT(email) DO UPDATE
         SET name = excluded.name,
             country = excluded.country;`,
        params
      );
      processed = Math.min(total, i + chunk.length);
      report("candidates");
    }

    // Fetch candidate ids for all emails.
    const candByEmail = new Map();
    processed = 0;
    report("lookup");
    for (let i = 0; i < uniqRows.length; i += CHUNK) {
      const chunk = uniqRows.slice(i, i + CHUNK);
      const inSql = chunk.map(() => "?").join(",");
      const rows = await all(
        `SELECT id, name, email, country FROM candidates WHERE email IN (${inSql});`,
        chunk.map((r) => r.email)
      );
      for (const c of rows || []) {
        const email = String(c.email || "").trim().toLowerCase();
        if (email) candByEmail.set(email, c);
      }
      processed = Math.min(total, i + chunk.length);
      report("lookup");
    }

    // Fetch existing sessions for these candidates (for this exam period).
    const canReuse = String(assignmentStrategy || "") !== "single_least_random";
    const existingByCandidateId = new Map();
    if (canReuse) {
      const candIds = Array.from(
        new Set(Array.from(candByEmail.values()).map((c) => Number(c.id)).filter((n) => Number.isFinite(n) && n > 0))
      );
      const ID_CHUNK = 300; // ep param + ids stays under limit
      processed = 0;
      report("sessions_lookup");
      for (let i = 0; i < candIds.length; i += ID_CHUNK) {
        const ids = candIds.slice(i, i + ID_CHUNK);
        const inSql = ids.map(() => "?").join(",");
        const rows = await all(
          `SELECT candidate_id AS candidateId, id AS sessionId, token AS token
           FROM sessions
           WHERE exam_period_id = ?
             AND candidate_id IN (${inSql});`,
          [ep, ...ids]
        );
        for (const s of rows || []) {
          const cid = Number(s.candidateId || 0);
          if (Number.isFinite(cid) && cid > 0 && !existingByCandidateId.has(cid)) existingByCandidateId.set(cid, s);
        }
        processed = Math.min(total, i + ids.length);
        report("sessions_lookup");
      }
    }

    processed = 0;
    report("sessions");
    for (const r of uniqRows) {
      const email = String(r.email || "").trim().toLowerCase();
      const c = candByEmail.get(email) || null;
      const cid = Number(c?.id || 0);
      if (!Number.isFinite(cid) || cid <= 0) continue;

      const existing = canReuse ? existingByCandidateId.get(cid) : null;
      if (existing) {
        created.push({
          sessionId: Number(existing.sessionId),
          token: String(existing.token || ""),
          examPeriodId: ep,
          candidateId: cid,
          name: String(c?.name || r.name || ""),
          email: String(c?.email || r.email || ""),
          country: String(c?.country || r.country || ""),
          reused: true,
          assignedExaminer: "",
        });
        processed += 1;
        report("sessions");
        continue;
      }

      // Create a new session (retry on token collision).
      let token = makeToken();
      let sessionId = null;
      for (let i = 0; i < 6; i++) {
        try {
          const ins = await run(
            `INSERT INTO sessions (exam_period_id, candidate_id, token, name, submitted)
             VALUES (?, ?, ?, ?, 0);`,
            [ep, cid, token, String(c?.name || r.name || "Candidate")]
          );
          sessionId = Number(ins?.lastID || 0) || null;
          break;
        } catch (e) {
          const msg = String(e?.message || "");
          if (/UNIQUE|constraint/i.test(msg)) {
            token = makeToken();
            continue;
          }
          throw e;
        }
      }
      if (!sessionId) continue;

      created.push({
        sessionId,
        token,
        examPeriodId: ep,
        candidateId: cid,
        name: String(c?.name || r.name || ""),
        email: String(c?.email || r.email || ""),
        country: String(c?.country || r.country || ""),
        reused: false,
        assignedExaminer: "",
      });

      processed += 1;
      report("sessions");
    }

    await run("COMMIT;");
    processed = total;
    report("done");
    return { sessions: created };
  } catch (e) {
    try { await run("ROLLBACK;"); } catch {}
    throw e;
  }
}

async function getGateForToken(token) {
  const t = String(token || "").trim();
  if (!t) return null;
  const s = await get(`SELECT id, exam_period_id AS examPeriodId FROM sessions WHERE token = ? ORDER BY id DESC LIMIT 1;`, [t]);
  if (!s) return null;

  const now = Date.now();
  const openAtUtc = Number(_appConfig?.openAtUtc ?? DEFAULT_OPEN_AT_UTC_MS);
  const durationMinutes = Number(_appConfig?.durationMinutes ?? DEFAULT_DURATION_MINUTES);
  const durMinOk = Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : DEFAULT_DURATION_MINUTES;
  const openOk = Number.isFinite(openAtUtc) && openAtUtc > 0 ? openAtUtc : DEFAULT_OPEN_AT_UTC_MS;
  const durMs = durMinOk * 60 * 1000;
  const endAtUtc = openOk + durMs;

  const examPeriodId = Number(s?.examPeriodId || 0) || 1;
  return { now, openAtUtc: openOk, durationMinutes: durMinOk, durMs, endAtUtc, examPeriodId };
}

async function getSessionForExam(token) {
  const t = String(token || "").trim();
  if (!t) return null;

  const row = await get(
    `SELECT s.id, s.token, s.name, s.submitted, COALESCE(s.disqualified, 0) AS disqualified,
            s.exam_period_id AS exam_period_id,
            q.total_grade AS total_grade,
            EXISTS(SELECT 1 FROM proctoring_acks pa WHERE pa.session_id = s.id) AS proctoring_acked
     FROM sessions s
     LEFT JOIN question_grades q ON q.session_id = s.id
     WHERE s.token = ?
     ORDER BY s.id DESC
     LIMIT 1;`,
    [t]
  );
  if (!row) return null;

  const openAtUtc = Number(_appConfig?.openAtUtc ?? DEFAULT_OPEN_AT_UTC_MS);
  const durationMinutes = Number(_appConfig?.durationMinutes ?? DEFAULT_DURATION_MINUTES);

  const payload = payloadForClientFromFull(await getAdminTest(Number(row.exam_period_id) || 1));
  // Hide the actual audio file URL from candidates; use ticket-based endpoint instead.
  try {
    for (const sec of payload.sections || []) {
      for (const item of sec.items || []) {
        if (item && String(item.type || "") === "listening-mcq") {
          delete item.audioUrl;
        }
      }
    }
  } catch {}

  return {
    session: {
      id: Number(row.id),
      token: String(row.token || ""),
      candidateName: String(row.name || ""),
      submitted: Number(row.submitted) === 1,
      disqualified: Number(row.disqualified) === 1,
      proctoringAcked: Number(row.proctoring_acked) === 1,
      grade: row.total_grade === null || row.total_grade === undefined ? null : Number(row.total_grade),
      examPeriodId: Number(row.exam_period_id) || 1,
      openAtUtc: Number.isFinite(openAtUtc) ? openAtUtc : DEFAULT_OPEN_AT_UTC_MS,
      durationMinutes: Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : DEFAULT_DURATION_MINUTES,
    },
    test: {
      id: 1,
      title: "English Test",
      payload,
    },
  };
}

function makeListeningTicket() {
  // URL-safe random token
  return crypto.randomBytes(24).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function issueListeningTicket(token, { maxPlays = 1, ttlMs = 20 * 60 * 1000 } = {}) {
  const t = String(token || "").trim();
  if (!t) return null;
  const s = await get(`SELECT id, submitted, exam_period_id FROM sessions WHERE token = ? ORDER BY id DESC LIMIT 1;`, [t]);
  if (!s) return null;
  if (Number(s.submitted) === 1) return { ok: false, blocked: true, reason: "submitted" };

  const sid = Number(s.id);
  const now = Date.now();
  const ttl = Number(ttlMs);
  const ttlOk = Number.isFinite(ttl) && ttl > 5000 ? Math.min(60 * 60 * 1000, Math.round(ttl)) : 20 * 60 * 1000;
  const max = Number(maxPlays);
  const maxOk = Number.isFinite(max) && max > 0 ? Math.min(3, Math.round(max)) : 1;

  await run("BEGIN;");
  try {
    const row = await get(
      `SELECT play_count AS playCount, ticket, ticket_expires_utc_ms AS expires
       FROM session_listening_access
       WHERE session_id = ? LIMIT 1;`,
      [sid]
    );
    const playCount = Number(row?.playCount || 0);
    const ticket = String(row?.ticket || "");
    const expires = Number(row?.expires || 0);
    if (ticket && Number.isFinite(expires) && expires > now + 5000) {
      await run("COMMIT;");
      return { ok: true, ticket, expiresAtUtcMs: expires, playCount, maxPlays: maxOk, examPeriodId: Number(s.exam_period_id) || 1 };
    }
    if (playCount >= maxOk) {
      await run("COMMIT;");
      return { ok: false, blocked: true, reason: "max_plays", playCount, maxPlays: maxOk };
    }

    const nextTicket = makeListeningTicket();
    const nextCount = playCount + 1;
    const nextExp = now + ttlOk;
    await run(
      `INSERT INTO session_listening_access (session_id, play_count, ticket, ticket_expires_utc_ms, updated_at_utc_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE
       SET play_count = excluded.play_count,
           ticket = excluded.ticket,
           ticket_expires_utc_ms = excluded.ticket_expires_utc_ms,
           updated_at_utc_ms = excluded.updated_at_utc_ms;`,
      [sid, nextCount, nextTicket, nextExp, now]
    );
    await run("COMMIT;");
    return { ok: true, ticket: nextTicket, expiresAtUtcMs: nextExp, playCount: nextCount, maxPlays: maxOk, examPeriodId: Number(s.exam_period_id) || 1 };
  } catch (e) {
    try { await run("ROLLBACK;"); } catch {}
    throw e;
  }
}

async function verifyListeningTicket(token, ticket) {
  const t = String(token || "").trim();
  const tk = String(ticket || "").trim();
  if (!t || !tk) return null;
  const row = await get(
    `SELECT s.id AS sessionId, s.exam_period_id AS examPeriodId, s.submitted AS submitted,
            a.ticket AS ticket, a.ticket_expires_utc_ms AS expires
     FROM sessions s
     LEFT JOIN session_listening_access a ON a.session_id = s.id
     WHERE s.token = ?
     ORDER BY s.id DESC
     LIMIT 1;`,
    [t]
  );
  if (!row) return null;
  if (Number(row.submitted) === 1) return { ok: false, blocked: true, reason: "submitted" };
  const exp = Number(row.expires || 0);
  if (!row.ticket || String(row.ticket) !== tk) return { ok: false, blocked: true, reason: "bad_ticket" };
  if (!Number.isFinite(exp) || exp <= Date.now()) return { ok: false, blocked: true, reason: "expired" };
  return { ok: true, sessionId: Number(row.sessionId), examPeriodId: Number(row.examPeriodId) || 1, expiresAtUtcMs: exp };
}

async function startSession(token) {
  const t = String(token || "").trim();
  if (!t) return null;
  const s = await get(`SELECT submitted FROM sessions WHERE token = ? ORDER BY id DESC LIMIT 1;`, [t]);
  if (!s) return null;
  if (Number(s.submitted) === 1) return { status: "submitted" };
  return { status: "started" };
}

async function hasProctoringAck(token) {
  const t = String(token || "").trim();
  if (!t) return false;
  const r = await get(`SELECT 1 FROM proctoring_acks WHERE token = ? LIMIT 1;`, [t]);
  return !!r;
}

async function recordProctoringAck(token, { noticeVersion } = {}) {
  const t = String(token || "").trim();
  if (!t) return null;
  const v = String(noticeVersion || "").trim() || getProctoringConfig().noticeVersion;

  const s = await get(`SELECT id, token FROM sessions WHERE token = ? ORDER BY id DESC LIMIT 1;`, [t]);
  if (!s) return null;

  const sid = Number(s.id);
  const ts = Date.now();
  try {
    await run(
      `INSERT INTO proctoring_acks (session_id, token, notice_version, acked_at_utc_ms)
       VALUES (?, ?, ?, ?);`,
      [sid, t, v, ts]
    );
  } catch {
    await run(
      `UPDATE proctoring_acks SET notice_version = ?, acked_at_utc_ms = ? WHERE session_id = ?;`,
      [v, ts, sid]
    );
  }

  return { ok: true };
}

async function addSessionSnapshot(token, { reason, remotePath, max = 10 } = {}) {
  const t = String(token || "").trim();
  if (!t) return null;
  const rsn = String(reason || "").trim() || "unknown";
  const rp = String(remotePath || "").trim();
  if (!rp) throw new Error("remote_path_required");

  const maxN = Number(max);
  const limit = Number.isFinite(maxN) && maxN > 0 ? Math.round(maxN) : 10;

  const s = await get(`SELECT id FROM sessions WHERE token = ? ORDER BY id DESC LIMIT 1;`, [t]);
  if (!s) return null;
  const sid = Number(s.id);

  await run("BEGIN;");
  try {
    const c = await get(`SELECT COUNT(1) AS n FROM session_snapshots WHERE session_id = ?;`, [sid]);
    const n = Number(c?.n || 0);
    if (n >= limit) {
      await run("COMMIT;");
      return { ok: false, limited: true, count: n, remaining: 0 };
    }

    const ins = await run(
      `INSERT INTO session_snapshots (session_id, token, reason, remote_path, created_at_utc_ms)
       VALUES (?, ?, ?, ?, ?);`,
      [sid, t, rsn, rp, Date.now()]
    );

    await run("COMMIT;");
    const next = n + 1;
    return { ok: true, limited: false, snapshotId: Number(ins?.lastID || 0) || null, count: next, remaining: Math.max(0, limit - next) };
  } catch (e) {
    try { await run("ROLLBACK;"); } catch {}
    throw e;
  }
}

async function listSessionSnapshots({ limit = 200, examPeriodId, sessionId } = {}) {
  const lim = Number(limit);
  const n = Number.isFinite(lim) && lim > 0 ? Math.min(2000, Math.round(lim)) : 200;
  const ep = examPeriodId === undefined || examPeriodId === null ? null : Number(examPeriodId);
  const sid = sessionId === undefined || sessionId === null ? null : Number(sessionId);

  const where = [];
  const params = [];
  if (Number.isFinite(ep) && ep > 0) { where.push("s.exam_period_id = ?"); params.push(ep); }
  if (Number.isFinite(sid) && sid > 0) { where.push("ss.session_id = ?"); params.push(sid); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await all(
    `SELECT ss.id AS id,
            ss.session_id AS sessionId,
            ss.token AS token,
            s.name AS candidateName,
            s.exam_period_id AS examPeriodId,
            s.submitted AS submitted,
            ss.reason AS reason,
            ss.remote_path AS remotePath,
            ss.created_at_utc_ms AS createdAtUtcMs
     FROM session_snapshots ss
     JOIN sessions s ON s.id = ss.session_id
     ${w}
     ORDER BY ss.id DESC
     LIMIT ?;`,
    [...params, n]
  );
  return Array.isArray(rows) ? rows : [];
}

async function getSessionSnapshotById(id) {
  const sid = Number(id);
  if (!Number.isFinite(sid) || sid <= 0) return null;
  return await get(
    `SELECT ss.id AS id,
            ss.session_id AS sessionId,
            ss.token AS token,
            s.name AS candidateName,
            s.exam_period_id AS examPeriodId,
            s.submitted AS submitted,
            ss.reason AS reason,
            ss.remote_path AS remotePath,
            ss.created_at_utc_ms AS createdAtUtcMs
     FROM session_snapshots ss
     JOIN sessions s ON s.id = ss.session_id
     WHERE ss.id = ?
     LIMIT 1;`,
    [sid]
  );
}

async function deleteSessionSnapshotById(id) {
  const sid = Number(id);
  if (!Number.isFinite(sid) || sid <= 0) return false;
  const r = await run(`DELETE FROM session_snapshots WHERE id = ?;`, [sid]);
  return Number(r?.changes || 0) > 0;
}

async function listSnapshotSessions({ limit = 5000, examPeriodId, submittedOnly } = {}) {
  const lim = Number(limit);
  const n = Number.isFinite(lim) && lim > 0 ? Math.min(20000, Math.round(lim)) : 5000;
  const ep = examPeriodId === undefined || examPeriodId === null ? null : Number(examPeriodId);
  const subOnly = submittedOnly === undefined || submittedOnly === null ? null : !!submittedOnly;

  const where = [];
  const params = [];
  if (Number.isFinite(ep) && ep > 0) { where.push("s.exam_period_id = ?"); params.push(ep); }
  if (subOnly === true) { where.push("s.submitted = 1"); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await all(
    `SELECT s.id AS sessionId,
            s.token AS token,
            s.name AS candidateName,
            s.exam_period_id AS examPeriodId,
            s.submitted AS submitted,
            COUNT(ss.id) AS snapshotCount,
            COALESCE(MAX(ss.created_at_utc_ms), 0) AS latestSnapshotUtcMs
     FROM sessions s
     LEFT JOIN session_snapshots ss ON ss.session_id = s.id
     ${w}
     GROUP BY s.id
     ORDER BY latestSnapshotUtcMs DESC, s.id DESC
     LIMIT ?;`,
    [...params, n]
  );
  return Array.isArray(rows) ? rows : [];
}

async function presencePing(_token, _status) {
  return true;
}

async function ensureSessionAssignedExaminer(_opts = {}) {
  // SQLite fallback does not persist examiner assignments.
  return "";
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
      if (!item || !item.id || item.type === "info" || item.type === "drag-words") continue;
      out[item.id] = answerToText(item, normAnswers?.[item.id]);
    }
  }
  return out;
}

function payloadForClientFromFull(full) {
  const payload = JSON.parse(JSON.stringify(full || {}));
  for (const sec of payload.sections || []) {
    for (const item of sec.items || []) {
      delete item.correctIndex;
      delete item.correct;
      delete item.correctText;
    }
  }
  return payload;
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
  const s = await get(`SELECT id, submitted, exam_period_id FROM sessions WHERE token = ? ORDER BY s.id DESC LIMIT 1`, [token]);
  if (!s) return null;
  if (s.submitted) return { status: "submitted" };

  const normAnswers = normalizeAnswers(answers);

  await run(`UPDATE sessions SET submitted = 1 WHERE id = ?`, [s.id]);

  const payload = await getAdminTest(Number(s.exam_period_id) || 1);

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

  const s = await get(`SELECT id, token, exam_period_id FROM sessions WHERE id = ? LIMIT 1;`, [sid]);
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

  // Compute objective score from Listening + Reading + Writing Task 1 (auto-gradable items only).
  const payload = await getAdminTest(Number(s.exam_period_id) || 1);
  let objectiveEarned = 0;
  let objectiveMax = 0;
  const sectionIdNorm = (sec) => String(sec?.id || "").trim().toLowerCase();
  for (const sec of payload.sections || []) {
    const sidNorm = sectionIdNorm(sec);
    const inObjectiveSection = sidNorm === "listening" || sidNorm === "reading" || sidNorm === "writing";
    if (!inObjectiveSection) continue;

    let writingTask1Active = true;
    for (const item of sec.items || []) {
      if (!item || !item.id || item.type === "info") continue;
      if (sidNorm === "writing") {
        if (item.type === "writing") writingTask1Active = false;
        if (!writingTask1Active) continue;
      }
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

async function listResults({ examPeriodId } = {}) {
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
    `SELECT q.session_id AS sessionId,
            q.token,
            s.exam_period_id AS examPeriodId,
            COALESCE(q.q_writing,'') AS qWriting,
            COALESCE(q.answers_json,'{}') AS answersJson,
            q.speaking_grade AS speakingGrade,
            q.writing_grade AS writingGrade,
            q.total_grade AS totalGrade,
            q.created_at_utc_ms AS createdAtUtcMs
     FROM question_grades q
     JOIN sessions s ON s.id = q.session_id
     WHERE q.session_id = ?
     LIMIT 1;`,
    [sid]
  );
}

function getConfig() {
  const p = getProctoringConfig();
  return {
    serverNow: Date.now(),
    openAtUtc: _appConfig?.openAtUtc ?? DEFAULT_OPEN_AT_UTC_MS,
    durationMinutes: _appConfig?.durationMinutes ?? DEFAULT_DURATION_MINUTES,
    proctoring: p,
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

function normalizeAdminTestPayload(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const sectionsRaw = Array.isArray(p.sections) ? p.sections : [];
  const sections = sectionsRaw.slice(0, 8).map((sec, secIdx) => {
    const s = sec && typeof sec === "object" ? sec : {};
    const id = String(s.id || "").trim().slice(0, 40) || `sec_${secIdx + 1}`;
    const title = String(s.title || "").trim().slice(0, 120) || "Section";
    const description = String(s.description || "").trim().slice(0, 600);
    const rules = s.rules && typeof s.rules === "object" ? s.rules : null;
    const itemsRaw = Array.isArray(s.items) ? s.items : [];
    const items = itemsRaw.slice(0, 400).map((it, iIdx) => {
      const it0 = it && typeof it === "object" ? it : {};
      const type = String(it0.type || "").trim() || "mcq";
      const itemId = String(it0.id || "").trim().slice(0, 80) || `${id}_${iIdx + 1}`;
      const prompt = String(it0.prompt || "").trim().slice(0, 2500);
      const audioUrl = String(it0.audioUrl || "").trim().slice(0, 1200);
      const points = Number(it0.points ?? 1);
      const choicesRaw = Array.isArray(it0.choices) ? it0.choices : [];
      const choices = choicesRaw.slice(0, 12).map((c) => String(c || "").trim().slice(0, 240));
      const correctIndexRaw = Number(it0.correctIndex ?? 0);
      const correctIndex = Number.isFinite(correctIndexRaw)
        ? Math.max(0, Math.min(Math.floor(correctIndexRaw), Math.max(0, choices.length - 1)))
        : 0;

      if (type === "drag-words") {
        const title = String(it0.title || "").trim().slice(0, 180);
        const instructions = String(it0.instructions || "").trim().slice(0, 2000);
        const text = String(it0.text || "").trim().slice(0, 12000);
        const extraWords = String(it0.extraWords || "").trim().slice(0, 4000);
        const bankWordsRaw = Array.isArray(it0.bankWords) ? it0.bankWords : [];
        const bankWords = bankWordsRaw
          .slice(0, 40)
          .map((w) => String(w || "").trim().slice(0, 80))
          .filter(Boolean);
        const ppg = Number(it0.pointsPerGap ?? 1);
        const pointsPerGap = Number.isFinite(ppg) ? Math.max(0, Math.min(Math.round(ppg), 10)) : 1;
        return { id: itemId, type: "drag-words", title, instructions, text, extraWords, bankWords, pointsPerGap, points: 0 };
      }
      if (type === "info") return { id: itemId, type: "info", prompt, points: 0 };
      if (type === "writing") return { id: itemId, type: "writing", prompt, points: 0 };
      if (type === "tf") return { id: itemId, type: "tf", prompt, correct: !!it0.correct, points: Number.isFinite(points) ? Math.max(0, Math.min(points, 10)) : 1 };

      const out = {
        id: itemId,
        type: type === "listening-mcq" ? "listening-mcq" : "mcq",
        prompt,
        choices,
        correctIndex,
        points: Number.isFinite(points) ? Math.max(0, Math.min(points, 10)) : 1,
      };
      if (type === "listening-mcq" && audioUrl) out.audioUrl = audioUrl;
      return out;
    });
    return { id, title, description, rules, items };
  });

  return {
    version: Number(p.version || 1) || 1,
    randomize: !!p.randomize,
    sections,
  };
}

function defaultAdminTestPayloadFromConfig() {
  return getTestPayloadFull();
}

function coerceLegacyAdminTestToPayload(obj) {
  // Legacy format: { questions: [{id,text,choices,correctIndex}] }
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj.sections)) return obj;
  if (!Array.isArray(obj.questions)) return null;

  const qs = obj.questions.slice(0, 200).map((q, idx) => {
    const qq = q && typeof q === "object" ? q : {};
    const id = String(qq.id || "").trim().slice(0, 80) || `r_${idx + 1}`;
    const prompt = String(qq.text || "").trim().slice(0, 800);
    const choicesRaw = Array.isArray(qq.choices) ? qq.choices : [];
    const choices = choicesRaw.slice(0, 6).map((c) => String(c || "").trim().slice(0, 240));
    const correctIndexRaw = Number(qq.correctIndex ?? 0);
    const correctIndex = Number.isFinite(correctIndexRaw)
      ? Math.max(0, Math.min(Math.floor(correctIndexRaw), Math.max(0, choices.length - 1)))
      : 0;
    return { id, type: "mcq", prompt, choices, correctIndex, points: 1 };
  });

  const base = defaultAdminTestPayloadFromConfig();
  const sections = Array.isArray(base.sections) ? base.sections.slice() : [];
  const reading = sections.find((s) => String(s.id || "").includes("read")) || sections[1] || null;
  if (reading && reading.items) reading.items = qs;
  else sections.push({ id: "reading", title: "Part 2: Reading", items: qs });
  return { ...base, sections };
}

function adminTestHasAnyRealItems(payload) {
  const p = payload && typeof payload === "object" ? payload : null;
  if (!p || !Array.isArray(p.sections)) return false;
  for (const sec of p.sections || []) {
    for (const item of sec?.items || []) {
      if (!item || !item.type) continue;
      if (item.type === "info") continue;
      if (item.type === "mcq" || item.type === "listening-mcq" || item.type === "tf" || item.type === "short") return true;
      if (item.type === "drag-words") {
        const t = String(item.text || "").trim();
        if (/\*\*[^*]+?\*\*/.test(t)) return true;
      }
    }
  }
  return false;
}

async function getAdminTest(examPeriodId = 1) {
  const ep = Number(examPeriodId);
  const id = Number.isFinite(ep) && ep > 0 ? ep : 1;
  const row = await get(
    `SELECT payload_json AS payloadJson FROM admin_tests_by_period WHERE exam_period_id = ? LIMIT 1;`,
    [id]
  );
  if (!row || !row.payloadJson) return defaultAdminTestPayloadFromConfig();
  try {
    const j = JSON.parse(String(row.payloadJson || "{}"));
    const coerced = coerceLegacyAdminTestToPayload(j) || j;
    const norm = normalizeAdminTestPayload(coerced);
    // If the stored payload is effectively empty, fall back to the default test.
    // This avoids "No questions" when an older/partial save happened.
    if (!adminTestHasAnyRealItems(norm)) return defaultAdminTestPayloadFromConfig();
    return norm;
  } catch {
    return defaultAdminTestPayloadFromConfig();
  }
}

async function setAdminTest(examPeriodId = 1, test) {
  const ep = Number(examPeriodId);
  const id = Number.isFinite(ep) && ep > 0 ? ep : 1;
  const payload = normalizeAdminTestPayload(test);
  const now = Date.now();
  const json = JSON.stringify(payload || {});
  await run(
    `INSERT INTO admin_tests_by_period (exam_period_id, payload_json, updated_at_utc_ms)
     VALUES (?, ?, ?)
     ON CONFLICT(exam_period_id) DO UPDATE SET
       payload_json = excluded.payload_json,
       updated_at_utc_ms = excluded.updated_at_utc_ms;`,
    [id, json, now]
  );
  return { ok: true, updatedAtUtcMs: now };
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
     ORDER BY id ASC
     LIMIT 200;`
  );
}

async function deleteAllCoreData() {
  await ensureDb();
  await run("BEGIN;");
  try {
    // Order matters due to foreign keys.
    await run("DELETE FROM question_grades;");
    await run("DELETE FROM proctoring_acks;");
    await run("DELETE FROM session_snapshots;");
    await run("DELETE FROM session_listening_access;");
    await run("DELETE FROM sessions;");
    await run("DELETE FROM candidates;");
    // Reset autoincrement counters (best-effort).
    try {
      await run(
        "DELETE FROM sqlite_sequence WHERE name IN ('question_grades','proctoring_acks','session_snapshots','sessions','candidates');"
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

// Delete only a single session (row in admin candidates table), and cleanup dependent rows.
async function deleteSessionById(sessionId) {
  const sid = Number(sessionId);
  if (!Number.isFinite(sid) || sid <= 0) throw new Error("Invalid session id");

  await run("BEGIN;");
  try {
    const sr = await get(`SELECT id, candidate_id FROM sessions WHERE id = ? LIMIT 1;`, [sid]);
    if (!sr) {
      await run("ROLLBACK;");
      return { ok: false, deleted: 0 };
    }

    const candidateId = sr.candidate_id ? Number(sr.candidate_id) : null;

    await run(`DELETE FROM question_grades WHERE session_id = ?;`, [sid]);
    await run(`DELETE FROM proctoring_acks WHERE session_id = ?;`, [sid]);
    await run(`DELETE FROM session_snapshots WHERE session_id = ?;`, [sid]);
    await run(`DELETE FROM session_listening_access WHERE session_id = ?;`, [sid]);
    const sdel = await run(`DELETE FROM sessions WHERE id = ?;`, [sid]);

    let candidateDeleted = false;
    if (Number.isFinite(candidateId) && candidateId > 0) {
      const c = await get(`SELECT COUNT(1) AS n FROM sessions WHERE candidate_id = ?;`, [candidateId]);
      const n = Number(c?.n || 0);
      if (n <= 0) {
        await run(`DELETE FROM candidates WHERE id = ?;`, [candidateId]);
        candidateDeleted = true;
      }
    }

    await run("COMMIT;");
    return { ok: true, deleted: Number(sdel?.changes || 0), candidateDeleted };
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
