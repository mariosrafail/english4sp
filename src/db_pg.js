const { Pool } = require("pg");
const { hashPassword, verifyPassword } = require("./auth");
const { getTestPayloadFull, getTestPayloadForClient, OPEN_AT_UTC_MS: DEFAULT_OPEN_AT_UTC_MS, DURATION_MINUTES: DEFAULT_DURATION_MINUTES } = require("./test_config");

let pool = null;
// Exam periods now hold per-period configuration (open time + duration).

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
            s.exam_period_id,
            ep.open_at_utc_ms, ep.duration_minutes
     FROM public.sessions s
     LEFT JOIN public.exam_periods ep ON ep.id = s.exam_period_id
     LEFT JOIN public.question_grades qg ON qg.session_id = s.id
     WHERE s.token = $1
     LIMIT 1`,
    [token]
  );
  const s = r.rows[0];
  if (!s) return null;

  const openAtUtc = Number(s.open_at_utc_ms);
  const durationMinutes = Number(s.duration_minutes);

  return {
    session: {
      id: s.id,
      token: s.token,
      candidateName: s.name,
      submitted: !!s.submitted,
      disqualified: !!s.disqualified,
      grade: s.total_grade === null || s.total_grade === undefined ? null : Number(s.total_grade),
      examPeriodId: Number(s.exam_period_id) || 1,
      openAtUtc: Number.isFinite(openAtUtc) ? openAtUtc : DEFAULT_OPEN_AT_UTC_MS,
      durationMinutes: Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : DEFAULT_DURATION_MINUTES,
    },
    test: {
      id: 1,
      title: "English Test",
      payload: getTestPayloadForClient(),
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

async function submitAnswers(token, answers, clientMeta) {
  const s = await q1(
    `SELECT id, submitted, COALESCE(disqualified, FALSE) AS disqualified
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

  const payload = getTestPayloadFull();
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
        token,
        COALESCE(q_writing, '') AS "qWriting",
        COALESCE(answers_json, '{}'::jsonb) AS "answersJson",
        speaking_grade AS "speakingGrade",
        writing_grade AS "writingGrade",
        total_grade AS "totalGrade",
        created_at_utc_ms AS "createdAtUtcMs"
     FROM public.question_grades
     WHERE session_id = $1
     LIMIT 1;`,
    [sid]
  );
  return row || null;
}


function getConfig() {
  // Kept for backwards compatibility with the public /api/config endpoint.
  return {
    serverNow: Date.now(),
  };
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
  const payload = getTestPayloadFull();
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
  listCandidatesForExaminer,
  examinerCanAccessSession,
  setExaminerGrades,
  presencePing,
  getConfig,
  listExamPeriods,
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
