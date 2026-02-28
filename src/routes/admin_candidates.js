module.exports = function registerAdminCandidatesRoutes(app, ctx) {
  const {
    ensureInit,
    adminAuth,
    DB,
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

  function normHeader(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^a-z0-9 _-]/g, "");
  }

  function pickCell(row, keys) {
    if (!row) return "";
    for (const k of keys || []) {
      const kk = normHeader(k);
      if (Object.prototype.hasOwnProperty.call(row, kk)) return row[kk];
    }
    return "";
  }

  function softWrapText(text, maxCharsPerLine = 70) {
    const src = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const outLines = [];
    for (const rawLine of src.split("\n")) {
      const line = String(rawLine || "");
      if (line.length <= maxCharsPerLine) {
        outLines.push(line);
        continue;
      }
      const words = line.split(/\s+/).filter(Boolean);
      if (!words.length) {
        outLines.push("");
        continue;
      }
      let cur = "";
      for (const w of words) {
        if (!cur) {
          cur = w;
          continue;
        }
        if ((cur + " " + w).length <= maxCharsPerLine) cur += " " + w;
        else {
          outLines.push(cur);
          cur = w;
        }
      }
      if (cur) outLines.push(cur);
    }
    return outLines.join("\r\n");
  }

  app.post("/api/admin/import-excel", upload.single("file"), async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

    const examPeriodId = Number(req.body?.examPeriodId || 1);
    if (!Number.isFinite(examPeriodId) || examPeriodId <= 0) {
      return res.status(400).json({ error: "Invalid exam period id" });
    }
    if (!req.file?.buffer) return res.status(400).json({ error: "Missing file" });

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    } catch {
      return res.status(400).json({ error: "Invalid Excel file" });
    }
    const sheetName = workbook.SheetNames?.[0];
    if (!sheetName) return res.status(400).json({ error: "No sheets found" });
    const ws = workbook.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(ws, { defval: "" });

    const mapped = raw.map((row) => {
      const out = {};
      for (const [k, v] of Object.entries(row || {})) out[normHeader(k)] = v;
      return out;
    });

    const rows = [];
    for (const r of mapped) {
      const name = String(pickCell(r, ["name", "full name", "candidate name"]) || "").trim();
      const email = String(pickCell(r, ["email", "e-mail", "mail"]) || "").trim();
      const country = String(pickCell(r, ["country", "country code", "country_code", "countrycode"]) || "").trim();
      if (!email) continue;
      rows.push({ name, email, country });
    }
    if (!rows.length) return res.status(400).json({ error: "No valid rows. Email is required." });

    const created = await DB.importCandidatesAndCreateSessions({
      rows,
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

    const base = getPublicBase(req);
    const exportRows = (created.sessions || []).map((s) => {
      const url = `${base}/exam.html?token=${s.token}&sid=${s.sessionId}`;
      const speakingUrl = `${base}/speaking.html?token=${encodeURIComponent(String(s.token || ""))}`;
      return {
        name: String(s.name || ""),
        email: String(s.email || ""),
        countryCode: String(s.country || ""),
        examPeriodId: Number(s.examPeriodId || ""),
        assignedExaminer: String(s.assignedExaminer || ""),
        sessionId: Number(s.sessionId || ""),
        token: String(s.token || ""),
        link: softWrapText(url, 85),
        rawLink: url,
        speakingLink: softWrapText(speakingUrl, 85),
        rawSpeakingLink: speakingUrl,
      };
    });

    const outWb = new ExcelJS.Workbook();
    const outWs = outWb.addWorksheet("sessions");
    outWs.columns = [
      { header: "Name", key: "name", width: 18 },
      { header: "Email", key: "email", width: 24 },
      { header: "Country code", key: "countryCode", width: 14 },
      { header: "Exam period id", key: "examPeriodId", width: 14 },
      { header: "Assigned examiner", key: "assignedExaminer", width: 18 },
      { header: "Session id", key: "sessionId", width: 12 },
      { header: "Token", key: "token", width: 22 },
      { header: "Link", key: "link", width: 200 },
      { header: "Speaking Access Link", key: "speakingLink", width: 200 },
    ];
    outWs.getRow(1).font = { bold: true };
    outWs.getColumn(8).alignment = { wrapText: true, vertical: "top" };
    outWs.getColumn(9).alignment = { wrapText: true, vertical: "top" };

    for (const r of exportRows) {
      const row = outWs.addRow({
        name: r.name,
        email: r.email,
        countryCode: r.countryCode,
        examPeriodId: r.examPeriodId,
        assignedExaminer: r.assignedExaminer,
        sessionId: r.sessionId,
        token: r.token,
        link: r.link,
        speakingLink: r.speakingLink,
      });
      const linkCell = row.getCell(8);
      linkCell.value = { text: r.link, hyperlink: r.rawLink };
      linkCell.alignment = { wrapText: true, vertical: "top" };
      linkCell.font = { color: { argb: "FF0563C1" }, underline: true };
      const speakingCell = row.getCell(9);
      speakingCell.value = { text: r.speakingLink, hyperlink: r.rawSpeakingLink };
      speakingCell.alignment = { wrapText: true, vertical: "top" };
      speakingCell.font = { color: { argb: "FF0563C1" }, underline: true };
    }

    const wrapKeys = new Set(["link", "speakingLink", "name", "email", "assignedExaminer"]);
    const minWidthByKey = {
      token: 22,
      link: 100,
      speakingLink: 100,
    };
    for (let c = 1; c <= outWs.columnCount; c++) {
      const col = outWs.getColumn(c);
      const key = String(col.key || "");
      let maxLen = String(col.header || "").length;
      col.eachCell({ includeEmpty: true }, (cell) => {
        const txt = String(cell.text ?? cell.value ?? "");
        for (const ln of txt.split(/\r?\n/)) maxLen = Math.max(maxLen, ln.length);
      });
      const width = wrapKeys.has(key)
        ? Math.min(95, Math.max(14, Math.ceil(maxLen * 0.95)))
        : Math.min(36, Math.max(10, Math.ceil(maxLen * 1.1)));
      const minW = Number(minWidthByKey[key] || 0);
      col.width = minW > 0 ? Math.max(width, minW) : width;
    }

    for (let r = 2; r <= outWs.rowCount; r++) {
      const row = outWs.getRow(r);
      let neededLines = 1;
      for (let c = 1; c <= outWs.columnCount; c++) {
        const col = outWs.getColumn(c);
        const key = String(col.key || "");
        if (!wrapKeys.has(key)) continue;
        const txt = String(row.getCell(c).text ?? row.getCell(c).value ?? "");
        const colChars = Math.max(12, Math.floor(Number(col.width || 20)));
        const lines = txt
          .split(/\r?\n/)
          .reduce((sum, ln) => sum + Math.max(1, Math.ceil(String(ln).length / colChars)), 0);
        neededLines = Math.max(neededLines, lines);
      }
      row.height = Math.min(220, Math.max(20, neededLines * 15));
    }

    const out = await outWb.xlsx.writeBuffer();
    const buf = Buffer.from(out);

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

    const speakingUrl = `${getPublicBase(req)}/speaking.html?token=${encodeURIComponent(String(s.token || ""))}`;
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
    const url = `${base}/exam.html?token=${s.token}&sid=${s.sessionId}`;

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

  app.get("/api/admin/candidates/:sessionId/details", async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

    const sid = Number(req.params.sessionId);
    if (!Number.isFinite(sid) || sid <= 0) {
      return res.status(400).json({ error: "Invalid session id" });
    }

    if (!DB.getQuestionGrades) {
      return res.status(501).json({ error: "Details endpoint is unavailable for this DB adapter" });
    }

    const qg = await DB.getQuestionGrades(sid);
    if (!qg) return res.status(404).json({ error: "No submitted details found for this session" });

    const ep = Number(qg.examPeriodId || 1);
    const examPeriodId = Number.isFinite(ep) && ep > 0 ? ep : 1;
    const payload = DB.getAdminTest ? await DB.getAdminTest(examPeriodId) : getTestPayloadFull();
    const answersObj = parseAnswersJson(qg.answersJson);
    const review = buildReviewItems(payload, answersObj);

    res.json({
      sessionId: sid,
      examPeriodId,
      qWriting: String(qg.qWriting || ""),
      answersJson: answersObj,
      totalGrade: qg.totalGrade ?? null,
      speakingGrade: qg.speakingGrade ?? null,
      writingGrade: qg.writingGrade ?? null,
      objectiveEarned: review.objectiveEarned,
      objectiveMax: review.objectiveMax,
      items: review.items,
    });
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

    const rowsIn = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const includeDetailed = !!req.body?.includeDetailed;
    if (!rowsIn.length) return res.status(400).json({ error: "No rows to export" });
    if (rowsIn.length > 50000) return res.status(400).json({ error: "Too many rows to export" });

    const payloadCache = new Map();
    const exported = [];
    for (const r of rowsIn) {
      const sid = Number(r.sessionId || 0);
      const epIdRaw = Number(r.examPeriodId || 0);
      const epId = Number.isFinite(epIdRaw) && epIdRaw > 0 ? epIdRaw : 1;
      const base = {
        examPeriod: String(r.examPeriodName || ""),
        candidateCode: String(r.candidateCode || ""),
        name: String(r.candidateName || ""),
        token: String(r.token || ""),
        submitted: r.submitted ? "YES" : "NO",
        grade: r.totalGrade ?? "",
        disqualified: r.disqualified ? "YES" : "NO",
      };

      if (!includeDetailed || !Number.isFinite(sid) || sid <= 0) {
        exported.push(base);
        continue;
      }

      let qg = null;
      try {
        qg = await DB.getQuestionGrades(sid);
      } catch {}
      const answersObj = parseAnswersJson(qg?.answersJson);
      let payload = payloadCache.get(epId);
      if (!payload) {
        payload = DB.getAdminTest ? await DB.getAdminTest(epId) : getTestPayloadFull();
        payloadCache.set(epId, payload);
      }
      const review = buildReviewItems(payload, answersObj);
      const objectiveEarned = Number(review.objectiveEarned || 0);
      const objectiveMax = Number(review.objectiveMax || 0);
      const objectivePct = objectiveMax > 0 ? Math.round((objectiveEarned / objectiveMax) * 1000) / 10 : 0;
      const writingGrade = qg?.writingGrade == null ? "" : `${Number(qg.writingGrade)}%`;
      const speakingGrade = qg?.speakingGrade == null ? "" : `${Number(qg.speakingGrade)}%`;
      const totalGrade = qg?.totalGrade == null ? (base.grade === "" ? "" : `${Number(base.grade)}%`) : `${Number(qg.totalGrade)}%`;
      const breakdown = (review.items || [])
        .map((it) => {
          if (it.isCorrect === true) return `${it.id}: Correct`;
          if (it.isCorrect === false) return `${it.id}: Wrong`;
          return `${it.id}: N/A`;
        })
        .join(" | ");

      exported.push({
        ...base,
        objective: `${objectiveEarned}/${objectiveMax}`,
        objectivePercent: `${objectivePct}%`,
        writingGrade,
        speakingGrade,
        totalGrade,
        writingText: softWrapText(String(qg?.qWriting || ""), 80),
        detailedBreakdown: softWrapText(breakdown, 90),
      });
    }

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("admin_candidates");
    const columns = includeDetailed
      ? [
          { header: "Exam Period", key: "examPeriod" },
          { header: "Candidate Code", key: "candidateCode" },
          { header: "Name", key: "name" },
          { header: "Token", key: "token" },
          { header: "Submitted", key: "submitted" },
          { header: "Grade", key: "grade" },
          { header: "Disqualified", key: "disqualified" },
          { header: "Objective", key: "objective" },
          { header: "Objective %", key: "objectivePercent" },
          { header: "Writing Grade", key: "writingGrade" },
          { header: "Speaking Grade", key: "speakingGrade" },
          { header: "Total Grade", key: "totalGrade" },
          { header: "Writing Text", key: "writingText" },
          { header: "Detailed Breakdown", key: "detailedBreakdown" },
        ]
      : [
          { header: "Exam Period", key: "examPeriod" },
          { header: "Candidate Code", key: "candidateCode" },
          { header: "Name", key: "name" },
          { header: "Token", key: "token" },
          { header: "Submitted", key: "submitted" },
          { header: "Grade", key: "grade" },
          { header: "Disqualified", key: "disqualified" },
        ];
    ws.columns = columns.map((c) => ({ ...c, width: 14 }));
    ws.getRow(1).font = { bold: true };

    for (const row of exported) ws.addRow(row);

    const wrapKeys = new Set(["writingText", "detailedBreakdown", "name"]);
    for (let c = 1; c <= ws.columnCount; c++) {
      const col = ws.getColumn(c);
      const key = String(col.key || "");
      let maxLen = String(col.header || "").length;
      col.eachCell({ includeEmpty: true }, (cell, rowNumber) => {
        const text = String(cell.value ?? "");
        for (const ln of text.split(/\r?\n/)) maxLen = Math.max(maxLen, ln.length);
        if (rowNumber >= 2 && wrapKeys.has(key)) cell.alignment = { wrapText: true, vertical: "top" };
      });
      const width = wrapKeys.has(key)
        ? Math.min(95, Math.max(16, Math.ceil(maxLen * 0.95)))
        : Math.min(40, Math.max(10, Math.ceil(maxLen * 1.1)));
      col.width = width;
    }

    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      let neededLines = 1;
      for (let c = 1; c <= ws.columnCount; c++) {
        const col = ws.getColumn(c);
        const key = String(col.key || "");
        if (!wrapKeys.has(key)) continue;
        const text = String(row.getCell(c).value || "");
        const colChars = Math.max(12, Math.floor(Number(col.width || 20)));
        const lines = text
          .split(/\r?\n/)
          .reduce((sum, ln) => sum + Math.max(1, Math.ceil(String(ln).length / colChars)), 0);
        neededLines = Math.max(neededLines, lines);
      }
      row.height = Math.min(260, Math.max(20, neededLines * 15));
    }

    const out = await workbook.xlsx.writeBuffer();
    const buf = Buffer.from(out);

    const scopeRaw = String(req.body?.scope || "selected").trim().replace(/[^A-Za-z0-9._-]/g, "_");
    const scope = scopeRaw || "selected";
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const filename = `admin_candidates_${scope}_${ts}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);
    res.send(buf);
  });

  app.post("/api/admin/delete-all-data", async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

    await DB.deleteAllCoreData();
    res.json({ ok: true });
  });

  app.post("/api/admin/candidates/bulk-delete", async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    if (!DB.deleteCandidateBySessionId) return res.status(501).json({ error: "Not supported on this DB adapter" });

    const idsRaw = Array.isArray(req.body?.sessionIds) ? req.body.sessionIds : [];
    const ids = Array.from(new Set(idsRaw.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)));
    if (!ids.length) return res.status(400).json({ error: "No sessionIds provided" });

    let okCount = 0;
    let failCount = 0;
    const errors = [];
    for (const sid of ids) {
      try {
        const out = await DB.deleteCandidateBySessionId(sid);
        if (out?.ok) okCount += 1;
        else failCount += 1;
      } catch (e) {
        failCount += 1;
        errors.push({ sessionId: sid, error: String(e?.message || "delete_failed") });
      }
    }

    res.json({
      ok: true,
      requested: ids.length,
      deleted: okCount,
      failed: failCount,
      errors: errors.slice(0, 100),
    });
  });

  app.delete("/api/admin/candidates/:sessionId", async (req, res) => {
    await ensureInit();
    const a = await adminAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

    const sessionId = Number(req.params.sessionId);
    const out = await DB.deleteCandidateBySessionId(sessionId);
    if (!out?.ok) return res.status(404).json({ error: "Session not found" });
    res.json(out);
  });
};

