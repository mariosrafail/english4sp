function createSqliteGradingHelpers(deps) {
  const {
    run,
    get,
    all,
    db,
    verifyPassword,
    getAdminTest,
    answerToText,
  } = deps;

  async function setExaminerGrades({ sessionId, speakingGrade, writingGrade }) {
    const sid = Number(sessionId);
    if (!Number.isFinite(sid)) return null;

    const sp = speakingGrade === null || speakingGrade === undefined || speakingGrade === "" ? null : Number(speakingGrade);
    const wr = writingGrade === null || writingGrade === undefined || writingGrade === "" ? null : Number(writingGrade);

    function clamp100(n) {
      if (n === null) return null;
      if (!Number.isFinite(n)) return null;
      const v = Math.round(n);
      if (v < 0) return 0;
      if (v > 100) return 100;
      return v;
    }

    const spV = clamp100(sp);
    const wrV = clamp100(wr);

    const s = await get(`SELECT id, token, exam_period_id FROM sessions WHERE id = ? LIMIT 1;`, [sid]);
    if (!s) return null;

    const qg = await get(`SELECT id FROM question_grades WHERE session_id = ? LIMIT 1;`, [sid]);
    if (qg) {
      await run(
        `UPDATE question_grades
         SET speaking_grade = ?, writing_grade = ?, created_at_utc_ms = ?
         WHERE session_id = ?`,
        [spV, wrV, Date.now(), sid]
      );
    } else {
      await run(
        `INSERT INTO question_grades (session_id, token, q_writing, answers_json, speaking_grade, writing_grade, created_at_utc_ms)
         VALUES (?, ?, '', '{}', ?, ?, ?)`,
        [sid, String(s.token || ""), spV, wrV, Date.now()]
      );
    }

    const q = await get(`SELECT COALESCE(answers_json,'{}') AS answers_json FROM question_grades WHERE session_id = ? LIMIT 1;`, [sid]);
    let ansObj = {};
    try { ansObj = JSON.parse(String(q?.answers_json || "{}")); } catch {}

    const payload = await getAdminTest(Number(s.exam_period_id) || 1);
    let objectiveEarned = 0;
    let objectiveMax = 0;
    const sectionIdNorm = (sec) => String(sec?.id || "").trim().toLowerCase();
    for (const sec of payload.sections || []) {
      const sidNorm = sectionIdNorm(sec);
      const inObjectiveSection = sidNorm === "listening" || sidNorm === "reading" || sidNorm === "writing";
      if (!inObjectiveSection) continue;

      let writingTask1Active = true;
      for (const item of sec.items || []) {
        if (!item || !item.id || item.type === "info") continue;
        if (sidNorm === "writing") {
          if (item.type === "writing") writingTask1Active = false;
          if (!writingTask1Active) continue;
        }
        const pts = Number(item.points || 0);
        if (pts <= 0) continue;

        let expected = "";
        if (item.type === "mcq" || item.type === "listening-mcq") expected = answerToText(item, item.correctIndex);
        else if (item.type === "tf") expected = answerToText(item, item.correct);
        else if (item.type === "short") expected = answerToText(item, item.correctText);
        if (!expected) continue;

        const got = String(ansObj[item.id] ?? "").trim().toLowerCase();
        objectiveMax += pts;
        if (got === String(expected).trim().toLowerCase()) objectiveEarned += pts;
      }
    }
    const objectivePercent = objectiveMax > 0 ? (objectiveEarned / objectiveMax) * 100 : 0;
    const spCalc = spV === null ? 0 : spV;
    const wrCalc = wrV === null ? 0 : wrV;
    const total = Math.round((objectivePercent * 0.6) + (wrCalc * 0.2) + (spCalc * 0.2));

    await run(
      `UPDATE question_grades
       SET total_grade = ?, created_at_utc_ms = ?
       WHERE session_id = ?`,
      [total, Date.now(), sid]
    );

    return {
      sessionId: sid,
      objectiveEarned,
      objectiveMax,
      objectivePercent: Math.round(objectivePercent * 10) / 10,
      speakingGrade: spV,
      writingGrade: wrV,
      totalGrade: total,
    };
  }

  async function listResults({ examPeriodId } = {}) {
    const ep = examPeriodId ? Number(examPeriodId) : null;
    const rows = await all(
      ep
        ? `SELECT s.id AS sessionId, s.exam_period_id AS examPeriodId, s.name AS candidateName, s.token, s.submitted, q.total_grade AS totalGrade
           FROM sessions s
           LEFT JOIN question_grades q ON q.session_id = s.id
           WHERE submitted = 1 AND exam_period_id = ?
           ORDER BY s.id DESC
           LIMIT 5000`
        : `SELECT s.id AS sessionId, s.exam_period_id AS examPeriodId, s.name AS candidateName, s.token, s.submitted, q.total_grade AS totalGrade
           FROM sessions s
           LEFT JOIN question_grades q ON q.session_id = s.id
           WHERE submitted = 1
           ORDER BY s.id DESC
           LIMIT 5000`,
      ep ? [ep] : []
    );
    return rows;
  }

  async function getQuestionGrades(sessionId) {
    const sid = Number(sessionId);
    if (!Number.isFinite(sid)) return null;
    return await get(
      `SELECT q.session_id AS sessionId,
              q.token,
              s.exam_period_id AS examPeriodId,
              COALESCE(q.q_writing,'') AS qWriting,
              COALESCE(q.answers_json,'{}') AS answersJson,
              q.speaking_grade AS speakingGrade,
              q.writing_grade AS writingGrade,
              q.total_grade AS totalGrade,
              q.created_at_utc_ms AS createdAtUtcMs
       FROM question_grades q
       JOIN sessions s ON s.id = q.session_id
       WHERE q.session_id = ?
       LIMIT 1;`,
      [sid]
    );
  }

  async function verifyAdmin(username, password) {
    const u = String(username || "");
    const p = String(password || "");
    if (!u || !p) return false;
    const row = await get(`SELECT pass_hash FROM admins WHERE username = ? LIMIT 1;`, [u]);
    if (!row) return false;
    return verifyPassword(p, row.pass_hash);
  }

  async function verifyExaminer(username, password) {
    const u = String(username || "");
    const p = String(password || "");
    if (!u || !p) return false;
    const row = await get(`SELECT pass_hash FROM examiners WHERE username = ? LIMIT 1;`, [u]);
    if (!row) return false;
    return verifyPassword(p, row.pass_hash);
  }

  async function deleteAllCoreData() {
    db();
    await run("BEGIN;");
    try {
      await run("DELETE FROM question_grades;");
      await run("DELETE FROM proctoring_acks;");
      await run("DELETE FROM session_snapshots;");
      await run("DELETE FROM session_listening_access;");
      await run("DELETE FROM sessions;");
      await run("DELETE FROM candidates;");
      try {
        await run(
          "DELETE FROM sqlite_sequence WHERE name IN ('question_grades','proctoring_acks','session_snapshots','sessions','candidates');"
        );
      } catch {}
      await run("COMMIT;");
      return { ok: true };
    } catch (e) {
      try { await run("ROLLBACK;"); } catch {}
      throw e;
    }
  }

  async function deleteCandidateBySessionId(sessionId) {
    const sid = Number(sessionId);
    if (!Number.isFinite(sid) || sid <= 0) throw new Error("Invalid session id");

    await run("BEGIN;");
    try {
      const sr = await get(`SELECT id, candidate_id FROM sessions WHERE id = ? LIMIT 1;`, [sid]);
      if (!sr) {
        await run("ROLLBACK;");
        return { ok: false, deleted: 0 };
      }

      const candidateId = sr.candidate_id;

      if (candidateId) {
        await run(
          `DELETE FROM question_grades WHERE session_id IN (SELECT id FROM sessions WHERE candidate_id = ?);`,
          [candidateId]
        );
        const sdel = await run(`DELETE FROM sessions WHERE candidate_id = ?;`, [candidateId]);
        await run(`DELETE FROM candidates WHERE id = ?;`, [candidateId]);
        await run("COMMIT;");
        return { ok: true, deleted: Number(sdel?.changes || 0) };
      }

      await run(`DELETE FROM question_grades WHERE session_id = ?;`, [sid]);
      const sdel = await run(`DELETE FROM sessions WHERE id = ?;`, [sid]);
      await run("COMMIT;");
      return { ok: true, deleted: Number(sdel?.changes || 0) };
    } catch (e) {
      try { await run("ROLLBACK;"); } catch {}
      throw e;
    }
  }

  async function deleteSessionById(sessionId) {
    const sid = Number(sessionId);
    if (!Number.isFinite(sid) || sid <= 0) throw new Error("Invalid session id");

    await run("BEGIN;");
    try {
      const sr = await get(`SELECT id, candidate_id FROM sessions WHERE id = ? LIMIT 1;`, [sid]);
      if (!sr) {
        await run("ROLLBACK;");
        return { ok: false, deleted: 0 };
      }

      const candidateId = sr.candidate_id ? Number(sr.candidate_id) : null;

      await run(`DELETE FROM question_grades WHERE session_id = ?;`, [sid]);
      await run(`DELETE FROM proctoring_acks WHERE session_id = ?;`, [sid]);
      await run(`DELETE FROM session_snapshots WHERE session_id = ?;`, [sid]);
      await run(`DELETE FROM session_listening_access WHERE session_id = ?;`, [sid]);
      const sdel = await run(`DELETE FROM sessions WHERE id = ?;`, [sid]);

      let candidateDeleted = false;
      if (Number.isFinite(candidateId) && candidateId > 0) {
        const c = await get(`SELECT COUNT(1) AS n FROM sessions WHERE candidate_id = ?;`, [candidateId]);
        const n = Number(c?.n || 0);
        if (n <= 0) {
          await run(`DELETE FROM candidates WHERE id = ?;`, [candidateId]);
          candidateDeleted = true;
        }
      }

      await run("COMMIT;");
      return { ok: true, deleted: Number(sdel?.changes || 0), candidateDeleted };
    } catch (e) {
      try { await run("ROLLBACK;"); } catch {}
      throw e;
    }
  }

  return {
    setExaminerGrades,
    listResults,
    getQuestionGrades,
    verifyAdmin,
    verifyExaminer,
    deleteAllCoreData,
    deleteCandidateBySessionId,
    deleteSessionById,
  };
}

module.exports = { createSqliteGradingHelpers };
