const fs = require("fs");
const path = require("path");

function createAdminCandidatesHelpers(deps) {
  const {
    DB,
    Storage,
    XLSX,
    ExcelJS,
    getPublicBase,
    ensureSpeakingSlotForSession,
  } = deps || {};

  const importJobs = new Map();

  function normHeader(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^a-z0-9 _-]/g, "");
  }

  function pickCell(row, keys) {
    if (!row) return "";
    for (const k of keys || []) {
      const kk = normHeader(k);
      if (Object.prototype.hasOwnProperty.call(row, kk)) return row[kk];
    }
    return "";
  }

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

  function clampInt(n, min, max) {
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    return Math.max(min, Math.min(max, Math.floor(v)));
  }

  function speakingImportConcurrency() {
    const v = clampInt(process.env.SPEAKING_IMPORT_CONCURRENCY, 1, 12);
    return v || 5;
  }

  function makeImportJobId() {
    return `${Date.now()}_${Math.random().toString(16).slice(2)}_${Math.random().toString(16).slice(2)}`;
  }

  function pruneImportJobs() {
    const now = Date.now();
    const TTL_MS = 20 * 60 * 1000;
    for (const [id, j] of importJobs.entries()) {
      const createdAt = Number(j?.createdAtUtcMs || 0);
      const doneAt = Number(j?.doneAtUtcMs || 0);
      const base = doneAt || createdAt;
      const age = base ? (now - base) : (TTL_MS + 1);
      if (age > TTL_MS) importJobs.delete(id);
    }
  }

  function importJobPublic(job) {
    const j = job && typeof job === "object" ? job : {};
    return {
      jobId: String(j.jobId || ""),
      examPeriodId: Number(j.examPeriodId || 0) || null,
      phase: String(j.phase || "queued"),
      processed: Number(j.processed || 0),
      total: Number(j.total || 0),
      done: !!j.done,
      error: String(j.error || ""),
      speakingCreated: Number(j.speakingCreated || 0),
      speakingFailed: Number(j.speakingFailed || 0),
      speakingError: String(j.speakingError || ""),
    };
  }

  function parseCandidateRowsFromWorkbookBuffer(buffer) {
    let workbook;
    try {
      workbook = XLSX.read(buffer, { type: "buffer" });
    } catch {
      return { ok: false, error: "Invalid Excel file" };
    }
    const sheetName = workbook.SheetNames?.[0];
    if (!sheetName) return { ok: false, error: "No sheets found" };
    const ws = workbook.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(ws, { defval: "" });

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
    if (!rows.length) return { ok: false, error: "No valid rows. Email is required." };
    return { ok: true, rows };
  }

  async function buildCandidatesExportXlsx({ created, examPeriodId, publicBase }) {
    const ep = Number(examPeriodId || 1) || 1;
    const base = String(publicBase || "").trim();

    const exportRows = (created?.sessions || []).map((s) => {
      const url = `${base}/exam/?token=${s.token}&sid=${s.sessionId}`;
      const speakingUrl = `${base}/speaking/?token=${encodeURIComponent(String(s.token || ""))}`;
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
    const filename = `sessions_examperiod_${ep}.xlsx`;
    return { buffer: buf, filename };
  }

  async function runImportJob(job) {
    const jobId = String(job?.jobId || "");
    if (!jobId) return;

    async function runPool(items, concurrency, worker) {
      const list = Array.isArray(items) ? items : [];
      const concRaw = Number(concurrency);
      const conc = Number.isFinite(concRaw) && concRaw > 0 ? Math.max(1, Math.min(12, Math.floor(concRaw))) : 4;
      let idx = 0;
      const runners = new Array(Math.min(conc, list.length)).fill(0).map(async () => {
        while (idx < list.length) {
          const i = idx;
          idx += 1;
          await worker(list[i], i);
        }
      });
      await Promise.all(runners);
    }

    try {
      pruneImportJobs();
      job.phase = "importing";
      job.processed = 0;
      job.done = false;
      job.error = "";

      const created = await DB.importCandidatesAndCreateSessions({
        rows: job.rows,
        examPeriodId: job.examPeriodId,
        assignmentStrategy: "batch_even",
        onProgress: (p) => {
          if (!importJobs.has(jobId)) return;
          job.processed = Math.max(Number(job.processed || 0), Number(p?.processed || 0));
          job.total = Number(p?.total || job.total || 0);
          const ph = String(p?.phase || "").trim();
          if (ph) job.phase = ph;
        },
      });

      job.phase = "speaking";
      job.processed = 0;
      const createdSessions = Array.isArray(created?.sessions) ? created.sessions : [];
      job.total = createdSessions.length;
      job.speakingCreated = 0;
      job.speakingFailed = 0;
      job.speakingError = "";

      if (typeof ensureSpeakingSlotForSession === "function") {
        const ep = Number(job.examPeriodId || 1) || 1;
        const SPEAKING_CONCURRENCY = speakingImportConcurrency();
        await runPool(createdSessions, SPEAKING_CONCURRENCY, async (s) => {
          try {
            const out = await ensureSpeakingSlotForSession(s, ep);
            if (out?.ok && out?.created) job.speakingCreated += 1;
            if (out?.ok === false && !out?.skipped) {
              job.speakingFailed += 1;
              if (!job.speakingError) job.speakingError = String(out?.error || "speaking_slot_create_failed");
            }
          } catch (e) {
            job.speakingFailed += 1;
            if (!job.speakingError) job.speakingError = String(e?.message || "speaking_slot_create_failed");
          } finally {
            job.processed = Math.min(job.total, Number(job.processed || 0) + 1);
          }
        });
      } else {
        job.processed = job.total;
      }

      job.phase = "exporting";
      const built = await buildCandidatesExportXlsx({
        created,
        examPeriodId: job.examPeriodId,
        publicBase: job.publicBase,
      });
      job.resultBuffer = built.buffer;
      job.resultFilename = built.filename;

      job.phase = "done";
      job.done = true;
      job.doneAtUtcMs = Date.now();
    } catch (e) {
      job.phase = "error";
      job.done = true;
      job.error = String(e?.message || "import_failed");
      job.doneAtUtcMs = Date.now();
    } finally {
      pruneImportJobs();
    }
  }

  async function deleteSnapshotFilesBySessionId(sessionId) {
    const sid = Number(sessionId);
    if (!Number.isFinite(sid) || sid <= 0) return { ok: false, deleted: 0, errors: [{ error: "invalid_session_id" }] };
    if (typeof DB.listSessionSnapshots !== "function") return { ok: true, deleted: 0, errors: [] };

    let snaps = [];
    try {
      snaps = await DB.listSessionSnapshots({ sessionId: sid, limit: 2000 });
    } catch (e) {
      return { ok: false, deleted: 0, errors: [{ error: String(e?.message || "snapshot_list_failed") }] };
    }

    const paths = Array.from(
      new Set(
        (snaps || [])
          .map((r) => String(r?.remotePath || "").trim())
          .filter(Boolean)
      )
    );
    if (!paths.length) return { ok: true, deleted: 0, errors: [] };

    const dirsToTry = Array.from(
      new Set(
        paths
          .map((p) => String(p || "").trim().replace(/\\/g, "/"))
          .map((p) => p.split("/").slice(0, -1).join("/"))
          .filter(Boolean)
      )
    ).sort((a, b) => b.length - a.length);

    const settled = await Promise.allSettled(paths.map((p) => Storage.deleteFile(p)));
    let deleted = 0;
    const errors = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      const p = paths[i];
      if (r.status === "fulfilled") {
        if (r.value) deleted += 1;
      } else {
        errors.push({ path: p, error: String(r.reason?.message || r.reason || "delete_failed") });
      }
    }

    for (const relDir of dirsToTry) {
      try {
        if (typeof Storage.resolvePath !== "function") break;
        const resolved = Storage.resolvePath(relDir);
        const absDir = String(resolved?.abs || "");
        const baseDir = String(resolved?.base || "");
        if (!absDir || !baseDir) continue;
        if (!absDir.startsWith(baseDir)) continue;
        const entries = await fs.promises.readdir(absDir).catch((e) => {
          if (e && e.code === "ENOENT") return null;
          throw e;
        });
        if (entries === null) continue;
        if (entries.length > 0) continue;
        await fs.promises.rmdir(absDir).catch((e) => {
          if (e && (e.code === "ENOENT" || e.code === "ENOTEMPTY")) return;
          throw e;
        });
      } catch (e) {
        errors.push({ path: relDir, error: String(e?.message || "delete_empty_dir_failed") });
      }
    }

    return { ok: errors.length === 0, deleted, errors };
  }

  async function deleteAllSnapshotFilesFromStorage() {
    let abs = "";
    try {
      if (typeof Storage.resolvePath === "function") {
        const p = Storage.resolvePath("snapshots");
        abs = String(p?.abs || "");
      }
    } catch {}

    if (!abs) {
      try {
        if (typeof Storage.storageBaseDir === "function") {
          abs = path.join(Storage.storageBaseDir(), "snapshots");
        }
      } catch {}
    }

    if (!abs) {
      return { ok: false, path: "", deleted: false, error: "snapshot_storage_path_unavailable" };
    }

    try {
      fs.rmSync(abs, { recursive: true, force: true });
      return { ok: true, path: abs, deleted: true };
    } catch (e) {
      return { ok: false, path: abs, deleted: false, error: String(e?.message || "snapshot_storage_delete_failed") };
    }
  }

  function createImportJob({ examPeriodId, rows, req }) {
    const jobId = makeImportJobId();
    const job = {
      jobId,
      createdAtUtcMs: Date.now(),
      doneAtUtcMs: 0,
      phase: "queued",
      processed: 0,
      total: Array.isArray(rows) ? rows.length : 0,
      done: false,
      error: "",
      examPeriodId,
      publicBase: getPublicBase(req),
      rows: Array.isArray(rows) ? rows : [],
      resultBuffer: null,
      resultFilename: "",
      speakingCreated: 0,
      speakingFailed: 0,
      speakingError: "",
    };
    importJobs.set(jobId, job);
    return job;
  }

  return {
    importJobs,
    normHeader,
    pickCell,
    softWrapText,
    pruneImportJobs,
    importJobPublic,
    parseCandidateRowsFromWorkbookBuffer,
    buildCandidatesExportXlsx,
    runImportJob,
    deleteSnapshotFilesBySessionId,
    deleteAllSnapshotFilesFromStorage,
    createImportJob,
  };
}

module.exports = {
  createAdminCandidatesHelpers,
};
