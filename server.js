// server.js
require('dotenv').config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
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
      if (!item || !item.id || item.type === "info") continue;
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
    const payload = { ...rawPayload, durationMinutes: SPEAKING_DURATION_MINUTES, videoProvider: "zoom" };
    if (!hasZoomConfig()) {
      return res.status(400).json({
        error: "Zoom requires configuration. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET (and optionally ZOOM_USER_ID, ZOOM_TIMEZONE).",
      });
    }
    let out = await DB.createSpeakingSlot(payload);

    try {
      const z = await createZoomMeetingForSlot(out);
      const updated = await DB.updateSpeakingSlot({
        id: Number(out.id),
        meetingId: z.meetingId,
        joinUrl: z.joinUrl,
        startUrl: z.startUrl,
        meetingMetadata: z.metadata,
      });
      if (updated) out = updated;
    } catch (zerr) {
      // Strict behavior: do not keep fallback link when provider is Zoom.
      // If Zoom meeting creation fails, remove the just-created slot and return an error.
      try {
        if (DB.deleteSpeakingSlot && Number(out?.id) > 0) {
          await DB.deleteSpeakingSlot(Number(out.id));
        }
      } catch {}
      return res.status(502).json({
        error: `Zoom meeting creation failed: ${String(zerr?.message || "unknown error")}`,
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
    if (!hasZoomConfig()) {
      return res.status(400).json({
        error: "Zoom requires configuration. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET (and optionally ZOOM_USER_ID, ZOOM_TIMEZONE).",
      });
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

app.put("/api/admin/speaking-slots/:id", async (req, res) => {
  try {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    if (!DB.updateSpeakingSlot) return res.status(501).json({ error: "Not supported on this database adapter" });

    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const prevSlot = DB.getSpeakingSlotById ? await DB.getSpeakingSlotById(req.params.id) : null;
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

    // If this slot uses Zoom:
    // - on time change: create a fresh meeting URL, then remove previous meeting
    // - otherwise: keep existing meeting in sync via PATCH
    if (String(out?.videoProvider || "").toLowerCase() === "zoom") {
      if (hasStart) {
        try {
          const z = await createZoomMeetingForSlot(out);
          const updated = await DB.updateSpeakingSlot({
            id: Number(out.id),
            meetingId: z.meetingId,
            joinUrl: z.joinUrl,
            startUrl: z.startUrl,
            meetingMetadata: z.metadata,
          });
          if (updated) out = updated;

          const oldMeetingId = String(prevSlot?.meetingId || "").trim();
          const newMeetingId = String(out?.meetingId || "").trim();
          if (oldMeetingId && oldMeetingId !== newMeetingId) {
            try { await deleteZoomMeetingById(oldMeetingId); } catch {}
          }
        } catch (zerr) {
          return res.status(502).json({
            error: `Zoom meeting refresh failed: ${String(zerr?.message || "unknown error")}`,
          });
        }
      } else if (String(out?.meetingId || "").trim()) {
        try {
          await updateZoomMeetingForSlot(out);
        } catch {
          // Non-fatal: keep local update even if Zoom sync fails.
        }
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
  if (!hasZoomConfig()) {
    throw new Error("Zoom is not configured");
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
        videoProvider: "zoom",
      });

      const z = await createZoomMeetingForSlot(slot);
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
      try {
        if (slot?.id && DB.deleteSpeakingSlot) {
          await DB.deleteSpeakingSlot(Number(slot.id));
        }
      } catch {}
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

async function ensureSpeakingLinksOnStartup() {
  try {
    await ensureInit();
    if (!DB.listExamPeriods || !DB.listSessionsMissingSpeakingSlot || !DB.createSpeakingSlot) return;
    if (!hasZoomConfig()) {
      console.log("[speaking-startup] skipped: Zoom is not configured");
      return;
    }

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

let _zoomTokenCache = { token: "", expAtMs: 0 };

function hasZoomConfig() {
  return !!(
    String(process.env.ZOOM_ACCOUNT_ID || "").trim() &&
    String(process.env.ZOOM_CLIENT_ID || "").trim() &&
    String(process.env.ZOOM_CLIENT_SECRET || "").trim()
  );
}

async function getZoomAccessToken() {
  if (!hasZoomConfig()) {
    throw new Error("Zoom is not configured. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET.");
  }
  const now = Date.now();
  if (_zoomTokenCache.token && now < (_zoomTokenCache.expAtMs - 15000)) {
    return _zoomTokenCache.token;
  }

  const accountId = String(process.env.ZOOM_ACCOUNT_ID || "").trim();
  const clientId = String(process.env.ZOOM_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.ZOOM_CLIENT_SECRET || "").trim();
  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.access_token) {
    throw new Error(`Zoom token request failed (${r.status})`);
  }
  const expSec = Number(j.expires_in || 3600);
  _zoomTokenCache = {
    token: String(j.access_token),
    expAtMs: Date.now() + Math.max(60, expSec) * 1000,
  };
  return _zoomTokenCache.token;
}

function zoomDurationMinutes(slot) {
  const s = Number(slot?.startUtcMs || 0);
  const e = Number(slot?.endUtcMs || 0);
  const mins = Math.round((e - s) / (60 * 1000));
  return Number.isFinite(mins) && mins > 0 ? mins : 30;
}

function zoomTopicForSlot(slot) {
  const candidate = String(slot?.candidateName || "").trim();
  return candidate ? `Speaking Interview - ${candidate}` : "Speaking Interview";
}

async function createZoomMeetingForSlot(slot) {
  const token = await getZoomAccessToken();
  const userId = String(process.env.ZOOM_USER_ID || "me").trim() || "me";
  const start = Number(slot?.startUtcMs || 0);
  if (!Number.isFinite(start) || start <= 0) throw new Error("Invalid slot start time for Zoom");

  const body = {
    topic: zoomTopicForSlot(slot),
    type: 2,
    start_time: new Date(start).toISOString(),
    duration: zoomDurationMinutes(slot),
    timezone: String(process.env.ZOOM_TIMEZONE || "Europe/Athens"),
    settings: {
      host_video: true,
      participant_video: true,
      waiting_room: false,
      join_before_host: true,
    },
  };

  const r = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(userId)}/meetings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.id || !j?.join_url) {
    throw new Error(`Zoom meeting create failed (${r.status})`);
  }
  return {
    meetingId: String(j.id),
    joinUrl: String(j.join_url || ""),
    startUrl: String(j.start_url || j.join_url || ""),
    metadata: {
      provider: "zoom",
      autoGenerated: true,
      zoomMeetingUuid: String(j.uuid || ""),
      zoomTopic: String(j.topic || body.topic),
      zoomTimezone: String(j.timezone || body.timezone),
      createdAtUtcMs: Date.now(),
    },
  };
}

async function updateZoomMeetingForSlot(slot) {
  const meetingId = String(slot?.meetingId || "").trim();
  if (!meetingId) return;
  const token = await getZoomAccessToken();
  const start = Number(slot?.startUtcMs || 0);
  if (!Number.isFinite(start) || start <= 0) return;

  const body = {
    topic: zoomTopicForSlot(slot),
    start_time: new Date(start).toISOString(),
    duration: zoomDurationMinutes(slot),
    timezone: String(process.env.ZOOM_TIMEZONE || "Europe/Athens"),
    settings: {
      waiting_room: false,
      join_before_host: true,
    },
  };

  const r = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    throw new Error(`Zoom meeting update failed (${r.status})`);
  }
}

async function deleteZoomMeetingById(meetingId) {
  const mid = String(meetingId || "").trim();
  if (!mid) return;
  const token = await getZoomAccessToken();
  const r = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(mid)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  // 204 deleted, 404 already gone -> both considered fine.
  if (r.status === 204 || r.status === 404) return;
  if (!r.ok) {
    throw new Error(`Zoom meeting delete failed (${r.status})`);
  }
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
  ];
  outWs.getRow(1).font = { bold: true };
  outWs.getColumn(8).alignment = { wrapText: true, vertical: "top" };

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
    });
    const linkCell = row.getCell(8);
    linkCell.value = { text: r.link, hyperlink: r.rawLink };
    linkCell.alignment = { wrapText: true, vertical: "top" };
    linkCell.font = { color: { argb: "FF0563C1" }, underline: true };
  }

  const wrapKeys = new Set(["link", "name", "email", "assignedExaminer"]);
  const minWidthByKey = {
    token: 22,
    link: 100,
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

  const base = getPublicBase(req);
  const url = `${base}/exam.html?token=${s.token}&sid=${s.sessionId}`;

  res.json({
    ok: true,
    sessionId: s.sessionId,
    token: s.token,
    reused: !!s.reused,
    assignedExaminer: s.assignedExaminer || "",
    url,
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

  const payload = getTestPayloadFull();
  const answersObj = parseAnswersJson(qg.answersJson);
  const review = buildReviewItems(payload, answersObj);

  res.json({
    sessionId: sid,
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

  const payload = getTestPayloadFull();
  const exported = [];
  for (const r of rowsIn) {
    const sid = Number(r.sessionId || 0);
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

app.post("/api/session/:token/start", async (req, res) => {
  await ensureInit();
  if (await requireGateForToken(req.params.token, res)) return;
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
