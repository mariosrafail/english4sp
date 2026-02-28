const path = require("path");

module.exports = function registerAdminFilesRoutes(app, ctx) {
  const { ensureInit, adminAuth, DB, Storage, streamFileWithRange } = ctx || {};
  if (!app) throw new Error("admin_files_routes_missing_app");
  if (!ensureInit || !adminAuth || !DB || !Storage || !streamFileWithRange) throw new Error("admin_files_routes_missing_ctx");

  app.get("/api/admin/files/index", async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    if (!DB.listExamPeriods) return res.status(501).json({ error: "Not supported on this database adapter" });

    const eps = await DB.listExamPeriods();
    const examPeriods = Array.isArray(eps) ? eps : [];
    const epNameById = new Map(
      examPeriods
        .map((ep) => {
          const id = Number(ep?.id || 0);
          if (!Number.isFinite(id) || id <= 0) return null;
          const name = String(ep?.name || "").trim() || `Exam period ${id}`;
          return [id, name];
        })
        .filter(Boolean)
    );

    const listening = [];
    for (const ep of examPeriods) {
      const id = Number(ep?.id || 0);
      if (!Number.isFinite(id) || id <= 0) continue;
      const relPath = `listening/ep_${id}/listening.mp3`;
      const st = await Storage.statFile(relPath);
      listening.push({
        examPeriodId: id,
        examPeriodName: String(ep?.name || `Exam period ${id}`),
        relPath,
        exists: !!st.exists,
        size: st.exists ? st.size : 0,
        mtimeMs: st.exists ? st.mtimeMs : 0,
        url: st.exists ? `/api/admin/files/download?path=${encodeURIComponent(relPath)}` : "",
      });
    }

    const snaps = DB.listSessionSnapshots ? await DB.listSessionSnapshots({ limit: 500 }) : [];
    const snapshots = [];
    for (const s of (Array.isArray(snaps) ? snaps : [])) {
      const relPath = String(s?.remotePath || "");
      let st = null;
      try {
        st = relPath ? await Storage.statFile(relPath) : null;
      } catch {
        st = null;
      }
      const exists = !!(st && st.exists);
      const examPeriodId = Number(s?.examPeriodId || 0) || null;
      snapshots.push({
        id: Number(s?.id || 0) || null,
        sessionId: Number(s?.sessionId || 0) || null,
        token: String(s?.token || ""),
        candidateName: String(s?.candidateName || ""),
        examPeriodId,
        examPeriodName: examPeriodId ? String(epNameById.get(examPeriodId) || "") : "",
        submitted: !!(s && (s.submitted === true || Number(s.submitted) === 1)),
        reason: String(s?.reason || ""),
        createdAtUtcMs: Number(s?.createdAtUtcMs || 0) || 0,
        relPath,
        exists,
        size: exists ? st.size : 0,
        mtimeMs: exists ? st.mtimeMs : 0,
        url: exists ? `/api/admin/files/download?path=${encodeURIComponent(relPath)}` : "",
      });
    }

    const sessionRows = DB.listSnapshotSessions ? await DB.listSnapshotSessions({ limit: 20000 }) : [];
    const snapshotSessions = (Array.isArray(sessionRows) ? sessionRows : []).map((r) => {
      const examPeriodId = Number(r?.examPeriodId || 0) || null;
      return {
        sessionId: Number(r?.sessionId || 0) || null,
        token: String(r?.token || ""),
        candidateName: String(r?.candidateName || ""),
        examPeriodId,
        examPeriodName: examPeriodId ? String(epNameById.get(examPeriodId) || "") : "",
        submitted: !!(r && (r.submitted === true || Number(r.submitted) === 1)),
        snapshotCount: Number(r?.snapshotCount || 0) || 0,
        latestSnapshotUtcMs: Number(r?.latestSnapshotUtcMs || 0) || 0,
      };
    });

    res.json({ ok: true, listening, snapshots, snapshotSessions });
  });

  app.get("/api/admin/files/snapshots", async (req, res) => {
    try {
      await ensureInit();
      const a = await adminAuth(req, res);
      if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
      if (!DB.listSessionSnapshots || !DB.listExamPeriods) return res.status(501).json({ error: "Not supported on this database adapter" });

      const sessionId = Number(req.query?.sessionId || 0);
      if (!Number.isFinite(sessionId) || sessionId <= 0) return res.status(400).json({ error: "invalid_session_id" });
      const lim = Number(req.query?.limit || 200);
      const limit = Number.isFinite(lim) && lim > 0 ? Math.min(2000, Math.round(lim)) : 200;

      const eps = await DB.listExamPeriods();
      const examPeriods = Array.isArray(eps) ? eps : [];
      const epNameById = new Map(
        examPeriods
          .map((ep) => {
            const id = Number(ep?.id || 0);
            if (!Number.isFinite(id) || id <= 0) return null;
            const name = String(ep?.name || "").trim() || `Exam period ${id}`;
            return [id, name];
          })
          .filter(Boolean)
      );

      const snaps = await DB.listSessionSnapshots({ sessionId, limit });
      const out = [];
      for (const s of (Array.isArray(snaps) ? snaps : [])) {
        const relPath = String(s?.remotePath || "");
        let st = null;
        try {
          st = relPath ? await Storage.statFile(relPath) : null;
        } catch {
          st = null;
        }
        const exists = !!(st && st.exists);
        const examPeriodId = Number(s?.examPeriodId || 0) || null;
        out.push({
          id: Number(s?.id || 0) || null,
          sessionId: Number(s?.sessionId || 0) || null,
          token: String(s?.token || ""),
          candidateName: String(s?.candidateName || ""),
          examPeriodId,
          examPeriodName: examPeriodId ? String(epNameById.get(examPeriodId) || "") : "",
          submitted: !!(s && (s.submitted === true || Number(s.submitted) === 1)),
          reason: String(s?.reason || ""),
          createdAtUtcMs: Number(s?.createdAtUtcMs || 0) || 0,
          relPath,
          exists,
          size: exists ? st.size : 0,
          mtimeMs: exists ? st.mtimeMs : 0,
          url: exists ? `/api/admin/files/download?path=${encodeURIComponent(relPath)}` : "",
        });
      }

      res.json({ ok: true, sessionId, snapshots: out });
    } catch (e) {
      console.error("admin_files_snapshots_error", e);
      res.status(500).json({ error: "snapshots_failed" });
    }
  });

  app.get("/api/admin/files/download", async (req, res) => {
    try {
      await ensureInit();
      const a = await adminAuth(req, res);
      if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
      const rel = String(req.query?.path || "").trim();
      const st = await Storage.statFile(rel);
      if (!st.exists) return res.status(404).json({ error: "not_found" });
      const ct = Storage.contentTypeForPath(st.relPath);
      const name = path.basename(st.relPath);
      streamFileWithRange(req, res, st.absPath, { contentType: ct, downloadName: name });
    } catch (e) {
      console.error("admin_file_download_error", e);
      res.status(500).json({ error: "download_failed" });
    }
  });

  app.post("/api/admin/files/delete", async (req, res) => {
    try {
      await ensureInit();
      const a = await adminAuth(req, res);
      if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

      const kind = String(req.body?.kind || "").trim();
      if (kind === "snapshot") {
        if (!DB.getSessionSnapshotById || !DB.deleteSessionSnapshotById) return res.status(501).json({ error: "Not supported on this database adapter" });
        const id = Number(req.body?.id || 0);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "invalid_id" });
        const row = await DB.getSessionSnapshotById(id);
        if (!row) return res.status(404).json({ error: "not_found" });
        const relPath = String(row.remotePath || "").trim();
        if (relPath) {
          try {
            await Storage.deleteFile(relPath);
          } catch {}
        }
        await DB.deleteSessionSnapshotById(id);
        return res.json({ ok: true });
      }

      if (kind === "listening") {
        if (!DB.getAdminTest || !DB.setAdminTest) return res.status(501).json({ error: "Not supported on this database adapter" });
        const ep = Number(req.body?.examPeriodId || 0);
        if (!Number.isFinite(ep) || ep <= 0) return res.status(400).json({ error: "invalid_exam_period" });
        const relPath = `listening/ep_${ep}/listening.mp3`;
        try {
          await Storage.deleteFile(relPath);
        } catch {}

        // Best-effort: clear stored audioUrl from the test payload so the builder doesn't show a dead link.
        try {
          const test = await DB.getAdminTest(ep);
          if (test && Array.isArray(test.sections)) {
            for (const sec of test.sections) {
              for (const item of (sec?.items || [])) {
                if (item && String(item.type || "") === "listening-mcq") {
                  item.audioUrl = "";
                }
              }
            }
            await DB.setAdminTest(ep, test);
          }
        } catch {}

        return res.json({ ok: true });
      }

      return res.status(400).json({ error: "unknown_kind" });
    } catch (e) {
      console.error("admin_files_delete_error", e);
      res.status(500).json({ error: "delete_failed" });
    }
  });
};
