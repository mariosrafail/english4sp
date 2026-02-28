const { Pool } = require("pg");
const { hashPassword, verifyPassword } = require("./auth");
const crypto = require("crypto");
const { getTestPayloadFull, getTestPayloadForClient, OPEN_AT_UTC_MS: DEFAULT_OPEN_AT_UTC_MS, DURATION_MINUTES: DEFAULT_DURATION_MINUTES } = require("./test_config");

let pool = null;
// Exam periods now hold per-period configuration (open time + duration).
const SPEAKING_SLOT_DURATION_MINUTES = 60;

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

async function createSession({ candidateName }) {
  const token = makeToken(10);
  const name = String(candidateName || "Candidate").trim() || "Candidate";
  const r = await q(
    `INSERT INTO public.sessions (token, name, submitted)
     VALUES ($1, $2, FALSE)
     RETURNING id`,
    [token, name]
  );
  return { token, sessionId: r.rows[0].id };
}

async function importCandidatesAndCreateSessions({ rows, examPeriodId, assignmentStrategy = "batch_even" }) {
  const ep = Number(examPeriodId) || 1;
  if (!Number.isFinite(ep) || ep <= 0) throw new Error("Invalid exam period");

  // Ensure exam period exists (with defaults if new)
  await q(
    `INSERT INTO exam_periods (id, name, open_at_utc_ms, duration_minutes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING;`,
    [ep, `Exam Period ${ep}`, DEFAULT_OPEN_AT_UTC_MS, DEFAULT_DURATION_MINUTES]
  );

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const created = [];

    for (const r of rows || []) {
      const name = String(r.name || "").trim();
      const email = String(r.email || "").trim().toLowerCase();
      const country = String(r.country || "").trim();
      if (!email) continue;

      const cand = await client.query(
        `INSERT INTO candidates (name, email, country)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name,
             country = EXCLUDED.country
         RETURNING id, name, email, country;`,
        [name || null, email, country || null]
      );
      const c = cand.rows[0];

      // If the same email is already registered for the same exam period,
      // do NOT create another session/link.
      // Qualify selected columns to avoid ambiguity (both tables have an "id")
      const existing = await client.query(
        `SELECT s.id AS id, s.token AS token
         FROM sessions s
         LEFT JOIN question_grades q ON q.session_id = s.id
         WHERE s.exam_period_id = $1 AND s.candidate_id = $2
         LIMIT 1;`,
        [ep, c.id]
      );
      if (existing.rows.length && String(assignmentStrategy || "") !== "single_least_random") {
        created.push({
          sessionId: existing.rows[0].id,
          token: existing.rows[0].token,
          examPeriodId: ep,
          candidateId: c.id,
          name: c.name || "",
          email: c.email,
          country: c.country || "",
          reused: true,
        });
        continue;
      }

      // Otherwise create a new session
      let token = makeToken(10);
      // retry on collision
      for (let i = 0; i < 5; i++) {
        try {
          const s = await client.query(
            `INSERT INTO sessions (exam_period_id, candidate_id, token, name, submitted)
             VALUES ($1, $2, $3, $4, FALSE)
             RETURNING id;`,
            [ep, c.id, token, c.name || "Candidate"]
          );
          created.push({
            sessionId: s.rows[0].id,
            token,
            examPeriodId: ep,
            candidateId: c.id,
            name: c.name || "",
            email: c.email,
            country: c.country || "",
            reused: false,
          });
          break;
        } catch (e) {
          // unique violation on token
          if (e && e.code === "23505") {
            token = makeToken(10);
            continue;
          }
          throw e;
        }
      }
    }

    const sidsForAssign = created.map((x) => Number(x.sessionId));
    if (String(assignmentStrategy || "") === "single_least_random") {
      for (const sid of sidsForAssign) {
        await assignSingleToLeastLoadedRandomTie({ sessionId: sid, examPeriodId: ep, client });
      }
    } else {
      await assignSessionsBalancedAcrossExaminers({
        sessionIds: sidsForAssign,
        examPeriodId: ep,
        client,
      });
    }

    const sidList = created
      .map((x) => Number(x.sessionId))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (sidList.length) {
      const asg = await client.query(
        `SELECT a.session_id, e.username
         FROM public.examiner_assignments a
         JOIN public.examiners e ON e.id = a.examiner_id
         WHERE a.session_id = ANY($1::int[]);`,
        [sidList]
      );
      const bySid = new Map((asg.rows || []).map((r) => [Number(r.session_id), String(r.username || "")]));
      for (const c of created) c.assignedExaminer = bySid.get(Number(c.sessionId)) || "";
    }

    await client.query("COMMIT");
    return { sessions: created };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function getSessionForExam(token) {
  const r = await q(
    `SELECT s.id, s.token, s.name, s.submitted,
            COALESCE(s.disqualified, FALSE) AS disqualified,
            qg.total_grade AS total_grade,
            (pa.session_id IS NOT NULL) AS proctoring_acked,
            s.exam_period_id,
            ep.open_at_utc_ms, ep.duration_minutes
     FROM public.sessions s
     LEFT JOIN public.exam_periods ep ON ep.id = s.exam_period_id
     LEFT JOIN public.question_grades qg ON qg.session_id = s.id
     LEFT JOIN public.proctoring_acks pa ON pa.session_id = s.id
     WHERE s.token = $1
     LIMIT 1`,
    [token]
  );
  const s = r.rows[0];
  if (!s) return null;

  const openAtUtc = Number(s.open_at_utc_ms);
  const durationMinutes = Number(s.duration_minutes);

  const payload = payloadForClientFromFull(await getAdminTest(Number(s.exam_period_id) || 1));
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
      id: s.id,
      token: s.token,
      candidateName: s.name,
      submitted: !!s.submitted,
      disqualified: !!s.disqualified,
      proctoringAcked: !!s.proctoring_acked,
      grade: s.total_grade === null || s.total_grade === undefined ? null : Number(s.total_grade),
      examPeriodId: Number(s.exam_period_id) || 1,
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

async function getGateForToken(token) {
  const r = await q(
    `SELECT s.token, s.exam_period_id,
            ep.open_at_utc_ms, ep.duration_minutes
     FROM public.sessions s
     LEFT JOIN public.exam_periods ep ON ep.id = s.exam_period_id
     WHERE s.token = $1
     LIMIT 1;`,
    [token]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const now = Date.now();
  const openAt = Number(row.open_at_utc_ms);
  const durMin = Number(row.duration_minutes);
  const openAtUtc = Number.isFinite(openAt) ? openAt : DEFAULT_OPEN_AT_UTC_MS;
  const durationMinutes = Number.isFinite(durMin) && durMin > 0 ? durMin : DEFAULT_DURATION_MINUTES;
  const durMs = durationMinutes * 60 * 1000;
  const endAt = openAtUtc + durMs;
  return {
    now,
    openAtUtc,
    durationMinutes,
    durMs,
    endAtUtc: endAt,
  };
}

async function startSession(token) {
  const r = await q(`SELECT submitted FROM public.sessions WHERE token = $1`, [token]);
  const s = r.rows[0];
  if (!s) return null;
  if (s.submitted) return { status: "submitted" };
  return { status: "started" };
}

async function hasProctoringAck(token) {
  const t = String(token || "").trim();
  if (!t) return false;
  const r = await q(`SELECT 1 FROM public.proctoring_acks WHERE token = $1 LIMIT 1;`, [t]);
  return !!(r.rows && r.rows.length);
}

async function recordProctoringAck(token, { noticeVersion } = {}) {
  const t = String(token || "").trim();
  if (!t) return null;
  const v = String(noticeVersion || "").trim() || getProctoringConfig().noticeVersion;

  const s = await q1(`SELECT id FROM public.sessions WHERE token = $1 LIMIT 1;`, [t]);
  if (!s) return null;

  await q(
    `INSERT INTO public.proctoring_acks (session_id, token, notice_version)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id)
     DO UPDATE SET notice_version = EXCLUDED.notice_version, acked_at = now();`,
    [Number(s.id), t, v]
  );
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

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const s = await client.query(`SELECT id FROM public.sessions WHERE token = $1 LIMIT 1;`, [t]);
    const row = s.rows?.[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    const sid = Number(row.id);

    const c = await client.query(`SELECT COUNT(1)::int AS n FROM public.session_snapshots WHERE session_id = $1;`, [sid]);
    const n = Number(c.rows?.[0]?.n || 0);
    if (n >= limit) {
      await client.query("COMMIT");
      return { ok: false, limited: true, count: n, remaining: 0 };
    }

    const ins = await client.query(
      `INSERT INTO public.session_snapshots (session_id, token, reason, remote_path)
       VALUES ($1, $2, $3, $4)
       RETURNING id;`,
      [sid, t, rsn, rp]
    );

    await client.query("COMMIT");
    const next = n + 1;
    const snapshotId = ins?.rows?.[0]?.id ? Number(ins.rows[0].id) : null;
    return { ok: true, limited: false, snapshotId, count: next, remaining: Math.max(0, limit - next) };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function listSessionSnapshots({ limit = 200, examPeriodId, sessionId } = {}) {
  const lim = Number(limit);
  const n = Number.isFinite(lim) && lim > 0 ? Math.min(2000, Math.round(lim)) : 200;
  const ep = examPeriodId === undefined || examPeriodId === null ? null : Number(examPeriodId);
  const sid = sessionId === undefined || sessionId === null ? null : Number(sessionId);

  const where = [];
  const params = [];
  if (Number.isFinite(ep) && ep > 0) { params.push(ep); where.push(`s.exam_period_id = $${params.length}`); }
  if (Number.isFinite(sid) && sid > 0) { params.push(sid); where.push(`ss.session_id = $${params.length}`); }
  params.push(n);
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const r = await q(
    `SELECT ss.id AS id,
            ss.session_id AS "sessionId",
            ss.token AS token,
            s.name AS "candidateName",
            s.exam_period_id AS "examPeriodId",
            s.submitted AS submitted,
            ss.reason AS reason,
            ss.remote_path AS "remotePath",
            (EXTRACT(EPOCH FROM ss.created_at) * 1000)::bigint AS "createdAtUtcMs"
     FROM public.session_snapshots ss
     JOIN public.sessions s ON s.id = ss.session_id
     ${w}
     ORDER BY ss.id DESC
     LIMIT $${params.length};`,
    params
  );
  return Array.isArray(r?.rows) ? r.rows : [];
}

async function getSessionSnapshotById(id) {
  const sid = Number(id);
  if (!Number.isFinite(sid) || sid <= 0) return null;
  const r = await q(
    `SELECT ss.id AS id,
            ss.session_id AS "sessionId",
            ss.token AS token,
            s.name AS "candidateName",
            s.exam_period_id AS "examPeriodId",
            s.submitted AS submitted,
            ss.reason AS reason,
            ss.remote_path AS "remotePath",
            (EXTRACT(EPOCH FROM ss.created_at) * 1000)::bigint AS "createdAtUtcMs"
     FROM public.session_snapshots ss
     JOIN public.sessions s ON s.id = ss.session_id
     WHERE ss.id = $1
     LIMIT 1;`,
    [sid]
  );
  return r?.rows?.[0] || null;
}

async function deleteSessionSnapshotById(id) {
  const sid = Number(id);
  if (!Number.isFinite(sid) || sid <= 0) return false;
  const r = await q(`DELETE FROM public.session_snapshots WHERE id = $1;`, [sid]);
  return Number(r?.rowCount || 0) > 0;
}

async function listSnapshotSessions({ limit = 5000, examPeriodId, submittedOnly } = {}) {
  const lim = Number(limit);
  const n = Number.isFinite(lim) && lim > 0 ? Math.min(20000, Math.round(lim)) : 5000;
  const ep = examPeriodId === undefined || examPeriodId === null ? null : Number(examPeriodId);
  const subOnly = submittedOnly === undefined || submittedOnly === null ? null : !!submittedOnly;

  const where = [];
  const params = [];
  if (Number.isFinite(ep) && ep > 0) { params.push(ep); where.push(`s.exam_period_id = $${params.length}`); }
  if (subOnly === true) { where.push(`s.submitted = TRUE`); }
  params.push(n);
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const r = await q(
    `SELECT s.id AS "sessionId",
            s.token AS token,
            s.name AS "candidateName",
            s.exam_period_id AS "examPeriodId",
            s.submitted AS submitted,
            COUNT(ss.id)::int AS "snapshotCount",
            COALESCE(MAX((EXTRACT(EPOCH FROM ss.created_at) * 1000)::bigint), 0)::bigint AS "latestSnapshotUtcMs"
     FROM public.sessions s
     LEFT JOIN public.session_snapshots ss ON ss.session_id = s.id
     ${w}
     GROUP BY s.id
     ORDER BY "latestSnapshotUtcMs" DESC, s.id DESC
     LIMIT $${params.length};`,
    params
  );
  return Array.isArray(r?.rows) ? r.rows : [];
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
    // Store a/b/c... (not the full option text) as requested.
    const letter = String.fromCharCode("a".charCodeAt(0) + idx);
    // If choices exist, bound-check to avoid meaningless letters.
    const max = Array.isArray(item.choices) ? item.choices.length : Infinity;
    if (idx >= max) return "";
    return letter;
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
  const payload = await getAdminTest(Number(s.exam_period_id) || 1);
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

async function submitAnswers(token, answers, clientMeta) {
  const s = await q1(
    `SELECT id, submitted, exam_period_id, COALESCE(disqualified, FALSE) AS disqualified
     FROM sessions
     WHERE token = $1
     ORDER BY id DESC
     LIMIT 1`,
    [token]
  );
  if (!s) return null;
  if (s.submitted) return { status: "submitted", disqualified: !!s.disqualified };

  const normAnswers = normalizeAnswers(answers);

  const reason = String(clientMeta?.reason || "").trim();
  const isDisqualified = /face_missing|tab_violation|disqual/i.test(reason);

  await q(
    `UPDATE sessions
     SET submitted = TRUE,
         disqualified = CASE WHEN $2::boolean THEN TRUE ELSE COALESCE(disqualified, FALSE) END
     WHERE id = $1`,
    [s.id, isDisqualified]
  );

  const payload = await getAdminTest(Number(s.exam_period_id) || 1);
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

  // Idempotent write (avoids race conditions if submit is triggered twice).
  await q(
    `INSERT INTO question_grades (session_id, token, q_writing, answers_json, created_at_utc_ms)
     VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT (session_id)
     DO UPDATE SET
       token = EXCLUDED.token,
       q_writing = EXCLUDED.q_writing,
       answers_json = EXCLUDED.answers_json,
       created_at_utc_ms = EXCLUDED.created_at_utc_ms`,
    [s.id, token, wVal, answersJson, Date.now()]
  );

  // If disqualified by proctoring, force grade to 0 and lock it server-side.
  if (isDisqualified) {
    await q(
      `UPDATE public.question_grades
       SET speaking_grade = 0,
           writing_grade = 0,
           total_grade = 0,
           created_at_utc_ms = $2
       WHERE session_id = $1`,
      [s.id, Date.now()]
    );
  }

  return { status: "submitted", disqualified: isDisqualified };
}

async function listCandidatesForExaminer({ examinerUsername } = {}) {
  const u = String(examinerUsername || "").trim();
  if (!u) return [];
  const r = await q(
    `SELECT
        s.id AS "sessionId",
        s.token,
        s.submitted,
        COALESCE(s.disqualified, FALSE) AS "disqualified",
        COALESCE(qg.q_writing, '') AS "qWriting",
        qg.speaking_grade AS "speakingGrade",
        qg.writing_grade AS "writingGrade",
        s.exam_period_id AS "examPeriodId",
        COALESCE(ep.name, CONCAT('Exam Period ', s.exam_period_id::text)) AS "examPeriodName"
     FROM public.sessions s
     JOIN public.examiner_assignments ea ON ea.session_id = s.id
     JOIN public.examiners ex ON ex.id = ea.examiner_id
     LEFT JOIN public.question_grades qg ON qg.session_id = s.id
     LEFT JOIN public.exam_periods ep ON ep.id = s.exam_period_id
     WHERE ex.username = $1
     ORDER BY s.id DESC
     LIMIT 15000`,
    [u]
  );
  return r.rows;
}

async function examinerCanAccessSession({ sessionId, examinerUsername }) {
  const sid = Number(sessionId);
  const u = String(examinerUsername || "").trim();
  if (!Number.isFinite(sid) || sid <= 0 || !u) return false;
  const r = await q(
    `SELECT 1
     FROM public.examiner_assignments ea
     JOIN public.examiners ex ON ex.id = ea.examiner_id
     WHERE ea.session_id = $1
       AND ex.username = $2
     LIMIT 1;`,
    [sid, u]
  );
  return !!(r.rows && r.rows.length);
}

async function listCandidates() {
  const r = await q(
    `SELECT s.id AS "sessionId", s.name AS "candidateName", s.token, s.submitted,
            s.exam_period_id AS "examPeriodId",
            qg.total_grade AS "totalGrade",
            COALESCE(s.disqualified, FALSE) AS "disqualified",
            COALESCE(ex.username, '') AS "assignedExaminer"
     FROM public.sessions s
     LEFT JOIN public.question_grades qg ON qg.session_id = s.id
     LEFT JOIN public.examiner_assignments ea ON ea.session_id = s.id
     LEFT JOIN public.examiners ex ON ex.id = ea.examiner_id
     ORDER BY s.id DESC
     LIMIT 15000`
  );
  return r.rows;
}

async function listSessionsMissingSpeakingSlot(examPeriodId) {
  const ep = Number(examPeriodId);
  if (!Number.isFinite(ep) || ep <= 0) throw new Error("Invalid exam period id");
  const r = await q(
    `SELECT s.id AS "sessionId",
            s.exam_period_id AS "examPeriodId"
     FROM public.sessions s
     LEFT JOIN public.speaking_slots os ON os.session_id = s.id
     WHERE s.exam_period_id = $1
       AND os.id IS NULL
     ORDER BY s.id ASC
     LIMIT 50000;`,
    [ep]
  );
  return (r.rows || []).map((row) => ({
    sessionId: Number(row.sessionId),
    examPeriodId: Number(row.examPeriodId),
  }));
}

async function getSessionScheduleDefaults(sessionId) {
  const sid = Number(sessionId);
  if (!Number.isFinite(sid) || sid <= 0) return null;

  const s = await q1(
    `SELECT s.id, s.name, s.exam_period_id
     FROM public.sessions s
     WHERE s.id = $1
     LIMIT 1;`,
    [sid]
  );
  if (!s) return null;

  const examinerUsername = await ensureSessionAssignedExaminer({
    sessionId: Number(s.id),
    examPeriodId: Number(s.exam_period_id),
  });

  return {
    sessionId: Number(s.id),
    candidateName: String(s.name || ""),
    examPeriodId: Number(s.exam_period_id || 0) || null,
    examinerUsername: String(examinerUsername || ""),
  };
}

// Delete a candidate completely (candidate row + all their sessions + grades)
// Identified via a session id (row in admin candidates table).
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

    const candidateId = sr.rows[0].candidate_id;

    if (candidateId) {
      // Delete grades for ALL sessions of this candidate
      await client.query(
        `DELETE FROM public.question_grades
         WHERE session_id IN (SELECT id FROM public.sessions WHERE candidate_id = $1)`,
        [candidateId]
      );
      // Delete speaking slots bound to this candidate sessions, and any orphaned rows by candidate_id.
      await client.query(
        `DELETE FROM public.speaking_slots
         WHERE session_id IN (SELECT id FROM public.sessions WHERE candidate_id = $1)
            OR candidate_id = $1`,
        [candidateId]
      );
      // Delete all sessions
      const sdel = await client.query(
        `DELETE FROM public.sessions WHERE candidate_id = $1`,
        [candidateId]
      );
      // Delete candidate
      await client.query(`DELETE FROM public.candidates WHERE id = $1`, [candidateId]);
      await client.query("COMMIT");
      return { ok: true, deleted: Number(sdel.rowCount || 0) };
    }

    // Fallback (older rows without candidate_id): delete only the session + its grades
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


function getConfig() {
  // Kept for backwards compatibility with the public /api/config endpoint.
  const p = getProctoringConfig();
  return {
    serverNow: Date.now(),
    proctoring: p,
  };
}

function normalizeAdminTest(test) {
  const p = test && typeof test === "object" ? test : {};
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

function defaultAdminTestFromConfig() {
  return getTestPayloadFull();
}

function coerceLegacyAdminTestToPayload(obj) {
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

  const base = defaultAdminTestFromConfig();
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
  const row = await q1(
    `SELECT payload_json AS payload_json
     FROM public.admin_tests_by_period
     WHERE exam_period_id = $1
     LIMIT 1;`,
    [id]
  );
  if (!row || !row.payload_json) return defaultAdminTestFromConfig();
  const coerced = coerceLegacyAdminTestToPayload(row.payload_json) || row.payload_json;
  const norm = normalizeAdminTest(coerced);
  if (!adminTestHasAnyRealItems(norm)) return defaultAdminTestFromConfig();
  return norm;
}

async function setAdminTest(examPeriodId = 1, test) {
  const ep = Number(examPeriodId);
  const id = Number.isFinite(ep) && ep > 0 ? ep : 1;
  const payload = normalizeAdminTest(test);
  const now = Date.now();
  await q(
    `INSERT INTO public.admin_tests_by_period (exam_period_id, payload_json, updated_at_utc_ms)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (exam_period_id) DO UPDATE SET
       payload_json = EXCLUDED.payload_json,
       updated_at_utc_ms = EXCLUDED.updated_at_utc_ms;`,
    [id, JSON.stringify(payload || {}), now]
  );
  return { ok: true, updatedAtUtcMs: now };
}

async function listExamPeriods() {
  const r = await q(
    `SELECT id, name,
            COALESCE(open_at_utc_ms, $1) AS open_at_utc_ms,
            COALESCE(duration_minutes, $2) AS duration_minutes
     FROM public.exam_periods
     ORDER BY id ASC;`,
    [DEFAULT_OPEN_AT_UTC_MS, DEFAULT_DURATION_MINUTES]
  );
  return r.rows.map(row => ({
    id: Number(row.id),
    name: row.name,
    openAtUtc: Number(row.open_at_utc_ms),
    durationMinutes: Number(row.duration_minutes),
  }));
}

function normalizeSpeakingSlotRow(row = {}) {
  let metadata = row.meeting_metadata_json;
  if (typeof metadata === "string") {
    try { metadata = JSON.parse(metadata); } catch { metadata = null; }
  }
  if (!metadata || typeof metadata !== "object") metadata = null;
  return {
    id: Number(row.id),
    examPeriodId: row.exam_period_id === null || row.exam_period_id === undefined ? null : Number(row.exam_period_id),
    sessionId: row.session_id === null || row.session_id === undefined ? null : Number(row.session_id),
    candidateId: row.candidate_id === null || row.candidate_id === undefined ? null : Number(row.candidate_id),
    candidateName: String(row.candidate_name || row.session_candidate_name || ""),
    sessionToken: String(row.session_token || ""),
    startUtcMs: Number(row.start_utc_ms),
    endUtcMs: Number(row.end_utc_ms),
    videoProvider: String(row.video_provider || "manual"),
    examinerUsername: String(row.examiner_username || row.assigned_examiner || ""),
    meetingId: String(row.meeting_id || ""),
    joinUrl: String(row.join_url || ""),
    startUrl: String(row.start_url || ""),
    meetingMetadata: metadata,
    status: String(row.status || "scheduled"),
    createdAtUtcMs: Number(row.created_at_utc_ms || 0),
    updatedAtUtcMs: Number(row.updated_at_utc_ms || 0),
  };
}

async function listExaminers() {
  const r = await q(
    `SELECT id, username
     FROM public.examiners
     ORDER BY id ASC;`
  );
  return (r.rows || []).map((row) => ({
    id: Number(row.id),
    username: String(row.username || ""),
  }));
}

async function listSpeakingSlots({ examPeriodId, examinerUsername, fromUtcMs, toUtcMs, limit } = {}) {
  const filters = [];
  const params = [];
  const ep = Number(examPeriodId);
  if (Number.isFinite(ep) && ep > 0) {
    params.push(ep);
    filters.push(`COALESCE(os.exam_period_id, s.exam_period_id) = $${params.length}`);
  }
  const examiner = String(examinerUsername || "").trim();
  if (examiner) {
    params.push(examiner);
    filters.push(`COALESCE(NULLIF(os.examiner_username, ''), ex.username, '') = $${params.length}`);
  }
  const from = Number(fromUtcMs);
  if (Number.isFinite(from) && from > 0) {
    params.push(from);
    filters.push(`os.end_utc_ms >= $${params.length}`);
  }
  const to = Number(toUtcMs);
  if (Number.isFinite(to) && to > 0) {
    params.push(to);
    filters.push(`os.start_utc_ms <= $${params.length}`);
  }
  const limRaw = Number(limit);
  const lim = Number.isFinite(limRaw) && limRaw > 0 ? Math.min(5000, Math.round(limRaw)) : 1500;
  params.push(lim);

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const r = await q(
    `SELECT
        os.*,
        s.name AS session_candidate_name,
        s.token AS session_token,
        s.exam_period_id AS session_exam_period_id,
        ea.examiner_id AS assignment_examiner_id,
        ex.username AS assigned_examiner
     FROM public.speaking_slots os
     LEFT JOIN public.sessions s ON s.id = os.session_id
     LEFT JOIN public.examiner_assignments ea ON ea.session_id = os.session_id
     LEFT JOIN public.examiners ex ON ex.id = ea.examiner_id
     ${where}
     ORDER BY os.start_utc_ms ASC, os.id ASC
     LIMIT $${params.length};`,
    params
  );
  return (r.rows || []).map(normalizeSpeakingSlotRow);
}

async function getSpeakingSlotById(id) {
  const slotId = Number(id);
  if (!Number.isFinite(slotId) || slotId <= 0) return null;
  const row = await q1(
    `SELECT
        os.*,
        s.name AS session_candidate_name,
        s.token AS session_token,
        s.exam_period_id AS session_exam_period_id,
        ea.examiner_id AS assignment_examiner_id,
        ex.username AS assigned_examiner
     FROM public.speaking_slots os
     LEFT JOIN public.sessions s ON s.id = os.session_id
     LEFT JOIN public.examiner_assignments ea ON ea.session_id = os.session_id
     LEFT JOIN public.examiners ex ON ex.id = ea.examiner_id
     WHERE os.id = $1
     LIMIT 1;`,
    [slotId]
  );
  return row ? normalizeSpeakingSlotRow(row) : null;
}

async function createSpeakingSlot(input = {}) {
  const now = Date.now();
  const sessionId = Number(input.sessionId);
  let session = null;
  if (Number.isFinite(sessionId) && sessionId > 0) {
    session = await q1(
      `SELECT s.id, s.exam_period_id, s.candidate_id, s.name
       FROM public.sessions s
       WHERE s.id = $1
       LIMIT 1;`,
      [sessionId]
    );
    if (!session) throw new Error("Session not found");
  }

  const providedStart = Number(input.startUtcMs);
  const providedEnd = Number(input.endUtcMs);
  const durationMinutes = SPEAKING_SLOT_DURATION_MINUTES;
  if (!Number.isFinite(providedStart) || providedStart <= 0) throw new Error("Invalid start time");
  const endUtcMs = Number.isFinite(providedEnd) && providedEnd > providedStart
    ? providedEnd
    : (Number.isFinite(durationMinutes) && durationMinutes > 0 ? providedStart + durationMinutes * 60 * 1000 : NaN);
  if (!Number.isFinite(endUtcMs) || endUtcMs <= providedStart) throw new Error("Invalid end time");

  const examPeriodIdRaw = Number(input.examPeriodId);
  const examPeriodId = Number.isFinite(examPeriodIdRaw) && examPeriodIdRaw > 0
    ? examPeriodIdRaw
    : Number(session?.exam_period_id || 0);
  const candidateId = session?.candidate_id ? Number(session.candidate_id) : null;
  const candidateName = session
    ? String(session.name || "").trim()
    : String(input.candidateName || "").trim();
  if (!candidateName) throw new Error("Candidate name is required");

  const videoProvider = String(input.videoProvider || "manual").trim().toLowerCase() || "manual";
  const status = String(input.status || "scheduled").trim().toLowerCase() || "scheduled";
  let examinerUsername = "";
  if (session) {
    examinerUsername = await ensureSessionAssignedExaminer({
      sessionId: Number(session.id),
      examPeriodId: Number(session.exam_period_id),
    });
  } else {
    examinerUsername = String(input.examinerUsername || "").trim();
  }

  if (examinerUsername) {
    const ex = await q1(`SELECT 1 FROM public.examiners WHERE username = $1 LIMIT 1;`, [examinerUsername]);
    if (!ex) throw new Error("Invalid examiner username");
  }

  let meetingMetadata = input.meetingMetadata;
  if (meetingMetadata && typeof meetingMetadata !== "object") {
    try { meetingMetadata = JSON.parse(String(meetingMetadata)); } catch { meetingMetadata = null; }
  }
  if (!meetingMetadata || typeof meetingMetadata !== "object") meetingMetadata = null;

  const meetingIdVal = String(input.meetingId || "").trim() || null;
  const joinUrlVal = String(input.joinUrl || "").trim() || null;
  const startUrlVal = String(input.startUrl || "").trim() || null;

  const r = await q(
    `INSERT INTO public.speaking_slots
      (exam_period_id, session_id, candidate_id, candidate_name, start_utc_ms, end_utc_ms, video_provider,
       examiner_username, meeting_id, join_url, start_url, meeting_metadata_json, status, created_at_utc_ms, updated_at_utc_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)
     RETURNING *;`,
    [
      Number.isFinite(examPeriodId) && examPeriodId > 0 ? examPeriodId : null,
      session ? Number(session.id) : null,
      Number.isFinite(candidateId) && candidateId > 0 ? candidateId : null,
      candidateName,
      providedStart,
      endUtcMs,
      videoProvider,
      examinerUsername || null,
      meetingIdVal,
      joinUrlVal,
      startUrlVal,
      meetingMetadata ? JSON.stringify(meetingMetadata) : null,
      status,
      now,
      now,
    ]
  );
  const createdId = Number(r.rows?.[0]?.id || 0);
  if (createdId > 0) {
    const full = await getSpeakingSlotById(createdId);
    if (full) return full;
  }
  return normalizeSpeakingSlotRow(r.rows[0]);
}

async function updateSpeakingSlot({ id, ...input } = {}) {
  const slotId = Number(id);
  if (!Number.isFinite(slotId) || slotId <= 0) throw new Error("Invalid slot id");
  const existing = await q1(`SELECT * FROM public.speaking_slots WHERE id = $1 LIMIT 1;`, [slotId]);
  if (!existing) return null;

  const next = {
    examPeriodId: existing.exam_period_id === null || existing.exam_period_id === undefined ? null : Number(existing.exam_period_id),
    sessionId: existing.session_id === null || existing.session_id === undefined ? null : Number(existing.session_id),
    candidateId: existing.candidate_id === null || existing.candidate_id === undefined ? null : Number(existing.candidate_id),
    candidateName: String(existing.candidate_name || ""),
    startUtcMs: Number(existing.start_utc_ms),
    endUtcMs: Number(existing.end_utc_ms),
    videoProvider: String(existing.video_provider || "manual"),
    examinerUsername: String(existing.examiner_username || ""),
    meetingId: String(existing.meeting_id || ""),
    joinUrl: String(existing.join_url || ""),
    startUrl: String(existing.start_url || ""),
    status: String(existing.status || "scheduled"),
    meetingMetadata: existing.meeting_metadata_json || null,
  };

  if (Object.prototype.hasOwnProperty.call(input, "sessionId")) {
    const sid = Number(input.sessionId);
    if (!Number.isFinite(sid) || sid <= 0) {
      next.sessionId = null;
      next.candidateId = null;
    } else {
      const s = await q1(
        `SELECT id, exam_period_id, candidate_id, name
         FROM public.sessions
         WHERE id = $1
         LIMIT 1;`,
        [sid]
      );
      if (!s) throw new Error("Session not found");
      next.sessionId = Number(s.id);
      next.candidateId = s.candidate_id === null || s.candidate_id === undefined ? null : Number(s.candidate_id);
      next.candidateName = String(s.name || next.candidateName);
      next.examinerUsername = await ensureSessionAssignedExaminer({
        sessionId: Number(s.id),
        examPeriodId: Number(s.exam_period_id),
      });
      if (!Object.prototype.hasOwnProperty.call(input, "examPeriodId")) {
        next.examPeriodId = Number(s.exam_period_id || next.examPeriodId || 0) || null;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, "examPeriodId")) {
    const ep = Number(input.examPeriodId);
    next.examPeriodId = Number.isFinite(ep) && ep > 0 ? ep : null;
  }
  if (Object.prototype.hasOwnProperty.call(input, "candidateName")) {
    const nm = String(input.candidateName || "").trim();
    if (!nm) throw new Error("Candidate name is required");
    next.candidateName = nm;
  }
  if (Object.prototype.hasOwnProperty.call(input, "startUtcMs")) {
    const v = Number(input.startUtcMs);
    if (!Number.isFinite(v) || v <= 0) throw new Error("Invalid start time");
    next.startUtcMs = v;
  }
  if (
    Object.prototype.hasOwnProperty.call(input, "startUtcMs") ||
    Object.prototype.hasOwnProperty.call(input, "endUtcMs") ||
    Object.prototype.hasOwnProperty.call(input, "durationMinutes")
  ) {
    next.endUtcMs = next.startUtcMs + SPEAKING_SLOT_DURATION_MINUTES * 60 * 1000;
  }
  if (!Number.isFinite(next.endUtcMs) || next.endUtcMs <= next.startUtcMs) throw new Error("Invalid end time");

  if (Object.prototype.hasOwnProperty.call(input, "videoProvider")) {
    next.videoProvider = String(input.videoProvider || "manual").trim().toLowerCase() || "manual";
  }
  if (Object.prototype.hasOwnProperty.call(input, "status")) {
    next.status = String(input.status || "scheduled").trim().toLowerCase() || "scheduled";
  }
  if (Object.prototype.hasOwnProperty.call(input, "examinerUsername")) {
    next.examinerUsername = String(input.examinerUsername || "").trim();
  }
  if (next.examinerUsername) {
    const ex = await q1(`SELECT 1 FROM public.examiners WHERE username = $1 LIMIT 1;`, [next.examinerUsername]);
    if (!ex) throw new Error("Invalid examiner username");
  }
  if (Object.prototype.hasOwnProperty.call(input, "meetingId")) next.meetingId = String(input.meetingId || "").trim();
  if (Object.prototype.hasOwnProperty.call(input, "joinUrl")) next.joinUrl = String(input.joinUrl || "").trim();
  if (Object.prototype.hasOwnProperty.call(input, "startUrl")) next.startUrl = String(input.startUrl || "").trim();

  if (Object.prototype.hasOwnProperty.call(input, "meetingMetadata")) {
    let mm = input.meetingMetadata;
    if (mm && typeof mm !== "object") {
      try { mm = JSON.parse(String(mm)); } catch { mm = null; }
    }
    next.meetingMetadata = mm && typeof mm === "object" ? mm : null;
  }

  const r = await q(
    `UPDATE public.speaking_slots
     SET exam_period_id = $2,
         session_id = $3,
         candidate_id = $4,
         candidate_name = $5,
         start_utc_ms = $6,
         end_utc_ms = $7,
         video_provider = $8,
         examiner_username = $9,
         meeting_id = $10,
         join_url = $11,
         start_url = $12,
         meeting_metadata_json = $13::jsonb,
         status = $14,
         updated_at_utc_ms = $15
     WHERE id = $1
     RETURNING *;`,
    [
      slotId,
      next.examPeriodId,
      next.sessionId,
      next.candidateId,
      next.candidateName,
      next.startUtcMs,
      next.endUtcMs,
      next.videoProvider,
      next.examinerUsername || null,
      next.meetingId || null,
      next.joinUrl || null,
      next.startUrl || null,
      next.meetingMetadata ? JSON.stringify(next.meetingMetadata) : null,
      next.status,
      Date.now(),
    ]
  );
  if (!r.rows.length) return null;
  const full = await getSpeakingSlotById(slotId);
  return full || normalizeSpeakingSlotRow(r.rows[0]);
}

async function deleteSpeakingSlot(id) {
  const slotId = Number(id);
  if (!Number.isFinite(slotId) || slotId <= 0) throw new Error("Invalid slot id");
  const r = await q(`DELETE FROM public.speaking_slots WHERE id = $1;`, [slotId]);
  return { ok: true, deleted: Number(r.rowCount || 0) };
}

async function getSpeakingJoinBySessionToken(token) {
  const tok = String(token || "").trim();
  if (!tok) return null;
  const now = Date.now();

  // Pick active slot first, then nearest upcoming slot, then latest past slot.
  const row = await q1(
    `SELECT
        os.*,
        s.token AS session_token,
        s.name AS session_candidate_name
     FROM public.speaking_slots os
     JOIN public.sessions s ON s.id = os.session_id
     WHERE s.token = $1
     ORDER BY
       CASE
         WHEN $2 BETWEEN os.start_utc_ms AND os.end_utc_ms THEN 0
         WHEN $2 < os.start_utc_ms THEN 1
         ELSE 2
       END ASC,
       CASE
         WHEN $2 < os.start_utc_ms THEN os.start_utc_ms - $2
         ELSE $2 - os.end_utc_ms
       END ASC,
       os.id DESC
     LIMIT 1;`,
    [tok, now]
  );
  if (!row) return null;
  return normalizeSpeakingSlotRow(row);
}

async function createExamPeriod({ id, name, openAtUtc, durationMinutes } = {}) {
  let newId = Number(id);
  if (!Number.isFinite(newId) || newId <= 0) {
    const r = await q(`SELECT COALESCE(MAX(id), 0) AS max_id FROM public.exam_periods;`);
    newId = Number(r.rows?.[0]?.max_id || 0) + 1;
  }
  const nm = String(name || `Exam Period ${newId}`).trim() || `Exam Period ${newId}`;
  const open = Number(openAtUtc);
  const dur = Math.round(Number(durationMinutes));
  const openVal = Number.isFinite(open) ? open : DEFAULT_OPEN_AT_UTC_MS;
  const durVal = Number.isFinite(dur) && dur > 0 ? dur : DEFAULT_DURATION_MINUTES;

  await q(
    `INSERT INTO public.exam_periods (id, name, open_at_utc_ms, duration_minutes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING;`,
    [newId, nm, openVal, durVal]
  );
  return { id: newId };
}

async function updateExamPeriod({ id, name, openAtUtc, durationMinutes }) {
  const ep = Number(id);
  if (!Number.isFinite(ep) || ep <= 0) throw new Error('Invalid exam period id');
  const nm = String(name || '').trim();
  const open = Number(openAtUtc);
  const dur = Math.round(Number(durationMinutes));
  if (!Number.isFinite(open) || open < 0) throw new Error('Invalid open time');
  if (!Number.isFinite(dur) || dur <= 0) throw new Error('Invalid duration');

  await q(
    `UPDATE public.exam_periods
     SET name = COALESCE(NULLIF($2, ''), name),
         open_at_utc_ms = $3,
         duration_minutes = $4
     WHERE id = $1;`,
    [ep, nm, open, dur]
  );
  return { ok: true };
}

async function deleteExamPeriod(id) {
  const ep = Number(id);
  if (!Number.isFinite(ep) || ep <= 0) throw new Error('Invalid exam period id');
  // Cascade delete sessions + question_grades for this period.
  await q(`DELETE FROM public.question_grades WHERE exam_period_id = $1;`, [ep]);
  await q(`DELETE FROM public.sessions WHERE exam_period_id = $1;`, [ep]);
  await q(`DELETE FROM public.exam_periods WHERE id = $1;`, [ep]);
  return { ok: true };
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

function makeListeningTicket() {
  return crypto.randomBytes(24).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function issueListeningTicket(token, { maxPlays = 1, ttlMs = 20 * 60 * 1000 } = {}) {
  const t = String(token || "").trim();
  if (!t) return null;
  const s = await q1(
    `SELECT id, submitted, exam_period_id
     FROM public.sessions
     WHERE token = $1
     ORDER BY id DESC
     LIMIT 1;`,
    [t]
  );
  if (!s) return null;
  if (!!s.submitted) return { ok: false, blocked: true, reason: "submitted" };

  const sid = Number(s.id);
  const now = Date.now();
  const ttl = Number(ttlMs);
  const ttlOk = Number.isFinite(ttl) && ttl > 5000 ? Math.min(60 * 60 * 1000, Math.round(ttl)) : 20 * 60 * 1000;
  const max = Number(maxPlays);
  const maxOk = Number.isFinite(max) && max > 0 ? Math.min(3, Math.round(max)) : 1;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const row = await client.query(
      `SELECT play_count::int AS play_count, ticket, ticket_expires_utc_ms::bigint AS expires
       FROM public.session_listening_access
       WHERE session_id = $1
       LIMIT 1;`,
      [sid]
    );
    const r0 = row.rows?.[0] || null;
    const playCount = Number(r0?.play_count || 0);
    const ticket = String(r0?.ticket || "");
    const expires = Number(r0?.expires || 0);

    if (ticket && Number.isFinite(expires) && expires > now + 5000) {
      await client.query("COMMIT");
      return { ok: true, ticket, expiresAtUtcMs: expires, playCount, maxPlays: maxOk, examPeriodId: Number(s.exam_period_id) || 1 };
    }
    if (playCount >= maxOk) {
      await client.query("COMMIT");
      return { ok: false, blocked: true, reason: "max_plays", playCount, maxPlays: maxOk };
    }

    const nextTicket = makeListeningTicket();
    const nextCount = playCount + 1;
    const nextExp = now + ttlOk;
    await client.query(
      `INSERT INTO public.session_listening_access (session_id, play_count, ticket, ticket_expires_utc_ms, updated_at_utc_ms)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (session_id) DO UPDATE
       SET play_count = EXCLUDED.play_count,
           ticket = EXCLUDED.ticket,
           ticket_expires_utc_ms = EXCLUDED.ticket_expires_utc_ms,
           updated_at_utc_ms = EXCLUDED.updated_at_utc_ms;`,
      [sid, nextCount, nextTicket, nextExp, now]
    );
    await client.query("COMMIT");
    return { ok: true, ticket: nextTicket, expiresAtUtcMs: nextExp, playCount: nextCount, maxPlays: maxOk, examPeriodId: Number(s.exam_period_id) || 1 };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function verifyListeningTicket(token, ticket) {
  const t = String(token || "").trim();
  const tk = String(ticket || "").trim();
  if (!t || !tk) return null;
  const r = await q(
    `SELECT s.id AS "sessionId", s.exam_period_id AS "examPeriodId", s.submitted AS submitted,
            a.ticket AS ticket, a.ticket_expires_utc_ms AS "expires"
     FROM public.sessions s
     LEFT JOIN public.session_listening_access a ON a.session_id = s.id
     WHERE s.token = $1
     ORDER BY s.id DESC
     LIMIT 1;`,
    [t]
  );
  const row = r.rows?.[0] || null;
  if (!row) return null;
  if (!!row.submitted) return { ok: false, blocked: true, reason: "submitted" };
  const exp = Number(row.expires || 0);
  if (!row.ticket || String(row.ticket) !== tk) return { ok: false, blocked: true, reason: "bad_ticket" };
  if (!Number.isFinite(exp) || exp <= Date.now()) return { ok: false, blocked: true, reason: "expired" };
  return { ok: true, sessionId: Number(row.sessionId), examPeriodId: Number(row.examPeriodId) || 1, expiresAtUtcMs: exp };
}

// updateAppConfig removed (app_config deprecated)



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

  // Compute objective score from all auto-gradable items.
  const payload = await getAdminTest(Number(s.exam_period_id) || 1);
  function norm(s){ return String(s || "").trim().toLowerCase(); }
  const ansObj = (qg && typeof qg.answers_json === "object" && qg.answers_json) || {};
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

async function deleteAllCoreData() {
  // Order and CASCADE keep this safe even if there are FKs.
  await q("BEGIN;");
  try {
    await q(
      "TRUNCATE public.examiner_assignments, public.question_grades, public.sessions, public.candidates RESTART IDENTITY CASCADE;"
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
  deleteAllCoreData,
};
