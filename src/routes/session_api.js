module.exports = function registerSessionRoutes(app, ctx) {
  const {
    ensureInit,
    DB,
    Storage,
    Meetings,
    upload,
    requireGateForToken,
    parseSnapshotMax,
    isPng,
    safeTitlePrefix,
    buildStampHhmmss_DDMM_YYYY,
    streamFileWithRange,
    isProctoringAckRequired,
    normalizeRoomName,
    normalizeParticipantName,
  } = ctx || {};

  if (!app) throw new Error("session_routes_missing_app");
  if (
    !ensureInit ||
    !DB ||
    !Storage ||
    !Meetings ||
    !upload ||
    !requireGateForToken ||
    !parseSnapshotMax ||
    !isPng ||
    !safeTitlePrefix ||
    !buildStampHhmmss_DDMM_YYYY ||
    !streamFileWithRange ||
    !isProctoringAckRequired ||
    !normalizeRoomName ||
    !normalizeParticipantName
  ) {
    throw new Error("session_routes_missing_ctx");
  }

  // Public speaking gate endpoint (token-based countdown -> redirect URL).
  app.get("/api/speaking/:token", async (req, res) => {
    await ensureInit();
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(400).json({ error: "Missing token" });
    if (!DB.getSpeakingJoinBySessionToken) {
      return res.status(501).json({ error: "Speaking gate endpoint unavailable for this DB adapter" });
    }

    const slot = await DB.getSpeakingJoinBySessionToken(token);
    if (!slot) return res.status(404).json({ error: "No speaking slot found for this token" });

    const now = Date.now();
    const startUtcMs = Number(slot.startUtcMs || 0);
    const endUtcMs = Number(slot.endUtcMs || 0);
    const out = {
      status: "countdown",
      serverNow: now,
      startUtcMs,
      endUtcMs,
      candidateName: String(slot.candidateName || ""),
      sessionToken: String(slot.sessionToken || token),
    };

    if (Number.isFinite(startUtcMs) && Number.isFinite(endUtcMs)) {
      if (now < startUtcMs) return res.json(out);
      if (now > endUtcMs) return res.json({ ...out, status: "ended" });
      return res.json({
        ...out,
        status: "open",
        redirectUrl: String(slot.joinUrl || "").trim(),
      });
    }

    return res.json(out);
  });

  app.post("/api/meeting/livekit-token", async (req, res) => {
    try {
      const room = normalizeRoomName(req.body?.room);
      if (!room) return res.status(400).json({ error: "invalid_room" });
      if (!/^eng4-/i.test(room)) return res.status(400).json({ error: "invalid_room_prefix" });

      const cap = await Meetings.ensureLivekitRoomAndCapacity(room);
      const participantNumber = Math.max(1, Math.min(2, Number(cap?.count || 0) + 1));
      const assignedName = `Participant ${participantNumber}`;
      const out = await Meetings.createLivekitJoinToken(room, assignedName);
      return res.json({
        ok: true,
        room,
        maxParticipants: 2,
        wsUrl: out.wsUrl,
        token: out.token,
        identity: out.identity,
        name: out.name,
        participantNumber,
      });
    } catch (e) {
      const msg = String(e?.message || "livekit_token_failed");
      if (msg === "room_full") return res.status(409).json({ error: "room_full", message: "This call is already full (max 2)." });
      if (msg === "livekit_not_configured" || msg === "livekit_sdk_missing") {
        return res.status(503).json({ error: msg });
      }
      return res.status(500).json({ error: "livekit_token_failed", message: msg });
    }
  });

  // Exam routes (gated)
  app.get("/api/session/:token", async (req, res) => {
    await ensureInit();
    // For candidate page we never return "locked" just because the exam is in the future.
    // Instead we return a status the client can use to show a countdown in the user's local time.
    const gate = await DB.getGateForToken(String(req.params.token || ""));
    if (!gate) return res.status(404).json({ error: "Invalid or expired token" });

    const { now, openAtUtc, endAtUtc } = gate;
    if (openAtUtc && now < openAtUtc) {
      return res.json({ status: "countdown", serverNow: now, openAtUtc, endAtUtc });
    }
    if (openAtUtc && endAtUtc && now > endAtUtc) {
      return res.json({ status: "ended", serverNow: now, openAtUtc, endAtUtc });
    }

    const data = await DB.getSessionForExam(String(req.params.token || ""));
    if (!data) return res.status(404).json({ error: "Invalid or expired token" });
    res.json({ status: "running", ...data, serverNow: now, openAtUtc, endAtUtc });
  });

  app.post("/api/session/:token/proctoring-ack", async (req, res) => {
    await ensureInit();
    if (await requireGateForToken(req.params.token, res)) return;
    if (!DB.recordProctoringAck) return res.status(501).json({ error: "Not supported on this database adapter" });

    const noticeVersion = String(req.body?.noticeVersion || "").trim();
    const out = await DB.recordProctoringAck(String(req.params.token || ""), { noticeVersion });
    if (!out) return res.status(404).json({ error: "Invalid or expired token" });
    res.json(out);
  });

  app.post("/api/session/:token/snapshot", upload.single("image"), async (req, res) => {
    try {
      await ensureInit();
      if (await requireGateForToken(req.params.token, res)) return;
      if (!DB.addSessionSnapshot) return res.status(501).json({ error: "Not supported on this database adapter" });

      const t = String(req.params.token || "").trim();
      if (!t) return res.status(400).json({ error: "missing_token" });
      const gate = DB.getGateForToken ? await DB.getGateForToken(t) : null;
      const examPeriodId = Number(gate?.examPeriodId || 0) || 1;

      const reason = String(req.body?.reason || "unknown").trim() || "unknown";
      const max = parseSnapshotMax();

      const file = req.file;
      const buf = file && file.buffer ? Buffer.from(file.buffer) : null;
      if (!buf || !buf.length) return res.status(400).json({ error: "missing_image" });
      if (!isPng(buf)) return res.status(400).json({ error: "only_png_supported" });

      const titlePrefix = safeTitlePrefix(String(req.body?.titlePrefix || ""), 32);
      const stampRaw = String(req.body?.stamp || "").trim();
      const stamp = /^\d{6}_\d{4}_\d{4}$/.test(stampRaw) ? stampRaw : buildStampHhmmss_DDMM_YYYY(new Date());
      const fname = `${titlePrefix}_${stamp}.png`;
      const remotePath = `snapshots/ep_${examPeriodId}/${t}/${fname}`;
      const storedReason = `${titlePrefix}:${reason}`;
      const meta = await DB.addSessionSnapshot(t, { reason: storedReason, remotePath, max });
      if (!meta) {
        return res.status(404).json({ error: "Invalid or expired token" });
      }
      if (!meta.ok && meta.limited) {
        return res.status(429).json({ error: "snapshot_limit_reached", count: meta.count, remaining: meta.remaining });
      }

      try {
        await Storage.writeFile(remotePath, buf);
      } catch (e) {
        // Best-effort rollback if the file write fails.
        try {
          if (DB.deleteSessionSnapshotById && meta.snapshotId) await DB.deleteSessionSnapshotById(Number(meta.snapshotId));
        } catch {}
        throw e;
      }

      console.log("snapshot_stored", { token: t, reason, remotePath, count: meta.count });
      res.json({ ok: true, remotePath, snapshotId: meta.snapshotId ?? null, count: meta.count, remaining: meta.remaining });
    } catch (e) {
      console.error("snapshot_upload_error", e);
      res.status(500).json({ error: "snapshot_upload_failed", message: String(e?.message || e) });
    }
  });

  app.get("/api/session/:token/listening-audio", async (req, res) => {
    try {
      await ensureInit();
      if (await requireGateForToken(req.params.token, res)) return;
      const ticket = String(req.query?.ticket || "").trim();
      if (!DB.verifyListeningTicket) return res.status(501).json({ error: "Not supported on this database adapter" });
      const ver = await DB.verifyListeningTicket(String(req.params.token || ""), ticket);
      if (!ver) return res.status(404).json({ error: "Invalid or expired token" });
      if (!ver.ok) return res.status(403).json({ error: "listening_denied", reason: ver.reason || "denied" });
      const examPeriodId = Number(ver.examPeriodId || 1);
      const rel = `listening/ep_${examPeriodId}/listening.mp3`;
      const st = await Storage.statFile(rel);
      if (!st.exists) return res.status(404).json({ error: "missing_listening_audio" });

      // If storage is served publicly (e.g. FILE_STORAGE_DIR=./public/storage),
      // redirect to the static URL for simplicity/performance.
      if (typeof Storage.publicUrlForPath === "function") {
        const pub = Storage.publicUrlForPath(rel);
        if (pub) {
          res.setHeader("Cache-Control", "no-store");
          return res.redirect(302, pub);
        }
      }
      res.setHeader("Cache-Control", "no-store");
      streamFileWithRange(req, res, st.absPath, { contentType: "audio/mpeg", downloadName: "listening.mp3" });
    } catch (e) {
      console.error("listening_audio_stream_error", e);
      res.status(500).json({ error: "stream_failed" });
    }
  });

  app.post("/api/session/:token/listening-ticket", async (req, res) => {
    try {
      await ensureInit();
      if (await requireGateForToken(req.params.token, res)) return;
      if (isProctoringAckRequired() && DB.hasProctoringAck) {
        const ok = await DB.hasProctoringAck(String(req.params.token || ""));
        if (!ok) return res.status(412).json({ error: "proctoring_ack_required" });
      }
      if (!DB.issueListeningTicket) return res.status(501).json({ error: "Not supported on this database adapter" });

      // Always enforce play-once server-side.
      const maxPlays = 1;
      const ttlMs = 25 * 60 * 1000;
      const out = await DB.issueListeningTicket(String(req.params.token || ""), { maxPlays, ttlMs });
      if (!out) return res.status(404).json({ error: "Invalid or expired token" });
      if (!out.ok) return res.status(403).json({ error: "listening_denied", reason: out.reason || "denied", playCount: out.playCount ?? null, maxPlays: out.maxPlays ?? maxPlays });

      const url = `/api/session/${encodeURIComponent(String(req.params.token || ""))}/listening-audio?ticket=${encodeURIComponent(String(out.ticket || ""))}`;
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, url, expiresAtUtcMs: out.expiresAtUtcMs ?? null, playCount: out.playCount ?? null, maxPlays: out.maxPlays ?? maxPlays });
    } catch (e) {
      console.error("listening_ticket_error", e);
      res.status(500).json({ error: "ticket_failed" });
    }
  });

  app.post("/api/session/:token/start", async (req, res) => {
    await ensureInit();
    if (await requireGateForToken(req.params.token, res)) return;
    if (isProctoringAckRequired() && DB.hasProctoringAck) {
      const ok = await DB.hasProctoringAck(String(req.params.token || ""));
      if (!ok) return res.status(412).json({ error: "proctoring_ack_required" });
    }
    const out = await DB.startSession(String(req.params.token || ""));
    if (!out) return res.status(404).json({ error: "Invalid or expired token" });
    res.json(out);
  });

  app.post("/api/session/:token/presence", async (req, res) => {
    await ensureInit();
    if (await requireGateForToken(req.params.token, res)) return;
    const out = await DB.presencePing(String(req.params.token || ""), req.body?.status || "unknown");
    res.json(out);
  });

  app.post("/api/session/:token/submit", async (req, res) => {
    try {
      await ensureInit();
      if (await requireGateForToken(req.params.token, res)) return;
      const out = await DB.submitAnswers(
        String(req.params.token || ""),
        req.body?.answers || {},
        req.body?.clientMeta || null
      );
      if (!out) return res.status(404).json({ error: "Invalid or expired token" });
      res.json(out);
    } catch (e) {
      console.error("submit_error", e);
      res.status(500).json({ error: "submit_failed" });
    }
  });
};
