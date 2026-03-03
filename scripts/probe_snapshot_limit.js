#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.PROBE_BASE_URL || "http://localhost:8080",
    linksFile: process.env.PROBE_LINKS_FILE || "",
    minKb: Number(process.env.PROBE_MIN_KB || 64),
    maxKb: Number(process.env.PROBE_MAX_KB || 2048),
    timeoutMs: Number(process.env.PROBE_TIMEOUT_MS || 25000),
    reportFile: process.env.PROBE_REPORT_FILE || "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] || "").trim();
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || String(next).startsWith("--")) continue;
    i += 1;
    if (key === "base-url") out.baseUrl = String(next);
    else if (key === "links") out.linksFile = String(next);
    else if (key === "min-kb") out.minKb = Number(next);
    else if (key === "max-kb") out.maxKb = Number(next);
    else if (key === "timeout-ms") out.timeoutMs = Number(next);
    else if (key === "report-file") out.reportFile = String(next);
  }
  out.baseUrl = String(out.baseUrl || "http://localhost:8080").replace(/\/+$/, "");
  if (!Number.isFinite(out.minKb) || out.minKb < 8) out.minKb = 8;
  if (!Number.isFinite(out.maxKb) || out.maxKb < out.minKb) out.maxKb = out.minKb;
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs < 1000) out.timeoutMs = 25000;
  out.minKb = Math.floor(out.minKb);
  out.maxKb = Math.floor(out.maxKb);
  return out;
}

function normalizeKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 _-]/g, "");
}

function tokenFromAny(v) {
  const raw = String(v || "").trim();
  if (!raw) return "";
  if (!/https?:\/\//i.test(raw) && !raw.includes("?")) {
    if (/^[A-Za-z0-9._~-]{8,}$/.test(raw)) return raw;
    return "";
  }
  try {
    const u = new URL(raw);
    return String(u.searchParams.get("token") || "").trim();
  } catch {
    return "";
  }
}

function loadTokens(filePath) {
  const abs = path.resolve(process.cwd(), String(filePath || ""));
  if (!fs.existsSync(abs)) throw new Error(`Links file not found: ${abs}`);
  const ext = path.extname(abs).toLowerCase();

  if (ext === ".xlsx" || ext === ".xls") {
    const wb = XLSX.readFile(abs);
    const sh = wb.SheetNames?.[0];
    if (!sh) return [];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sh], { defval: "" });
    const out = [];
    for (const row of rows) {
      const mapped = {};
      for (const [k, v] of Object.entries(row || {})) mapped[normalizeKey(k)] = v;
      let tok = tokenFromAny(mapped.token);
      if (!tok) tok = tokenFromAny(mapped.link || mapped.rawlink || mapped.url);
      if (!tok) tok = Object.values(mapped).map(tokenFromAny).find(Boolean) || "";
      if (tok) out.push(tok);
    }
    return Array.from(new Set(out));
  }

  const txt = fs.readFileSync(abs, "utf8");
  const lines = String(txt || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return Array.from(new Set(lines.map(tokenFromAny).filter(Boolean)));
}

function makePngLikeBlob(kb) {
  const bytes = Math.max(128, Math.floor(Number(kb) * 1024));
  const buf = Buffer.alloc(bytes, 0);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  sig.copy(buf, 0);
  for (let i = 8; i < bytes; i += 1024) {
    buf[i] = (i * 29) % 251;
  }
  return new Blob([buf], { type: "image/png" });
}

async function fetchJson(url, { method = "GET", body = undefined, timeoutMs = 25000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: { error: String(e?.message || e || "request_failed") } };
  } finally {
    clearTimeout(timer);
  }
}

async function uploadSnapshot(baseUrl, token, kb, timeoutMs) {
  const t = encodeURIComponent(String(token));
  const stamp = (() => {
    const d = new Date();
    const HH = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const DD = String(d.getDate()).padStart(2, "0");
    const MM = String(d.getMonth() + 1).padStart(2, "0");
    const YYYY = String(d.getFullYear());
    return `${HH}${mm}${ss}_${DD}${MM}_${YYYY}`;
  })();

  const fd = new FormData();
  fd.append("reason", "probe_limit");
  fd.append("titlePrefix", "SNAPSHOT");
  fd.append("stamp", stamp);
  fd.append("image", makePngLikeBlob(kb), "probe.png");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/session/${t}/snapshot`, {
      method: "POST",
      body: fd,
      signal: controller.signal,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: { error: String(e?.message || e || "request_failed") } };
  } finally {
    clearTimeout(timer);
  }
}

async function prepareToken(baseUrl, token, timeoutMs) {
  const t = encodeURIComponent(String(token));
  await fetchJson(`${baseUrl}/api/session/${t}`, { timeoutMs });
  await fetchJson(`${baseUrl}/api/session/${t}/proctoring-ack`, {
    method: "POST",
    timeoutMs,
    body: { noticeVersion: "snapshot_probe" },
  });
  await fetchJson(`${baseUrl}/api/session/${t}/start`, { method: "POST", timeoutMs, body: {} });
}

async function main() {
  const cfg = parseArgs(process.argv);
  if (!cfg.linksFile) {
    console.error("Missing --links file path");
    process.exit(2);
    return;
  }

  const tokens = loadTokens(cfg.linksFile);
  if (!tokens.length) {
    console.error("No tokens found in links file");
    process.exit(2);
    return;
  }

  console.log("=== Snapshot Upload Limit Probe ===");
  console.log(`baseUrl   : ${cfg.baseUrl}`);
  console.log(`linksFile : ${cfg.linksFile}`);
  console.log(`tokens    : ${tokens.length}`);
  console.log(`range KB  : ${cfg.minKb}..${cfg.maxKb}`);

  let lo = cfg.minKb;
  let hi = cfg.maxKb;
  let bestOk = 0;
  let firstFail = null;
  const attempts = [];
  let tokenIdx = 0;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const token = tokens[tokenIdx % tokens.length];
    tokenIdx += 1;

    await prepareToken(cfg.baseUrl, token, cfg.timeoutMs);
    const r = await uploadSnapshot(cfg.baseUrl, token, mid, cfg.timeoutMs);
    attempts.push({ kb: mid, status: r.status, ok: !!r.ok, error: String(r?.json?.error || "") });

    console.log(`probe ${mid}KB -> status ${r.status} (${r.ok ? "ok" : "fail"})`);

    if (r.ok) {
      bestOk = Math.max(bestOk, mid);
      lo = mid + 1;
      continue;
    }

    if (r.status === 413 || r.status === 0) {
      if (firstFail == null || mid < firstFail) firstFail = mid;
      hi = mid - 1;
      continue;
    }

    // Non-size failure: keep record and continue reducing to find stable floor.
    hi = mid - 1;
  }

  const summary = {
    baseUrl: cfg.baseUrl,
    linksFile: cfg.linksFile,
    tokens: tokens.length,
    testedRangeKb: [cfg.minKb, cfg.maxKb],
    bestAcceptedKb: bestOk || null,
    firstRejectedKb: firstFail,
    attempts,
  };

  console.log("\n=== Probe Summary ===");
  console.log(`bestAcceptedKb : ${summary.bestAcceptedKb ?? "none"}`);
  console.log(`firstRejectedKb: ${summary.firstRejectedKb ?? "none"}`);

  if (cfg.reportFile) {
    const outPath = path.resolve(process.cwd(), cfg.reportFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf8");
    console.log(`report: ${outPath}`);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e?.stack || e);
  process.exit(1);
});
