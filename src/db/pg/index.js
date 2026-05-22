const { Pool } = require("pg");
const { hashPassword, verifyPassword } = require("../../auth");
const crypto = require("crypto");
const { getTestPayloadFull, getTestPayloadForClient, OPEN_AT_UTC_MS: DEFAULT_OPEN_AT_UTC_MS, DURATION_MINUTES: DEFAULT_DURATION_MINUTES } = require("../../test_config");
const { createAdminTestHelpers } = require("./admin-test");
const { createPgProctoringHelpers } = require("./proctoring");
const { createPgSpeakingHelpers } = require("./speaking");
const { createPgPeriodsHelpers } = require("./periods");
const { createPgSessionFlowHelpers } = require("./session-flow");
const { createPgGradingHelpers } = require("./grading");
const { createPgAssignmentHelpers } = require("./assignments");

let pool = null;
// Exam periods now hold per-period configuration (open time + duration).
const SPEAKING_SLOT_DURATION_MINUTES = 60;

const {
  getConfig: buildConfigResponse,
  normalizeAdminTest,
  defaultAdminTestFromConfig,
  coerceLegacyAdminTestToPayload,
  adminTestHasAnyRealItems,
} = createAdminTestHelpers({
  getTestPayloadFull,
});

const {
  hasProctoringAck,
  recordProctoringAck,
  addSessionSnapshot,
  listSessionSnapshots,
  getSessionSnapshotById,
  deleteSessionSnapshotById,
  listSnapshotSessions,
  issueListeningTicket,
  verifyListeningTicket,
  addExamSecurityEvent,
  listExamSecurityEvents,
} = createPgProctoringHelpers({
  q,
  q1,
  getPool,
  getProctoringConfig,
});

let listSessionsMissingSpeakingSlot = () => [];
let getSessionScheduleDefaults = async () => null;
let listExaminers = async () => [];
let listSpeakingSlots = async () => [];
let getSpeakingSlotById = async () => null;
let createSpeakingSlot = async () => null;
let updateSpeakingSlot = async () => null;
let deleteSpeakingSlot = async () => ({ ok: true, deleted: 0 });
let getSpeakingJoinBySessionToken = async () => null;
let getAdminTest = async () => defaultAdminTestFromConfig();
let setAdminTest = async () => ({ ok: true, updatedAtUtcMs: Date.now() });
let listExamPeriods = async () => [];
let createExamPeriod = async () => ({ id: 0 });
let updateExamPeriod = async () => ({ ok: true });
let deleteExamPeriod = async () => ({ ok: true });
let createSession = async () => ({ token: "", sessionId: 0 });
let importCandidatesAndCreateSessions = async () => ({ sessions: [] });
let normalizeAnswers = (answers) => (answers && typeof answers === "object" ? answers : {});
let answerToText = () => "";
let buildStoredAnswers = () => ({});
let payloadForClientFromFull = (full) => JSON.parse(JSON.stringify(full || {}));
let getSessionForExam = async () => null;
let getGateForToken = async () => null;
let startSession = async () => null;
let gradeAttempt = async () => ({ score: 0, maxScore: 0, percent: 0, breakdown: [] });
let submitAnswers = async () => null;
let listCandidatesForExaminer = async () => [];
let examinerCanAccessSession = async () => false;
let listCandidates = async () => [];
let listResults = async () => [];
let getConfig = () => buildConfigResponse(getProctoringConfig);
let getQuestionGrades = async () => null;
let verifyAdmin = async () => false;
let verifyExaminer = async () => false;
let setExaminerGrades = async () => null;
let deleteCandidateBySessionId = async () => ({ ok: false, deleted: 0 });
let deleteSessionById = async () => ({ ok: false, deleted: 0 });
let deleteAllCoreData = async () => ({ ok: true });
let assignSessionsToLeastLoadedExaminers = async () => ({ assigned: 0 });
let assignSessionsBalancedAcrossExaminers = async () => ({ assigned: 0 });
let assignSingleToLeastLoadedRandomTie = async () => ({ assigned: 0 });
let autoAssignUnassignedSessions = async () => undefined;
let ensureSessionAssignedExaminer = async () => "";
let setSessionAssignedExaminer = async () => null;

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

function getConnString() {
  return process.env.DATABASE_URL || "";
}

function getPool() {
  if (pool) return pool;
  const cs = getConnString();
  if (!cs) throw new Error("Postgres connection string missing. Set DATABASE_URL.");
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

// Convenience helper: return first row (or null) for queries that expect a single record.
// Several parts of this codebase rely on this behavior.
async function q1(text, params = []) {
  const r = await q(text, params);
  return r && r.rows && r.rows.length ? r.rows[0] : null;
}

({
  assignSessionsToLeastLoadedExaminers,
  assignSessionsBalancedAcrossExaminers,
  assignSingleToLeastLoadedRandomTie,
  autoAssignUnassignedSessions,
  ensureSessionAssignedExaminer,
  setSessionAssignedExaminer,
} = createPgAssignmentHelpers({
  q,
  q1,
}));

({
  listSessionsMissingSpeakingSlot,
  getSessionScheduleDefaults,
  listExaminers,
  listSpeakingSlots,
  getSpeakingSlotById,
  createSpeakingSlot,
  updateSpeakingSlot,
  deleteSpeakingSlot,
  getSpeakingJoinBySessionToken,
} = createPgSpeakingHelpers({
  q,
  q1,
  ensureSessionAssignedExaminer: (args) => ensureSessionAssignedExaminer(args),
  speakingSlotDurationMinutes: SPEAKING_SLOT_DURATION_MINUTES,
}));

({
  getAdminTest,
  setAdminTest,
  listExamPeriods,
  createExamPeriod,
  updateExamPeriod,
  deleteExamPeriod,
} = createPgPeriodsHelpers({
  q,
  q1,
  defaultOpenAtUtcMs: DEFAULT_OPEN_AT_UTC_MS,
  defaultDurationMinutes: DEFAULT_DURATION_MINUTES,
  normalizeAdminTest,
  defaultAdminTestFromConfig,
  coerceLegacyAdminTestToPayload,
  adminTestHasAnyRealItems,
}));

({
  createSession,
  importCandidatesAndCreateSessions,
  normalizeAnswers,
  answerToText,
  buildStoredAnswers,
  payloadForClientFromFull,
  getSessionForExam,
  getGateForToken,
  startSession,
  gradeAttempt,
  submitAnswers,
  listCandidatesForExaminer,
  examinerCanAccessSession,
  listCandidates,
} = createPgSessionFlowHelpers({
  q,
  q1,
  getPool,
  makeToken,
  assignSingleToLeastLoadedRandomTie: (args) => assignSingleToLeastLoadedRandomTie(args),
  assignSessionsBalancedAcrossExaminers: (args) => assignSessionsBalancedAcrossExaminers(args),
  ensureSessionAssignedExaminer: (args) => ensureSessionAssignedExaminer(args),
  defaultOpenAtUtcMs: DEFAULT_OPEN_AT_UTC_MS,
  defaultDurationMinutes: DEFAULT_DURATION_MINUTES,
  getAdminTest: (examPeriodId) => getAdminTest(examPeriodId),
}));

({
  listResults,
  getConfig,
  getQuestionGrades,
  verifyAdmin,
  verifyExaminer,
  setExaminerGrades,
  deleteCandidateBySessionId,
  deleteSessionById,
  deleteAllCoreData,
} = createPgGradingHelpers({
  q,
  q1,
  getPool,
  verifyPassword,
  buildConfigResponse,
  getProctoringConfig,
  getAdminTest: (examPeriodId) => getAdminTest(examPeriodId),
  answerToText,
}));

function makeToken(len = 10) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function initDb() {
  // Exam periods
  await q(`
    CREATE TABLE IF NOT EXISTS exam_periods (
      id INT PRIMARY KEY,
      name TEXT NOT NULL,
      open_at_utc_ms BIGINT,
      duration_minutes INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Add columns if this DB existed before the change.
  await q(`ALTER TABLE exam_periods ADD COLUMN IF NOT EXISTS open_at_utc_ms BIGINT;`);
  await q(`ALTER TABLE exam_periods ADD COLUMN IF NOT EXISTS duration_minutes INT;`);

  // Seed default exam period id=1 if not present
  const ep1 = await q(`SELECT id FROM exam_periods WHERE id = 1 LIMIT 1;`);
  if (!ep1.rows.length) {
    await q(
      `INSERT INTO exam_periods (id, name, open_at_utc_ms, duration_minutes)
       VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO NOTHING;`,
      ["Default Exam Period", DEFAULT_OPEN_AT_UTC_MS, DEFAULT_DURATION_MINUTES]
    );
  }

  // Candidates (unique by email)
  await q(`
    CREATE TABLE IF NOT EXISTS candidates (
      id BIGSERIAL PRIMARY KEY,
      name TEXT,
      email TEXT NOT NULL UNIQUE,
      country TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Ensure candidates are deduplicated ONLY by email.
  // Some older schemas accidentally had a UNIQUE constraint/index on name.
  // If that exists, drop it so same-name people can co-exist.
  await q(`
    DO $$
    DECLARE
      rec RECORD;
    BEGIN
      -- Drop UNIQUE constraints that are exactly on (name)
      FOR rec IN (
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'public'
          AND rel.relname = 'candidates'
          AND con.contype = 'u'
          AND array_length(con.conkey, 1) = 1
          AND (
            SELECT attname FROM pg_attribute
            WHERE attrelid = rel.oid AND attnum = con.conkey[1]
          ) = 'name'
      ) LOOP
        EXECUTE format('ALTER TABLE public.candidates DROP CONSTRAINT IF EXISTS %I', rec.conname);
      END LOOP;

      -- Drop UNIQUE indexes that are exactly on (name)
      FOR rec IN (
        SELECT idx.relname AS index_name
        FROM pg_index i
        JOIN pg_class idx ON idx.oid = i.indexrelid
        JOIN pg_class tbl ON tbl.oid = i.indrelid
        JOIN pg_namespace nsp ON nsp.oid = tbl.relnamespace
        WHERE nsp.nspname = 'public'
          AND tbl.relname = 'candidates'
          AND i.indisunique = true
          AND i.indnatts = 1
          AND (
            SELECT attname FROM pg_attribute
            WHERE attrelid = tbl.oid AND attnum = i.indkey[1]
          ) = 'name'
      ) LOOP
        EXECUTE format('DROP INDEX IF EXISTS public.%I', rec.index_name);
      END LOOP;

      -- Ensure there is a unique index on email (in case older schema missed it)
      IF NOT EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN pg_class idx ON idx.oid = i.indexrelid
        JOIN pg_class tbl ON tbl.oid = i.indrelid
        JOIN pg_namespace nsp ON nsp.oid = tbl.relnamespace
        WHERE nsp.nspname = 'public'
          AND tbl.relname = 'candidates'
          AND i.indisunique = true
          AND i.indnatts = 1
          AND (
            SELECT attname FROM pg_attribute
            WHERE attrelid = tbl.oid AND attnum = i.indkey[1]
          ) = 'email'
      ) THEN
        EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS candidates_email_unique ON public.candidates(email)';
      END IF;
    END $$;
  `);

  // Sessions (one per attempt)
  await q(`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      exam_period_id INT,
      candidate_id BIGINT,
      token TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      submitted BOOLEAN NOT NULL DEFAULT FALSE,
      submitted_at_utc_ms BIGINT,
      started_at_utc_ms BIGINT,
      personal_end_at_utc_ms BIGINT,
      CONSTRAINT sessions_exam_period_fk FOREIGN KEY (exam_period_id) REFERENCES exam_periods(id),
      CONSTRAINT sessions_candidate_fk FOREIGN KEY (candidate_id) REFERENCES candidates(id)
    );
  `);

  // Migrate older schema
  await q(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS exam_period_id INT;`);
  await q(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS candidate_id BIGINT;`);
  await q(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS disqualified BOOLEAN NOT NULL DEFAULT FALSE;`);
  await q(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS submitted_at_utc_ms BIGINT;`);
  await q(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS started_at_utc_ms BIGINT;`);
  await q(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS personal_end_at_utc_ms BIGINT;`);
  await q(`CREATE INDEX IF NOT EXISTS idx_sessions_exam_period_id ON sessions(exam_period_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_sessions_candidate_id ON sessions(candidate_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_sessions_exam_period_candidate ON sessions(exam_period_id, candidate_id);`);

  // Proctoring acknowledgements (one per session attempt)
  await q(`
    CREATE TABLE IF NOT EXISTS public.proctoring_acks (
      session_id INT PRIMARY KEY,
      token TEXT NOT NULL,
      notice_version TEXT NOT NULL,
      acked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT proctoring_acks_session_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE
    );
  `);
  await q(`CREATE INDEX IF NOT EXISTS idx_proctoring_acks_token ON public.proctoring_acks(token);`);

  await q(`
    CREATE TABLE IF NOT EXISTS public.exam_security_events (
      id SERIAL PRIMARY KEY,
      session_id INT NOT NULL,
      exam_period_id INT,
      candidate_id BIGINT,
      event_type TEXT NOT NULL,
      payload_json JSONB,
      created_at_utc_ms BIGINT NOT NULL,
      CONSTRAINT exam_security_events_session_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE,
      CONSTRAINT exam_security_events_exam_period_fk FOREIGN KEY (exam_period_id) REFERENCES public.exam_periods(id),
      CONSTRAINT exam_security_events_candidate_fk FOREIGN KEY (candidate_id) REFERENCES public.candidates(id)
    );
  `);
  await q(`CREATE INDEX IF NOT EXISTS idx_exam_security_events_session_id ON public.exam_security_events(session_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_exam_security_events_exam_period_id ON public.exam_security_events(exam_period_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_exam_security_events_event_type ON public.exam_security_events(event_type);`);

  // Exam snapshots (max N per session enforced in code)
  await q(`
    CREATE TABLE IF NOT EXISTS public.session_snapshots (
      id BIGSERIAL PRIMARY KEY,
      session_id INT NOT NULL,
      token TEXT NOT NULL,
      reason TEXT NOT NULL,
      remote_path TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT session_snapshots_session_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE
    );
  `);
  await q(`CREATE INDEX IF NOT EXISTS idx_session_snapshots_session_id ON public.session_snapshots(session_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_session_snapshots_token ON public.session_snapshots(token);`);

  // Listening "play once" enforcement (server-side)
  await q(`
    CREATE TABLE IF NOT EXISTS public.session_listening_access (
      session_id INT PRIMARY KEY,
      play_count INT NOT NULL DEFAULT 0,
      ticket TEXT,
      ticket_expires_utc_ms BIGINT,
      updated_at_utc_ms BIGINT NOT NULL,
      CONSTRAINT session_listening_access_session_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE
    );
  `);
  await q(`CREATE INDEX IF NOT EXISTS idx_session_listening_access_ticket ON public.session_listening_access(ticket);`);

  // Legacy migration: if an old app_config table exists, move its values into exam_periods(id=1)
  // and then drop app_config.
  try {
    const t = await q(`SELECT to_regclass('public.app_config') AS name;`);
    if (t.rows?.[0]?.name) {
      // Ensure duration_minutes exists on app_config if it was created by older versions
      try { await q(`ALTER TABLE app_config ADD COLUMN IF NOT EXISTS duration_minutes INT;`); } catch {}

      // Convert duration_seconds -> duration_minutes if present
      try {
        const cols = await q(
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'app_config' AND table_schema = 'public';`
        );
        const colSet = new Set(cols.rows.map(r => r.column_name));
        if (colSet.has('duration_seconds')) {
          await q(
            `UPDATE app_config
             SET duration_minutes = COALESCE(duration_minutes, GREATEST(1, ROUND(duration_seconds / 60.0)))
             WHERE id = 1;`
          );
        }
      } catch {}

      const r = await q(`SELECT open_at_utc_ms, duration_minutes FROM app_config WHERE id = 1 LIMIT 1;`);
      if (r.rows.length) {
        const openAt = Number(r.rows[0].open_at_utc_ms);
        const durMin = Number(r.rows[0].duration_minutes);
        await q(
          `UPDATE exam_periods
           SET open_at_utc_ms = COALESCE(open_at_utc_ms, $2),
               duration_minutes = COALESCE(duration_minutes, $3)
           WHERE id = $1;`,
          [1, Number.isFinite(openAt) ? openAt : DEFAULT_OPEN_AT_UTC_MS, Number.isFinite(durMin) ? durMin : DEFAULT_DURATION_MINUTES]
        );
      }
      // Drop old table
      try { await q(`DROP TABLE IF EXISTS app_config;`); } catch {}
    }
  } catch {}

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
      { username: "admin1", pass: "AS8549D1ASD0" },
      { username: "admin2", pass: "A8S97D401AS0" },
      { username: "admin3", pass: "ASD129AS5D04" },
      { username: "admin4", pass: "AS1D0AS8D40D" },
      { username: "admin5", pass: "ASD410A85SD0" },
    ];
  for (const a of seed) {
    await q(`INSERT INTO admins (username, pass_hash) VALUES ($1, $2)`, [a.username, hashPassword(a.pass)]);
  }
}

  // Examiners accounts (DB-driven)
  await q(`
    CREATE TABLE IF NOT EXISTS examiners (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL
    );
  `);

  const exrows = await q(`SELECT id FROM examiners LIMIT 1;`);
  if (!exrows.rows.length) {
    const seedEx = [
      { username: "examiner1", pass: "6NR7UYNUJH7U" },
      { username: "examiner2", pass: "SD789F6HSDF9" },
      { username: "examiner3", pass: "Y6UH75Y65GHH" },
      { username: "examiner4", pass: "Y56HYU56HY67" },
      { username: "examiner5", pass: "65YTUH67H67J" },
    ];
    for (const u of seedEx) {
      await q(`INSERT INTO examiners (username, pass_hash) VALUES ($1, $2)`, [u.username, hashPassword(u.pass)]);
    }
  }

  // Examiner assignments (one examiner per session)
  await q(`
    CREATE TABLE IF NOT EXISTS public.examiner_assignments (
      id BIGSERIAL PRIMARY KEY,
      session_id INT NOT NULL UNIQUE,
      examiner_id INT NOT NULL,
      assigned_at_utc_ms BIGINT NOT NULL,
      CONSTRAINT examiner_assignments_session_fk
        FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE,
      CONSTRAINT examiner_assignments_examiner_fk
        FOREIGN KEY (examiner_id) REFERENCES public.examiners(id) ON DELETE CASCADE
    );
  `);
  await q(`ALTER TABLE public.examiner_assignments ADD COLUMN IF NOT EXISTS assigned_at_utc_ms BIGINT;`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_examiner_assignments_session_id ON public.examiner_assignments(session_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_examiner_assignments_examiner_id ON public.examiner_assignments(examiner_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_examiner_assignments_session_id ON public.examiner_assignments(session_id);`);

  // Admin-managed tests (MCQ builder). Stored per exam period.
  await q(`
    CREATE TABLE IF NOT EXISTS public.admin_tests_by_period (
      exam_period_id INT PRIMARY KEY,
      payload_json JSONB NOT NULL,
      updated_at_utc_ms BIGINT NOT NULL,
      CONSTRAINT admin_tests_by_period_exam_period_fk
        FOREIGN KEY (exam_period_id) REFERENCES public.exam_periods(id) ON DELETE CASCADE
    );
  `);

  // Migration: if legacy public.admin_tests(scope='global') exists, copy into period 1 (best-effort).
  try {
    const legacy = await q1(`SELECT to_regclass('public.admin_tests') AS name;`);
    if (legacy?.name) {
      const existing = await q1(`SELECT 1 FROM public.admin_tests_by_period LIMIT 1;`);
      if (!existing) {
        const row = await q1(
          `SELECT payload_json AS payload_json, updated_at_utc_ms AS updated_at_utc_ms
           FROM public.admin_tests
           WHERE scope = 'global'
           LIMIT 1;`
        );
        if (row?.payload_json) {
          await q(
            `INSERT INTO public.admin_tests_by_period (exam_period_id, payload_json, updated_at_utc_ms)
             VALUES (1, $1::jsonb, $2)
             ON CONFLICT (exam_period_id) DO NOTHING;`,
            [JSON.stringify(row.payload_json), Number(row.updated_at_utc_ms || Date.now())]
          );
        }
      }
    }
  } catch {}

  // Seed per-exam-period tests (non-destructive).
  // Goal: keep the full "default" test for the first January period, and smaller tests for other periods.
  try {
    const epsR = await q(`SELECT id, name FROM public.exam_periods ORDER BY id ASC;`);
    const eps = epsR.rows || [];
    const existingR = await q(`SELECT exam_period_id FROM public.admin_tests_by_period;`);
    const existing = new Set((existingR.rows || []).map((r) => Number(r.exam_period_id)).filter((n) => Number.isFinite(n) && n > 0));

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

    const full = normalizeAdminTest(convertLegacyWritingToDragWords(defaultAdminTestFromConfig()));

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
      return normalizeAdminTest(p);
    };

    const small = makeSmall(full);
    const now = Date.now();
    for (const epRow of eps || []) {
      const id = Number(epRow?.id || 0);
      if (!Number.isFinite(id) || id <= 0) continue;
      if (existing.has(id)) continue;
      const payload = id === januaryId ? full : small;
      await q(
        `INSERT INTO public.admin_tests_by_period (exam_period_id, payload_json, updated_at_utc_ms)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (exam_period_id) DO NOTHING;`,
        [id, JSON.stringify(payload || {}), now]
      );
    }
  } catch {}

  // speaking interview slots (calendar scheduling + optional video meeting metadata)
  // Migrate legacy table name oral_slots -> speaking_slots.
  await q(`
    DO $$
    BEGIN
      IF to_regclass('public.speaking_slots') IS NULL AND to_regclass('public.oral_slots') IS NOT NULL THEN
        ALTER TABLE public.oral_slots RENAME TO speaking_slots;
      END IF;
    END $$;
  `);
  await q(`
    DO $$
    BEGIN
      IF to_regclass('public.speaking_slots') IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM pg_constraint
           WHERE conrelid = 'public.speaking_slots'::regclass
             AND conname = 'oral_slots_examiner_username_fkey'
         ) THEN
        ALTER TABLE public.speaking_slots
        RENAME CONSTRAINT oral_slots_examiner_username_fkey TO speaking_slots_examiner_username_fkey;
      END IF;
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END $$;
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS public.speaking_slots (
      id SERIAL PRIMARY KEY,
      exam_period_id INT,
      session_id INT,
      candidate_id BIGINT,
      candidate_name TEXT NOT NULL,
      start_utc_ms BIGINT NOT NULL,
      end_utc_ms BIGINT NOT NULL,
      video_provider TEXT NOT NULL DEFAULT 'manual',
      examiner_username TEXT,
      meeting_id TEXT,
      join_url TEXT,
      start_url TEXT,
      meeting_metadata_json JSONB,
      status TEXT NOT NULL DEFAULT 'scheduled',
      created_at_utc_ms BIGINT NOT NULL,
      updated_at_utc_ms BIGINT NOT NULL,
      CONSTRAINT speaking_slots_exam_period_fk FOREIGN KEY (exam_period_id) REFERENCES public.exam_periods(id) ON DELETE SET NULL,
      CONSTRAINT speaking_slots_session_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE SET NULL,
      CONSTRAINT speaking_slots_candidate_fk FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE SET NULL
    );
  `);
  await q(`ALTER TABLE public.speaking_slots ADD COLUMN IF NOT EXISTS exam_period_id INT;`);
  await q(`ALTER TABLE public.speaking_slots ADD COLUMN IF NOT EXISTS session_id INT;`);
  await q(`ALTER TABLE public.speaking_slots ADD COLUMN IF NOT EXISTS candidate_id BIGINT;`);
  await q(`ALTER TABLE public.speaking_slots ADD COLUMN IF NOT EXISTS candidate_name TEXT;`);
  await q(`ALTER TABLE public.speaking_slots ADD COLUMN IF NOT EXISTS start_utc_ms BIGINT;`);
  await q(`ALTER TABLE public.speaking_slots ADD COLUMN IF NOT EXISTS end_utc_ms BIGINT;`);
  await q(`ALTER TABLE public.speaking_slots ADD COLUMN IF NOT EXISTS video_provider TEXT;`);
  await q(`ALTER TABLE public.speaking_slots ADD COLUMN IF NOT EXISTS examiner_username TEXT;`);
  await q(`ALTER TABLE public.speaking_slots ADD COLUMN IF NOT EXISTS meeting_id TEXT;`);
  await q(`ALTER TABLE public.speaking_slots ADD COLUMN IF NOT EXISTS join_url TEXT;`);
  await q(`ALTER TABLE public.speaking_slots ADD COLUMN IF NOT EXISTS start_url TEXT;`);
  await q(`ALTER TABLE public.speaking_slots ADD COLUMN IF NOT EXISTS meeting_metadata_json JSONB;`);
  await q(`ALTER TABLE public.speaking_slots ADD COLUMN IF NOT EXISTS status TEXT;`);
  await q(`ALTER TABLE public.speaking_slots ADD COLUMN IF NOT EXISTS created_at_utc_ms BIGINT;`);
  await q(`ALTER TABLE public.speaking_slots ADD COLUMN IF NOT EXISTS updated_at_utc_ms BIGINT;`);
  await q(`UPDATE public.speaking_slots SET video_provider = COALESCE(NULLIF(video_provider, ''), 'manual') WHERE video_provider IS NULL OR video_provider = '';`);
  await q(`UPDATE public.speaking_slots SET status = COALESCE(NULLIF(status, ''), 'scheduled') WHERE status IS NULL OR status = '';`);
  await q(`UPDATE public.speaking_slots SET meeting_id = NULL WHERE meeting_id = '';`);
  await q(`UPDATE public.speaking_slots SET join_url = NULL WHERE join_url = '';`);
  await q(`UPDATE public.speaking_slots SET start_url = NULL WHERE start_url = '';`);
  await q(`UPDATE public.speaking_slots SET join_url = NULL WHERE join_url LIKE 'https://meet.jit.si/%';`);
  await q(`UPDATE public.speaking_slots SET start_url = NULL WHERE start_url LIKE 'https://meet.jit.si/%';`);
  await q(`UPDATE public.speaking_slots SET created_at_utc_ms = COALESCE(created_at_utc_ms, EXTRACT(EPOCH FROM now())::bigint * 1000) WHERE created_at_utc_ms IS NULL;`);
  await q(`UPDATE public.speaking_slots SET updated_at_utc_ms = COALESCE(updated_at_utc_ms, created_at_utc_ms, EXTRACT(EPOCH FROM now())::bigint * 1000) WHERE updated_at_utc_ms IS NULL;`);
  await q(`
    DO $$
    BEGIN
      BEGIN
        ALTER TABLE public.speaking_slots
        ALTER COLUMN candidate_name SET NOT NULL;
      EXCEPTION WHEN others THEN
        NULL;
      END;
      BEGIN
        ALTER TABLE public.speaking_slots
        ALTER COLUMN start_utc_ms SET NOT NULL;
      EXCEPTION WHEN others THEN
        NULL;
      END;
      BEGIN
        ALTER TABLE public.speaking_slots
        ALTER COLUMN end_utc_ms SET NOT NULL;
      EXCEPTION WHEN others THEN
        NULL;
      END;
      BEGIN
        ALTER TABLE public.speaking_slots
        ALTER COLUMN video_provider SET NOT NULL;
      EXCEPTION WHEN others THEN
        NULL;
      END;
      BEGIN
        ALTER TABLE public.speaking_slots
        ALTER COLUMN status SET NOT NULL;
      EXCEPTION WHEN others THEN
        NULL;
      END;
      BEGIN
        ALTER TABLE public.speaking_slots
        ALTER COLUMN created_at_utc_ms SET NOT NULL;
      EXCEPTION WHEN others THEN
        NULL;
      END;
      BEGIN
        ALTER TABLE public.speaking_slots
        ALTER COLUMN updated_at_utc_ms SET NOT NULL;
      EXCEPTION WHEN others THEN
        NULL;
      END;
    END $$;
  `);
  await q(`CREATE INDEX IF NOT EXISTS idx_speaking_slots_exam_period_start ON public.speaking_slots(exam_period_id, start_utc_ms);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_speaking_slots_start ON public.speaking_slots(start_utc_ms);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_speaking_slots_session_id ON public.speaking_slots(session_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_speaking_slots_examiner_username ON public.speaking_slots(examiner_username);`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_speaking_slots_session_id_not_null ON public.speaking_slots(session_id) WHERE session_id IS NOT NULL;`);
  await q(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'speaking_slots_examiner_username_fkey'
          AND conrelid = 'public.speaking_slots'::regclass
      ) THEN
        ALTER TABLE public.speaking_slots
        ADD CONSTRAINT speaking_slots_examiner_username_fkey
        FOREIGN KEY (examiner_username) REFERENCES public.examiners(username) ON DELETE SET NULL;
      END IF;
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END $$;
  `);

  // Per-question grades (A,B,C as text)
  await q(`
    CREATE TABLE IF NOT EXISTS public.question_grades (
      id SERIAL PRIMARY KEY,
      session_id INT NOT NULL UNIQUE,
      exam_period_id INT,
      token TEXT,
      q_writing TEXT,
      answers_json JSONB,
      speaking_grade INT CHECK (speaking_grade BETWEEN 0 AND 100),
      writing_grade INT CHECK (writing_grade BETWEEN 0 AND 100),
      total_grade INT CHECK (total_grade BETWEEN 0 AND 100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT question_grades_session_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id),
      CONSTRAINT question_grades_exam_period_fk FOREIGN KEY (exam_period_id) REFERENCES public.exam_periods(id)
    );
  `);
  // Migration: older DBs may not have token column on question_grades.
  await q(`ALTER TABLE public.question_grades ADD COLUMN IF NOT EXISTS token TEXT;`);
  // Migration: ensure question_grades has exam_period_id (older DBs may not)
  await q(`ALTER TABLE public.question_grades ADD COLUMN IF NOT EXISTS exam_period_id INT;`);
  // Older DBs may not have token stored in question_grades.
  await q(`ALTER TABLE public.question_grades ADD COLUMN IF NOT EXISTS token TEXT;`);
  await q(`ALTER TABLE public.question_grades DROP COLUMN IF EXISTS q_a;`);
  await q(`ALTER TABLE public.question_grades DROP COLUMN IF EXISTS q_b;`);
  await q(`ALTER TABLE public.question_grades DROP COLUMN IF EXISTS q_c;`);
  await q(`ALTER TABLE public.question_grades ADD COLUMN IF NOT EXISTS q_writing TEXT;`);
  await q(`ALTER TABLE public.question_grades ADD COLUMN IF NOT EXISTS answers_json JSONB;`);
  await q(`ALTER TABLE public.question_grades ADD COLUMN IF NOT EXISTS speaking_grade INT;`);
  await q(`ALTER TABLE public.question_grades ADD COLUMN IF NOT EXISTS writing_grade INT;`);
  await q(`ALTER TABLE public.question_grades ADD COLUMN IF NOT EXISTS total_grade INT;`);

  await q(`CREATE INDEX IF NOT EXISTS idx_question_grades_exam_period_id ON public.question_grades(exam_period_id);`);

  // Migration: older DBs may store timestamps as epoch milliseconds.
  await q(`ALTER TABLE public.question_grades ADD COLUMN IF NOT EXISTS created_at_utc_ms BIGINT;`);

  // Ensure session_id can be used for UPSERT.
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_question_grades_session_id ON public.question_grades(session_id);`);

  // Backfill assignments for older sessions that may not be assigned yet.
  await autoAssignUnassignedSessions();
}

async function presencePing(_token, _status) {
  return true;
}


module.exports = {
  initDb,
  createSession,
  importCandidatesAndCreateSessions,
  getSessionForExam,
  getGateForToken,
  startSession,
  submitAnswers,
  listResults,
  listCandidates,
  listSessionsMissingSpeakingSlot,
  getSessionScheduleDefaults,
  listCandidatesForExaminer,
  examinerCanAccessSession,
  setExaminerGrades,
  presencePing,
  hasProctoringAck,
  recordProctoringAck,
  addSessionSnapshot,
  listSessionSnapshots,
  listSnapshotSessions,
  getSessionSnapshotById,
  deleteSessionSnapshotById,
  issueListeningTicket,
  verifyListeningTicket,
  addExamSecurityEvent,
  listExamSecurityEvents,
  getConfig,
  getAdminTest,
  setAdminTest,
  listExamPeriods,
  listExaminers,
  listSpeakingSlots,
  getSpeakingSlotById,
  getSpeakingJoinBySessionToken,
  createSpeakingSlot,
  updateSpeakingSlot,
  deleteSpeakingSlot,
  createExamPeriod,
  updateExamPeriod,
  deleteExamPeriod,
  verifyAdmin,
  verifyExaminer,
  ensureSessionAssignedExaminer,
  setSessionAssignedExaminer,
  getQuestionGrades,
  deleteCandidateBySessionId,
  deleteSessionById,
  deleteAllCoreData,
};
