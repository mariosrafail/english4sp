module.exports = function registerAdminTestsRoutes(app, ctx) {
  const {
    ensureInit,
    adminAuth,
    DB,
    Storage,
    uploadListeningAudio,
    multer,
    normalizeAdminTestPayload,
  } = ctx || {};

  if (!app) throw new Error("admin_tests_routes_missing_app");
  if (!ensureInit || !adminAuth || !DB || !Storage || !uploadListeningAudio || !multer || !normalizeAdminTestPayload) {
    throw new Error("admin_tests_routes_missing_ctx");
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
};

