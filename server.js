// server.js
require('dotenv').config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const https = require("https");
const http = require("http");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const Storage = require("./src/storage");
const Meetings = require("./src/meetings");
const registerAdminSpeakingRoutes = require("./src/routes/admin_speaking");
const registerAdminTestsRoutes = require("./src/routes/admin_tests");
const registerAdminFilesRoutes = require("./src/routes/admin_files");
const registerAdminCandidatesRoutes = require("./src/routes/admin_candidates");
const {
  createAdminToken,
  verifyAdminToken,
  setAuthCookie,
  clearAuthCookie,
  rateLimitLogin,
} = require("./src/admin_session");

const {
  createExaminerToken,
  setExaminerAuthCookie,
  clearExaminerAuthCookie,
  rateLimitExaminerLogin,
  getExaminerFromRequest,
} = require("./src/examiner_session");
const { getTestPayloadFull } = require("./src/test_config");

// ÎŠÎ´Î¹Î± ÎµÏ€Î¹Î»Î¿Î³Î® DB ÏŒÏ€Ï‰Ï‚ Ï„ÏŽÏÎ±: Î±Î½ Ï…Ï€Î¬ÏÏ‡ÎµÎ¹ DATABASE_URL, Ï€Î¬ÎµÎ¹ ÏƒÎµ Postgres Î±Î»Î»Î¹ÏŽÏ‚ SQLite
const hasPg = !!(
  process.env.DATABASE_URL ||
  process.env.NETLIFY_DATABASE_URL_UNPOOLED ||
  process.env.NETLIFY_DATABASE_URL
);
const DB = hasPg ? require("./src/db_pg") : require("./src/db");

function toAnswerText(item, raw) {
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
    const v = raw === true || raw === "true" || raw === "True" || raw === 1 || raw === "1";
    return v ? "true" : "false";
  }
  if (item.type === "short") return String(raw ?? "").trim();
  return "";
}

function parseAnswersJson(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const x = JSON.parse(String(raw));
    return x && typeof x === "object" ? x : {};
  } catch {
    return {};
  }
}

function buildReviewItems(payload, answersObj) {
  const items = [];
  let objectiveEarned = 0;
  let objectiveMax = 0;
  for (const sec of payload.sections || []) {
    for (const item of sec.items || []) {
      if (!item || !item.id || item.type === "info" || item.type === "drag-words") continue;
      const pts = Number(item.points || 0);
      const expected = toAnswerText(item, item.type === "short" ? item.correctText : (item.type === "tf" ? item.correct : item.correctIndex));
      const got = String(answersObj[item.id] ?? "").trim();
      const autoScorable = pts > 0 && !!expected;
      const isCorrect = autoScorable ? (got.toLowerCase() === expected.toLowerCase()) : null;
      const earned = autoScorable ? (isCorrect ? pts : 0) : null;
      if (autoScorable) {
        objectiveEarned += Number(earned || 0);
        objectiveMax += pts;
      }
      items.push({
        id: item.id,
        section: String(sec.title || sec.id || "Section"),
        prompt: String(item.prompt || ""),
        candidateAnswer: got,
        correctAnswer: expected,
        points: pts,
        earned,
        isCorrect,
      });
    }
  }
  return { items, objectiveEarned, objectiveMax };
}

let initPromise = null;
async function ensureInit() {
  if (!initPromise) initPromise = DB.initDb();
  return initPromise;
}

async function requireGateForToken(token, res) {
  const gate = await DB.getGateForToken(String(token || ""));
  if (!gate) {
    res.status(404).json({ error: "Invalid or expired token" });
    return true;
  }
  const { now, openAtUtc, endAtUtc, durMs } = gate;
  if (openAtUtc && now < openAtUtc) {
    // For write actions we keep the gate strict (client should show countdown instead).
    res.status(423).json({ error: "not_open_yet", serverNow: now, openAtUtc, endAtUtc });
    return true;
  }
  if (openAtUtc && durMs && now > endAtUtc) {
    res.status(410).json({ error: "expired", serverNow: now, openAtUtc, endAtUtc });
    return true;
  }
  return false;
}

function isProctoringAckRequired() {
  const raw = process.env.REQUIRE_PROCTORING_ACK;
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  const v = String(raw).trim().toLowerCase();
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return true;
}

function isPng(buffer) {
  if (!buffer || buffer.length < 8) return false;
  return (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
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

function getCookieAdmin(req) {
  const { getAdminFromRequest } = require("./src/admin_session");
  return getAdminFromRequest(req);
}

async function adminAuth(req, res) {
  // Prefer secure cookie auth, but also allow Basic Auth for API testing.
  const c = getCookieAdmin(req);
  if (c.ok) return { ok: true, user: c.user, method: "cookie" };
  const b = await basicAuth(req);
  if (b.ok) return { ok: true, user: b.user, method: "basic" };
  return { ok: false };
}

async function basicAuthExaminer(req) {
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
  const ok = await DB.verifyExaminer(user, pass);
  return { ok, user };
}

function examinerCookieAuth(req) {
  return getExaminerFromRequest(req);
}

async function examinerAuth(req, res) {
  const c = examinerCookieAuth(req);
  if (c.ok) return { ok: true, user: c.user, method: "cookie" };
  const b = await basicAuthExaminer(req);
  if (b.ok) return { ok: true, user: b.user, method: "basic" };
  return { ok: false };
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
const SPEAKING_DURATION_MINUTES = 60;
const ATHENS_TZ = "Europe/Athens";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// Listening audio can be larger than other uploads (mp3). Keep in memory, but allow a higher cap.
const uploadListeningAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function parseBoolEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return !!defaultValue;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return !!defaultValue;
}

function parseSnapshotMax() {
  const n = Number(process.env.SNAPSHOT_MAX || "10");
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 10;
}

function safeSlug(s, maxLen = 40) {
  const raw = String(s || "").trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "unknown").slice(0, Math.max(1, Number(maxLen) || 40));
}

function safeTitlePrefix(s, maxLen = 40) {
  const raw = String(s || "").trim().toUpperCase();
  const cleaned = raw.replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "SNAPSHOT").slice(0, Math.max(1, Number(maxLen) || 40));
}

function buildStampHhmmss_DDMM_YYYY(d) {
  const dt = d instanceof Date ? d : new Date();
  const HH = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  const ss = String(dt.getSeconds()).padStart(2, "0");
  const DD = String(dt.getDate()).padStart(2, "0");
  const MM = String(dt.getMonth() + 1).padStart(2, "0");
  const YYYY = String(dt.getFullYear());
  return `${HH}${mm}${ss}_${DD}${MM}_${YYYY}`;
}

function parseNextcloudPublicShareConfig() {
  const shareUrlRaw = String(process.env.NEXTCLOUD_SHARE_URL || "").trim();
  const password = String(process.env.NEXTCLOUD_SHARE_PASSWORD || "").trim();
  const baseDir = String(process.env.NEXTCLOUD_SNAPSHOTS_DIR || "snapshots").trim() || "snapshots";
  const enabled = parseBoolEnv("NEXTCLOUD_UPLOAD_ENABLED", false);

  let shareUrl = null;
  try { shareUrl = new URL(shareUrlRaw); } catch {}
  if (!enabled || !shareUrl) return { enabled: false };

  const origin = shareUrl.origin;
  const m = shareUrl.pathname.match(/\/s\/([^/]+)/i);
  const shareToken = m && m[1] ? String(m[1]) : "";
  if (!shareToken) return { enabled: false };

  const webdavBaseUrl = `${origin}/public.php/webdav/`;
  const auth = Buffer.from(`${shareToken}:${password}`, "utf8").toString("base64");
  const authHeader = `Basic ${auth}`;
  return { enabled: true, webdavBaseUrl, authHeader, baseDir };
}

function buildWebdavUrl(webdavBaseUrl, segments) {
  const u = new URL(webdavBaseUrl);
  let p = u.pathname || "/";
  if (!p.endsWith("/")) p += "/";
  const segs = (segments || []).map((s) => encodeURIComponent(String(s || "")));
  u.pathname = p + segs.join("/");
  return u.toString();
}

function webdavRequest(url, { method = "GET", headers = {}, body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + (u.search || ""),
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          resolve({
            status: Number(res.statusCode || 0),
            headers: res.headers || {},
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(new Error("timeout")); } catch {}
    });
    if (body) req.write(body);
    req.end();
  });
}

async function ensureWebdavDir(webdavBaseUrl, authHeader, segments) {
  const mk = async (segs) => {
    const url = buildWebdavUrl(webdavBaseUrl, segs);
    const r = await webdavRequest(url, { method: "MKCOL", headers: { Authorization: authHeader } });
    // 201 Created, 405 Method Not Allowed (already exists), 409 Conflict (missing parent)
    if ([201, 405].includes(r.status)) return true;
    if (r.status === 409) return false;
    // Some servers return 200 OK for existing dirs.
    if (r.status >= 200 && r.status < 300) return true;
    throw new Error(`webdav_mkcol_failed_${r.status}`);
  };

  const out = [];
  for (const s of segments || []) {
    out.push(s);
    // Try to create, if parent missing (409), retry after creating parent in next iterations.
    const ok = await mk(out);
    if (!ok) {
      // Parent missing: attempt again (should succeed in next loop if parent created),
      // but if it persists, it will throw next time.
      await mk(out);
    }
  }
}

async function putWebdavFile({ webdavBaseUrl, authHeader, remoteSegments, contentType, data }) {
  const url = buildWebdavUrl(webdavBaseUrl, remoteSegments);
  const r = await webdavRequest(url, {
    method: "PUT",
    headers: {
      Authorization: authHeader,
      "Content-Type": contentType || "application/octet-stream",
      "Content-Length": Buffer.byteLength(data || Buffer.alloc(0)),
    },
    body: data,
  });
  if (r.status >= 200 && r.status < 300) return { ok: true, url };
  throw new Error(`webdav_put_failed_${r.status}`);
}

async function deleteWebdavFile({ webdavBaseUrl, authHeader, remoteSegments }) {
  const url = buildWebdavUrl(webdavBaseUrl, remoteSegments);
  const r = await webdavRequest(url, { method: "DELETE", headers: { Authorization: authHeader } });
  // 204 No Content (deleted), 404 (not found)
  if ([204, 404].includes(r.status)) return { ok: true };
  if (r.status >= 200 && r.status < 300) return { ok: true };
  return { ok: false, status: r.status };
}

// Guard admin UI file (server-side). API routes are guarded per-endpoint below.
app.use(async (req, res, next) => {
  if (req.path !== "/admin.html" && req.path !== "/speaking-scheduling.html") return next();
  const a = await adminAuth(req, res);
  if (a.ok) return next();
  return res.redirect("/index.html");
});

// Guard examiner UI file (server-side).
app.use(async (req, res, next) => {
  if (req.path !== "/candidates2.html") return next();
  const a = await examinerAuth(req, res);
  if (a.ok) return next();
  return res.redirect("/examiners.html");
});

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

// Admin session (secure cookie)
app.post("/api/admin/login", async (req, res) => {
  await ensureInit();
  if (!rateLimitLogin(req, res)) return;

  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "").trim();
  if (!username || !password) return res.status(400).json({ error: "Missing credentials" });

  const ok = await DB.verifyAdmin(username, password);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = createAdminToken(username);
  setAuthCookie(req, res, token);
  res.json({ ok: true, user: username });
});

app.post("/api/admin/logout", async (req, res) => {
  clearAuthCookie(req, res);
  res.json({ ok: true });
});

app.get("/api/admin/me", async (req, res) => {
  const c = getCookieAdmin(req);
  if (!c.ok) return res.status(401).json({ error: "not_logged_in" });
  res.json({ ok: true, user: c.user, exp: c.exp });
});

// Examiner session (secure cookie)
app.post("/api/examiner/login", async (req, res) => {
  await ensureInit();
  if (!rateLimitExaminerLogin(req, res)) return;

  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "").trim();
  if (!username || !password) return res.status(400).json({ error: "Missing credentials" });

  const ok = await DB.verifyExaminer(username, password);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = createExaminerToken(username);
  setExaminerAuthCookie(req, res, token);
  res.json({ ok: true, user: username });
});

app.post("/api/examiner/logout", async (req, res) => {
  clearExaminerAuthCookie(req, res);
  res.json({ ok: true });
});

app.get("/api/examiner/me", async (req, res) => {
  const c = examinerCookieAuth(req);
  if (!c.ok) return res.status(401).json({ error: "not_logged_in" });
  res.json({ ok: true, user: c.user, exp: c.exp });
});

// Admin routes (cookie or Basic Auth)
app.get("/api/admin/exam-periods", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  res.json(await DB.listExamPeriods());
});

app.post("/api/admin/exam-periods", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  const out = await DB.createExamPeriod({
    id: req.body?.id,
    name: req.body?.name,
    openAtUtc: req.body?.openAtUtc,
    durationMinutes: req.body?.durationMinutes,
  });
  res.json(out);
});

app.put("/api/admin/exam-periods/:id", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  const out = await DB.updateExamPeriod({
    id: req.params.id,
    name: req.body?.name,
    openAtUtc: req.body?.openAtUtc,
    durationMinutes: req.body?.durationMinutes,
  });
  res.json(out);
});

app.delete("/api/admin/exam-periods/:id", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  const out = await DB.deleteExamPeriod(req.params.id);
  res.json(out);
});

function normalizeAdminTestPayload(test) {
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

function parseDropboxConfig() {
  const token = String(process.env.DROPBOX_ACCESS_TOKEN || "").trim();
  const baseDir = String(process.env.DROPBOX_LISTENING_DIR || "/eng4sp_listening").trim() || "/eng4sp_listening";
  return { enabled: !!token, token, baseDir };
}

function httpsJson(url, { method = "GET", headers = {}, body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + (u.search || ""),
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try { json = JSON.parse(buf.toString("utf8") || "null"); } catch {}
          resolve({ status: Number(res.statusCode || 0), json, body: buf, headers: res.headers || {} });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(new Error("timeout")); } catch {}
    });
    if (body) req.write(body);
    req.end();
  });
}

async function dropboxUploadMp3({ token, remotePath, data }) {
  const r = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: "https:",
        hostname: "content.dropboxapi.com",
        port: 443,
        path: "/2/files/upload",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({
            path: remotePath,
            mode: "overwrite",
            autorename: false,
            mute: true,
            strict_conflict: false,
          }),
          "Content-Length": Buffer.byteLength(data || Buffer.alloc(0)),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try { json = JSON.parse(buf.toString("utf8") || "null"); } catch {}
          resolve({ status: Number(res.statusCode || 0), json, body: buf });
        });
      }
    );
    req.on("error", reject);
    req.write(data || Buffer.alloc(0));
    req.end();
  });
  if (r.status >= 200 && r.status < 300) return r.json;
  const msg = r.json?.error_summary || `dropbox_upload_failed_${r.status}`;
  throw new Error(msg);
}

async function dropboxGetOrCreateSharedLink({ token, path }) {
  const base = "https://api.dropboxapi.com/2/sharing";
  const makeRawUrl = (url) => {
    try {
      const u = new URL(String(url || ""));
      u.searchParams.delete("dl");
      u.searchParams.set("raw", "1");
      return u.toString();
    } catch {
      return String(url || "");
    }
  };

  const create = await httpsJson(`${base}/create_shared_link_with_settings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (create.status >= 200 && create.status < 300 && create.json?.url) return makeRawUrl(create.json.url);

  const sum = String(create.json?.error_summary || "");
  if (sum.includes("shared_link_already_exists")) {
    const list = await httpsJson(`${base}/list_shared_links`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path, direct_only: true }),
    });
    const url = list.json?.links && list.json.links[0] ? String(list.json.links[0].url || "") : "";
    if (url) return makeRawUrl(url);
  }

  throw new Error("dropbox_shared_link_failed");
}

registerAdminTestsRoutes(app, {
  ensureInit,
  adminAuth,
  DB,
  Storage,
  uploadListeningAudio,
  multer,
  normalizeAdminTestPayload,
});

registerAdminFilesRoutes(app, {
  ensureInit,
  adminAuth,
  DB,
  Storage,
  streamFileWithRange,
});

registerAdminSpeakingRoutes(app, {
  ensureInit,
  adminAuth,
  DB,
  getPublicBase,
  createMeetingForSlot,
  speakingVideoProvider,
  SPEAKING_DURATION_MINUTES,
  autoGenerateSpeakingSlotsForExamPeriod,
});

registerAdminCandidatesRoutes(app, {
  ensureInit,
  adminAuth,
  DB,
  upload,
  XLSX,
  ExcelJS,
  getPublicBase,
  autoGenerateSpeakingSlotsForExamPeriod,
  ensureSpeakingSlotForSession,
  parseAnswersJson,
  buildReviewItems,
  getTestPayloadFull,
});

app.post("/api/admin/create-session", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  const created = await DB.createSession({ candidateName: String(req.body?.candidateName || "Candidate") });

  const base = getPublicBase(req);

  res.json({
    token: created.token,
    sessionId: created.sessionId,
    url: `${base}/exam.html?token=${created.token}&sid=${created.sessionId}`,
  });
});

function getPublicBase(req) {
  const forced = process.env.PUBLIC_BASE_URL || process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL;
  if (forced && String(forced).trim()) {
    return String(forced).trim().replace(/\/+$/, "");
  }
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function getTimeZoneParts(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(Number(utcMs) || Date.now()));
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function getTimeZoneOffsetMs(utcMs, timeZone) {
  const p = getTimeZoneParts(utcMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Number(utcMs);
}

function zonedDateTimeToUtcMs({ year, month, day, hour, minute, second = 0 }, timeZone) {
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const off1 = getTimeZoneOffsetMs(guessUtc, timeZone);
  let out = guessUtc - off1;
  const off2 = getTimeZoneOffsetMs(out, timeZone);
  if (off2 !== off1) out = guessUtc - off2;
  return out;
}

function daysInMonth(year, monthOneBased) {
  return new Date(Date.UTC(year, monthOneBased, 0)).getUTCDate();
}

function randomIntInclusive(min, max) {
  const lo = Math.ceil(Number(min));
  const hi = Math.floor(Number(max));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function buildRandomSpeakingStartUtcNextMonthAthens(usedStarts = new Set()) {
  const nowParts = getTimeZoneParts(Date.now(), ATHENS_TZ);
  let year = nowParts.year;
  let month = nowParts.month + 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }

  const maxDays = daysInMonth(year, month);
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const day = randomIntInclusive(1, maxDays);
    const hour = randomIntInclusive(8, 21);
    const minute = [0, 15, 30, 45][randomIntInclusive(0, 3)];
    const startUtcMs = zonedDateTimeToUtcMs(
      { year, month, day, hour, minute, second: 0 },
      ATHENS_TZ
    );
    if (!usedStarts.has(startUtcMs)) {
      usedStarts.add(startUtcMs);
      return startUtcMs;
    }
  }
  return null;
}

async function autoGenerateSpeakingSlotsForExamPeriod(examPeriodId, { maxErrors = 200 } = {}) {
  const ep = Number(examPeriodId);
  if (!Number.isFinite(ep) || ep <= 0) throw new Error("Invalid exam period id");
  if (!DB.listSessionsMissingSpeakingSlot || !DB.createSpeakingSlot) {
    throw new Error("Not supported on this database adapter");
  }
  const missing = await DB.listSessionsMissingSpeakingSlot(ep);
  const existing = DB.listSpeakingSlots
    ? await DB.listSpeakingSlots({ examPeriodId: ep, limit: 50000 })
    : [];
  const usedStarts = new Set(
    (Array.isArray(existing) ? existing : [])
      .map((x) => Number(x?.startUtcMs || 0))
      .filter((x) => Number.isFinite(x) && x > 0)
  );

  let created = 0;
  let failed = 0;
  const errors = [];
  for (const row of missing || []) {
    const sessionId = Number(row?.sessionId || 0);
    if (!Number.isFinite(sessionId) || sessionId <= 0) continue;
    const startUtcMs = buildRandomSpeakingStartUtcNextMonthAthens(usedStarts);
    if (!Number.isFinite(startUtcMs) || startUtcMs <= 0) {
      failed += 1;
      errors.push({ sessionId, error: "no_random_slot_available" });
      continue;
    }

    let slot = null;
    try {
      slot = await DB.createSpeakingSlot({
        examPeriodId: ep,
        sessionId,
        startUtcMs,
        durationMinutes: SPEAKING_DURATION_MINUTES,
        videoProvider: speakingVideoProvider(),
      });

      const z = await createMeetingForSlot(slot);
      const updated = await DB.updateSpeakingSlot({
        id: Number(slot.id),
        meetingId: z.meetingId,
        joinUrl: z.joinUrl,
        startUrl: z.startUrl,
        meetingMetadata: z.metadata,
      });
      if (updated) slot = updated;
      created += 1;
    } catch (err) {
      failed += 1;
      errors.push({ sessionId, error: String(err?.message || "unknown_error") });
    }
  }

  return {
    ok: true,
    examPeriodId: ep,
    requested: Array.isArray(missing) ? missing.length : 0,
    created,
    failed,
    errors: errors.slice(0, Math.max(1, Number(maxErrors) || 200)),
  };
}

async function ensureSpeakingSlotForSession(session, examPeriodId) {
  const sid = Number(session?.sessionId || session?.id || 0);
  const ep = Number(examPeriodId || session?.examPeriodId || 0);
  if (!Number.isFinite(sid) || sid <= 0) {
    return { ok: false, skipped: true, reason: "invalid_session_id" };
  }
  if (!Number.isFinite(ep) || ep <= 0) {
    return { ok: false, skipped: true, reason: "invalid_exam_period_id" };
  }
  if (!DB.createSpeakingSlot || !DB.updateSpeakingSlot || !DB.listSpeakingSlots) {
    return { ok: false, skipped: true, reason: "db_adapter_not_supported" };
  }

  const existing = await DB.listSpeakingSlots({ examPeriodId: ep, limit: 50000 });
  const rows = Array.isArray(existing) ? existing : [];
  const existingSlot = rows.find((x) => Number(x?.sessionId || 0) === sid);
  if (existingSlot && String(existingSlot?.joinUrl || "").trim()) {
    return { ok: true, created: false, slot: existingSlot };
  }

  const usedStarts = new Set(
    rows
      .map((x) => Number(x?.startUtcMs || 0))
      .filter((x) => Number.isFinite(x) && x > 0)
  );
  const startUtcMs = buildRandomSpeakingStartUtcNextMonthAthens(usedStarts);
  if (!Number.isFinite(startUtcMs) || startUtcMs <= 0) {
    return { ok: false, skipped: true, reason: "no_random_slot_available" };
  }

  let slot = existingSlot || null;
  let createdNow = false;
  try {
    if (!slot) {
      slot = await DB.createSpeakingSlot({
        examPeriodId: ep,
        sessionId: sid,
        startUtcMs,
        durationMinutes: SPEAKING_DURATION_MINUTES,
        videoProvider: speakingVideoProvider(),
      });
      createdNow = true;
    }

    if (!String(slot?.joinUrl || "").trim()) {
      const z = await createMeetingForSlot(slot);
      const updated = await DB.updateSpeakingSlot({
        id: Number(slot.id),
        meetingId: z.meetingId,
        joinUrl: z.joinUrl,
        startUrl: z.startUrl,
        meetingMetadata: z.metadata,
      });
      if (updated) slot = updated;
    }

    return { ok: true, created: createdNow, slot };
  } catch (err) {
    return {
      ok: false,
      created: createdNow,
      slot: slot || null,
      error: String(err?.message || "speaking_slot_create_failed"),
    };
  }
}

async function ensureSpeakingLinksOnStartup() {
  try {
    await ensureInit();
    if (!DB.listExamPeriods || !DB.listSessionsMissingSpeakingSlot || !DB.createSpeakingSlot) return;

    const periods = await DB.listExamPeriods();
    const list = Array.isArray(periods) ? periods : [];
    let totalCreated = 0;
    let totalFailed = 0;

    for (const p of list) {
      const ep = Number(p?.id || 0);
      if (!Number.isFinite(ep) || ep <= 0) continue;
      const out = await autoGenerateSpeakingSlotsForExamPeriod(ep, { maxErrors: 20 });
      totalCreated += Number(out?.created || 0);
      totalFailed += Number(out?.failed || 0);
      if (Number(out?.created || 0) > 0 || Number(out?.failed || 0) > 0) {
        console.log(`[speaking-startup] examPeriod=${ep} created=${out.created} failed=${out.failed}`);
      }
    }
    console.log(`[speaking-startup] complete created=${totalCreated} failed=${totalFailed}`);
  } catch (e) {
    console.error("[speaking-startup] error:", e?.message || e);
  }
}

function speakingVideoProvider() { return Meetings.speakingVideoProvider(); }

function normalizeRoomName(raw) { return Meetings.normalizeRoomName(raw); }
function normalizeParticipantName(raw) { return Meetings.normalizeParticipantName(raw); }

async function createMeetingForSlot(slot) {
  return Meetings.createMeetingForSlot(slot, { defaultDurationMinutes: SPEAKING_DURATION_MINUTES });
}

// Examiner routes (cookie or Basic Auth)
app.get("/api/examiner/candidates", async (req, res) => {
  await ensureInit();
  const a = await examinerAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  res.json(await DB.listCandidatesForExaminer({ examinerUsername: a.user }));
});

app.get("/api/examiner/exam-periods", async (req, res) => {
  await ensureInit();
  const a = await examinerAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  res.json(await DB.listExamPeriods());
});

app.get("/api/examiner/speaking-slots", async (req, res) => {
  await ensureInit();
  const a = await examinerAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  if (!DB.listSpeakingSlots) return res.json([]);
  const examPeriodId = req.query?.examPeriodId;
  const fromUtcMs = req.query?.fromUtcMs;
  const toUtcMs = req.query?.toUtcMs;
  const limit = req.query?.limit;
  const out = await DB.listSpeakingSlots({
    examPeriodId: examPeriodId === undefined ? undefined : Number(examPeriodId),
    fromUtcMs: fromUtcMs === undefined ? undefined : Number(fromUtcMs),
    toUtcMs: toUtcMs === undefined ? undefined : Number(toUtcMs),
    limit: limit === undefined ? undefined : Number(limit),
    examinerUsername: a.user,
  });
  const base = getPublicBase(req);
  const rows = (Array.isArray(out) ? out : []).map((r) => {
    const tok = String(r?.sessionToken || "").trim();
    return {
      ...r,
      speakingUrl: tok ? `${base}/speaking.html?token=${encodeURIComponent(tok)}` : "",
    };
  });
  res.json(rows);
});

app.post("/api/examiner/export-excel", async (req, res) => {
  await ensureInit();
  const a = await examinerAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

  const rowsIn = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rowsIn.length) return res.status(400).json({ error: "No rows to export" });
  if (rowsIn.length > 20000) return res.status(400).json({ error: "Too many rows to export" });

  function softWrapText(text, maxCharsPerLine = 70) {
    const src = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const outLines = [];
    for (const rawLine of src.split("\n")) {
      const line = String(rawLine || "");
      if (line.length <= maxCharsPerLine) {
        outLines.push(line);
        continue;
      }
      const words = line.split(/\s+/).filter(Boolean);
      if (!words.length) {
        outLines.push("");
        continue;
      }
      let cur = "";
      for (const w of words) {
        if (!cur) {
          cur = w;
          continue;
        }
        if ((cur + " " + w).length <= maxCharsPerLine) cur += " " + w;
        else {
          outLines.push(cur);
          cur = w;
        }
      }
      if (cur) outLines.push(cur);
    }
    // Use CRLF so desktop Excel recognizes explicit line breaks immediately.
    return outLines.join("\r\n");
  }

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet("candidates");
  ws.columns = [
    { header: "Candidate Code", key: "candidateCode", width: 16 },
    { header: "Writing", key: "writing", width: 95 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  for (const r of rowsIn) {
    const text = softWrapText(r.qWriting || "", 90);
    const row = ws.addRow({
      candidateCode: String(r.candidateCode || ""),
      writing: String(text || ""),
    });
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
    const logicalLines = String(text || "")
      .split(/\r?\n/)
      .reduce((sum, line) => sum + Math.max(1, Math.ceil(String(line || "").length / 90)), 0);
    row.height = Math.min(220, Math.max(20, logicalLines * 15));
  }

  const out = await workbook.xlsx.writeBuffer();
  const buf = Buffer.from(out);

  const labelRaw = String(req.body?.label || "ALL").trim().replace(/[^A-Za-z0-9._-]/g, "_");
  const label = labelRaw || "ALL";
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const filename = `candidates_${label}_${ts}.xlsx`;

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buf);
});

app.post("/api/examiner/sessions/:id/finalize-grade", async (req, res) => {
  await ensureInit();
  const a = await examinerAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

  const sessionId = Number(req.params.id);
  if (DB.examinerCanAccessSession) {
    const allowed = await DB.examinerCanAccessSession({ sessionId, examinerUsername: a.user });
    if (!allowed) return res.status(403).json({ error: "Forbidden" });
  }
  const speakingGrade = req.body?.speaking_grade;
  const writingGrade = req.body?.writing_grade;

  const out = await DB.setExaminerGrades({ sessionId, speakingGrade, writingGrade });
  if (!out) return res.status(404).json({ error: "Session not found" });
  res.json(out);
});

// Public speaking gate endpoint (token-based countdown -> redirect URL).
app.get("/api/speaking/:token", async (req, res) => {
  await ensureInit();
  const token = String(req.params.token || "").trim();
  if (!token) return res.status(400).json({ error: "Missing token" });
  if (!DB.getSpeakingJoinBySessionToken) {
    return res.status(501).json({ error: "Speaking gate endpoint unavailable for this DB adapter" });
  }

  const slot = await DB.getSpeakingJoinBySessionToken(token);
  if (!slot) return res.status(404).json({ error: "No speaking slot found for this token" });

  const now = Date.now();
  const startUtcMs = Number(slot.startUtcMs || 0);
  const endUtcMs = Number(slot.endUtcMs || 0);
  const out = {
    status: "countdown",
    serverNow: now,
    startUtcMs,
    endUtcMs,
    candidateName: String(slot.candidateName || ""),
    sessionToken: String(slot.sessionToken || token),
  };

  if (Number.isFinite(startUtcMs) && Number.isFinite(endUtcMs)) {
    if (now < startUtcMs) return res.json(out);
    if (now > endUtcMs) return res.json({ ...out, status: "ended" });
    return res.json({
      ...out,
      status: "open",
      redirectUrl: String(slot.joinUrl || "").trim(),
    });
  }

  return res.json(out);
});

app.post("/api/meeting/livekit-token", async (req, res) => {
  try {
    const room = normalizeRoomName(req.body?.room);
    const name = normalizeParticipantName(req.body?.name || req.body?.displayName || "Guest");
    if (!room) return res.status(400).json({ error: "invalid_room" });
    if (!/^eng4-/i.test(room)) return res.status(400).json({ error: "invalid_room_prefix" });

    await Meetings.ensureLivekitRoomAndCapacity(room);
    const out = await Meetings.createLivekitJoinToken(room, name);
    return res.json({
      ok: true,
      room,
      maxParticipants: 2,
      wsUrl: out.wsUrl,
      token: out.token,
      identity: out.identity,
      name: out.name,
    });
  } catch (e) {
    const msg = String(e?.message || "livekit_token_failed");
    if (msg === "room_full") return res.status(409).json({ error: "room_full", message: "This call is already full (max 2)." });
    if (msg === "livekit_not_configured" || msg === "livekit_sdk_missing") {
      return res.status(503).json({ error: msg });
    }
    return res.status(500).json({ error: "livekit_token_failed", message: msg });
  }
});


// Exam routes (gated)
app.get("/api/session/:token", async (req, res) => {
  await ensureInit();
  // For candidate page we never return "locked" just because the exam is in the future.
  // Instead we return a status the client can use to show a countdown in the user's local time.
  const gate = await DB.getGateForToken(String(req.params.token || ""));
  if (!gate) return res.status(404).json({ error: "Invalid or expired token" });

  const { now, openAtUtc, endAtUtc } = gate;
  if (openAtUtc && now < openAtUtc) {
    return res.json({ status: "countdown", serverNow: now, openAtUtc, endAtUtc });
  }
  if (openAtUtc && endAtUtc && now > endAtUtc) {
    return res.json({ status: "ended", serverNow: now, openAtUtc, endAtUtc });
  }

  const data = await DB.getSessionForExam(String(req.params.token || ""));
  if (!data) return res.status(404).json({ error: "Invalid or expired token" });
  res.json({ status: "running", ...data, serverNow: now, openAtUtc, endAtUtc });
});

app.post("/api/session/:token/proctoring-ack", async (req, res) => {
  await ensureInit();
  if (await requireGateForToken(req.params.token, res)) return;
  if (!DB.recordProctoringAck) return res.status(501).json({ error: "Not supported on this database adapter" });

  const noticeVersion = String(req.body?.noticeVersion || "").trim();
  const out = await DB.recordProctoringAck(String(req.params.token || ""), { noticeVersion });
  if (!out) return res.status(404).json({ error: "Invalid or expired token" });
  res.json(out);
});

app.post("/api/session/:token/snapshot", upload.single("image"), async (req, res) => {
  try {
    await ensureInit();
    if (await requireGateForToken(req.params.token, res)) return;
    if (!DB.addSessionSnapshot) return res.status(501).json({ error: "Not supported on this database adapter" });

    const t = String(req.params.token || "").trim();
    if (!t) return res.status(400).json({ error: "missing_token" });

    const reason = String(req.body?.reason || "unknown").trim() || "unknown";
    const max = parseSnapshotMax();

    const file = req.file;
    const buf = file && file.buffer ? Buffer.from(file.buffer) : null;
    if (!buf || !buf.length) return res.status(400).json({ error: "missing_image" });
    if (!isPng(buf)) return res.status(400).json({ error: "only_png_supported" });

    const titlePrefix = safeTitlePrefix(String(req.body?.titlePrefix || ""), 32);
    const stampRaw = String(req.body?.stamp || "").trim();
    const stamp = /^\d{6}_\d{4}_\d{4}$/.test(stampRaw) ? stampRaw : buildStampHhmmss_DDMM_YYYY(new Date());
    const fname = `${titlePrefix}_${stamp}.png`;
    const remotePath = `snapshots/${t}/${fname}`;
    const storedReason = `${titlePrefix}:${reason}`;
    const meta = await DB.addSessionSnapshot(t, { reason: storedReason, remotePath, max });
    if (!meta) {
      return res.status(404).json({ error: "Invalid or expired token" });
    }
    if (!meta.ok && meta.limited) {
      return res.status(429).json({ error: "snapshot_limit_reached", count: meta.count, remaining: meta.remaining });
    }

    try {
      await Storage.writeFile(remotePath, buf);
    } catch (e) {
      // Best-effort rollback if the file write fails.
      try {
        if (DB.deleteSessionSnapshotById && meta.snapshotId) await DB.deleteSessionSnapshotById(Number(meta.snapshotId));
      } catch {}
      throw e;
    }

    console.log("snapshot_stored", { token: t, reason, remotePath, count: meta.count });
    res.json({ ok: true, remotePath, snapshotId: meta.snapshotId ?? null, count: meta.count, remaining: meta.remaining });
  } catch (e) {
    console.error("snapshot_upload_error", e);
    res.status(500).json({ error: "snapshot_upload_failed", message: String(e?.message || e) });
  }
});

function streamFileWithRange(req, res, absPath, { contentType = "application/octet-stream", downloadName = "" } = {}) {
  const stat = fs.statSync(absPath);
  const size = Number(stat.size || 0);
  res.setHeader("Accept-Ranges", "bytes");
  if (downloadName) {
    res.setHeader("Content-Disposition", `inline; filename="${String(downloadName).replace(/\"/g, "")}"`);
  }
  res.setHeader("Content-Type", contentType);

  const range = String(req.headers.range || "").trim();
  if (!range || !/^bytes=/.test(range)) {
    res.setHeader("Content-Length", String(size));
    fs.createReadStream(absPath).pipe(res);
    return;
  }

  const m = range.match(/bytes=(\d*)-(\d*)/);
  const start = m && m[1] ? Number(m[1]) : 0;
  const endRaw = m && m[2] ? Number(m[2]) : (size - 1);
  const end = Number.isFinite(endRaw) ? Math.min(endRaw, size - 1) : (size - 1);
  if (!Number.isFinite(start) || start < 0 || start >= size || end < start) {
    res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
    return;
  }
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  res.setHeader("Content-Length", String(end - start + 1));
  fs.createReadStream(absPath, { start, end }).pipe(res);
}

app.get("/api/session/:token/listening-audio", async (req, res) => {
  try {
    await ensureInit();
    if (await requireGateForToken(req.params.token, res)) return;
    const ticket = String(req.query?.ticket || "").trim();
    if (!DB.verifyListeningTicket) return res.status(501).json({ error: "Not supported on this database adapter" });
    const ver = await DB.verifyListeningTicket(String(req.params.token || ""), ticket);
    if (!ver) return res.status(404).json({ error: "Invalid or expired token" });
    if (!ver.ok) return res.status(403).json({ error: "listening_denied", reason: ver.reason || "denied" });
    const examPeriodId = Number(ver.examPeriodId || 1);
    const rel = `listening/ep_${examPeriodId}/listening.mp3`;
    const st = await Storage.statFile(rel);
    if (!st.exists) return res.status(404).json({ error: "missing_listening_audio" });
    res.setHeader("Cache-Control", "no-store");
    streamFileWithRange(req, res, st.absPath, { contentType: "audio/mpeg", downloadName: "listening.mp3" });
  } catch (e) {
    console.error("listening_audio_stream_error", e);
    res.status(500).json({ error: "stream_failed" });
  }
});

app.post("/api/session/:token/listening-ticket", async (req, res) => {
  try {
    await ensureInit();
    if (await requireGateForToken(req.params.token, res)) return;
    if (isProctoringAckRequired() && DB.hasProctoringAck) {
      const ok = await DB.hasProctoringAck(String(req.params.token || ""));
      if (!ok) return res.status(412).json({ error: "proctoring_ack_required" });
    }
    if (!DB.issueListeningTicket) return res.status(501).json({ error: "Not supported on this database adapter" });

    // Always enforce play-once server-side.
    const maxPlays = 1;
    const ttlMs = 25 * 60 * 1000;
    const out = await DB.issueListeningTicket(String(req.params.token || ""), { maxPlays, ttlMs });
    if (!out) return res.status(404).json({ error: "Invalid or expired token" });
    if (!out.ok) return res.status(403).json({ error: "listening_denied", reason: out.reason || "denied", playCount: out.playCount ?? null, maxPlays: out.maxPlays ?? maxPlays });

    const url = `/api/session/${encodeURIComponent(String(req.params.token || ""))}/listening-audio?ticket=${encodeURIComponent(String(out.ticket || ""))}`;
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, url, expiresAtUtcMs: out.expiresAtUtcMs ?? null, playCount: out.playCount ?? null, maxPlays: out.maxPlays ?? maxPlays });
  } catch (e) {
    console.error("listening_ticket_error", e);
    res.status(500).json({ error: "ticket_failed" });
  }
});

app.post("/api/session/:token/start", async (req, res) => {
  await ensureInit();
  if (await requireGateForToken(req.params.token, res)) return;
  if (isProctoringAckRequired() && DB.hasProctoringAck) {
    const ok = await DB.hasProctoringAck(String(req.params.token || ""));
    if (!ok) return res.status(412).json({ error: "proctoring_ack_required" });
  }
  const out = await DB.startSession(String(req.params.token || ""));
  if (!out) return res.status(404).json({ error: "Invalid or expired token" });
  res.json(out);
});

app.post("/api/session/:token/presence", async (req, res) => {
  await ensureInit();
  if (await requireGateForToken(req.params.token, res)) return;
  const out = await DB.presencePing(String(req.params.token || ""), req.body?.status || "unknown");
  res.json(out);
});

app.post("/api/session/:token/submit", async (req, res) => {
  try {
    await ensureInit();
    if (await requireGateForToken(req.params.token, res)) return;
    const out = await DB.submitAnswers(
      String(req.params.token || ""),
      req.body?.answers || {},
      req.body?.clientMeta || null
    );
    if (!out) return res.status(404).json({ error: "Invalid or expired token" });
    res.json(out);
  } catch (e) {
    console.error("submit_error", e);
    res.status(500).json({ error: "submit_failed" });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`API+UI running on http://localhost:${port}`);
  void ensureSpeakingLinksOnStartup();
});
