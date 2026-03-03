#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const XLSX = require("xlsx");

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.STRESS_BASE_URL || "http://localhost:8080",
    linksFile: process.env.STRESS_LINKS_FILE || "",
    concurrency: Number(process.env.STRESS_CONCURRENCY || 50),
    withPresence: String(process.env.STRESS_WITH_PRESENCE || "1") !== "0",
    withListening: String(process.env.STRESS_WITH_LISTENING || "1") !== "0",
    withSnapshots: String(process.env.STRESS_WITH_SNAPSHOTS || "1") !== "0",
    realisticFlow: String(process.env.STRESS_REALISTIC_FLOW || "0") === "1",
    snapshotCount: Number(process.env.STRESS_SNAPSHOT_COUNT || 2),
    snapshotSizeKb: Number(process.env.STRESS_SNAPSHOT_SIZE_KB || 1024),
    durationMinutes: Number(process.env.STRESS_DURATION_MINUTES || 10),
    listeningActions: Number(process.env.STRESS_LISTENING_ACTIONS || 1),
    playStartMinute: Number(process.env.STRESS_PLAY_START_MINUTE || 1),
    playEndMinute: Number(process.env.STRESS_PLAY_END_MINUTE || 2),
    audioWaitMinutes: Number(process.env.STRESS_AUDIO_WAIT_MINUTES || 5),
    answerPhaseMinutes: Number(process.env.STRESS_ANSWER_PHASE_MINUTES || 4),
    submitWindowMinutes: Number(process.env.STRESS_SUBMIT_WINDOW_MINUTES || 2),
    presenceIntervalSec: Number(process.env.STRESS_PRESENCE_INTERVAL_SEC || 25),
    listeningIntervalSec: Number(process.env.STRESS_LISTENING_INTERVAL_SEC || 20),
    listeningChunkKb: Number(process.env.STRESS_LISTENING_CHUNK_KB || 512),
    failRateThreshold: Number(process.env.STRESS_FAIL_RATE_THRESHOLD || 0.1),
    timeoutMs: Number(process.env.STRESS_TIMEOUT_MS || 15000),
    ackVersion: process.env.STRESS_ACK_VERSION || "stress-test-v1",
    reportFile: process.env.STRESS_REPORT_FILE || "",
    strictExamLinks: String(process.env.STRESS_STRICT_EXAM_LINKS || "0") === "1",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] || "").trim();
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === "with-presence") {
      out.withPresence = true;
      continue;
    }
    if (key === "no-presence") {
      out.withPresence = false;
      continue;
    }
    if (key === "with-listening") {
      out.withListening = true;
      continue;
    }
    if (key === "no-listening") {
      out.withListening = false;
      continue;
    }
    if (key === "with-snapshots") {
      out.withSnapshots = true;
      continue;
    }
    if (key === "no-snapshots") {
      out.withSnapshots = false;
      continue;
    }
    if (key === "realistic-flow") {
      out.realisticFlow = true;
      continue;
    }
    if (key === "simple-flow") {
      out.realisticFlow = false;
      continue;
    }
    if (key === "strict-exam-links") {
      out.strictExamLinks = true;
      continue;
    }
    if (key === "allow-any-link-column") {
      out.strictExamLinks = false;
      continue;
    }
    if (next == null || String(next).startsWith("--")) continue;
    i += 1;
    if (key === "base-url") out.baseUrl = String(next);
    else if (key === "links") out.linksFile = String(next);
    else if (key === "concurrency") out.concurrency = Number(next);
    else if (key === "snapshot-count") out.snapshotCount = Number(next);
    else if (key === "snapshot-size-kb") out.snapshotSizeKb = Number(next);
    else if (key === "duration-minutes") out.durationMinutes = Number(next);
    else if (key === "listening-actions") out.listeningActions = Number(next);
    else if (key === "play-start-minute") out.playStartMinute = Number(next);
    else if (key === "play-end-minute") out.playEndMinute = Number(next);
    else if (key === "audio-wait-minutes") out.audioWaitMinutes = Number(next);
    else if (key === "answer-phase-minutes") out.answerPhaseMinutes = Number(next);
    else if (key === "submit-window-minutes") out.submitWindowMinutes = Number(next);
    else if (key === "presence-interval-sec") out.presenceIntervalSec = Number(next);
    else if (key === "listening-interval-sec") out.listeningIntervalSec = Number(next);
    else if (key === "listening-chunk-kb") out.listeningChunkKb = Number(next);
    else if (key === "fail-rate-threshold") out.failRateThreshold = Number(next);
    else if (key === "timeout-ms") out.timeoutMs = Number(next);
    else if (key === "ack-version") out.ackVersion = String(next);
    else if (key === "report-file") out.reportFile = String(next);
  }

  if (!Number.isFinite(out.concurrency) || out.concurrency < 1) out.concurrency = 1;
  out.concurrency = Math.min(1000, Math.floor(out.concurrency));
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs < 1000) out.timeoutMs = 1000;
  out.timeoutMs = Math.min(120000, Math.floor(out.timeoutMs));
  if (!Number.isFinite(out.snapshotCount) || out.snapshotCount < 0) out.snapshotCount = 0;
  out.snapshotCount = Math.min(10, Math.floor(out.snapshotCount));
  if (!Number.isFinite(out.snapshotSizeKb) || out.snapshotSizeKb < 1) out.snapshotSizeKb = 1024;
  out.snapshotSizeKb = Math.min(8192, Math.floor(out.snapshotSizeKb));
  if (!Number.isFinite(out.durationMinutes) || out.durationMinutes < 0.1) out.durationMinutes = 10;
  out.durationMinutes = Math.min(180, out.durationMinutes);
  if (!Number.isFinite(out.listeningActions) || out.listeningActions < 0) out.listeningActions = 1;
  out.listeningActions = Math.min(200, Math.floor(out.listeningActions));
  if (!Number.isFinite(out.playStartMinute) || out.playStartMinute < 0) out.playStartMinute = 1;
  if (!Number.isFinite(out.playEndMinute) || out.playEndMinute <= out.playStartMinute) out.playEndMinute = out.playStartMinute + 1;
  if (!Number.isFinite(out.audioWaitMinutes) || out.audioWaitMinutes < 0) out.audioWaitMinutes = 5;
  if (!Number.isFinite(out.answerPhaseMinutes) || out.answerPhaseMinutes < 0) out.answerPhaseMinutes = 4;
  if (!Number.isFinite(out.submitWindowMinutes) || out.submitWindowMinutes < 0.1) out.submitWindowMinutes = 2;
  out.playStartMinute = Math.min(300, out.playStartMinute);
  out.playEndMinute = Math.min(300, out.playEndMinute);
  out.audioWaitMinutes = Math.min(300, out.audioWaitMinutes);
  out.answerPhaseMinutes = Math.min(300, out.answerPhaseMinutes);
  out.submitWindowMinutes = Math.min(300, out.submitWindowMinutes);
  if (!Number.isFinite(out.presenceIntervalSec) || out.presenceIntervalSec < 2) out.presenceIntervalSec = 25;
  out.presenceIntervalSec = Math.min(300, Math.floor(out.presenceIntervalSec));
  if (!Number.isFinite(out.listeningIntervalSec) || out.listeningIntervalSec < 2) out.listeningIntervalSec = 20;
  out.listeningIntervalSec = Math.min(300, Math.floor(out.listeningIntervalSec));
  if (!Number.isFinite(out.listeningChunkKb) || out.listeningChunkKb < 8) out.listeningChunkKb = 512;
  out.listeningChunkKb = Math.min(16384, Math.floor(out.listeningChunkKb));
  if (!Number.isFinite(out.failRateThreshold) || out.failRateThreshold < 0) out.failRateThreshold = 0.1;
  if (!out.baseUrl) out.baseUrl = "http://localhost:8080";
  out.baseUrl = out.baseUrl.replace(/\/+$/, "");
  return out;
}

function normalizeKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 _-]/g, "");
}

function tryExtractTokenFromUrlOrToken(s) {
  const raw = String(s || "").trim();
  if (!raw) return "";
  if (!/https?:\/\//i.test(raw) && !raw.includes("?")) {
    // Plain token
    if (/^[A-Za-z0-9._~-]{8,}$/.test(raw)) return raw;
    return "";
  }
  try {
    const u = new URL(raw);
    const t = String(u.searchParams.get("token") || "").trim();
    return t;
  } catch {
    return "";
  }
}

function parseTxtOrCsv(content) {
  const strictExamLinks = arguments.length > 1 ? !!arguments[1] : false;
  const lines = String(content || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return [];

  const maybeCsv = lines[0].includes(",");
  if (!maybeCsv) {
    return lines.map(tryExtractTokenFromUrlOrToken).filter(Boolean);
  }

  const header = lines[0].split(",").map((h) => normalizeKey(h));
  const tokenIdx = header.findIndex((h) => h === "token");
  const linkIdx = header.findIndex((h) => h === "link" || h === "rawlink" || h === "url");

  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(",").map((x) => String(x || "").trim());
    let tok = "";
    if (tokenIdx >= 0) tok = tryExtractTokenFromUrlOrToken(cols[tokenIdx]);
    if (!tok && linkIdx >= 0) tok = tryExtractTokenFromUrlOrToken(cols[linkIdx]);
    if (!tok && !strictExamLinks) {
      tok = cols.map(tryExtractTokenFromUrlOrToken).find(Boolean) || "";
    }
    if (tok) out.push(tok);
  }
  return out;
}

function loadTokensFromFile(filePath, { strictExamLinks = false } = {}) {
  const abs = path.resolve(process.cwd(), String(filePath || "").trim());
  if (!fs.existsSync(abs)) throw new Error(`Links file not found: ${abs}`);

  const ext = path.extname(abs).toLowerCase();
  if (ext === ".xlsx" || ext === ".xls") {
    const wb = XLSX.readFile(abs);
    const first = wb.SheetNames && wb.SheetNames[0];
    if (!first) throw new Error("No sheet found in Excel file");
    const ws = wb.Sheets[first];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    const out = [];

    for (const row of rows) {
      const mapped = {};
      for (const [k, v] of Object.entries(row || {})) mapped[normalizeKey(k)] = v;

      let tok = "";
      tok = tryExtractTokenFromUrlOrToken(mapped.token);
      if (!tok) tok = tryExtractTokenFromUrlOrToken(mapped.link || mapped.rawlink || mapped.url);
      if (!tok && !strictExamLinks) tok = Object.values(mapped).map(tryExtractTokenFromUrlOrToken).find(Boolean) || "";
      if (tok) out.push(tok);
    }
    return out;
  }

  const content = fs.readFileSync(abs, "utf8");
  return parseTxtOrCsv(content, strictExamLinks);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function fetchJson(url, { method = "GET", body = undefined, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const ended = performance.now();
    const ms = ended - started;
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, ms };
  } catch (err) {
    const ended = performance.now();
    return {
      ok: false,
      status: 0,
      json: { error: String(err && err.message ? err.message : err || "request_failed") },
      ms: ended - started,
    };
  } finally {
    clearTimeout(t);
  }
}

async function fetchMultipart(url, { formData, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
    const ended = performance.now();
    const ms = ended - started;
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, ms };
  } catch (err) {
    const ended = performance.now();
    return {
      ok: false,
      status: 0,
      json: { error: String(err && err.message ? err.message : err || "request_failed") },
      ms: ended - started,
    };
  } finally {
    clearTimeout(t);
  }
}

async function fetchRaw(url, { method = "GET", headers = undefined, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
    });
    const ended = performance.now();
    const ms = ended - started;
    try { await res.arrayBuffer(); } catch {}
    return { ok: res.ok, status: res.status, ms };
  } catch (err) {
    const ended = performance.now();
    return { ok: false, status: 0, ms: ended - started, error: String(err && err.message ? err.message : err || "request_failed") };
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function randomInt(min, max) {
  const a = Math.floor(Number(min));
  const b = Math.floor(Number(max));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  if (b <= a) return a;
  return a + Math.floor(Math.random() * (b - a + 1));
}

function pickRandom(arr) {
  const list = Array.isArray(arr) ? arr : [];
  if (!list.length) return null;
  return list[randomInt(0, list.length - 1)];
}

function shuffleCopy(arr) {
  const out = [...(Array.isArray(arr) ? arr : [])];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function buildPngLikeBlob(sizeBytes) {
  const size = Math.max(128, Math.floor(Number(sizeBytes) || (1024 * 1024)));
  const buf = Buffer.alloc(size, 0);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  sig.copy(buf, 0);
  for (let i = 8; i < size; i += 4096) {
    buf[i] = (i * 31) % 251;
  }
  return new Blob([buf], { type: "image/png" });
}

function buildWritingText(item) {
  const title = String(item?.title || "Writing task").trim();
  const prompt = String(item?.prompt || item?.text || "").trim();
  return [
    `This is a stress-test writing response for: ${title}.`,
    `Main idea: ${prompt.slice(0, 120) || "candidate writes a structured answer"}.`,
    "The response includes an introduction, key points, and a short conclusion.",
    "It is intentionally realistic but auto-generated for load testing.",
  ].join("\n\n");
}

function buildRandomAnswersFromSessionJson(sessionJson) {
  const payload = sessionJson?.test?.payload;
  const sections = Array.isArray(payload?.sections) ? payload.sections : [];
  const out = {};

  for (const sec of sections) {
    const items = Array.isArray(sec?.items) ? sec.items : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const id = String(item.id || "").trim();
      if (!id) continue;
      const type = String(item.type || "").trim().toLowerCase();
      if (!type || type === "info") continue;

      if (type === "mcq" || type === "listening-mcq") {
        const choices = (Array.isArray(item.choices) ? item.choices : []).map((c) => String(c || "").trim()).filter(Boolean);
        if (!choices.length) continue;
        out[id] = randomInt(0, choices.length - 1);
        continue;
      }

      if (type === "tf") {
        out[id] = Math.random() < 0.5 ? "true" : "false";
        continue;
      }

      if (type === "writing") {
        out[id] = buildWritingText(item);
        continue;
      }

      if (type === "drag-words") {
        const txt = String(item.text || "");
        const gaps = (txt.match(/\*\*[^*]+\*\*/g) || []).length;
        const choices = (Array.isArray(item.choices) ? item.choices : []).map((c) => String(c || "").trim()).filter(Boolean);
        for (let g = 1; g <= gaps; g += 1) {
          out[`${id}_g${g}`] = choices.length ? randomInt(0, choices.length - 1) : "";
        }
        continue;
      }

      out[id] = `auto_answer_${randomInt(1000, 9999)}`;
    }
  }

  return out;
}

async function runCandidateFlow({
  baseUrl,
  token,
  timeoutMs,
  withPresence,
  withListening,
  withSnapshots,
  realisticFlow,
  snapshotCount,
  snapshotSizeKb,
  durationMinutes,
  presenceIntervalSec,
  listeningIntervalSec,
  listeningChunkKb,
  listeningActions,
  playStartMinute,
  playEndMinute,
  audioWaitMinutes,
  answerPhaseMinutes,
  submitWindowMinutes,
  ackVersion,
}, metrics) {
  const t = encodeURIComponent(String(token));
  const sessionUrl = `${baseUrl}/api/session/${t}`;
  const ackUrl = `${baseUrl}/api/session/${t}/proctoring-ack`;
  const startUrl = `${baseUrl}/api/session/${t}/start`;
  const presenceUrl = `${baseUrl}/api/session/${t}/presence`;
  const submitUrl = `${baseUrl}/api/session/${t}/submit`;
  const listeningTicketUrl = `${baseUrl}/api/session/${t}/listening-ticket`;
  const snapshotUrl = `${baseUrl}/api/session/${t}/snapshot`;
  const simDurationMs = Math.max(1000, Math.floor(Number(durationMinutes || 10) * 60 * 1000));
  const presenceEveryMs = Math.max(2000, Math.floor(Number(presenceIntervalSec || 25) * 1000));
  const listeningEveryMs = Math.max(2000, Math.floor(Number(listeningIntervalSec || 20) * 1000));

  function record(endpoint, result) {
    const bucket = metrics.endpoints[endpoint] || { times: [], statuses: new Map(), fail: 0, total: 0 };
    bucket.total += 1;
    bucket.times.push(result.ms);
    bucket.statuses.set(result.status, (bucket.statuses.get(result.status) || 0) + 1);
    if (!result.ok) bucket.fail += 1;
    metrics.endpoints[endpoint] = bucket;
  }

  const session = await fetchJson(sessionUrl, { timeoutMs });
  record("GET /api/session/:token", session);

  if (!session.ok) {
    return { ok: false, token, reason: `session_${session.status || "error"}` };
  }

  const st = String(session.json && session.json.status ? session.json.status : "").toLowerCase();
  if (st === "countdown") return { ok: true, token, skipped: true, reason: "countdown" };
  if (st === "ended") return { ok: true, token, skipped: true, reason: "ended" };
  const answersTemplate = buildRandomAnswersFromSessionJson(session.json || {});
  const stagedAnswers = {};
  const answerEntries = shuffleCopy(Object.entries(answersTemplate));
  let stagedAnswerCount = 0;

  const ack = await fetchJson(ackUrl, {
    method: "POST",
    timeoutMs,
    body: { noticeVersion: ackVersion },
  });
  record("POST /api/session/:token/proctoring-ack", ack);
  if (!ack.ok && ack.status !== 404 && ack.status !== 501) {
    return { ok: false, token, reason: `ack_${ack.status || "error"}` };
  }

  const started = await fetchJson(startUrl, { method: "POST", timeoutMs, body: {} });
  record("POST /api/session/:token/start", started);
  if (!started.ok) {
    return { ok: false, token, reason: `start_${started.status || "error"}` };
  }

  const doListeningAction = async () => {
    const lt = await fetchJson(listeningTicketUrl, { method: "POST", timeoutMs, body: {} });
    record("POST /api/session/:token/listening-ticket", lt);
    const ticketDeniedExpected = lt.status === 403;
    if (!lt.ok && !ticketDeniedExpected && lt.status !== 404 && lt.status !== 501) {
      return { ok: false, reason: `listening_ticket_${lt.status || "error"}` };
    }

    const audioRel = String(lt?.json?.url || "").trim();
    if (!audioRel) return { ok: true };
    const audioUrl = audioRel.startsWith("http") ? audioRel : `${baseUrl}${audioRel.startsWith("/") ? "" : "/"}${audioRel}`;
    const byteLen = Math.max(8 * 1024, Math.floor(Number(listeningChunkKb || 512) * 1024));
    const audio = await fetchRaw(audioUrl, {
      method: "GET",
      headers: { Range: `bytes=0-${byteLen - 1}` },
      timeoutMs,
    });
    record("GET /api/session/:token/listening-audio", audio);
    if (!audio.ok && audio.status !== 403 && audio.status !== 404) {
      return { ok: false, reason: `listening_audio_${audio.status || "error"}` };
    }
    return { ok: true };
  };

  const snapshotBlob = withSnapshots && snapshotCount > 0
    ? buildPngLikeBlob(Math.max(128 * 1024, Number(snapshotSizeKb || 1024) * 1024))
    : null;

  const doSnapshotAction = async (i) => {
    if (!snapshotBlob) return { ok: true };
    const fd = new FormData();
    fd.append("reason", i === 0 ? "exam_start" : "face_check");
    fd.append("titlePrefix", i === 0 ? "START_EXAM" : "FACE_NOTONCAMERA");
    const hh = String(randomInt(0, 23)).padStart(2, "0");
    const mm = String(randomInt(0, 59)).padStart(2, "0");
    const ss = String(randomInt(0, 59)).padStart(2, "0");
    fd.append("stamp", `${hh}${mm}${ss}_0303_2026`);
    fd.append("image", snapshotBlob, "snapshot.png");
    const snap = await fetchMultipart(snapshotUrl, { formData: fd, timeoutMs });
    record("POST /api/session/:token/snapshot", snap);
    if (!snap.ok && snap.status !== 404 && snap.status !== 413 && snap.status !== 429 && snap.status !== 501) {
      return { ok: false, reason: `snapshot_${snap.status || "error"}` };
    }
    return { ok: true, limited: snap.status === 429 };
  };

  let listeningDone = 0;
  const maxListeningActions = Math.max(0, Number(listeningActions || 0));

  const minuteMs = 60 * 1000;
  const playStartMs = Math.max(0, Math.floor(Number(playStartMinute || 1) * minuteMs));
  const playEndMs = Math.max(playStartMs + 1000, Math.floor(Number(playEndMinute || 2) * minuteMs));
  const audioWaitMs = Math.max(0, Math.floor(Number(audioWaitMinutes || 5) * minuteMs));
  const answerPhaseMs = Math.max(0, Math.floor(Number(answerPhaseMinutes || 4) * minuteMs));
  const submitWindowMs = Math.max(1000, Math.floor(Number(submitWindowMinutes || 2) * minuteMs));

  const nowStart = Date.now();
  const realisticTotalMs = playEndMs + audioWaitMs + answerPhaseMs + submitWindowMs;
  const effectiveDurationMs = realisticFlow ? Math.max(simDurationMs, realisticTotalMs) : simDurationMs;
  const simEndAt = nowStart + effectiveDurationMs;

  const answerStartMs = playEndMs + audioWaitMs;
  const answerEndMs = answerStartMs + answerPhaseMs;
  const submitStartMs = answerEndMs;
  const submitEndMs = submitStartMs + submitWindowMs;

  const plannedFirstListeningAt = realisticFlow
    ? (nowStart + randomInt(playStartMs, Math.max(playStartMs, playEndMs - 1)))
    : nowStart;

  const plannedSubmitAt = realisticFlow
    ? (nowStart + randomInt(submitStartMs, Math.max(submitStartMs, submitEndMs - 1)))
    : simEndAt;

  if (withListening && listeningDone < maxListeningActions && !realisticFlow) {
    const firstListen = await doListeningAction();
    if (!firstListen.ok) return { ok: false, token, reason: firstListen.reason || "listening_failed" };
    listeningDone += 1;
  }

  let snapshotsDone = 0;
  let snapshotLimited = false;
  let nextPresenceAt = nowStart + randomInt(300, Math.max(400, Math.floor(presenceEveryMs * 0.6)));
  let nextListeningAt = nowStart + randomInt(500, Math.max(700, Math.floor(listeningEveryMs * 0.8)));
  while (Date.now() < plannedSubmitAt) {
    const now = Date.now();
    const elapsedMs = now - nowStart;

    if (realisticFlow && answerEntries.length && elapsedMs >= answerStartMs) {
      const progress = answerPhaseMs <= 0
        ? 1
        : Math.max(0, Math.min(1, (Math.min(elapsedMs, answerEndMs) - answerStartMs) / answerPhaseMs));
      const targetCount = Math.min(answerEntries.length, Math.max(stagedAnswerCount, Math.floor(progress * answerEntries.length)));
      while (stagedAnswerCount < targetCount) {
        const [k, v] = answerEntries[stagedAnswerCount];
        stagedAnswers[k] = v;
        stagedAnswerCount += 1;
      }
    }

    if (withPresence && now >= nextPresenceAt) {
      const p1 = await fetchJson(presenceUrl, {
        method: "POST",
        timeoutMs,
        body: { status: "active" },
      });
      record("POST /api/session/:token/presence", p1);
      if (!p1.ok && p1.status !== 404 && p1.status !== 501) {
        return { ok: false, token, reason: `presence_${p1.status || "error"}` };
      }
      nextPresenceAt = now + presenceEveryMs + randomInt(-1500, 1500);
    }

    const listeningReadyAt = realisticFlow
      ? (listeningDone === 0 ? plannedFirstListeningAt : nextListeningAt)
      : nextListeningAt;
    if (withListening && listeningDone < maxListeningActions && now >= listeningReadyAt) {
      const l = await doListeningAction();
      if (!l.ok) return { ok: false, token, reason: l.reason || "listening_failed" };
      listeningDone += 1;
      nextListeningAt = now + listeningEveryMs + randomInt(-2000, 2000);
    }

    if (withSnapshots && snapshotsDone < snapshotCount && !snapshotLimited) {
      const targetAt = simEndAt - Math.floor(((snapshotCount - snapshotsDone) / (snapshotCount + 1)) * effectiveDurationMs);
      if (now >= targetAt) {
        const s = await doSnapshotAction(snapshotsDone);
        if (!s.ok) return { ok: false, token, reason: s.reason || "snapshot_failed" };
        snapshotsDone += 1;
        snapshotLimited = !!s.limited;
      }
    }

    const untilEnd = plannedSubmitAt - now;
    if (untilEnd <= 0) break;
    await sleep(Math.min(750, Math.max(120, untilEnd)));
  }

  if (realisticFlow) {
    while (stagedAnswerCount < answerEntries.length) {
      const [k, v] = answerEntries[stagedAnswerCount];
      stagedAnswers[k] = v;
      stagedAnswerCount += 1;
    }
  }

  const answersForSubmit = realisticFlow
    ? (Object.keys(stagedAnswers).length ? stagedAnswers : answersTemplate)
    : answersTemplate;

  const submitted = await fetchJson(submitUrl, {
    method: "POST",
    timeoutMs,
    body: {
      answers: answersForSubmit,
      clientMeta: { source: "stress_candidates", at: Date.now(), mode: realisticFlow ? "realistic_phased" : "long_sim", durationMinutes },
    },
  });
  record("POST /api/session/:token/submit", submitted);
  if (!submitted.ok) {
    return { ok: false, token, reason: `submit_${submitted.status || "error"}` };
  }

  return { ok: true, token };
}

async function runPool(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const conc = Math.max(1, Math.min(1000, Math.floor(Number(concurrency) || 1)));
  let idx = 0;
  const out = new Array(list.length);
  const runners = new Array(Math.min(conc, list.length)).fill(0).map(async () => {
    while (idx < list.length) {
      const i = idx;
      idx += 1;
      out[i] = await worker(list[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

function printEndpointStats(metrics) {
  console.log("\n=== Endpoint Stats ===");
  const names = Object.keys(metrics.endpoints);
  if (!names.length) {
    console.log("No endpoint stats collected.");
    return;
  }

  for (const name of names) {
    const b = metrics.endpoints[name];
    const p50 = percentile(b.times, 50).toFixed(1);
    const p95 = percentile(b.times, 95).toFixed(1);
    const max = Math.max(0, ...b.times).toFixed(1);
    const failRate = b.total ? ((b.fail / b.total) * 100).toFixed(2) : "0.00";
    const statusLine = [...b.statuses.entries()]
      .sort((a, b2) => Number(a[0]) - Number(b2[0]))
      .map(([code, n]) => `${code}:${n}`)
      .join(" ");

    console.log(`- ${name}`);
    console.log(`  calls=${b.total} fail=${b.fail} failRate=${failRate}% p50=${p50}ms p95=${p95}ms max=${max}ms`);
    console.log(`  statuses: ${statusLine || "(none)"}`);
  }
}

function endpointStatsObject(metrics) {
  const out = {};
  const names = Object.keys(metrics.endpoints || {});
  for (const name of names) {
    const b = metrics.endpoints[name];
    out[name] = {
      calls: Number(b.total || 0),
      fail: Number(b.fail || 0),
      failRate: b.total ? (b.fail / b.total) : 0,
      p50Ms: percentile(b.times || [], 50),
      p95Ms: percentile(b.times || [], 95),
      maxMs: Math.max(0, ...((b.times || []).map((x) => Number(x) || 0))),
      statuses: Object.fromEntries([...(b.statuses || new Map()).entries()].map(([k, v]) => [String(k), Number(v || 0)])),
    };
  }
  return out;
}

async function main() {
  const cfg = parseArgs(process.argv);
  if (!cfg.linksFile) {
    console.error("Missing --links file path (txt/csv/xlsx with candidate links or tokens)");
    process.exit(2);
    return;
  }

  const tokens = Array.from(new Set(loadTokensFromFile(cfg.linksFile, { strictExamLinks: cfg.strictExamLinks }).map((x) => String(x || "").trim()).filter(Boolean)));
  if (!tokens.length) {
    console.error("No valid tokens found in links file");
    process.exit(2);
    return;
  }

  console.log("=== Stress Candidates ===");
  console.log(`baseUrl      : ${cfg.baseUrl}`);
  console.log(`linksFile     : ${cfg.linksFile}`);
  console.log(`tokens        : ${tokens.length}`);
  console.log(`concurrency   : ${cfg.concurrency}`);
  console.log(`duration min  : ${cfg.durationMinutes}`);
  console.log(`flow mode     : ${cfg.realisticFlow ? "realistic-phased" : "simple"}`);
  console.log(`presence ping : ${cfg.withPresence ? "on" : "off"}`);
  console.log(`listening     : ${cfg.withListening ? `on (${cfg.listeningActions} actions, ${cfg.listeningIntervalSec}s)` : "off"}`);
  console.log(`snapshots     : ${cfg.withSnapshots ? `on (${cfg.snapshotCount} x ${cfg.snapshotSizeKb}KB)` : "off"}`);
  console.log(`timeout (ms)  : ${cfg.timeoutMs}`);
  console.log(`strict links  : ${cfg.strictExamLinks ? "exam-only" : "auto"}`);
  if (cfg.realisticFlow) {
    console.log(`phases        : play ${cfg.playStartMinute}-${cfg.playEndMinute}m ; wait ${cfg.audioWaitMinutes}m ; answer ${cfg.answerPhaseMinutes}m ; submit-window ${cfg.submitWindowMinutes}m`);
  }

  const metrics = { endpoints: {} };
  const startedAt = performance.now();

  const results = await runPool(tokens, cfg.concurrency, async (token) => {
    return runCandidateFlow(
      {
        baseUrl: cfg.baseUrl,
        token,
        timeoutMs: cfg.timeoutMs,
        withPresence: cfg.withPresence,
        withListening: cfg.withListening,
        withSnapshots: cfg.withSnapshots,
        realisticFlow: cfg.realisticFlow,
        snapshotCount: cfg.snapshotCount,
        snapshotSizeKb: cfg.snapshotSizeKb,
        durationMinutes: cfg.durationMinutes,
        presenceIntervalSec: cfg.presenceIntervalSec,
        listeningIntervalSec: cfg.listeningIntervalSec,
        listeningChunkKb: cfg.listeningChunkKb,
        listeningActions: cfg.listeningActions,
        playStartMinute: cfg.playStartMinute,
        playEndMinute: cfg.playEndMinute,
        audioWaitMinutes: cfg.audioWaitMinutes,
        answerPhaseMinutes: cfg.answerPhaseMinutes,
        submitWindowMinutes: cfg.submitWindowMinutes,
        ackVersion: cfg.ackVersion,
      },
      metrics
    );
  });

  const elapsed = performance.now() - startedAt;
  const total = results.length;
  const ok = results.filter((r) => r && r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r && r.skipped).length;
  const failed = results.filter((r) => !r || !r.ok).length;
  const failRate = total ? failed / total : 0;

  const topReasons = new Map();
  for (const r of results) {
    if (!r || r.ok) continue;
    const key = String(r.reason || "failed");
    topReasons.set(key, (topReasons.get(key) || 0) + 1);
  }

  console.log("\n=== Candidate Flow Summary ===");
  console.log(`total=${total} ok=${ok} skipped=${skipped} failed=${failed} failRate=${(failRate * 100).toFixed(2)}% elapsed=${(elapsed / 1000).toFixed(2)}s`);
  if (topReasons.size) {
    console.log("Top failure reasons:");
    for (const [reason, n] of [...topReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`- ${reason}: ${n}`);
    }
  }

  printEndpointStats(metrics);

  if (cfg.reportFile) {
    const reportPath = path.resolve(process.cwd(), String(cfg.reportFile));
    const report = {
      generatedAtUtc: new Date().toISOString(),
      config: {
        baseUrl: cfg.baseUrl,
        linksFile: cfg.linksFile,
        tokens: tokens.length,
        concurrency: cfg.concurrency,
        withPresence: cfg.withPresence,
        withListening: cfg.withListening,
        withSnapshots: cfg.withSnapshots,
        realisticFlow: cfg.realisticFlow,
        snapshotCount: cfg.snapshotCount,
        snapshotSizeKb: cfg.snapshotSizeKb,
        durationMinutes: cfg.durationMinutes,
        presenceIntervalSec: cfg.presenceIntervalSec,
        listeningIntervalSec: cfg.listeningIntervalSec,
        listeningChunkKb: cfg.listeningChunkKb,
        listeningActions: cfg.listeningActions,
        playStartMinute: cfg.playStartMinute,
        playEndMinute: cfg.playEndMinute,
        audioWaitMinutes: cfg.audioWaitMinutes,
        answerPhaseMinutes: cfg.answerPhaseMinutes,
        submitWindowMinutes: cfg.submitWindowMinutes,
        timeoutMs: cfg.timeoutMs,
        failRateThreshold: cfg.failRateThreshold,
        strictExamLinks: cfg.strictExamLinks,
      },
      summary: {
        total,
        ok,
        skipped,
        failed,
        failRate,
        elapsedSec: elapsed / 1000,
      },
      failureReasons: Object.fromEntries([...topReasons.entries()].map(([k, v]) => [k, v])),
      endpoints: endpointStatsObject(metrics),
    };
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`Report file: ${reportPath}`);
  }

  if (failRate > cfg.failRateThreshold) {
    console.error(`\nFAIL: flow failRate ${(failRate * 100).toFixed(2)}% is above threshold ${(cfg.failRateThreshold * 100).toFixed(2)}%`);
    process.exit(1);
    return;
  }

  console.log("\nPASS: fail rate is within threshold.");
}

main().catch((err) => {
  console.error("Fatal error:", err && err.stack ? err.stack : err);
  process.exit(1);
});
