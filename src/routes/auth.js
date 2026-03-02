module.exports = function registerAuthRoutes(app, ctx) {
  const {
    ensureInit,
    DB,
    rateLimitLogin,
    createAdminToken,
    setAuthCookie,
    clearAuthCookie,
    getCookieAdmin,
    rateLimitExaminerLogin,
    createExaminerToken,
    setExaminerAuthCookie,
    clearExaminerAuthCookie,
    examinerCookieAuth,
  } = ctx || {};

  if (!app) throw new Error("auth_routes_missing_app");
  if (
    !ensureInit ||
    !DB ||
    !rateLimitLogin ||
    !createAdminToken ||
    !setAuthCookie ||
    !clearAuthCookie ||
    !getCookieAdmin ||
    !rateLimitExaminerLogin ||
    !createExaminerToken ||
    !setExaminerAuthCookie ||
    !clearExaminerAuthCookie ||
    !examinerCookieAuth
  ) {
    throw new Error("auth_routes_missing_ctx");
  }

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
};

