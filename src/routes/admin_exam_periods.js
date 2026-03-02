module.exports = function registerAdminExamPeriodsRoutes(app, ctx) {
  const { ensureInit, adminAuth, DB, getPublicBase } = ctx || {};
  if (!app) throw new Error("admin_exam_periods_routes_missing_app");
  if (!ensureInit || !adminAuth || !DB || !getPublicBase) throw new Error("admin_exam_periods_routes_missing_ctx");

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
};

