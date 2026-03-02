const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");

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

  const listeningUploadSessions = new Map(); // uploadId -> { examPeriodId, createdAt, chunkBytes, tmpDir }

  function parseChunkBytes(raw, fallback) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    const x = Math.round(n);
    if (x < 64 * 1024) return 64 * 1024;
    return Math.min(2 * 1024 * 1024, x);
  }

  function defaultChunkBytes() {
    return parseChunkBytes(process.env.LISTENING_UPLOAD_CHUNK_BYTES, 900 * 1024);
  }

  function tmpListeningUploadDir(uploadId) {
    const base = typeof Storage.storageBaseDir === "function" ? Storage.storageBaseDir() : path.resolve(path.join(__dirname, "..", "..", "storage"));
    return path.join(base, "_tmp", "listening_uploads", String(uploadId || ""));
  }

  function cleanupUpload(uploadId) {
    const id = String(uploadId || "").trim();
    if (!id) return;
    const meta = listeningUploadSessions.get(id) || null;
    listeningUploadSessions.delete(id);
    const dir = meta?.tmpDir ? String(meta.tmpDir) : tmpListeningUploadDir(id);
    try {
      if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }

  async function getTestLockState(examPeriodId) {
    const now = Date.now();
    let openAtUtc = null;
    let durationMinutes = null;

    try {
      if (typeof DB.listExamPeriods === "function") {
        const rows = await DB.listExamPeriods();
        const eps = Array.isArray(rows) ? rows : [];
        const row = eps.find((r) => Number(r?.id || 0) === Number(examPeriodId));
        const o = Number(row?.openAtUtc);
        const d = Number(row?.durationMinutes);
        if (Number.isFinite(o) && o > 0) openAtUtc = o;
        if (Number.isFinite(d) && d > 0) durationMinutes = Math.round(d);
      }
    } catch {}

    if (!Number.isFinite(Number(openAtUtc)) || Number(openAtUtc) <= 0) {
      try {
        if (typeof DB.getConfig === "function") {
          const cfg = DB.getConfig() || {};
          const o = Number(cfg.openAtUtc);
          const d = Number(cfg.durationMinutes);
          if (Number.isFinite(o) && o > 0) openAtUtc = o;
          if (Number.isFinite(d) && d > 0) durationMinutes = Math.round(d);
        }
      } catch {}
    }

    const locked = Number.isFinite(Number(openAtUtc)) && now >= Number(openAtUtc);
    return { locked, serverNow: now, openAtUtc, durationMinutes };
  }

  app.get("/api/admin/tests", async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    if (!DB.getAdminTest) return res.status(501).json({ error: "Not supported on this database adapter" });
    const ep = Number(req.query?.examPeriodId || 1);
    const examPeriodId = Number.isFinite(ep) && ep > 0 ? ep : 1;
    const test = await DB.getAdminTest(examPeriodId);
    const lock = await getTestLockState(examPeriodId);
    res.json({ ok: true, examPeriodId, test, ...lock });
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

    const lock = await getTestLockState(examPeriodId);
    if (lock.locked) return res.status(423).json({ error: "locked", message: "Test is locked (already started).", examPeriodId, ...lock });

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
    const lock = await getTestLockState(examPeriodId);
    res.json({ ok: true, examPeriods: rows, examPeriodId, test, ...lock });
  });

  app.post("/api/admin/listening-audio", (req, res) => {
    uploadListeningAudio.single("audio")(req, res, async (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: "file_too_large", message: "MP3 too large (max 100 MB)." });
        }
        return res.status(400).json({ error: "upload_error", message: String(err?.message || err) });
      }

      try {
        await ensureInit();
        const a = await adminAuth(req, res);
        if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

        const ep = Number(req.query?.examPeriodId || 1);
        const examPeriodId = Number.isFinite(ep) && ep > 0 ? ep : 1;

        const lock = await getTestLockState(examPeriodId);
        if (lock.locked) return res.status(423).json({ error: "locked", message: "Test is locked (already started).", examPeriodId, ...lock });

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

  // Chunked upload for environments with strict reverse-proxy body size limits (413).
  app.post("/api/admin/listening-audio/chunk/init", async (req, res) => {
    try {
      await ensureInit();
      const a = await adminAuth(req, res);
      if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

      const ep = Number(req.query?.examPeriodId || 1);
      const examPeriodId = Number.isFinite(ep) && ep > 0 ? ep : 1;

      const lock = await getTestLockState(examPeriodId);
      if (lock.locked) return res.status(423).json({ error: "locked", message: "Test is locked (already started).", examPeriodId, ...lock });

      const chunkBytes = parseChunkBytes(req.body?.chunkBytes, defaultChunkBytes());
      const uploadId = crypto.randomUUID();
      const tmpDir = tmpListeningUploadDir(uploadId);
      fs.mkdirSync(tmpDir, { recursive: true });

      listeningUploadSessions.set(uploadId, { examPeriodId, createdAt: Date.now(), chunkBytes, tmpDir });
      res.json({ ok: true, uploadId, chunkBytes });
    } catch (e) {
      console.error("listening_audio_chunk_init_error", e);
      res.status(500).json({ error: "chunk_init_failed", message: String(e?.message || e) });
    }
  });

  app.post(
    "/api/admin/listening-audio/chunk/part",
    express.raw({ type: "application/octet-stream", limit: "3mb" }),
    async (req, res) => {
      try {
        await ensureInit();
        const a = await adminAuth(req, res);
        if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

        const uploadId = String(req.query?.uploadId || "").trim();
        const idx = Number(req.query?.index);
        if (!uploadId) return res.status(400).json({ error: "missing_upload_id" });
        if (!Number.isFinite(idx) || idx < 0) return res.status(400).json({ error: "invalid_index" });

        const meta = listeningUploadSessions.get(uploadId) || null;
        if (!meta) return res.status(404).json({ error: "unknown_upload" });

        const buf = req.body && Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
        if (!buf.length) return res.status(400).json({ error: "empty_chunk" });
        if (buf.length > Number(meta.chunkBytes || defaultChunkBytes())) {
          return res.status(413).json({ error: "chunk_too_large", message: "Chunk exceeds negotiated chunkBytes." });
        }

        const partPath = path.join(String(meta.tmpDir), `chunk_${Math.floor(idx)}.bin`);
        fs.writeFileSync(partPath, buf);
        res.json({ ok: true, uploadId, index: Math.floor(idx), bytes: buf.length });
      } catch (e) {
        console.error("listening_audio_chunk_part_error", e);
        res.status(500).json({ error: "chunk_part_failed", message: String(e?.message || e) });
      }
    }
  );

  app.post("/api/admin/listening-audio/chunk/complete", async (req, res) => {
    try {
      await ensureInit();
      const a = await adminAuth(req, res);
      if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

      const uploadId = String(req.body?.uploadId || "").trim();
      const totalChunks = Number(req.body?.totalChunks || 0);
      const totalBytes = Number(req.body?.totalBytes || 0);
      if (!uploadId) return res.status(400).json({ error: "missing_upload_id" });
      if (!Number.isFinite(totalChunks) || totalChunks <= 0 || totalChunks > 5000) return res.status(400).json({ error: "invalid_total_chunks" });
      if (!Number.isFinite(totalBytes) || totalBytes <= 0 || totalBytes > 120 * 1024 * 1024) return res.status(400).json({ error: "invalid_total_bytes" });

      const meta = listeningUploadSessions.get(uploadId) || null;
      if (!meta) return res.status(404).json({ error: "unknown_upload" });

      const lock = await getTestLockState(Number(meta.examPeriodId || 1));
      if (lock.locked) {
        cleanupUpload(uploadId);
        return res.status(423).json({ error: "locked", message: "Test is locked (already started).", examPeriodId: meta.examPeriodId, ...lock });
      }

      const bufs = [];
      let nBytes = 0;
      for (let i = 0; i < Math.floor(totalChunks); i++) {
        const p = path.join(String(meta.tmpDir), `chunk_${i}.bin`);
        if (!fs.existsSync(p)) return res.status(400).json({ error: "missing_chunk", index: i });
        const b = fs.readFileSync(p);
        nBytes += b.length;
        bufs.push(b);
      }
      if (nBytes !== Math.floor(totalBytes)) {
        return res.status(400).json({ error: "size_mismatch", expected: Math.floor(totalBytes), got: nBytes });
      }

      const finalBuf = Buffer.concat(bufs, nBytes);
      const examPeriodId = Number(meta.examPeriodId || 1);
      const relPath = `listening/ep_${examPeriodId}/listening.mp3`;
      await Storage.writeFile(relPath, finalBuf);

      const url = typeof Storage.publicUrlForPath === "function"
        ? (Storage.publicUrlForPath(relPath) || `/api/admin/files/download?path=${encodeURIComponent(relPath)}`)
        : `/api/admin/files/download?path=${encodeURIComponent(relPath)}`;

      // Best-effort: keep test payload in sync (store the admin download URL).
      try {
        if (DB.getAdminTest && DB.setAdminTest) {
          const test = await DB.getAdminTest(examPeriodId);
          if (test && Array.isArray(test.sections)) {
            let changed = false;
            for (const sec of (test.sections || [])) {
              for (const item of (sec?.items || [])) {
                if (item && String(item.type || "") === "listening-mcq") {
                  item.audioUrl = `/api/admin/files/download?path=${encodeURIComponent(relPath)}`;
                  changed = true;
                  break;
                }
              }
              if (changed) break;
            }
            if (changed) await DB.setAdminTest(examPeriodId, test);
          }
        }
      } catch {}

      cleanupUpload(uploadId);
      res.json({ ok: true, provider: "storage", relPath, url });
    } catch (e) {
      console.error("listening_audio_chunk_complete_error", e);
      res.status(500).json({ error: "chunk_complete_failed", message: String(e?.message || e) });
    }
  });

  app.post("/api/admin/listening-audio/chunk/cancel", async (req, res) => {
    try {
      await ensureInit();
      const a = await adminAuth(req, res);
      if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
      const uploadId = String(req.body?.uploadId || "").trim();
      cleanupUpload(uploadId);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: "chunk_cancel_failed" });
    }
  });
};
