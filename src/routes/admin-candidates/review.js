function createAdminCandidateReviewHelpers(deps) {
  const {
    DB,
    ExcelJS,
    parseAnswersJson,
    buildReviewItems,
    getTestPayloadFull,
    softWrapText,
    deleteSnapshotFilesBySessionId,
  } = deps || {};

  async function getCandidateDetails(sessionId) {
    const sid = Number(sessionId);
    if (!Number.isFinite(sid) || sid <= 0) {
      return { ok: false, status: 400, error: "Invalid session id" };
    }

    if (!DB.getQuestionGrades) {
      return { ok: false, status: 501, error: "Details endpoint is unavailable for this DB adapter" };
    }

    const qg = await DB.getQuestionGrades(sid);
    if (!qg) return { ok: false, status: 404, error: "No submitted details found for this session" };

    const ep = Number(qg.examPeriodId || 1);
    const examPeriodId = Number.isFinite(ep) && ep > 0 ? ep : 1;
    const payload = DB.getAdminTest ? await DB.getAdminTest(examPeriodId) : getTestPayloadFull();
    const answersObj = parseAnswersJson(qg.answersJson);
    const review = buildReviewItems(payload, answersObj);

    return {
      ok: true,
      data: {
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
      },
    };
  }

  async function buildCandidatesExportBuffer({ rows, includeDetailed, scope }) {
    const rowsIn = Array.isArray(rows) ? rows : [];
    if (!rowsIn.length) return { ok: false, status: 400, error: "No rows to export" };
    if (rowsIn.length > 50000) return { ok: false, status: 400, error: "Too many rows to export" };

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
        email: String(r.email || ""),
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
          { header: "Email", key: "email" },
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
          { header: "Email", key: "email" },
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
    const scopeRaw = String(scope || "selected").trim().replace(/[^A-Za-z0-9._-]/g, "_");
    const safeScope = scopeRaw || "selected";
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const filename = `admin_candidates_${safeScope}_${ts}.xlsx`;

    return { ok: true, buffer: buf, filename };
  }

  async function bulkDeleteSessions(sessionIds) {
    if (typeof DB.deleteSessionById !== "function") {
      return { ok: false, status: 501, error: "Not supported on this DB adapter" };
    }

    const idsRaw = Array.isArray(sessionIds) ? sessionIds : [];
    const ids = Array.from(new Set(idsRaw.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)));
    if (!ids.length) return { ok: false, status: 400, error: "No sessionIds provided" };

    let okCount = 0;
    let failCount = 0;
    const errors = [];
    for (const sid of ids) {
      try {
        const snap = await deleteSnapshotFilesBySessionId(sid);
        const out = await DB.deleteSessionById(sid);
        if (out?.ok) okCount += 1;
        else failCount += 1;
        for (const e of snap?.errors || []) errors.push({ sessionId: sid, ...e });
      } catch (e) {
        failCount += 1;
        errors.push({ sessionId: sid, error: String(e?.message || "delete_failed") });
      }
    }

    return {
      ok: true,
      data: {
        ok: true,
        requested: ids.length,
        deleted: okCount,
        failed: failCount,
        errors: errors.slice(0, 100),
      },
    };
  }

  async function deleteSingleSession(sessionId) {
    const sid = Number(sessionId);
    if (typeof DB.deleteSessionById !== "function") {
      return { ok: false, status: 501, error: "Not supported on this DB adapter" };
    }

    const snap = await deleteSnapshotFilesBySessionId(sid);
    const out = await DB.deleteSessionById(sid);
    if (!out?.ok) return { ok: false, status: 404, error: "Session not found" };

    return {
      ok: true,
      data: {
        ...out,
        snapshotDeleted: Number(snap?.deleted || 0),
        snapshotDeleteErrors: (snap?.errors || []).slice(0, 25),
      },
    };
  }

  return {
    getCandidateDetails,
    buildCandidatesExportBuffer,
    bulkDeleteSessions,
    deleteSingleSession,
  };
}

module.exports = {
  createAdminCandidateReviewHelpers,
};
