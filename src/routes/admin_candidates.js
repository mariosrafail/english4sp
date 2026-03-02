module.exports = function registerAdminCandidatesRoutes(app, ctx) {
  const {
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
  } = ctx || {};

  if (!app) throw new Error("admin_candidates_routes_missing_app");
  if (
    !ensureInit ||
    !adminAuth ||
    !DB ||
    !Storage ||
    !upload ||
    !XLSX ||
    !ExcelJS ||
    !getPublicBase ||
    !parseAnswersJson ||
    !buildReviewItems ||
    !getTestPayloadFull
  ) {
    throw new Error("admin_candidates_routes_missing_ctx");
  }

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

  const importJobs = new Map(); // jobId -> job

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

  async function buildCandidatesExportXlsx({ created, examPeriodId, publicBase }) {
    const ep = Number(examPeriodId || 1) || 1;
    const base = String(publicBase || "").trim();

    const exportRows = (created?.sessions || []).map((s) => {
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

      // Speaking slots + meeting links for the imported sessions only (with progress).
      job.phase = "speaking";
      job.processed = 0;
      const createdSessions = Array.isArray(created?.sessions) ? created.sessions : [];
      job.total = createdSessions.length;
      job.speakingCreated = 0;
      job.speakingFailed = 0;
      job.speakingError = "";

      if (typeof ensureSpeakingSlotForSession === "function") {
        const ep = Number(job.examPeriodId || 1) || 1;
        // Concurrency speeds up meeting/link creation (network-bound) without overloading providers.
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
        // Not available on this adapter/config.
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

  app.post("/api/admin/import-excel/job/start", upload.single("file"), async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

    const examPeriodId = Number(req.body?.examPeriodId || 1);
    if (!Number.isFinite(examPeriodId) || examPeriodId <= 0) {
      return res.status(400).json({ error: "Invalid exam period id" });
    }
    if (!req.file?.buffer) return res.status(400).json({ error: "Missing file" });

    pruneImportJobs();

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

    const jobId = makeImportJobId();
    const job = {
      jobId,
      createdAtUtcMs: Date.now(),
      doneAtUtcMs: 0,
      phase: "queued",
      processed: 0,
      total: rows.length,
      done: false,
      error: "",
      examPeriodId,
      publicBase: getPublicBase(req),
      rows,
      resultBuffer: null,
      resultFilename: "",
      speakingCreated: 0,
      speakingFailed: 0,
      speakingError: "",
    };

    importJobs.set(jobId, job);
    setTimeout(() => { void runImportJob(job); }, 0);

    res.json({ ok: true, job: importJobPublic(job) });
  });

  app.get("/api/admin/import-excel/job/:jobId", async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

    pruneImportJobs();
    const jobId = String(req.params.jobId || "").trim();
    const job = importJobs.get(jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ ok: true, job: importJobPublic(job) });
  });

  app.get("/api/admin/import-excel/job/:jobId/download", async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

    pruneImportJobs();
    const jobId = String(req.params.jobId || "").trim();
    const job = importJobs.get(jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (!job.done) return res.status(409).json({ error: "Job not finished" });
    if (job.phase === "error" || job.error) return res.status(400).json({ error: job.error || "import_failed" });
    if (!job.resultBuffer) return res.status(404).json({ error: "No export available" });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${String(job.resultFilename || "sessions.xlsx").replace(/[^A-Za-z0-9._-]/g, "_")}"`
    );
    res.send(Buffer.from(job.resultBuffer));
  });

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
    return { ok: errors.length === 0, deleted, errors };
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
      if (autoGenerateSpeakingSlotsForExamPeriod && DB.listSessionsMissingSpeakingSlot && DB.createSpeakingSlot) {
        speakingAuto = await autoGenerateSpeakingSlotsForExamPeriod(examPeriodId, { maxErrors: 100 });
      }
    } catch (e) {
      speakingAutoError = String(e?.message || "speaking_auto_generate_failed");
      console.warn("[import-excel] speaking auto-generate failed:", speakingAutoError);
    }

    const base = getPublicBase(req);
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
      if (ensureSpeakingSlotForSession) {
        speakingAuto = await ensureSpeakingSlotForSession(s, Number(s.examPeriodId || examPeriodId));
        if (!speakingAuto?.ok && !speakingAuto?.skipped) {
          speakingAutoError = String(speakingAuto?.error || "speaking_slot_create_failed");
        }
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
    try {
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
    } catch (e) {
      console.error("admin_candidate_details_error", {
        sessionId: Number(req.params.sessionId || 0) || null,
        error: String(e?.message || e || "details_failed"),
      });
      res.status(500).json({ error: "details_failed" });
    }
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

    const payloadCache = new Map();
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
      try {
        qg = await DB.getQuestionGrades(sid);
      } catch {}
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
    if (typeof DB.deleteSessionById !== "function") {
      return res.status(501).json({ error: "Not supported on this DB adapter" });
    }

    const idsRaw = Array.isArray(req.body?.sessionIds) ? req.body.sessionIds : [];
    const ids = Array.from(new Set(idsRaw.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)));
    if (!ids.length) return res.status(400).json({ error: "No sessionIds provided" });

    let okCount = 0;
    let failCount = 0;
    const errors = [];
    for (const sid of ids) {
      try {
        const snap = await deleteSnapshotFilesBySessionId(sid);
        const out = await DB.deleteSessionById(sid);
        if (out?.ok) okCount += 1;
        else failCount += 1;
        for (const e of snap?.errors || []) errors.push({ sessionId: sid, ...e });
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

  app.delete("/api/admin/candidates/:sessionId", async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

    const sessionId = Number(req.params.sessionId);
    if (typeof DB.deleteSessionById !== "function") {
      return res.status(501).json({ error: "Not supported on this DB adapter" });
    }

    const snap = await deleteSnapshotFilesBySessionId(sessionId);
    const out = await DB.deleteSessionById(sessionId);
    if (!out?.ok) return res.status(404).json({ error: "Session not found" });
    res.json({
      ...out,
      snapshotDeleted: Number(snap?.deleted || 0),
      snapshotDeleteErrors: (snap?.errors || []).slice(0, 25),
    });
  });
};
