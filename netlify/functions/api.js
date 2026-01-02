// Netlify Function: unified API router (replaces server.js)
//
// Keep calls the same as before (frontend calls /api/*). Use redirects:
//   /api/*   /.netlify/functions/api/:splat   200
//   /health  /.netlify/functions/api/health   200

const hasPg = !!(
  process.env.NETLIFY_DATABASE_URL ||
  process.env.DATABASE_URL ||
  process.env.NETLIFY_DATABASE_URL_UNPOOLED
);

// Prefer Netlify DB driver (Neon) for any Postgres connection string.
const DB = hasPg ? require("../../src/db_neon") : require("../../src/db");
 


let initPromise = null;
async function ensureInit() {
  if (!initPromise) initPromise = DB.initDb();
  return initPromise;
}

function json(statusCode, obj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(obj),
  };
}

function text(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
    body: String(body ?? ""),
  };
}

function okCors(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    ...extra,
  };
}

function parseJsonBody(event) {
  if (!event.body) return null;
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
}

async function basicAuth(event) {
  const hdr = (event.headers?.authorization || event.headers?.Authorization || "").trim();
  if (!hdr.startsWith("Basic ")) return { ok: false };
  const b64 = hdr.slice(6);
  let raw = "";
  try {
    raw = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return { ok: false };
  }
  const idx = raw.indexOf(":");
  const user = idx >= 0 ? raw.slice(0, idx) : raw;
  const pass = idx >= 0 ? raw.slice(idx + 1) : "";
  const ok = await DB.verifyAdmin(user, pass);
  return { ok, user };
}

function gatePayload() {
  const cfg = DB.getConfig();
  const now = Number(cfg.serverNow || Date.now());
  const openAt = Number(cfg.openAtUtc || 0);
  const durMs = Number(cfg.durationSeconds || 0) * 1000;
  const endAt = openAt + durMs;
  return { now, openAt, durMs, endAt };
}

function requireGate() {
  const { now, openAt, durMs, endAt } = gatePayload();
  if (openAt && now < openAt) {
    return json(423, {
      error: "locked",
      serverNow: now,
      openAtUtc: openAt,
      endAtUtc: endAt,
    }, okCors());
  }
  if (openAt && durMs && now > endAt) {
    return json(410, {
      error: "expired",
      serverNow: now,
      openAtUtc: openAt,
      endAtUtc: endAt,
    }, okCors());
  }
  return null;
}

function normalizePath(event) {
  // When called via redirect: event.path looks like '/.netlify/functions/api/<rest>'
  // When called directly: same.
  const p = event.path || "/";
  const prefix = "/.netlify/functions/api";
  if (p.startsWith(prefix)) {
    const rest = p.slice(prefix.length);
    return rest.startsWith("/") ? rest : "/" + rest;
  }
  // Fallback: if someone hits the function without extra path
  return "/";
}

function isMatch(method, path, m, re) {
  return method === m && re.test(path);
}

exports.handler = async (event) => {
  // CORS preflight
  if ((event.httpMethod || "GET") === "OPTIONS") {
    return { statusCode: 204, headers: okCors(), body: "" };
  }

  try {
    await ensureInit();

    const method = event.httpMethod || "GET";
    const path = normalizePath(event);

    // Health (mapped from /health via redirects)
    if (method === "GET" && (path === "/health" || path === "/")) {
      return json(200, { ok: true, db: hasPg ? "postgres" : "sqlite" }, okCors());
    }

    // Public config
    if (method === "GET" && path === "/config") {
      return json(200, DB.getConfig(), okCors());
    }

    // Admin auth
    if (path.startsWith("/admin/")) {
      const a = await basicAuth(event);
      if (!a.ok) {
        return text(
          401,
          "Auth required",
          {
            ...okCors({ "www-authenticate": 'Basic realm="Admin"' }),
          }
        );
      }

      if (method === "GET" && path === "/admin/config") {
        return json(200, DB.getConfig(), okCors());
      }

      if (method === "POST" && path === "/admin/config") {
        const body = parseJsonBody(event) || {};
        const out = await DB.updateAppConfig({
          openAtUtc: Number(body.openAtUtc),
          durationSeconds: Number(body.durationSeconds),
        });
        return json(200, out, okCors());
      }

      if (method === "POST" && path === "/admin/create-session") {
        const body = parseJsonBody(event) || {};
        const created = await DB.createSession({
          candidateName: String(body.candidateName || "Candidate"),
        });
        const base = "https://onlytestingonly.netlify.app";
        return json(
          200,
          {
            token: created.token,
            sessionId: created.sessionId,
            url: `${base}/exam.html?token=${created.token}&sid=${created.sessionId}`,
          },
          okCors()
        );
      }

      if (method === "GET" && path === "/admin/results") {
        const rows = await DB.listResults();
        return json(200, rows, okCors());
      }

      if (method === "GET" && path === "/admin/candidates") {
        const rows = await DB.listCandidates();
        return json(200, rows, okCors());
      }

      return json(404, { error: "Not found" }, okCors());
    }

    // Exam gate for exam endpoints
    if (path.startsWith("/session/")) {
      const gate = requireGate();
      if (gate) return gate;

      // /session/:token
      const m1 = path.match(/^\/session\/([^/]+)$/);
      if (method === "GET" && m1) {
        const token = String(m1[1] || "");
        const data = await DB.getSessionForExam(token);
        if (!data) return json(404, { error: "Invalid or expired token" }, okCors());
        return json(200, data, okCors());
      }

      // /session/:token/start
      const m2 = path.match(/^\/session\/([^/]+)\/start$/);
      if (method === "POST" && m2) {
        const token = String(m2[1] || "");
        const out = await DB.startSession(token);
        if (!out) return json(404, { error: "Invalid or expired token" }, okCors());
        return json(200, out, okCors());
      }

      // /session/:token/presence
      const m3 = path.match(/^\/session\/([^/]+)\/presence$/);
      if (method === "POST" && m3) {
        const token = String(m3[1] || "");
        const body = parseJsonBody(event) || {};
        const out = await DB.presencePing(token, body.status || "unknown");
        return json(200, out, okCors());
      }

      // /session/:token/submit
      const m4 = path.match(/^\/session\/([^/]+)\/submit$/);
      if (method === "POST" && m4) {
        const token = String(m4[1] || "");
        const body = parseJsonBody(event) || {};
        const out = await DB.submitAnswers(token, body.answers || {}, body.clientMeta || null);
        if (!out) return json(404, { error: "Invalid or expired token" }, okCors());
        return json(200, out, okCors());
      }

      return json(404, { error: "Not found" }, okCors());
    }

    // Unknown
    return json(404, { error: "Not found" }, okCors());
  } catch (err) {
    return json(500, { error: String(err?.message || err) }, okCors());
  }
};