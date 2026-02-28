module.exports = function registerAdminSpeakingRoutes(app, ctx) {
  const {
    ensureInit,
    adminAuth,
    DB,
    getPublicBase,
    createMeetingForSlot,
    speakingVideoProvider,
    SPEAKING_DURATION_MINUTES,
    autoGenerateSpeakingSlotsForExamPeriod,
  } = ctx || {};

  if (!app) throw new Error("admin_speaking_routes_missing_app");
  if (!ensureInit || !adminAuth || !DB) throw new Error("admin_speaking_routes_missing_ctx");

  app.get("/api/admin/examiners", async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    if (!DB.listExaminers) return res.json([]);
    res.json(await DB.listExaminers());
  });

  app.get("/api/admin/speaking-slots", async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    if (!DB.listSpeakingSlots) return res.json([]);

    const examPeriodId = req.query?.examPeriodId;
    const fromUtcMs = req.query?.fromUtcMs;
    const toUtcMs = req.query?.toUtcMs;
    const limit = req.query?.limit;
    const examinerUsername = req.query?.examinerUsername;

    const out = await DB.listSpeakingSlots({
      examPeriodId: examPeriodId === undefined ? undefined : Number(examPeriodId),
      fromUtcMs: fromUtcMs === undefined ? undefined : Number(fromUtcMs),
      toUtcMs: toUtcMs === undefined ? undefined : Number(toUtcMs),
      limit: limit === undefined ? undefined : Number(limit),
      examinerUsername: examinerUsername === undefined ? undefined : String(examinerUsername || ""),
    });
    const base = getPublicBase(req);
    const rows = (Array.isArray(out) ? out : []).map((r) => {
      const tok = String(r?.sessionToken || "").trim();
      return {
        ...r,
        speakingUrl: tok ? `${base}/speaking.html?token=${encodeURIComponent(tok)}` : "",
      };
    });
    res.json(rows);
  });

  app.post("/api/admin/speaking-slots", async (req, res) => {
    try {
      await ensureInit();
      const a = await adminAuth(req, res);
      if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
      if (!DB.createSpeakingSlot) return res.status(501).json({ error: "Not supported on this database adapter" });

      const rawPayload = req.body && typeof req.body === "object" ? req.body : {};
      const payload = {
        ...rawPayload,
        durationMinutes: SPEAKING_DURATION_MINUTES,
        videoProvider: speakingVideoProvider(),
      };
      let out = await DB.createSpeakingSlot(payload);

      try {
        const z = await createMeetingForSlot(out);
        const updated = await DB.updateSpeakingSlot({
          id: Number(out.id),
          meetingId: z.meetingId,
          joinUrl: z.joinUrl,
          startUrl: z.startUrl,
          meetingMetadata: z.metadata,
        });
        if (updated) out = updated;
      } catch (zerr) {
        return res.status(502).json({
          error: `Meeting link creation failed: ${String(zerr?.message || "unknown error")}`,
        });
      }

      res.json(out);
    } catch (e) {
      res.status(400).json({ error: e?.message || "create_speaking_slot_failed" });
    }
  });

  app.post("/api/admin/speaking-slots/auto-generate", async (req, res) => {
    try {
      await ensureInit();
      const a = await adminAuth(req, res);
      if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
      if (!DB.listSessionsMissingSpeakingSlot || !DB.createSpeakingSlot) {
        return res.status(501).json({ error: "Not supported on this database adapter" });
      }

      const examPeriodId = Number(req.body?.examPeriodId);
      if (!Number.isFinite(examPeriodId) || examPeriodId <= 0) {
        return res.status(400).json({ error: "Invalid exam period id" });
      }
      const out = await autoGenerateSpeakingSlotsForExamPeriod(examPeriodId, { maxErrors: 200 });
      return res.json(out);
    } catch (e) {
      return res.status(400).json({ error: e?.message || "auto_generate_speaking_slots_failed" });
    }
  });

  app.post("/api/admin/speaking-slots/recreate-meeting-links", async (req, res) => {
    try {
      await ensureInit();
      const a = await adminAuth(req, res);
      if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
      if (!DB.listSpeakingSlots || !DB.updateSpeakingSlot) {
        return res.status(501).json({ error: "Not supported on this database adapter" });
      }
      const examPeriodIdRaw = Number(req.body?.examPeriodId);
      const examPeriodId = Number.isFinite(examPeriodIdRaw) && examPeriodIdRaw > 0 ? examPeriodIdRaw : null;
      const slots = await DB.listSpeakingSlots({
        ...(examPeriodId ? { examPeriodId } : {}),
        limit: 50000,
      });

      let updated = 0;
      let failed = 0;
      const errors = [];
      for (const slot of Array.isArray(slots) ? slots : []) {
        const sid = Number(slot?.id || 0);
        if (!Number.isFinite(sid) || sid <= 0) continue;

        try {
          // Force a fresh room id on recreate/reset.
          const recreateInput = { ...slot, meetingId: "" };
          const z = await createMeetingForSlot(recreateInput);
          const out = await DB.updateSpeakingSlot({
            id: sid,
            meetingId: z.meetingId,
            joinUrl: z.joinUrl,
            startUrl: z.startUrl,
            meetingMetadata: z.metadata,
          });
          if (out) updated += 1;
        } catch (e) {
          failed += 1;
          errors.push({ slotId: sid, error: String(e?.message || "recreate_failed") });
        }
      }

      return res.json({
        ok: true,
        examPeriodId,
        scanned: Array.isArray(slots) ? slots.length : 0,
        updated,
        failed,
        errors: errors.slice(0, 200),
        provider: speakingVideoProvider(),
      });
    } catch (e) {
      return res.status(400).json({ error: e?.message || "recreate_meeting_links_failed" });
    }
  });

  app.put("/api/admin/speaking-slots/:id", async (req, res) => {
    try {
      await ensureInit();
      const a = await adminAuth(req, res);
      if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
      if (!DB.updateSpeakingSlot) return res.status(501).json({ error: "Not supported on this database adapter" });

      const payload = req.body && typeof req.body === "object" ? req.body : {};
      const hasStart = Object.prototype.hasOwnProperty.call(payload, "startUtcMs");
      let forcedStartUtcMs = null;
      let forcedEndUtcMs = null;
      if (hasStart) {
        const s = Number(payload.startUtcMs);
        if (!Number.isFinite(s) || s <= 0) {
          return res.status(400).json({ error: "Invalid start time" });
        }
        forcedStartUtcMs = s;
        forcedEndUtcMs = s + (SPEAKING_DURATION_MINUTES * 60 * 1000);
      }
      let out = await DB.updateSpeakingSlot({
        id: req.params.id,
        ...payload,
        ...(hasStart ? { startUtcMs: forcedStartUtcMs, endUtcMs: forcedEndUtcMs, durationMinutes: SPEAKING_DURATION_MINUTES } : {}),
      });
      if (!out) return res.status(404).json({ error: "Slot not found" });

      // Self-hosted provider: ensure a meeting link exists.
      if (!String(out?.joinUrl || "").trim()) {
        try {
          const z = await createMeetingForSlot(out);
          const updated = await DB.updateSpeakingSlot({
            id: Number(out.id),
            meetingId: z.meetingId,
            joinUrl: z.joinUrl,
            startUrl: z.startUrl,
            meetingMetadata: z.metadata,
          });
          if (updated) out = updated;
        } catch (serr) {
          return res.status(502).json({
            error: `Meeting link creation failed: ${String(serr?.message || "unknown error")}`,
          });
        }
      } else if (hasStart) {
        // On start-time change, rotate to a fresh room id.
        try {
          const z = await createMeetingForSlot({ ...out, meetingId: "" });
          const updated = await DB.updateSpeakingSlot({
            id: Number(out.id),
            meetingId: z.meetingId,
            joinUrl: z.joinUrl,
            startUrl: z.startUrl,
            meetingMetadata: z.metadata,
          });
          if (updated) out = updated;
        } catch (serr) {
          return res.status(502).json({
            error: `Meeting link refresh failed: ${String(serr?.message || "unknown error")}`,
          });
        }
      }

      res.json(out);
    } catch (e) {
      res.status(400).json({ error: e?.message || "update_speaking_slot_failed" });
    }
  });

  app.delete("/api/admin/speaking-slots/:id", async (req, res) => {
    try {
      await ensureInit();
      const a = await adminAuth(req, res);
      if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
      if (!DB.deleteSpeakingSlot) return res.status(501).json({ error: "Not supported on this database adapter" });
      const out = await DB.deleteSpeakingSlot(req.params.id);
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: e?.message || "delete_speaking_slot_failed" });
    }
  });
};

