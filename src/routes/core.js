const path = require("path");
const express = require("express");

module.exports = function registerCoreRoutes(app, ctx) {
  const { ensureInit, DB, hasPg, adminAuth, examinerAuth, rootDir } = ctx || {};
  if (!app) throw new Error("core_routes_missing_app");
  if (!ensureInit || !DB || hasPg === undefined || !adminAuth || !examinerAuth || !rootDir) {
    throw new Error("core_routes_missing_ctx");
  }

  const legacyPageRedirects = new Map([
    ["/", "/admin/login.html"],
    ["/index.html", "/admin/login.html"],
    ["/admin.html", "/admin/"],
    ["/admin-files.html", "/admin/files.html"],
    ["/admin-tests.html", "/admin/tests.html"],
    ["/admin-test-preview.html", "/admin/test-preview.html"],
    ["/candidates.html", "/candidates/"],
    ["/candidates2.html", "/examiners/candidates.html"],
    ["/examiners.html", "/examiners/"],
    ["/meeting.html", "/meetings/manual.html"],
    ["/meeting-livekit.html", "/meetings/livekit.html"],
    ["/speaking.html", "/speaking/"],
    ["/speaking-scheduling.html", "/speaking/scheduling.html"],
    ["/exam.html", "/exam/"],
  ]);

  app.use((req, res, next) => {
    const target = legacyPageRedirects.get(req.path);
    if (!target) return next();
    const suffix = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    return res.redirect(302, `${target}${suffix}`);
  });

  // Guard admin UI file (server-side). API routes are guarded per-endpoint.
  app.use(async (req, res, next) => {
    if (!["/admin/", "/admin/index.html", "/admin/files.html", "/admin/tests.html", "/speaking/scheduling.html"].includes(req.path)) {
      return next();
    }
    const a = await adminAuth(req, res);
    if (a.ok) return next();
    return res.redirect("/admin/login.html");
  });

  // Guard examiner UI file (server-side).
  app.use(async (req, res, next) => {
    if (req.path !== "/examiners/candidates.html") return next();
    const a = await examinerAuth(req, res);
    if (a.ok) return next();
    return res.redirect("/examiners/");
  });

  // Best-effort: discourage built-in browser translation on the candidate exam page.
  app.use((req, res, next) => {
    if (req.path !== "/exam/" && req.path !== "/exam/index.html") return next();
    res.setHeader("Content-Language", "en");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
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
