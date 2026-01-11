// server.js
require('dotenv').config();

const path = require("path");
const express = require("express");
const cors = require("cors");

// Ίδια επιλογή DB όπως τώρα: αν υπάρχει DATABASE_URL, πάει σε Postgres αλλιώς SQLite
const hasPg = !!(
  process.env.DATABASE_URL ||
  process.env.NETLIFY_DATABASE_URL_UNPOOLED ||
  process.env.NETLIFY_DATABASE_URL
);
const DB = hasPg ? require("./src/db_pg") : require("./src/db");

let initPromise = null;
async function ensureInit() {
  if (!initPromise) initPromise = DB.initDb();
  return initPromise;
}

function gatePayload() {
  const cfg = DB.getConfig();
  const now = Number(cfg.serverNow || Date.now());
  const openAt = Number(cfg.openAtUtc || 0);
  const durMs = Number(cfg.durationMinutes || 0) * 60 * 1000;
  const endAt = openAt + durMs;
  return { now, openAt, durMs, endAt };
}

function requireGate(res) {
  const { now, openAt, durMs, endAt } = gatePayload();
  if (openAt && now < openAt) {
    res.status(423).json({ error: "locked", serverNow: now, openAtUtc: openAt, endAtUtc: endAt });
    return true;
  }
  if (openAt && durMs && now > endAt) {
    res.status(410).json({ error: "expired", serverNow: now, openAtUtc: openAt, endAtUtc: endAt });
    return true;
  }
  return false;
}

async function basicAuth(req) {
  const hdr = (req.headers.authorization || "").trim();
  if (!hdr.startsWith("Basic ")) return { ok: false };
  let raw = "";
  try {
    raw = Buffer.from(hdr.slice(6), "base64").toString("utf8");
  } catch {
    return { ok: false };
  }
  const idx = raw.indexOf(":");
  const user = idx >= 0 ? raw.slice(0, idx) : raw;
  const pass = idx >= 0 ? raw.slice(idx + 1) : "";
  const ok = await DB.verifyAdmin(user, pass);
  return { ok, user };
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));

// Static UI
app.use(express.static(path.join(__dirname, "public")));

// Health
app.get("/health", async (req, res) => {
  await ensureInit();
  res.json({ ok: true, db: hasPg ? "postgres" : "sqlite" });
});

// Public config
app.get("/api/config", async (req, res) => {
  await ensureInit();
  res.json(DB.getConfig());
});

// Admin routes (Basic Auth)
app.get("/api/admin/config", async (req, res) => {
  await ensureInit();
  const a = await basicAuth(req);
  if (!a.ok) return res.status(401).set("WWW-Authenticate", 'Basic realm="Admin"').send("Auth required");
  res.json(DB.getConfig());
});

app.post("/api/admin/config", async (req, res) => {
  await ensureInit();
  const a = await basicAuth(req);
  if (!a.ok) return res.status(401).set("WWW-Authenticate", 'Basic realm="Admin"').send("Auth required");
  const out = await DB.updateAppConfig({
    openAtUtc: Number(req.body?.openAtUtc),
    durationMinutes: Number(req.body?.durationMinutes),
    // backward compatible
    durationSeconds: Number(req.body?.durationSeconds),
  });
  res.json(out);
});

app.post("/api/admin/create-session", async (req, res) => {
  await ensureInit();
  const a = await basicAuth(req);
  if (!a.ok) return res.status(401).set("WWW-Authenticate", 'Basic realm="Admin"').send("Auth required");
  const created = await DB.createSession({ candidateName: String(req.body?.candidateName || "Candidate") });

  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const base = `${proto}://${host}`;

  res.json({
    token: created.token,
    sessionId: created.sessionId,
    url: `${base}/exam.html?token=${created.token}&sid=${created.sessionId}`,
  });
});

app.get("/api/admin/results", async (req, res) => {
  await ensureInit();
  const a = await basicAuth(req);
  if (!a.ok) return res.status(401).set("WWW-Authenticate", 'Basic realm="Admin"').send("Auth required");
  res.json(await DB.listResults());
});

app.get("/api/admin/candidates", async (req, res) => {
  await ensureInit();
  const a = await basicAuth(req);
  if (!a.ok) return res.status(401).set("WWW-Authenticate", 'Basic realm="Admin"').send("Auth required");
  res.json(await DB.listCandidates());
});

// Exam routes (gated)
app.get("/api/session/:token", async (req, res) => {
  await ensureInit();
  if (requireGate(res)) return;
  const data = await DB.getSessionForExam(String(req.params.token || ""));
  if (!data) return res.status(404).json({ error: "Invalid or expired token" });
  res.json(data);
});

app.post("/api/session/:token/start", async (req, res) => {
  await ensureInit();
  if (requireGate(res)) return;
  const out = await DB.startSession(String(req.params.token || ""));
  if (!out) return res.status(404).json({ error: "Invalid or expired token" });
  res.json(out);
});

app.post("/api/session/:token/presence", async (req, res) => {
  await ensureInit();
  if (requireGate(res)) return;
  const out = await DB.presencePing(String(req.params.token || ""), req.body?.status || "unknown");
  res.json(out);
});

app.post("/api/session/:token/submit", async (req, res) => {
  await ensureInit();
  if (requireGate(res)) return;
  const out = await DB.submitAnswers(String(req.params.token || ""), req.body?.answers || {}, req.body?.clientMeta || null);
  if (!out) return res.status(404).json({ error: "Invalid or expired token" });
  res.json(out);
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`API+UI running on http://localhost:${port}`));
