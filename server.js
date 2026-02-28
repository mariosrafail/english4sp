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
let LivekitAccessToken = null;
let LivekitRoomServiceClient = null;
try {
  ({ AccessToken: LivekitAccessToken, RoomServiceClient: LivekitRoomServiceClient } = require("livekit-server-sdk"));
} catch {}

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

app.get("/api/admin/tests", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  if (!DB.getAdminTest) return res.status(501).json({ error: "Not supported on this database adapter" });
  const ep = Number(req.query?.examPeriodId || 1);
  const examPeriodId = Number.isFinite(ep) && ep > 0 ? ep : 1;
  const test = await DB.getAdminTest(examPeriodId);
  res.json({ ok: true, examPeriodId, test });
});

app.post("/api/admin/tests", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  if (!DB.setAdminTest) return res.status(501).json({ error: "Not supported on this database adapter" });

  const testRaw = req.body?.test;
  const test = normalizeAdminTestPayload(testRaw);
  const hasAny = (test.sections || []).some((s) => (s.items || []).some((it) => it && it.type !== "info"));
  if (!hasAny) return res.status(400).json({ error: "Add at least one item" });
  for (const sec of test.sections || []) {
    for (const it of sec.items || []) {
      if (!it || !it.type || it.type === "info") continue;
      if (it.type === "drag-words") {
        const text = String(it.text || "").trim();
        if (!text) return res.status(400).json({ error: "Drag words text is required" });
        if (!/\*\*[^*]+?\*\*/.test(text)) return res.status(400).json({ error: "Drag words text must include at least one **word** gap" });
        continue;
      }
      if (it.type === "writing") continue;
      if (it.type === "tf") continue;
      if (it.type === "mcq" || it.type === "listening-mcq") {
        if (!String(it.prompt || "").trim()) return res.status(400).json({ error: "Question prompt is required" });
        const filledChoices = (Array.isArray(it.choices) ? it.choices : []).filter((c) => String(c || "").trim());
        if (filledChoices.length < 2) return res.status(400).json({ error: "Each MCQ needs at least 2 options" });
        if (!it.choices[it.correctIndex] || !String(it.choices[it.correctIndex] || "").trim()) {
          return res.status(400).json({ error: "Correct option cannot be empty" });
        }
      }
    }
  }

  const ep = Number(req.query?.examPeriodId || 1);
  const examPeriodId = Number.isFinite(ep) && ep > 0 ? ep : 1;
  const out = await DB.setAdminTest(examPeriodId, test);
  res.json({ ok: true, examPeriodId, ...out });
});

// Bootstrap endpoint to reduce round-trips (faster admin test builder load).
app.get("/api/admin/tests-bootstrap", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  if (!DB.getAdminTest || !DB.listExamPeriods) return res.status(501).json({ error: "Not supported on this database adapter" });

  const examPeriods = await DB.listExamPeriods();
  const rows = Array.isArray(examPeriods) ? examPeriods : [];

  const epRaw = Number(req.query?.examPeriodId || 0);
  const fallbackId = rows.length ? Number(rows[0].id || 1) : 1;
  const examPeriodId = Number.isFinite(epRaw) && epRaw > 0 ? epRaw : (Number.isFinite(fallbackId) && fallbackId > 0 ? fallbackId : 1);

  const test = await DB.getAdminTest(examPeriodId);
  res.json({ ok: true, examPeriods: rows, examPeriodId, test });
});

app.post("/api/admin/listening-audio", (req, res) => {
  uploadListeningAudio.single("audio")(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "file_too_large", message: "MP3 too large (max 50 MB)." });
      }
      return res.status(400).json({ error: "upload_error", message: String(err?.message || err) });
    }

    try {
      await ensureInit();
      const a = await adminAuth(req, res);
      if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

      const ep = Number(req.query?.examPeriodId || 1);
      const examPeriodId = Number.isFinite(ep) && ep > 0 ? ep : 1;

      const f = req.file;
      const buf = f && f.buffer ? Buffer.from(f.buffer) : null;
      if (!buf || !buf.length) return res.status(400).json({ error: "missing_audio" });
      const name = String(f?.originalname || "listening.mp3");
      const ct = String(f?.mimetype || "");
      const isMp3 = name.toLowerCase().endsWith(".mp3") || ct === "audio/mpeg" || ct === "audio/mp3";
      if (!isMp3) return res.status(400).json({ error: "only_mp3_supported" });

      const relPath = `listening/ep_${examPeriodId}/listening.mp3`;
      await Storage.writeFile(relPath, buf);
      const url = `/api/admin/files/download?path=${encodeURIComponent(relPath)}`;

      // Best-effort: also set the listening audio URL in the test payload so admin preview/test builder stays in sync.
      try {
        if (DB.getAdminTest && DB.setAdminTest) {
          const test = await DB.getAdminTest(examPeriodId);
          if (test && Array.isArray(test.sections)) {
            let changed = false;
            for (const sec of (test.sections || [])) {
              for (const item of (sec?.items || [])) {
                if (item && String(item.type || "") === "listening-mcq") {
                  item.audioUrl = url;
                  changed = true;
                  break;
                }
              }
              if (changed) break;
            }
            if (changed) {
              await DB.setAdminTest(examPeriodId, test);
            }
          }
        }
      } catch {}

      return res.json({ ok: true, provider: "storage", relPath, url });
    } catch (e) {
      console.error("listening_audio_upload_error", e);
      return res.status(500).json({ error: "upload_failed", message: String(e?.message || e) });
    }
  });
});

app.get("/api/admin/files/index", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  if (!DB.listExamPeriods) return res.status(501).json({ error: "Not supported on this database adapter" });

  const eps = await DB.listExamPeriods();
  const examPeriods = Array.isArray(eps) ? eps : [];
  const epNameById = new Map(
    examPeriods
      .map((ep) => {
        const id = Number(ep?.id || 0);
        if (!Number.isFinite(id) || id <= 0) return null;
        const name = String(ep?.name || "").trim() || `Exam period ${id}`;
        return [id, name];
      })
      .filter(Boolean)
  );
  const listening = [];
  for (const ep of examPeriods) {
    const id = Number(ep?.id || 0);
    if (!Number.isFinite(id) || id <= 0) continue;
    const relPath = `listening/ep_${id}/listening.mp3`;
    const st = await Storage.statFile(relPath);
    listening.push({
      examPeriodId: id,
      examPeriodName: String(ep?.name || `Exam period ${id}`),
      relPath,
      exists: !!st.exists,
      size: st.exists ? st.size : 0,
      mtimeMs: st.exists ? st.mtimeMs : 0,
      url: st.exists ? `/api/admin/files/download?path=${encodeURIComponent(relPath)}` : "",
    });
  }

  const snaps = DB.listSessionSnapshots ? await DB.listSessionSnapshots({ limit: 500 }) : [];
  const snapshots = [];
  for (const s of (Array.isArray(snaps) ? snaps : [])) {
    const relPath = String(s?.remotePath || "");
    let st = null;
    try { st = relPath ? await Storage.statFile(relPath) : null; } catch { st = null; }
    const exists = !!(st && st.exists);
    const examPeriodId = Number(s?.examPeriodId || 0) || null;
    snapshots.push({
      id: Number(s?.id || 0) || null,
      sessionId: Number(s?.sessionId || 0) || null,
      token: String(s?.token || ""),
      candidateName: String(s?.candidateName || ""),
      examPeriodId,
      examPeriodName: examPeriodId ? String(epNameById.get(examPeriodId) || "") : "",
      submitted: !!(s && (s.submitted === true || Number(s.submitted) === 1)),
      reason: String(s?.reason || ""),
      createdAtUtcMs: Number(s?.createdAtUtcMs || 0) || 0,
      relPath,
      exists,
      size: exists ? st.size : 0,
      mtimeMs: exists ? st.mtimeMs : 0,
      url: exists ? `/api/admin/files/download?path=${encodeURIComponent(relPath)}` : "",
    });
  }

  const sessionRows = DB.listSnapshotSessions ? await DB.listSnapshotSessions({ limit: 20000 }) : [];
  const snapshotSessions = (Array.isArray(sessionRows) ? sessionRows : []).map((r) => {
    const examPeriodId = Number(r?.examPeriodId || 0) || null;
    return {
      sessionId: Number(r?.sessionId || 0) || null,
      token: String(r?.token || ""),
      candidateName: String(r?.candidateName || ""),
      examPeriodId,
      examPeriodName: examPeriodId ? String(epNameById.get(examPeriodId) || "") : "",
      submitted: !!(r && (r.submitted === true || Number(r.submitted) === 1)),
      snapshotCount: Number(r?.snapshotCount || 0) || 0,
      latestSnapshotUtcMs: Number(r?.latestSnapshotUtcMs || 0) || 0,
    };
  });

  res.json({ ok: true, listening, snapshots, snapshotSessions });
});

app.get("/api/admin/files/snapshots", async (req, res) => {
  try {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    if (!DB.listSessionSnapshots || !DB.listExamPeriods) return res.status(501).json({ error: "Not supported on this database adapter" });

    const sessionId = Number(req.query?.sessionId || 0);
    if (!Number.isFinite(sessionId) || sessionId <= 0) return res.status(400).json({ error: "invalid_session_id" });
    const lim = Number(req.query?.limit || 200);
    const limit = Number.isFinite(lim) && lim > 0 ? Math.min(2000, Math.round(lim)) : 200;

    const eps = await DB.listExamPeriods();
    const examPeriods = Array.isArray(eps) ? eps : [];
    const epNameById = new Map(
      examPeriods
        .map((ep) => {
          const id = Number(ep?.id || 0);
          if (!Number.isFinite(id) || id <= 0) return null;
          const name = String(ep?.name || "").trim() || `Exam period ${id}`;
          return [id, name];
        })
        .filter(Boolean)
    );

    const snaps = await DB.listSessionSnapshots({ sessionId, limit });
    const out = [];
    for (const s of (Array.isArray(snaps) ? snaps : [])) {
      const relPath = String(s?.remotePath || "");
      let st = null;
      try { st = relPath ? await Storage.statFile(relPath) : null; } catch { st = null; }
      const exists = !!(st && st.exists);
      const examPeriodId = Number(s?.examPeriodId || 0) || null;
      out.push({
        id: Number(s?.id || 0) || null,
        sessionId: Number(s?.sessionId || 0) || null,
        token: String(s?.token || ""),
        candidateName: String(s?.candidateName || ""),
        examPeriodId,
        examPeriodName: examPeriodId ? String(epNameById.get(examPeriodId) || "") : "",
        submitted: !!(s && (s.submitted === true || Number(s.submitted) === 1)),
        reason: String(s?.reason || ""),
        createdAtUtcMs: Number(s?.createdAtUtcMs || 0) || 0,
        relPath,
        exists,
        size: exists ? st.size : 0,
        mtimeMs: exists ? st.mtimeMs : 0,
        url: exists ? `/api/admin/files/download?path=${encodeURIComponent(relPath)}` : "",
      });
    }

    res.json({ ok: true, sessionId, snapshots: out });
  } catch (e) {
    console.error("admin_files_snapshots_error", e);
    res.status(500).json({ error: "snapshots_failed" });
  }
});

app.get("/api/admin/files/download", async (req, res) => {
  try {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    const rel = String(req.query?.path || "").trim();
    const st = await Storage.statFile(rel);
    if (!st.exists) return res.status(404).json({ error: "not_found" });
    const ct = Storage.contentTypeForPath(st.relPath);
    const name = path.basename(st.relPath);
    streamFileWithRange(req, res, st.absPath, { contentType: ct, downloadName: name });
  } catch (e) {
    console.error("admin_file_download_error", e);
    res.status(500).json({ error: "download_failed" });
  }
});

app.post("/api/admin/files/delete", async (req, res) => {
  try {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

    const kind = String(req.body?.kind || "").trim();
    if (kind === "snapshot") {
      if (!DB.getSessionSnapshotById || !DB.deleteSessionSnapshotById) return res.status(501).json({ error: "Not supported on this database adapter" });
      const id = Number(req.body?.id || 0);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "invalid_id" });
      const row = await DB.getSessionSnapshotById(id);
      if (!row) return res.status(404).json({ error: "not_found" });
      const relPath = String(row.remotePath || "").trim();
      if (relPath) {
        try { await Storage.deleteFile(relPath); } catch {}
      }
      await DB.deleteSessionSnapshotById(id);
      return res.json({ ok: true });
    }

    if (kind === "listening") {
      if (!DB.getAdminTest || !DB.setAdminTest) return res.status(501).json({ error: "Not supported on this database adapter" });
      const ep = Number(req.body?.examPeriodId || 0);
      if (!Number.isFinite(ep) || ep <= 0) return res.status(400).json({ error: "invalid_exam_period" });
      const relPath = `listening/ep_${ep}/listening.mp3`;
      try { await Storage.deleteFile(relPath); } catch {}

      // Best-effort: clear stored audioUrl from the test payload so the builder doesn't show a dead link.
      try {
        const test = await DB.getAdminTest(ep);
        if (test && Array.isArray(test.sections)) {
          for (const sec of test.sections) {
            for (const item of (sec?.items || [])) {
              if (item && String(item.type || "") === "listening-mcq") {
                item.audioUrl = "";
              }
            }
          }
          await DB.setAdminTest(ep, test);
        }
      } catch {}

      return res.json({ ok: true });
    }

    return res.status(400).json({ error: "unknown_kind" });
  } catch (e) {
    console.error("admin_files_delete_error", e);
    res.status(500).json({ error: "delete_failed" });
  }
});

app.get("/api/admin/examiners", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  if (!DB.listExaminers) return res.json([]);
  res.json(await DB.listExaminers());
});

app.get("/api/admin/speaking-slots", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  if (!DB.listSpeakingSlots) return res.json([]);

  const examPeriodId = req.query?.examPeriodId;
  const fromUtcMs = req.query?.fromUtcMs;
  const toUtcMs = req.query?.toUtcMs;
  const limit = req.query?.limit;
  const examinerUsername = req.query?.examinerUsername;

  const out = await DB.listSpeakingSlots({
    examPeriodId: examPeriodId === undefined ? undefined : Number(examPeriodId),
    fromUtcMs: fromUtcMs === undefined ? undefined : Number(fromUtcMs),
    toUtcMs: toUtcMs === undefined ? undefined : Number(toUtcMs),
    limit: limit === undefined ? undefined : Number(limit),
    examinerUsername: examinerUsername === undefined ? undefined : String(examinerUsername || ""),
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

app.post("/api/admin/speaking-slots", async (req, res) => {
  try {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    if (!DB.createSpeakingSlot) return res.status(501).json({ error: "Not supported on this database adapter" });

    const rawPayload = req.body && typeof req.body === "object" ? req.body : {};
    const payload = { ...rawPayload, durationMinutes: SPEAKING_DURATION_MINUTES, videoProvider: speakingVideoProvider() };
    let out = await DB.createSpeakingSlot(payload);

    try {
      const z = await createMeetingForSlot(out);
      const updated = await DB.updateSpeakingSlot({
        id: Number(out.id),
        meetingId: z.meetingId,
        joinUrl: z.joinUrl,
        startUrl: z.startUrl,
        meetingMetadata: z.metadata,
      });
      if (updated) out = updated;
    } catch (zerr) {
      return res.status(502).json({
        error: `Meeting link creation failed: ${String(zerr?.message || "unknown error")}`,
      });
    }

    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e?.message || "create_speaking_slot_failed" });
  }
});

app.post("/api/admin/speaking-slots/auto-generate", async (req, res) => {
  try {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    if (!DB.listSessionsMissingSpeakingSlot || !DB.createSpeakingSlot) {
      return res.status(501).json({ error: "Not supported on this database adapter" });
    }

    const examPeriodId = Number(req.body?.examPeriodId);
    if (!Number.isFinite(examPeriodId) || examPeriodId <= 0) {
      return res.status(400).json({ error: "Invalid exam period id" });
    }
    const out = await autoGenerateSpeakingSlotsForExamPeriod(examPeriodId, { maxErrors: 200 });
    return res.json(out);
  } catch (e) {
    return res.status(400).json({ error: e?.message || "auto_generate_speaking_slots_failed" });
  }
});

app.post("/api/admin/speaking-slots/recreate-meeting-links", async (req, res) => {
  try {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    if (!DB.listSpeakingSlots || !DB.updateSpeakingSlot) {
      return res.status(501).json({ error: "Not supported on this database adapter" });
    }
    const examPeriodIdRaw = Number(req.body?.examPeriodId);
    const examPeriodId = Number.isFinite(examPeriodIdRaw) && examPeriodIdRaw > 0 ? examPeriodIdRaw : null;
    const slots = await DB.listSpeakingSlots({
      ...(examPeriodId ? { examPeriodId } : {}),
      limit: 50000,
    });

    let updated = 0;
    let failed = 0;
    const errors = [];
    for (const slot of Array.isArray(slots) ? slots : []) {
      const sid = Number(slot?.id || 0);
      if (!Number.isFinite(sid) || sid <= 0) continue;

      try {
        // Force a fresh room id on recreate/reset.
        const recreateInput = { ...slot, meetingId: "" };
        const z = await createMeetingForSlot(recreateInput);
        const out = await DB.updateSpeakingSlot({
          id: sid,
          meetingId: z.meetingId,
          joinUrl: z.joinUrl,
          startUrl: z.startUrl,
          meetingMetadata: z.metadata,
        });
        if (out) updated += 1;
      } catch (e) {
        failed += 1;
        errors.push({ slotId: sid, error: String(e?.message || "recreate_failed") });
      }
    }

    return res.json({
      ok: true,
      examPeriodId,
      scanned: Array.isArray(slots) ? slots.length : 0,
      updated,
      failed,
      errors: errors.slice(0, 200),
      provider: speakingVideoProvider(),
    });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "recreate_meeting_links_failed" });
  }
});

app.put("/api/admin/speaking-slots/:id", async (req, res) => {
  try {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    if (!DB.updateSpeakingSlot) return res.status(501).json({ error: "Not supported on this database adapter" });

    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const hasStart = Object.prototype.hasOwnProperty.call(payload, "startUtcMs");
    let forcedStartUtcMs = null;
    let forcedEndUtcMs = null;
    if (hasStart) {
      const s = Number(payload.startUtcMs);
      if (!Number.isFinite(s) || s <= 0) {
        return res.status(400).json({ error: "Invalid start time" });
      }
      forcedStartUtcMs = s;
      forcedEndUtcMs = s + (SPEAKING_DURATION_MINUTES * 60 * 1000);
    }
    let out = await DB.updateSpeakingSlot({
      id: req.params.id,
      ...payload,
      ...(hasStart ? { startUtcMs: forcedStartUtcMs, endUtcMs: forcedEndUtcMs, durationMinutes: SPEAKING_DURATION_MINUTES } : {}),
    });
    if (!out) return res.status(404).json({ error: "Slot not found" });

    // Self-hosted provider: ensure a meeting link exists.
    if (!String(out?.joinUrl || "").trim()) {
      try {
        const z = await createMeetingForSlot(out);
        const updated = await DB.updateSpeakingSlot({
          id: Number(out.id),
          meetingId: z.meetingId,
          joinUrl: z.joinUrl,
          startUrl: z.startUrl,
          meetingMetadata: z.metadata,
        });
        if (updated) out = updated;
      } catch (serr) {
        return res.status(502).json({
          error: `Meeting link creation failed: ${String(serr?.message || "unknown error")}`,
        });
      }
    } else if (hasStart) {
      // On start-time change, rotate to a fresh room id.
      try {
        const z = await createMeetingForSlot({ ...out, meetingId: "" });
        const updated = await DB.updateSpeakingSlot({
          id: Number(out.id),
          meetingId: z.meetingId,
          joinUrl: z.joinUrl,
          startUrl: z.startUrl,
          meetingMetadata: z.metadata,
        });
        if (updated) out = updated;
      } catch (serr) {
        return res.status(502).json({
          error: `Meeting link refresh failed: ${String(serr?.message || "unknown error")}`,
        });
      }
    }

    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e?.message || "update_speaking_slot_failed" });
  }
});

app.delete("/api/admin/speaking-slots/:id", async (req, res) => {
  try {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    if (!DB.deleteSpeakingSlot) return res.status(501).json({ error: "Not supported on this database adapter" });
    const out = await DB.deleteSpeakingSlot(req.params.id);
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e?.message || "delete_speaking_slot_failed" });
  }
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

function normHeader(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function pickCell(row, keys) {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

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

function speakingVideoProvider() {
  const raw = String(process.env.SPEAKING_PROVIDER || "").trim().toLowerCase();
  if (!raw) return "mirotalk_p2p";
  if (raw === "selfhosted") return "mirotalk_p2p";
  if (raw === "self-hosted") return "mirotalk_p2p";
  if (raw === "mirotalk" || raw === "mirotalk-p2p") return "mirotalk_p2p";
  if (raw === "mirotalk_p2p" || raw === "jitsi" || raw === "talky" || raw === "livekit" || raw === "zoom") return raw;
  return "mirotalk_p2p";
}

function selfHostedMeetingBase() {
  const raw = String(
    process.env.SELF_HOSTED_MEETING_BASE_URL ||
    process.env.MEETING_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    ""
  ).trim();
  return raw.replace(/\/+$/, "");
}

function selfHostedJitsiBase() {
  const raw = String(process.env.SELF_HOSTED_JITSI_BASE_URL || "").trim();
  return raw.replace(/\/+$/, "");
}

function selfHostedMiroTalkBase() {
  const explicit = String(
    process.env.SELF_HOSTED_MIROTALK_BASE_URL ||
    process.env.MIROTALK_P2P_BASE_URL
  ).trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const appBase = String(process.env.PUBLIC_BASE_URL || "").trim();
  if (appBase) {
    try {
      const u = new URL(appBase);
      return `${u.protocol}//meet.${u.host}`.replace(/\/+$/, "");
    } catch {}
  }

  return "https://p2p.mirotalk.com";
}

function talkyBase() {
  const raw = String(
    process.env.TALKY_BASE_URL ||
    process.env.SELF_HOSTED_TALKY_BASE_URL ||
    "https://talky.io"
  ).trim();
  return raw.replace(/\/+$/, "");
}

function livekitWsBase() {
  const raw = String(
    process.env.LIVEKIT_URL ||
    process.env.SELF_HOSTED_LIVEKIT_URL ||
    ""
  ).trim();
  return raw.replace(/\/+$/, "");
}

function livekitApiBase() {
  const explicit = String(process.env.LIVEKIT_API_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const wsBase = livekitWsBase();
  if (!wsBase) return "";
  return wsBase
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://")
    .replace(/\/+$/, "");
}

let _zoomAccessToken = "";
let _zoomAccessTokenExpiresAtUtcMs = 0;

function parseZoomConfig() {
  const accountId = String(process.env.ZOOM_ACCOUNT_ID || "").trim();
  const clientId = String(process.env.ZOOM_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.ZOOM_CLIENT_SECRET || "").trim();
  const hostEmail = String(process.env.ZOOM_HOST_EMAIL || "").trim();
  const hostUserId = String(process.env.ZOOM_HOST_USER_ID || "").trim();
  const timezone = String(process.env.ZOOM_TIMEZONE || "UTC").trim() || "UTC";

  const userId = hostUserId || hostEmail;
  const enabled = !!(accountId && clientId && clientSecret && userId);
  return { enabled, accountId, clientId, clientSecret, userId, timezone };
}

async function zoomGetAccessToken() {
  const cfg = parseZoomConfig();
  if (!cfg.enabled) throw new Error("zoom_not_configured");

  const now = Date.now();
  if (_zoomAccessToken && now + 60_000 < _zoomAccessTokenExpiresAtUtcMs) return _zoomAccessToken;

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`, "utf8").toString("base64");
  const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(cfg.accountId)}`;
  const r = await httpsJson(url, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}` },
    timeoutMs: 20000,
  });

  if (!(r.status >= 200 && r.status < 300) || !r.json?.access_token) {
    const msg = String(r.json?.reason || r.json?.error || r.json?.message || `zoom_oauth_failed_${r.status}`);
    throw new Error(msg);
  }

  const token = String(r.json.access_token || "");
  const expiresInSec = Number(r.json.expires_in || 0);
  _zoomAccessToken = token;
  _zoomAccessTokenExpiresAtUtcMs = now + Math.max(0, expiresInSec) * 1000;
  return token;
}

function toZoomIsoUtc(ms) {
  return new Date(Number(ms)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function createZoomMeetingForSlot(slot) {
  const cfg = parseZoomConfig();
  if (!cfg.enabled) throw new Error("zoom_not_configured");

  const startUtcMs = Number(slot?.startUtcMs || 0);
  if (!Number.isFinite(startUtcMs) || startUtcMs <= 0) throw new Error("zoom_invalid_start_time");

  const durationMinutes = Number(slot?.durationMinutes || SPEAKING_DURATION_MINUTES || 0);
  const duration = Math.max(1, Math.min(12 * 60, Math.floor(durationMinutes) || 10));

  const candidateName = String(slot?.candidateName || "").trim();
  const topic = `ENG4SP Speaking${candidateName ? ` - ${candidateName}` : ""}`.slice(0, 190);

  const accessToken = await zoomGetAccessToken();
  const url = `https://api.zoom.us/v2/users/${encodeURIComponent(cfg.userId)}/meetings`;
  const body = {
    topic,
    type: 2,
    start_time: toZoomIsoUtc(startUtcMs),
    timezone: cfg.timezone,
    duration,
    settings: {
      waiting_room: true,
      join_before_host: false,
      mute_upon_entry: true,
      host_video: true,
      participant_video: true,
    },
  };

  const r = await httpsJson(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 20000,
  });

  if (!(r.status >= 200 && r.status < 300) || !r.json?.join_url) {
    const msg = String(r.json?.message || r.json?.error || `zoom_create_meeting_failed_${r.status}`);
    throw new Error(msg);
  }

  const meetingId = String(r.json.id || "").trim();
  const joinUrl = String(r.json.join_url || "").trim();
  const startUrl = String(r.json.start_url || "").trim() || joinUrl;
  return {
    meetingId,
    joinUrl,
    startUrl,
    metadata: {
      provider: "zoom",
      autoGenerated: true,
      hostUserId: cfg.userId,
      zoomMeetingId: meetingId,
      createdAtUtcMs: Date.now(),
    },
  };
}

function normalizeRoomName(raw) {
  const room = String(raw || "").trim();
  if (!room) return "";
  return room.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120);
}

function normalizeParticipantName(raw) {
  const x = String(raw || "").trim();
  if (!x) return "";
  return x.replace(/[\r\n\t]/g, " ").slice(0, 80);
}

function livekitIdentityFromName(name) {
  const base = normalizeParticipantName(name).replace(/[^A-Za-z0-9_.-]/g, "-");
  const safe = (base || "guest").slice(0, 40);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${safe}-${Date.now()}-${rnd}`.slice(0, 96);
}

function ensureLivekitConfigured() {
  if (!LivekitAccessToken || !LivekitRoomServiceClient) {
    throw new Error("livekit_sdk_missing");
  }
  const wsUrl = livekitWsBase();
  const apiUrl = livekitApiBase();
  const apiKey = String(process.env.LIVEKIT_API_KEY || "").trim();
  const apiSecret = String(process.env.LIVEKIT_API_SECRET || "").trim();
  if (!wsUrl || !apiUrl || !apiKey || !apiSecret) {
    throw new Error("livekit_not_configured");
  }
  return { wsUrl, apiUrl, apiKey, apiSecret };
}

async function ensureLivekitRoomAndCapacity(room) {
  const cfg = ensureLivekitConfigured();
  const svc = new LivekitRoomServiceClient(cfg.apiUrl, cfg.apiKey, cfg.apiSecret);
  try {
    await svc.createRoom({
      name: room,
      maxParticipants: 2,
      emptyTimeout: 60 * 10,
    });
  } catch (e) {
    const msg = String(e?.message || "").toLowerCase();
    if (!msg.includes("already exists")) throw e;
  }
  const participants = await svc.listParticipants(room);
  const count = Array.isArray(participants) ? participants.length : 0;
  if (count >= 2) throw new Error("room_full");
}

async function createLivekitJoinToken(room, displayName) {
  const cfg = ensureLivekitConfigured();
  const identity = livekitIdentityFromName(displayName);
  const token = new LivekitAccessToken(cfg.apiKey, cfg.apiSecret, {
    identity,
    name: normalizeParticipantName(displayName) || identity,
    ttl: "2h",
  });
  token.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
  });
  return {
    wsUrl: cfg.wsUrl,
    token: await token.toJwt(),
    identity,
    name: normalizeParticipantName(displayName) || identity,
  };
}

function selfHostedMeetingRoomForSlot(slot) {
  const existing = String(slot?.meetingId || "").trim();
  if (existing) return existing;
  const sid = Number(slot?.sessionId || 0);
  const sl = Number(slot?.id || 0);
  const start = Number(slot?.startUtcMs || 0);
  const raw = `eng4-${sid > 0 ? `s${sid}` : `x${sl > 0 ? sl : "0"}`}-${start > 0 ? Math.floor(start / 1000) : Date.now()}`;
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120) || `eng4-${Date.now()}`;
}

async function createSelfHostedMeetingForSlot(slot) {
  const room = selfHostedMeetingRoomForSlot(slot);
  const provider = speakingVideoProvider();

  if (provider === "jitsi") {
    const base = selfHostedMeetingBase();
    const jitsiBase = selfHostedJitsiBase();
    const query = `room=${encodeURIComponent(room)}${jitsiBase ? `&base=${encodeURIComponent(jitsiBase)}` : ""}`;
    const joinUrl = base ? `${base}/meeting.html?${query}` : `/meeting.html?${query}`;
    return {
      meetingId: room,
      joinUrl,
      startUrl: joinUrl,
      metadata: {
        provider: "jitsi",
        autoGenerated: true,
        room,
        createdAtUtcMs: Date.now(),
      },
    };
  }

  if (provider === "talky") {
    const base = talkyBase();
    const joinUrl = `${base}/${encodeURIComponent(room)}`;
    return {
      meetingId: room,
      joinUrl,
      startUrl: joinUrl,
      metadata: {
        provider: "talky",
        autoGenerated: true,
        room,
        createdAtUtcMs: Date.now(),
      },
    };
  }

  if (provider === "livekit") {
    const base = selfHostedMeetingBase();
    const query = `room=${encodeURIComponent(room)}`;
    const joinUrl = base ? `${base}/meeting-livekit.html?${query}` : `/meeting-livekit.html?${query}`;
    return {
      meetingId: room,
      joinUrl,
      startUrl: joinUrl,
      metadata: {
        provider: "livekit",
        autoGenerated: true,
        room,
        maxParticipants: 2,
        createdAtUtcMs: Date.now(),
      },
    };
  }

  const mirotalkBase = selfHostedMiroTalkBase();
  const joinUrl = `${mirotalkBase}/join?room=${encodeURIComponent(room)}`;
  return {
    meetingId: room,
    joinUrl,
    startUrl: joinUrl,
    metadata: {
      provider: "mirotalk_p2p",
      autoGenerated: true,
      room,
      createdAtUtcMs: Date.now(),
    },
  };
}

async function createMeetingForSlot(slot) {
  const provider = speakingVideoProvider();
  if (provider === "zoom") return createZoomMeetingForSlot(slot);
  return createSelfHostedMeetingForSlot(slot);
}


app.post("/api/admin/import-excel", upload.single("file"), async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

  const examPeriodId = Number(req.body?.examPeriodId || 1);
  if (!Number.isFinite(examPeriodId) || examPeriodId <= 0) {
    return res.status(400).json({ error: "Invalid exam period id" });
  }
  if (!req.file?.buffer) return res.status(400).json({ error: "Missing file" });

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: "buffer" });
  } catch {
    return res.status(400).json({ error: "Invalid Excel file" });
  }
  const sheetName = workbook.SheetNames?.[0];
  if (!sheetName) return res.status(400).json({ error: "No sheets found" });
  const ws = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json(ws, { defval: "" });

  // Build header map by normalizing keys present in first row
  const mapped = raw.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row || {})) out[normHeader(k)] = v;
    return out;
  });

  const rows = [];
  for (const r of mapped) {
    const name = String(pickCell(r, ["name", "full name", "candidate name"]) || "").trim();
    const email = String(pickCell(r, ["email", "e-mail", "mail"]) || "").trim();
    const country = String(pickCell(r, ["country", "country code", "country_code", "countrycode"]) || "").trim();
    if (!email) continue;
    rows.push({ name, email, country });
  }
  if (!rows.length) return res.status(400).json({ error: "No valid rows. Email is required." });

  const created = await DB.importCandidatesAndCreateSessions({
    rows,
    examPeriodId,
    assignmentStrategy: "batch_even",
  });
  let speakingAuto = null;
  let speakingAutoError = "";
  try {
    if (DB.listSessionsMissingSpeakingSlot && DB.createSpeakingSlot) {
      speakingAuto = await autoGenerateSpeakingSlotsForExamPeriod(examPeriodId, { maxErrors: 100 });
    }
  } catch (e) {
    speakingAutoError = String(e?.message || "speaking_auto_generate_failed");
    console.warn("[import-excel] speaking auto-generate failed:", speakingAutoError);
  }

  const base = getPublicBase(req);

  function softWrapText(text, maxCharsPerLine = 75) {
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
    return outLines.join("\r\n");
  }

  const exportRows = (created.sessions || []).map((s) => {
    const url = `${base}/exam.html?token=${s.token}&sid=${s.sessionId}`;
    const speakingUrl = `${base}/speaking.html?token=${encodeURIComponent(String(s.token || ""))}`;
    return {
      name: String(s.name || ""),
      email: String(s.email || ""),
      countryCode: String(s.country || ""),
      examPeriodId: Number(s.examPeriodId || ""),
      assignedExaminer: String(s.assignedExaminer || ""),
      sessionId: Number(s.sessionId || ""),
      token: String(s.token || ""),
      link: softWrapText(url, 85),
      rawLink: url,
      speakingLink: softWrapText(speakingUrl, 85),
      rawSpeakingLink: speakingUrl,
    };
  });

  const outWb = new ExcelJS.Workbook();
  const outWs = outWb.addWorksheet("sessions");
  outWs.columns = [
    { header: "Name", key: "name", width: 18 },
    { header: "Email", key: "email", width: 24 },
    { header: "Country code", key: "countryCode", width: 14 },
    { header: "Exam period id", key: "examPeriodId", width: 14 },
    { header: "Assigned examiner", key: "assignedExaminer", width: 18 },
    { header: "Session id", key: "sessionId", width: 12 },
    { header: "Token", key: "token", width: 22 },
    { header: "Link", key: "link", width: 200 },
    { header: "Speaking Access Link", key: "speakingLink", width: 200 },
  ];
  outWs.getRow(1).font = { bold: true };
  outWs.getColumn(8).alignment = { wrapText: true, vertical: "top" };
  outWs.getColumn(9).alignment = { wrapText: true, vertical: "top" };

  for (const r of exportRows) {
    const row = outWs.addRow({
      name: r.name,
      email: r.email,
      countryCode: r.countryCode,
      examPeriodId: r.examPeriodId,
      assignedExaminer: r.assignedExaminer,
      sessionId: r.sessionId,
      token: r.token,
      link: r.link,
      speakingLink: r.speakingLink,
    });
    const linkCell = row.getCell(8);
    linkCell.value = { text: r.link, hyperlink: r.rawLink };
    linkCell.alignment = { wrapText: true, vertical: "top" };
    linkCell.font = { color: { argb: "FF0563C1" }, underline: true };
    const speakingCell = row.getCell(9);
    speakingCell.value = { text: r.speakingLink, hyperlink: r.rawSpeakingLink };
    speakingCell.alignment = { wrapText: true, vertical: "top" };
    speakingCell.font = { color: { argb: "FF0563C1" }, underline: true };
  }

  const wrapKeys = new Set(["link", "speakingLink", "name", "email", "assignedExaminer"]);
  const minWidthByKey = {
    token: 22,
    link: 100,
    speakingLink: 100,
  };
  for (let c = 1; c <= outWs.columnCount; c++) {
    const col = outWs.getColumn(c);
    const key = String(col.key || "");
    let maxLen = String(col.header || "").length;
    col.eachCell({ includeEmpty: true }, (cell) => {
      const txt = String(cell.text ?? cell.value ?? "");
      for (const ln of txt.split(/\r?\n/)) maxLen = Math.max(maxLen, ln.length);
    });
    const width = wrapKeys.has(key)
      ? Math.min(95, Math.max(14, Math.ceil(maxLen * 0.95)))
      : Math.min(36, Math.max(10, Math.ceil(maxLen * 1.1)));
    const minW = Number(minWidthByKey[key] || 0);
    col.width = minW > 0 ? Math.max(width, minW) : width;
  }

  for (let r = 2; r <= outWs.rowCount; r++) {
    const row = outWs.getRow(r);
    let neededLines = 1;
    for (let c = 1; c <= outWs.columnCount; c++) {
      const col = outWs.getColumn(c);
      const key = String(col.key || "");
      if (!wrapKeys.has(key)) continue;
      const txt = String(row.getCell(c).text ?? row.getCell(c).value ?? "");
      const colChars = Math.max(12, Math.floor(Number(col.width || 20)));
      const lines = txt
        .split(/\r?\n/)
        .reduce((sum, ln) => sum + Math.max(1, Math.ceil(String(ln).length / colChars)), 0);
      neededLines = Math.max(neededLines, lines);
    }
    row.height = Math.min(220, Math.max(20, neededLines * 15));
  }

  const out = await outWb.xlsx.writeBuffer();
  const buf = Buffer.from(out);

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="sessions_examperiod_${examPeriodId}.xlsx"`
  );
  if (speakingAuto) {
    res.setHeader("X-Speaking-Slots-Created", String(Number(speakingAuto.created || 0)));
    res.setHeader("X-Speaking-Slots-Failed", String(Number(speakingAuto.failed || 0)));
  }
  if (speakingAutoError) {
    res.setHeader("X-Speaking-Slots-Error", speakingAutoError.slice(0, 180));
  }
  res.send(buf);
});

app.post("/api/admin/create-candidate", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

  const examPeriodId = Number(req.body?.examPeriodId || 1);
  if (!Number.isFinite(examPeriodId) || examPeriodId <= 0) {
    return res.status(400).json({ error: "Invalid exam period id" });
  }

  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const country = String(req.body?.country || "").trim();
  if (!email) return res.status(400).json({ error: "Email is required" });

  const created = await DB.importCandidatesAndCreateSessions({
    rows: [{ name, email, country }],
    examPeriodId,
    assignmentStrategy: "single_least_random",
  });

  const s = Array.isArray(created?.sessions) ? created.sessions[0] : null;
  if (!s) return res.status(500).json({ error: "Failed to create candidate session" });

  // Guarantee assignment to the least-loaded examiner (if DB adapter supports assignments).
  try {
    if (typeof DB.ensureSessionAssignedExaminer === "function") {
      const ensured = await DB.ensureSessionAssignedExaminer({
        sessionId: Number(s.sessionId),
        examPeriodId: Number(s.examPeriodId || examPeriodId),
      });
      if (String(ensured || "").trim()) s.assignedExaminer = String(ensured).trim();
    }
  } catch {}

  const speakingUrl = `${getPublicBase(req)}/speaking.html?token=${encodeURIComponent(String(s.token || ""))}`;
  let speakingAuto = null;
  let speakingAutoError = "";
  try {
    speakingAuto = await ensureSpeakingSlotForSession(s, Number(s.examPeriodId || examPeriodId));
    if (!speakingAuto?.ok && !speakingAuto?.skipped) {
      speakingAutoError = String(speakingAuto?.error || "speaking_slot_create_failed");
    }
  } catch (e) {
    speakingAutoError = String(e?.message || "speaking_slot_create_failed");
  }

  const base = getPublicBase(req);
  const url = `${base}/exam.html?token=${s.token}&sid=${s.sessionId}`;

  res.json({
    ok: true,
    sessionId: s.sessionId,
    token: s.token,
    reused: !!s.reused,
    assignedExaminer: s.assignedExaminer || "",
    url,
    speakingUrl,
    speakingAuto,
    speakingAutoError,
    candidate: {
      name: s.name || name,
      email: s.email || email,
      country: s.country || country,
      examPeriodId: s.examPeriodId || examPeriodId,
    },
  });
});

app.get("/api/admin/results", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  res.json(await DB.listResults());
});

app.get("/api/admin/candidates", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  res.json(await DB.listCandidates());
});

app.get("/api/admin/candidates/:sessionId/details", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

  const sid = Number(req.params.sessionId);
  if (!Number.isFinite(sid) || sid <= 0) {
    return res.status(400).json({ error: "Invalid session id" });
  }

  if (!DB.getQuestionGrades) {
    return res.status(501).json({ error: "Details endpoint is unavailable for this DB adapter" });
  }

  const qg = await DB.getQuestionGrades(sid);
  if (!qg) return res.status(404).json({ error: "No submitted details found for this session" });

  const ep = Number(qg.examPeriodId || 1);
  const examPeriodId = Number.isFinite(ep) && ep > 0 ? ep : 1;
  const payload = DB.getAdminTest ? await DB.getAdminTest(examPeriodId) : getTestPayloadFull();
  const answersObj = parseAnswersJson(qg.answersJson);
  const review = buildReviewItems(payload, answersObj);

  res.json({
    sessionId: sid,
    examPeriodId,
    qWriting: String(qg.qWriting || ""),
    answersJson: answersObj,
    totalGrade: qg.totalGrade ?? null,
    speakingGrade: qg.speakingGrade ?? null,
    writingGrade: qg.writingGrade ?? null,
    objectiveEarned: review.objectiveEarned,
    objectiveMax: review.objectiveMax,
    items: review.items,
  });
});

app.get("/api/admin/sessions/:sessionId/schedule-defaults", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  if (typeof DB.getSessionScheduleDefaults !== "function") {
    return res.status(501).json({ error: "Endpoint unavailable for this DB adapter" });
  }
  const sid = Number(req.params.sessionId);
  if (!Number.isFinite(sid) || sid <= 0) {
    return res.status(400).json({ error: "Invalid session id" });
  }
  const out = await DB.getSessionScheduleDefaults(sid);
  if (!out) return res.status(404).json({ error: "Session not found" });
  res.json(out);
});

app.post("/api/admin/export-candidates", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

  const rowsIn = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const includeDetailed = !!req.body?.includeDetailed;
  if (!rowsIn.length) return res.status(400).json({ error: "No rows to export" });
  if (rowsIn.length > 50000) return res.status(400).json({ error: "Too many rows to export" });

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
    return outLines.join("\r\n");
  }

  const payloadCache = new Map(); // examPeriodId -> payload
  const exported = [];
  for (const r of rowsIn) {
    const sid = Number(r.sessionId || 0);
    const epIdRaw = Number(r.examPeriodId || 0);
    const epId = Number.isFinite(epIdRaw) && epIdRaw > 0 ? epIdRaw : 1;
    const base = {
      examPeriod: String(r.examPeriodName || ""),
      candidateCode: String(r.candidateCode || ""),
      name: String(r.candidateName || ""),
      token: String(r.token || ""),
      submitted: r.submitted ? "YES" : "NO",
      grade: r.totalGrade ?? "",
      disqualified: r.disqualified ? "YES" : "NO",
    };

    if (!includeDetailed || !Number.isFinite(sid) || sid <= 0) {
      exported.push(base);
      continue;
    }

    let qg = null;
    try { qg = await DB.getQuestionGrades(sid); } catch {}
    const answersObj = parseAnswersJson(qg?.answersJson);
    let payload = payloadCache.get(epId);
    if (!payload) {
      payload = DB.getAdminTest ? await DB.getAdminTest(epId) : getTestPayloadFull();
      payloadCache.set(epId, payload);
    }
    const review = buildReviewItems(payload, answersObj);
    const objectiveEarned = Number(review.objectiveEarned || 0);
    const objectiveMax = Number(review.objectiveMax || 0);
    const objectivePct = objectiveMax > 0 ? Math.round((objectiveEarned / objectiveMax) * 1000) / 10 : 0;
    const writingGrade = qg?.writingGrade == null ? "" : `${Number(qg.writingGrade)}%`;
    const speakingGrade = qg?.speakingGrade == null ? "" : `${Number(qg.speakingGrade)}%`;
    const totalGrade = qg?.totalGrade == null ? (base.grade === "" ? "" : `${Number(base.grade)}%`) : `${Number(qg.totalGrade)}%`;
    const breakdown = (review.items || [])
      .map((it) => {
        if (it.isCorrect === true) return `${it.id}: Correct`;
        if (it.isCorrect === false) return `${it.id}: Wrong`;
        return `${it.id}: N/A`;
      })
      .join(" | ");

    exported.push({
      ...base,
      objective: `${objectiveEarned}/${objectiveMax}`,
      objectivePercent: `${objectivePct}%`,
      writingGrade,
      speakingGrade,
      totalGrade,
      writingText: softWrapText(String(qg?.qWriting || ""), 80),
      detailedBreakdown: softWrapText(breakdown, 90),
    });
  }

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet("admin_candidates");
  const columns = includeDetailed
    ? [
        { header: "Exam Period", key: "examPeriod" },
        { header: "Candidate Code", key: "candidateCode" },
        { header: "Name", key: "name" },
        { header: "Token", key: "token" },
        { header: "Submitted", key: "submitted" },
        { header: "Grade", key: "grade" },
        { header: "Disqualified", key: "disqualified" },
        { header: "Objective", key: "objective" },
        { header: "Objective %", key: "objectivePercent" },
        { header: "Writing Grade", key: "writingGrade" },
        { header: "Speaking Grade", key: "speakingGrade" },
        { header: "Total Grade", key: "totalGrade" },
        { header: "Writing Text", key: "writingText" },
        { header: "Detailed Breakdown", key: "detailedBreakdown" },
      ]
    : [
        { header: "Exam Period", key: "examPeriod" },
        { header: "Candidate Code", key: "candidateCode" },
        { header: "Name", key: "name" },
        { header: "Token", key: "token" },
        { header: "Submitted", key: "submitted" },
        { header: "Grade", key: "grade" },
        { header: "Disqualified", key: "disqualified" },
      ];
  ws.columns = columns.map((c) => ({ ...c, width: 14 }));
  ws.getRow(1).font = { bold: true };

  for (const row of exported) ws.addRow(row);

  const wrapKeys = new Set(["writingText", "detailedBreakdown", "name"]);
  for (let c = 1; c <= ws.columnCount; c++) {
    const col = ws.getColumn(c);
    const key = String(col.key || "");
    let maxLen = String(col.header || "").length;
    col.eachCell({ includeEmpty: true }, (cell, rowNumber) => {
      const text = String(cell.value ?? "");
      for (const ln of text.split(/\r?\n/)) maxLen = Math.max(maxLen, ln.length);
      if (rowNumber >= 2 && wrapKeys.has(key)) cell.alignment = { wrapText: true, vertical: "top" };
    });
    const width = wrapKeys.has(key)
      ? Math.min(95, Math.max(16, Math.ceil(maxLen * 0.95)))
      : Math.min(40, Math.max(10, Math.ceil(maxLen * 1.1)));
    col.width = width;
  }

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    let neededLines = 1;
    for (let c = 1; c <= ws.columnCount; c++) {
      const col = ws.getColumn(c);
      const key = String(col.key || "");
      if (!wrapKeys.has(key)) continue;
      const text = String(row.getCell(c).value || "");
      const colChars = Math.max(12, Math.floor(Number(col.width || 20)));
      const lines = text
        .split(/\r?\n/)
        .reduce((sum, ln) => sum + Math.max(1, Math.ceil(String(ln).length / colChars)), 0);
      neededLines = Math.max(neededLines, lines);
    }
    row.height = Math.min(260, Math.max(20, neededLines * 15));
  }

  const out = await workbook.xlsx.writeBuffer();
  const buf = Buffer.from(out);

  const scopeRaw = String(req.body?.scope || "selected").trim().replace(/[^A-Za-z0-9._-]/g, "_");
  const scope = scopeRaw || "selected";
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const filename = `admin_candidates_${scope}_${ts}.xlsx`;

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);
  res.send(buf);
});

app.post("/api/admin/delete-all-data", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

  await DB.deleteAllCoreData();
  res.json({ ok: true });
});

app.post("/api/admin/candidates/bulk-delete", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
  if (!DB.deleteCandidateBySessionId) return res.status(501).json({ error: "Not supported on this DB adapter" });

  const idsRaw = Array.isArray(req.body?.sessionIds) ? req.body.sessionIds : [];
  const ids = Array.from(new Set(idsRaw.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)));
  if (!ids.length) return res.status(400).json({ error: "No sessionIds provided" });

  let okCount = 0;
  let failCount = 0;
  const errors = [];
  for (const sid of ids) {
    try {
      const out = await DB.deleteCandidateBySessionId(sid);
      if (out?.ok) okCount += 1;
      else failCount += 1;
    } catch (e) {
      failCount += 1;
      errors.push({ sessionId: sid, error: String(e?.message || "delete_failed") });
    }
  }

  res.json({
    ok: true,
    requested: ids.length,
    deleted: okCount,
    failed: failCount,
    errors: errors.slice(0, 100),
  });
});

// Delete a candidate completely (candidates + sessions + question_grades)
// Identified by session id (row in admin candidates table).
app.delete("/api/admin/candidates/:sessionId", async (req, res) => {
  await ensureInit();
  const a = await adminAuth(req, res);
  if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

  const sessionId = Number(req.params.sessionId);
  const out = await DB.deleteCandidateBySessionId(sessionId);
  if (!out?.ok) return res.status(404).json({ error: "Session not found" });
  res.json(out);
});

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

    await ensureLivekitRoomAndCapacity(room);
    const out = await createLivekitJoinToken(room, name);
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
