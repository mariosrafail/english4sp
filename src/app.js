const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const https = require("https");
const http = require("http");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");

const Storage = require("./storage");
const Meetings = require("./meetings");

const registerAdminSpeakingRoutes = require("./routes/admin_speaking");
const registerAdminTestsRoutes = require("./routes/admin_tests");
const registerAdminFilesRoutes = require("./routes/admin_files");
const registerAdminCandidatesRoutes = require("./routes/admin_candidates");

const registerCoreRoutes = require("./routes/core");
const registerAuthRoutes = require("./routes/auth");
const registerAdminExamPeriodsRoutes = require("./routes/admin_exam_periods");
const registerExaminerRoutes = require("./routes/examiner_api");
const registerSessionRoutes = require("./routes/session_api");

const {
  createAdminToken,
  setAuthCookie,
  clearAuthCookie,
  rateLimitLogin,
  getAdminFromRequest,
} = require("./admin_session");

const {
  createExaminerToken,
  setExaminerAuthCookie,
  clearExaminerAuthCookie,
  rateLimitExaminerLogin,
  getExaminerFromRequest,
} = require("./examiner_session");

const { getTestPayloadFull } = require("./test_config");
const { parseAnswersJson, buildReviewItems } = require("./utils/review");

const rootDir = path.resolve(__dirname, "..");

// DB selection: if DATABASE_URL exists, use Postgres; else SQLite.
const hasPg = !!(
  process.env.DATABASE_URL ||
  process.env.NETLIFY_DATABASE_URL_UNPOOLED ||
  process.env.NETLIFY_DATABASE_URL
);
const DB = hasPg ? require("./db_pg") : require("./db");

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

const SPEAKING_DURATION_MINUTES = 60;
const ATHENS_TZ = "Europe/Athens";

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
  const pad2 = (n) => String(n).padStart(2, "0");
  const hh = pad2(dt.getHours());
  const mm = pad2(dt.getMinutes());
  const ss = pad2(dt.getSeconds());
  const dd = pad2(dt.getDate());
  const mo = pad2(dt.getMonth() + 1);
  const yy = String(dt.getFullYear());
  return `${hh}${mm}${ss}_${dd}${mo}_${yy}`;
}

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

function speakingVideoProvider() { return Meetings.speakingVideoProvider(); }
function normalizeRoomName(raw) { return Meetings.normalizeRoomName(raw); }
function normalizeParticipantName(raw) { return Meetings.normalizeParticipantName(raw); }
async function createMeetingForSlot(slot) {
  return Meetings.createMeetingForSlot(slot, { defaultDurationMinutes: SPEAKING_DURATION_MINUTES });
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

function normalizeAdminTestPayload(test) {
  const p = test && typeof test === "object" ? test : {};
  const sectionsRaw = Array.isArray(p.sections) ? p.sections : [];
  const sections = sectionsRaw.slice(0, 8).map((sec, secIdx) => {
    const s = sec && typeof s === "object" ? sec : {};
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
      if (audioUrl && type === "listening-mcq") out.audioUrl = audioUrl;
      if (type === "short") out.correctText = String(it0.correctText || "").trim().slice(0, 2000);
      return out;
    });

    return { id, title, description, rules, items };
  });

  return { sections };
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  // Listening audio can be larger than other uploads (mp3). Keep in memory, but allow a higher cap.
  const uploadListeningAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

  registerCoreRoutes(app, { ensureInit, DB, hasPg, adminAuth, examinerAuth, rootDir });

  registerAuthRoutes(app, {
    ensureInit,
    DB,
    rateLimitLogin,
    createAdminToken,
    setAuthCookie,
    clearAuthCookie,
    getCookieAdmin,
    rateLimitExaminerLogin,
    createExaminerToken,
    setExaminerAuthCookie,
    clearExaminerAuthCookie,
    examinerCookieAuth,
  });

  registerAdminExamPeriodsRoutes(app, { ensureInit, adminAuth, DB, getPublicBase });

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
    Storage,
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

  registerExaminerRoutes(app, { ensureInit, examinerAuth, DB, ExcelJS, getPublicBase });

  registerSessionRoutes(app, {
    ensureInit,
    DB,
    Storage,
    Meetings,
    upload,
    requireGateForToken,
    parseSnapshotMax,
    isPng,
    safeTitlePrefix,
    buildStampHhmmss_DDMM_YYYY,
    streamFileWithRange,
    isProctoringAckRequired,
    normalizeRoomName,
    normalizeParticipantName,
  });

  return { app, ensureSpeakingLinksOnStartup };
}

module.exports = { createApp, ensureSpeakingLinksOnStartup, ensureInit, DB, hasPg };
