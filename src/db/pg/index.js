const { Pool } = require("pg");
const { hashPassword, verifyPassword } = require("../../auth");
const crypto = require("crypto");
const { getTestPayloadFull, getTestPayloadForClient, OPEN_AT_UTC_MS: DEFAULT_OPEN_AT_UTC_MS, DURATION_MINUTES: DEFAULT_DURATION_MINUTES } = require("../../test_config");
const { createAdminTestHelpers } = require("./admin-test");
const { createPgProctoringHelpers } = require("./proctoring");
const { createPgSpeakingHelpers } = require("./speaking");
const { createPgPeriodsHelpers } = require("./periods");
const { createPgSessionFlowHelpers } = require("./session-flow");

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

// Convenience helper: return first row (or null) for queries that expect a single record.
// Several parts of this codebase rely on this behavior.
async function q1(text, params = []) {
  const r = await q(text, params);
  return r && r.rows && r.rows.length ? r.rows[0] : null;
}

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
      CONSTRAINT sessions_exam_period_fk FOREIGN KEY (exam_period_id) REFERENCES exam_periods(id),
      CONSTRAINT sessions_candidate_fk FOREIGN KEY (candidate_id) REFERENCES candidates(id)
    );
  `);

  // Migrate older schema
  await q(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS exam_period_id INT;`);
  await q(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS candidate_id BIGINT;`);
  await q(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS disqualified BOOLEAN NOT NULL DEFAULT FALSE;`);
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

async function assignSessionsToLeastLoadedExaminers({ sessionIds, examPeriodId, client = null }) {
  const sids = Array.from(
    new Set((sessionIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))
  );
  const ep = Number(examPeriodId);
  if (!sids.length || !Number.isFinite(ep) || ep <= 0) return { assigned: 0 };

  const qf = (text, params = []) => (client ? client.query(text, params) : q(text, params));

  const ex = await qf(`SELECT id, username FROM public.examiners ORDER BY id ASC;`);
  if (!ex.rows.length) return { assigned: 0 };

  const existing = await qf(
    `SELECT session_id FROM public.examiner_assignments WHERE session_id = ANY($1::int[]);`,
    [sids]
  );
  const assignedSet = new Set(existing.rows.map((r) => Number(r.session_id)));
  const toAssign = sids.filter((sid) => !assignedSet.has(sid));
  if (!toAssign.length) return { assigned: 0 };

  const countsRes = await qf(
    `SELECT e.id AS examiner_id, COALESCE(c.cnt, 0) AS cnt
     FROM public.examiners e
     LEFT JOIN (
       SELECT a.examiner_id, COUNT(*)::int AS cnt
       FROM public.examiner_assignments a
       JOIN public.sessions s ON s.id = a.session_id
       WHERE s.exam_period_id = $1
       GROUP BY a.examiner_id
     ) c ON c.examiner_id = e.id
     ORDER BY e.id ASC;`,
    [ep]
  );

  const counts = new Map(countsRes.rows.map((r) => [Number(r.examiner_id), Number(r.cnt) || 0]));
  const examinerIds = ex.rows.map((r) => Number(r.id));
  let assigned = 0;

  for (const sid of toAssign.sort((a, b) => a - b)) {
    let pick = examinerIds[0];
    let min = counts.get(pick) ?? 0;
    for (const exid of examinerIds) {
      const c = counts.get(exid) ?? 0;
      if (c < min || (c === min && exid < pick)) {
        pick = exid;
        min = c;
      }
    }

    const ins = await qf(
      `INSERT INTO public.examiner_assignments (session_id, examiner_id, assigned_at_utc_ms)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id) DO NOTHING;`,
      [sid, pick, Date.now()]
    );
    const changed = Number(ins?.rowCount || 0);
    if (changed > 0) {
      assigned += 1;
      counts.set(pick, (counts.get(pick) || 0) + 1);
    }
  }

  return { assigned };
}

// Batch strategy for Excel imports:
// split sessions as evenly as possible across all examiners (max delta 1 in the batch).
async function assignSessionsBalancedAcrossExaminers({ sessionIds, examPeriodId, client = null }) {
  const sids = Array.from(
    new Set((sessionIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))
  );
  const ep = Number(examPeriodId);
  if (!sids.length || !Number.isFinite(ep) || ep <= 0) return { assigned: 0 };

  const qf = (text, params = []) => (client ? client.query(text, params) : q(text, params));

  const ex = await qf(`SELECT id FROM public.examiners ORDER BY id ASC;`);
  const examinerIds = (ex.rows || []).map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
  if (!examinerIds.length) return { assigned: 0 };

  const existing = await qf(
    `SELECT session_id FROM public.examiner_assignments WHERE session_id = ANY($1::int[]);`,
    [sids]
  );
  const assignedSet = new Set((existing.rows || []).map((r) => Number(r.session_id)));
  const toAssign = sids.filter((sid) => !assignedSet.has(sid)).sort((a, b) => a - b);
  if (!toAssign.length) return { assigned: 0 };

  const order = [...examinerIds];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  let assigned = 0;
  for (let i = 0; i < toAssign.length; i++) {
    const sid = toAssign[i];
    const pick = order[i % order.length];
    const ins = await qf(
      `INSERT INTO public.examiner_assignments (session_id, examiner_id, assigned_at_utc_ms)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id) DO NOTHING;`,
      [sid, pick, Date.now()]
    );
    assigned += Number(ins?.rowCount || 0);
  }
  return { assigned };
}

// Single-candidate strategy:
// choose among least-loaded examiners, randomizing ties.
async function assignSingleToLeastLoadedRandomTie({ sessionId, examPeriodId, client = null }) {
  const sid = Number(sessionId);
  const ep = Number(examPeriodId);
  if (!Number.isFinite(sid) || sid <= 0 || !Number.isFinite(ep) || ep <= 0) return { assigned: 0 };

  const qf = (text, params = []) => (client ? client.query(text, params) : q(text, params));

  const already = await qf(`SELECT 1 FROM public.examiner_assignments WHERE session_id = $1 LIMIT 1;`, [sid]);
  if (already.rows?.length) return { assigned: 0 };

  const countsRes = await qf(
    `SELECT e.id AS examiner_id, COALESCE(c.cnt, 0) AS cnt
     FROM public.examiners e
     LEFT JOIN (
       SELECT a.examiner_id, COUNT(*)::int AS cnt
       FROM public.examiner_assignments a
       JOIN public.sessions s ON s.id = a.session_id
       WHERE s.exam_period_id = $1
       GROUP BY a.examiner_id
     ) c ON c.examiner_id = e.id
     ORDER BY e.id ASC;`,
    [ep]
  );
  const rows = countsRes.rows || [];
  if (!rows.length) return { assigned: 0 };

  let min = Number(rows[0].cnt || 0);
  for (const r of rows) {
    const c = Number(r.cnt || 0);
    if (c < min) min = c;
  }
  const candidates = rows
    .filter((r) => Number(r.cnt || 0) === min)
    .map((r) => Number(r.examiner_id))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!candidates.length) return { assigned: 0 };

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const ins = await qf(
    `INSERT INTO public.examiner_assignments (session_id, examiner_id, assigned_at_utc_ms)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id) DO NOTHING;`,
    [sid, pick, Date.now()]
  );
  return { assigned: Number(ins?.rowCount || 0) };
}

async function autoAssignUnassignedSessions() {
  const periods = await q(
    `SELECT DISTINCT exam_period_id
     FROM public.sessions
     WHERE exam_period_id IS NOT NULL
     ORDER BY exam_period_id ASC;`
  );
  for (const pr of periods.rows || []) {
    const ep = Number(pr.exam_period_id);
    if (!Number.isFinite(ep) || ep <= 0) continue;
    const un = await q(
      `SELECT s.id
       FROM public.sessions s
       LEFT JOIN public.examiner_assignments a ON a.session_id = s.id
       WHERE s.exam_period_id = $1
         AND a.session_id IS NULL
       ORDER BY s.id ASC
       LIMIT 50000;`,
      [ep]
    );
    const sids = (un.rows || []).map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
    if (sids.length) {
      await assignSessionsToLeastLoadedExaminers({ sessionIds: sids, examPeriodId: ep });
    }
  }
}

async function ensureSessionAssignedExaminer({ sessionId, examPeriodId } = {}) {
  const sid = Number(sessionId);
  if (!Number.isFinite(sid) || sid <= 0) return "";

  let ep = Number(examPeriodId);
  if (!Number.isFinite(ep) || ep <= 0) {
    const s = await q1(`SELECT exam_period_id FROM public.sessions WHERE id = $1 LIMIT 1;`, [sid]);
    ep = Number(s?.exam_period_id);
  }
  if (!Number.isFinite(ep) || ep <= 0) return "";

  await assignSingleToLeastLoadedRandomTie({ sessionId: sid, examPeriodId: ep });

  const row = await q1(
    `SELECT e.username
     FROM public.examiner_assignments a
     JOIN public.examiners e ON e.id = a.examiner_id
     WHERE a.session_id = $1
     LIMIT 1;`,
    [sid]
  );
  return String(row?.username || "");
}

async function presencePing(_token, _status) {
  return true;
}

async function listResults() {
  const r = await q(
    `SELECT s.id AS "sessionId", s.name AS "candidateName", s.token, s.submitted,
            qg.total_grade AS "totalGrade"
     FROM public.sessions s
     LEFT JOIN public.question_grades qg ON qg.session_id = s.id
     WHERE s.submitted = TRUE
     ORDER BY s.id DESC
     LIMIT 5000`
  );
  return r.rows;
}

function getConfig() {
  return buildConfigResponse(getProctoringConfig);
}

async function getQuestionGrades(sessionId) {
  const sid = Number(sessionId);
  if (!Number.isFinite(sid) || sid <= 0) return null;
  const row = await q1(
    `SELECT
        session_id AS "sessionId",
        public.question_grades.token AS "token",
        s.exam_period_id AS "examPeriodId",
        COALESCE(q_writing, '') AS "qWriting",
        COALESCE(answers_json, '{}'::jsonb) AS "answersJson",
        speaking_grade AS "speakingGrade",
        writing_grade AS "writingGrade",
        total_grade AS "totalGrade",
        created_at_utc_ms AS "createdAtUtcMs"
     FROM public.question_grades
     JOIN public.sessions s ON s.id = public.question_grades.session_id
     WHERE public.question_grades.session_id = $1
     LIMIT 1;`,
    [sid]
  );
  return row || null;
}

async function verifyAdmin(username, password) {
  const u = String(username || "");
  const p = String(password || "");
  if (!u || !p) return false;
  const row = await q(`SELECT pass_hash FROM admins WHERE username = $1 LIMIT 1;`, [u]);
  if (!row.rows.length) return false;
  return verifyPassword(p, row.rows[0].pass_hash);
}

async function verifyExaminer(username, password) {
  const u = String(username || "");
  const p = String(password || "");
  if (!u || !p) return false;
  const row = await q(`SELECT pass_hash FROM examiners WHERE username = $1 LIMIT 1;`, [u]);
  if (!row.rows.length) return false;
  return verifyPassword(p, row.rows[0].pass_hash);
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

  const sr = await q(`SELECT id, token, exam_period_id, COALESCE(disqualified, FALSE) AS disqualified FROM public.sessions WHERE id = $1`, [sid]);
  const s = sr.rows[0];
  if (!s) return null;

  // If the session is disqualified, force a locked total_grade=0 and refuse any examiner edits.
  if (s.disqualified) {
    await q(
      `INSERT INTO public.question_grades (session_id, exam_period_id, token, speaking_grade, writing_grade, total_grade, created_at_utc_ms)
       VALUES ($1, $2, $3, 0, 0, 0, $4)
       ON CONFLICT (session_id)
       DO UPDATE SET
         exam_period_id = EXCLUDED.exam_period_id,
         token = EXCLUDED.token,
         speaking_grade = 0,
         writing_grade = 0,
         total_grade = 0,
         created_at_utc_ms = EXCLUDED.created_at_utc_ms;`,
      [sid, s.exam_period_id, String(s.token || ""), Date.now()]
    );
    return { sessionId: sid, locked: true, disqualified: true, totalGrade: 0 };
  }

  await q(
    `INSERT INTO public.question_grades (session_id, exam_period_id, token, speaking_grade, writing_grade, created_at_utc_ms)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (session_id)
     DO UPDATE SET
       exam_period_id = EXCLUDED.exam_period_id,
       token = EXCLUDED.token,
       speaking_grade = EXCLUDED.speaking_grade,
       writing_grade = EXCLUDED.writing_grade,
       created_at_utc_ms = EXCLUDED.created_at_utc_ms;`,
    [sid, s.exam_period_id, String(s.token || ""), spV, wrV, Date.now()]
  );

  const qg = await q1(
    `SELECT COALESCE(answers_json, '{}'::jsonb) AS answers_json,
            speaking_grade, writing_grade
     FROM public.question_grades
     WHERE session_id = $1
     LIMIT 1;`,
    [sid]
  );

  // Compute objective score from Listening + Reading + Writing Task 1 (auto-gradable items only).
  const payload = await getAdminTest(Number(s.exam_period_id) || 1);
  function norm(s){ return String(s || "").trim().toLowerCase(); }
  const ansObj = (qg && typeof qg.answers_json === "object" && qg.answers_json) || {};
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
      const got = ansObj[item.id];
      objectiveMax += pts;
      if (norm(got) === norm(expected)) objectiveEarned += pts;
    }
  }
  const objectivePercent = objectiveMax > 0 ? (objectiveEarned / objectiveMax) * 100 : 0;

  const spCalc = qg?.speaking_grade === null || qg?.speaking_grade === undefined ? 0 : Number(qg.speaking_grade);
  const wrCalc = qg?.writing_grade === null || qg?.writing_grade === undefined ? 0 : Number(qg.writing_grade);

  // Final weighting: Objective 60%, Writing 20%, Speaking 20%.
  const final = Math.round((objectivePercent * 0.6) + (wrCalc * 0.2) + (spCalc * 0.2));

  await q(
    `UPDATE public.question_grades
     SET total_grade = $1
     WHERE session_id = $2;`,
    [final, sid]
  );

  return {
    sessionId: sid,
    objectiveEarned,
    objectiveMax,
    objectivePercent: Math.round(objectivePercent * 10) / 10,
    speakingGrade: spV,
    writingGrade: wrV,
    finalGrade: final,
  };
}

async function deleteCandidateBySessionId(sessionId) {
  const sid = Number(sessionId);
  if (!Number.isFinite(sid) || sid <= 0) throw new Error("Invalid session id");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sr = await client.query(
      `SELECT id, candidate_id
       FROM public.sessions
       WHERE id = $1
       FOR UPDATE`,
      [sid]
    );
    if (!sr.rows.length) {
      await client.query("ROLLBACK");
      return { ok: false, deleted: 0 };
    }

    const candidateId = sr.rows[0].candidate_id ? Number(sr.rows[0].candidate_id) : null;
    if (Number.isFinite(candidateId) && candidateId > 0) {
      await client.query(
        `DELETE FROM public.question_grades
         WHERE session_id IN (SELECT id FROM public.sessions WHERE candidate_id = $1)`,
        [candidateId]
      );
      await client.query(
        `DELETE FROM public.speaking_slots
         WHERE session_id IN (SELECT id FROM public.sessions WHERE candidate_id = $1)`,
        [candidateId]
      );
      const sdel = await client.query(
        `DELETE FROM public.sessions WHERE candidate_id = $1`,
        [candidateId]
      );
      await client.query(`DELETE FROM public.candidates WHERE id = $1`, [candidateId]);
      await client.query("COMMIT");
      return { ok: true, deleted: Number(sdel.rowCount || 0) };
    }

    await client.query(`DELETE FROM public.question_grades WHERE session_id = $1`, [sid]);
    await client.query(`DELETE FROM public.speaking_slots WHERE session_id = $1`, [sid]);
    const sdel = await client.query(`DELETE FROM public.sessions WHERE id = $1`, [sid]);
    await client.query("COMMIT");
    return { ok: true, deleted: Number(sdel.rowCount || 0) };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function deleteSessionById(sessionId) {
  const sid = Number(sessionId);
  if (!Number.isFinite(sid) || sid <= 0) throw new Error("Invalid session id");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sr = await client.query(
      `SELECT id, candidate_id
       FROM public.sessions
       WHERE id = $1
       FOR UPDATE`,
      [sid]
    );
    if (!sr.rows.length) {
      await client.query("ROLLBACK");
      return { ok: false, deleted: 0 };
    }

    const candidateId = sr.rows[0].candidate_id ? Number(sr.rows[0].candidate_id) : null;

    await client.query(`DELETE FROM public.question_grades WHERE session_id = $1`, [sid]);
    await client.query(`DELETE FROM public.speaking_slots WHERE session_id = $1`, [sid]);
    const sdel = await client.query(`DELETE FROM public.sessions WHERE id = $1`, [sid]);

    let candidateDeleted = false;
    if (Number.isFinite(candidateId) && candidateId > 0) {
      const c = await client.query(`SELECT COUNT(1) AS n FROM public.sessions WHERE candidate_id = $1`, [candidateId]);
      const n = Number(c.rows?.[0]?.n || 0);
      if (n <= 0) {
        await client.query(`DELETE FROM public.candidates WHERE id = $1`, [candidateId]);
        candidateDeleted = true;
      }
    }

    await client.query("COMMIT");
    return { ok: true, deleted: Number(sdel.rowCount || 0), candidateDeleted };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function deleteAllCoreData() {
  // Order and CASCADE keep this safe even if there are FKs.
  await q("BEGIN;");
  try {
    await q(
      "TRUNCATE public.speaking_slots, public.session_snapshots, public.session_listening_access, public.proctoring_acks, public.examiner_assignments, public.question_grades, public.sessions, public.candidates RESTART IDENTITY CASCADE;"
    );
    await q("COMMIT;");
    return { ok: true };
  } catch (e) {
    try { await q("ROLLBACK;"); } catch {}
    throw e;
  }
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
  getQuestionGrades,
  deleteCandidateBySessionId,
  deleteSessionById,
  deleteAllCoreData,
};
