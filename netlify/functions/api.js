// netlify/functions/api.js
// Netlify Function router for /api/* (via redirects) AND direct /.netlify/functions/api/*
// Uses Netlify DB (Neon) via @netlify/neon

const { neon } = require("@netlify/neon");

function sqlClient() {
  // Prefer Netlify DB integration env var. Fallback to DATABASE_URL for non-Netlify setups.
  const url = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("Missing database url (NETLIFY_DATABASE_URL or DATABASE_URL).");
  return neon(url);
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
    body: JSON.stringify(obj),
  };
}

function safeJson(s) {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

// IMPORTANT: supports BOTH "/.netlify/functions/api/..." and "/api/..." (rewrite)
function normalizePath(event) {
  const p = event.path || "/";

  // Case A: direct function call
  const fnPrefix = "/.netlify/functions/api";
  if (p.startsWith(fnPrefix)) {
    const rest = p.slice(fnPrefix.length);
    return rest.startsWith("/") ? rest : "/" + rest;
  }

  // Case B: rewritten from /api/*
  const apiPrefix = "/api";
  if (p === apiPrefix) return "/"; // treat /api as health/root
  if (p.startsWith(apiPrefix + "/")) return p.slice(apiPrefix.length); // "/admin/config", "/session/..", etc

  return "/";
}

function baseUrlFromEvent(event) {
  const proto = (event.headers && (event.headers["x-forwarded-proto"] || event.headers["X-Forwarded-Proto"])) || "https";
  const host =
    (event.headers && (event.headers["x-forwarded-host"] || event.headers["X-Forwarded-Host"])) ||
    (event.headers && event.headers.host) ||
    "localhost";
  return `${proto}://${host}`;
}

async function ensureTables(sql) {
  // Minimal schema for your current flow: config + sessions + submissions
  await sql`
    CREATE TABLE IF NOT EXISTS exam_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      opens_at TIMESTAMPTZ,
      duration_seconds INTEGER NOT NULL DEFAULT 3600,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `;

  await sql`
    INSERT INTO exam_config (id, duration_seconds)
    VALUES (1, 3600)
    ON CONFLICT (id) DO NOTHING;
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS exam_sessions (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      candidate_name TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS exam_submissions (
      id SERIAL PRIMARY KEY,
      session_token TEXT NOT NULL,
      answers JSONB NOT NULL,
      grade NUMERIC,
      submitted_at TIMESTAMPTZ DEFAULT now(),
      CONSTRAINT fk_session
        FOREIGN KEY (session_token)
        REFERENCES exam_sessions(token)
        ON DELETE CASCADE
    );
  `;
}

function makeToken(len = 24) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const method = event.httpMethod;
  const path = normalizePath(event);

  try {
    const sql = sqlClient();
    await ensureTables(sql);

    // Health/root
    if (method === "GET" && (path === "/" || path === "")) {
      return json(200, { ok: true, db: "postgres", serverTime: Date.now() });
    }

    // GET /admin/config
    if (method === "GET" && path === "/admin/config") {
      const rows = await sql`SELECT opens_at, duration_seconds FROM exam_config WHERE id = 1;`;
      const cfg = rows && rows[0] ? rows[0] : { opens_at: null, duration_seconds: 3600 };
      return json(200, {
        ok: true,
        serverTime: Date.now(),
        opensAt: cfg.opens_at ? new Date(cfg.opens_at).toISOString() : null,
        durationSeconds: Number(cfg.duration_seconds || 3600),
      });
    }

    // POST /admin/config  { opensAt: ISO string or null, durationSeconds: number }
    if (method === "POST" && path === "/admin/config") {
      const body = safeJson(event.body);
      const opensAt = body.opensAt ? new Date(body.opensAt) : null;
      const durationSeconds = Number(body.durationSeconds || 3600);

      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return json(400, { ok: false, error: "Invalid durationSeconds" });
      }

      await sql`
        UPDATE exam_config
        SET opens_at = ${opensAt ? opensAt.toISOString() : null},
            duration_seconds = ${durationSeconds},
            updated_at = now()
        WHERE id = 1;
      `;

      return json(200, { ok: true, serverTime: Date.now() });
    }

    // POST /admin/create-session  { name: string }
    // Returns token + full exam URL on current host
    if (method === "POST" && path === "/admin/create-session") {
      const body = safeJson(event.body);
      const candidateName = (body.name || body.candidateName || "").toString().trim() || "Candidate";

      const token = makeToken(28);
      const inserted = await sql`
        INSERT INTO exam_sessions (token, candidate_name)
        VALUES (${token}, ${candidateName})
        RETURNING id;
      `;
      const sessionId = inserted && inserted[0] ? inserted[0].id : null;

      const base = baseUrlFromEvent(event);
      return json(200, {
        ok: true,
        token,
        sessionId,
        url: `${base}/exam.html?token=${encodeURIComponent(token)}&sid=${encodeURIComponent(sessionId || "")}`,
      });
    }

    // GET /session/:token  (optional helper for exam page)
    if (method === "GET" && path.startsWith("/session/")) {
      const token = decodeURIComponent(path.slice("/session/".length));
      if (!token) return json(400, { ok: false, error: "Missing token" });

      const rows = await sql`SELECT id, token, candidate_name, created_at FROM exam_sessions WHERE token = ${token};`;
      if (!rows || !rows[0]) return json(404, { ok: false, error: "Session not found" });

      const cfgRows = await sql`SELECT opens_at, duration_seconds FROM exam_config WHERE id = 1;`;
      const cfg = cfgRows && cfgRows[0] ? cfgRows[0] : { opens_at: null, duration_seconds: 3600 };

      return json(200, {
        ok: true,
        serverTime: Date.now(),
        session: rows[0],
        opensAt: cfg.opens_at ? new Date(cfg.opens_at).toISOString() : null,
        durationSeconds: Number(cfg.duration_seconds || 3600),
      });
    }

    // POST /submit  { token, answers, grade? }
    if (method === "POST" && path === "/submit") {
      const body = safeJson(event.body);
      const token = (body.token || "").toString();
      const answers = body.answers;

      if (!token) return json(400, { ok: false, error: "Missing token" });
      if (answers === undefined) return json(400, { ok: false, error: "Missing answers" });

      // Ensure session exists
      const s = await sql`SELECT token FROM exam_sessions WHERE token = ${token};`;
      if (!s || !s[0]) return json(404, { ok: false, error: "Session not found" });

      const grade = body.grade !== undefined ? Number(body.grade) : null;

      await sql`
        INSERT INTO exam_submissions (session_token, answers, grade)
        VALUES (${token}, ${answers}, ${Number.isFinite(grade) ? grade : null});
      `;

      return json(200, { ok: true });
    }

    return json(404, { ok: false, error: `Not found: ${method} ${path}` });
  } catch (e) {
    return json(500, { ok: false, error: String(e && e.message ? e.message : e) });
  }
};
