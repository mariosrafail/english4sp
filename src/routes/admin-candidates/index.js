const { createAdminCandidatesHelpers } = require("./helpers");
const { createAdminCandidateReviewHelpers } = require("./review");

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

  const {
    importJobs,
    softWrapText,
    pruneImportJobs,
    importJobPublic,
    parseCandidateRowsFromWorkbookBuffer,
    buildCandidatesExportXlsx,
    runImportJob,
    deleteSnapshotFilesBySessionId,
    deleteAllSnapshotFilesFromStorage,
    createImportJob,
  } = createAdminCandidatesHelpers({
    DB,
    Storage,
    XLSX,
    ExcelJS,
    getPublicBase,
    ensureSpeakingSlotForSession,
  });

  const {
    getCandidateDetails,
    buildCandidatesExportBuffer,
    bulkDeleteSessions,
    deleteSingleSession,
  } = createAdminCandidateReviewHelpers({
    DB,
    ExcelJS,
    parseAnswersJson,
    buildReviewItems,
    getTestPayloadFull,
    softWrapText,
    deleteSnapshotFilesBySessionId,
  });

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

    const parsed = parseCandidateRowsFromWorkbookBuffer(req.file.buffer);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const job = createImportJob({
      examPeriodId,
      rows: parsed.rows,
      req,
    });
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

  app.post("/api/admin/import-excel", upload.single("file"), async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

    const examPeriodId = Number(req.body?.examPeriodId || 1);
    if (!Number.isFinite(examPeriodId) || examPeriodId <= 0) {
      return res.status(400).json({ error: "Invalid exam period id" });
    }
    if (!req.file?.buffer) return res.status(400).json({ error: "Missing file" });

    const parsed = parseCandidateRowsFromWorkbookBuffer(req.file.buffer);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const created = await DB.importCandidatesAndCreateSessions({
      rows: parsed.rows,
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

    const built = await buildCandidatesExportXlsx({
      created,
      examPeriodId,
      publicBase: getPublicBase(req),
    });
    const buf = built.buffer;

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

    const speakingUrl = `${getPublicBase(req)}/speaking/?token=${encodeURIComponent(String(s.token || ""))}`;
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
    const url = `${base}/exam/?token=${s.token}&sid=${s.sessionId}`;

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

  app.put("/api/admin/candidates/:sessionId/examiner", async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    if (typeof DB.setSessionAssignedExaminer !== "function") {
      return res.status(501).json({ error: "Not supported on this database adapter" });
    }

    const sid = Number(req.params.sessionId);
    if (!Number.isFinite(sid) || sid <= 0) {
      return res.status(400).json({ error: "Invalid session id" });
    }

    const examinerUsername = String(req.body?.examinerUsername || "").trim();
    if (!examinerUsername) {
      return res.status(400).json({ error: "Invalid examiner username" });
    }

    try {
      const out = await DB.setSessionAssignedExaminer({ sessionId: sid, examinerUsername });
      const rows = await DB.listCandidates();
      const row = Array.isArray(rows) ? rows.find((x) => Number(x?.sessionId || 0) === sid) : null;
      return res.json({
        ok: true,
        sessionId: sid,
        examinerUsername: String(out?.examinerUsername || examinerUsername),
        row: row || null,
      });
    } catch (e) {
      return res.status(400).json({ error: e?.message || "set_session_examiner_failed" });
    }
  });

  app.get("/api/admin/candidates/:sessionId/details", async (req, res) => {
    try {
      await ensureInit();
      const a = await adminAuth(req, res);
      if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

      const details = await getCandidateDetails(req.params.sessionId);
      if (!details.ok) return res.status(details.status || 500).json({ error: details.error || "details_failed" });
      res.json(details.data);
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

    const built = await buildCandidatesExportBuffer({
      rows: req.body?.rows,
      includeDetailed: !!req.body?.includeDetailed,
      scope: req.body?.scope,
    });
    if (!built.ok) return res.status(built.status || 500).json({ error: built.error || "export_failed" });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename=\"${built.filename}\"`);
    res.send(built.buffer);
  });

  app.post("/api/admin/delete-all-data", async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

    const snapshotStorage = await deleteAllSnapshotFilesFromStorage();
    await DB.deleteAllCoreData();
    res.json({ ok: true, snapshotStorage });
  });

  app.post("/api/admin/candidates/bulk-delete", async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    const result = await bulkDeleteSessions(req.body?.sessionIds);
    if (!result.ok) return res.status(result.status || 500).json({ error: result.error || "delete_failed" });
    res.json(result.data);
  });

  app.delete("/api/admin/candidates/:sessionId", async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

    const result = await deleteSingleSession(req.params.sessionId);
    if (!result.ok) return res.status(result.status || 500).json({ error: result.error || "delete_failed" });
    res.json(result.data);
  });
};
