const path = require("path");
const express = require("express");

module.exports = function registerCoreRoutes(app, ctx) {
  const { ensureInit, DB, hasPg, adminAuth, examinerAuth, rootDir } = ctx || {};
  if (!app) throw new Error("core_routes_missing_app");
  if (!ensureInit || !DB || hasPg === undefined || !adminAuth || !examinerAuth || !rootDir) {
    throw new Error("core_routes_missing_ctx");
  }

  // Guard admin UI file (server-side). API routes are guarded per-endpoint.
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
  app.use(express.static(path.join(rootDir, "public")));

  // Health
  app.get("/health", async (req, res) => {
    await ensureInit();
    res.json({ ok: true, db: hasPg ? "postgres" : "sqlite" });
  });

  // Public config
  app.get("/api/config", async (req, res) => {
    await ensureInit();
    const clampInt = (n, min, max) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return null;
      return Math.max(min, Math.min(max, Math.floor(v)));
    };
    const importSmoothSteps = clampInt(process.env.IMPORT_PROGRESS_SMOOTH_STEPS, 0, 200);

    const base = DB.getConfig() || {};
    res.json({
      ...base,
      adminUi: {
        // Default off: show real progress only.
        importSmoothSteps: importSmoothSteps === null ? 0 : importSmoothSteps,
      },
    });
  });
};
