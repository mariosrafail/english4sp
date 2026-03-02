module.exports = function registerExaminerRoutes(app, ctx) {
  const { ensureInit, examinerAuth, DB, ExcelJS, getPublicBase } = ctx || {};
  if (!app) throw new Error("examiner_routes_missing_app");
  if (!ensureInit || !examinerAuth || !DB || !ExcelJS || !getPublicBase) throw new Error("examiner_routes_missing_ctx");

  // Examiner routes (cookie or Basic Auth)
  app.get("/api/examiner/candidates", async (req, res) => {
    await ensureInit();
    const a = await examinerAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    res.json(await DB.listCandidatesForExaminer({ examinerUsername: a.user }));
  });

  app.get("/api/examiner/exam-periods", async (req, res) => {
    await ensureInit();
    const a = await examinerAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    res.json(await DB.listExamPeriods());
  });

  app.get("/api/examiner/speaking-slots", async (req, res) => {
    await ensureInit();
    const a = await examinerAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });
    if (!DB.listSpeakingSlots) return res.json([]);
    const examPeriodId = req.query?.examPeriodId;
    const fromUtcMs = req.query?.fromUtcMs;
    const toUtcMs = req.query?.toUtcMs;
    const limit = req.query?.limit;
    const out = await DB.listSpeakingSlots({
      examPeriodId: examPeriodId === undefined ? undefined : Number(examPeriodId),
      fromUtcMs: fromUtcMs === undefined ? undefined : Number(fromUtcMs),
      toUtcMs: toUtcMs === undefined ? undefined : Number(toUtcMs),
      limit: limit === undefined ? undefined : Number(limit),
      examinerUsername: a.user,
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

  app.post("/api/examiner/export-excel", async (req, res) => {
    await ensureInit();
    const a = await examinerAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

    const rowsIn = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rowsIn.length) return res.status(400).json({ error: "No rows to export" });
    if (rowsIn.length > 20000) return res.status(400).json({ error: "Too many rows to export" });

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
      // Use CRLF so desktop Excel recognizes explicit line breaks immediately.
      return outLines.join("\r\n");
    }

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("candidates");
    ws.columns = [
      { header: "Candidate Code", key: "candidateCode", width: 16 },
      { header: "Writing", key: "writing", width: 95 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getColumn(2).alignment = { wrapText: true, vertical: "top" };

    for (const r of rowsIn) {
      const text = softWrapText(r.qWriting || "", 90);
      const row = ws.addRow({
        candidateCode: String(r.candidateCode || ""),
        writing: String(text || ""),
      });
      row.getCell(2).alignment = { wrapText: true, vertical: "top" };
      const logicalLines = String(text || "")
        .split(/\r?\n/)
        .reduce((sum, line) => sum + Math.max(1, Math.ceil(String(line || "").length / 90)), 0);
      row.height = Math.min(220, Math.max(20, logicalLines * 15));
    }

    const out = await workbook.xlsx.writeBuffer();
    const buf = Buffer.from(out);

    const labelRaw = String(req.body?.label || "ALL").trim().replace(/[^A-Za-z0-9._-]/g, "_");
    const label = labelRaw || "ALL";
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const filename = `candidates_${label}_${ts}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buf);
  });

  app.post("/api/examiner/sessions/:id/finalize-grade", async (req, res) => {
    await ensureInit();
    const a = await examinerAuth(req, res);
    if (!a.ok) return res.status(401).json({ error: "Not authenticated" });

    const sessionId = Number(req.params.id);
    if (DB.examinerCanAccessSession) {
      const allowed = await DB.examinerCanAccessSession({ sessionId, examinerUsername: a.user });
      if (!allowed) return res.status(403).json({ error: "Forbidden" });
    }
    const speakingGrade = req.body?.speaking_grade;
    const writingGrade = req.body?.writing_grade;

    const out = await DB.setExaminerGrades({ sessionId, speakingGrade, writingGrade });
    if (!out) return res.status(404).json({ error: "Session not found" });
    res.json(out);
  });
};
