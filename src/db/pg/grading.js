function createPgGradingHelpers(deps) {
  const { calculateWeightedGrade } = require("../../utils/section_grading");
  const {
    q,
    q1,
    getPool,
    verifyPassword,
    buildConfigResponse,
    getProctoringConfig,
    getAdminTest,
    answerToText,
  } = deps;

  async function listResults() {
    const r = await q(
      `SELECT s.id AS "sessionId", s.name AS "candidateName", s.token, s.submitted,
              qg.total_grade AS "totalGrade"
       FROM public.sessions s
       LEFT JOIN public.question_grades qg ON qg.session_id = s.id
       WHERE s.submitted = TRUE
       ORDER BY s.id DESC
       LIMIT 5000`
    );
    return r.rows;
  }

  function getConfig() {
    return buildConfigResponse(getProctoringConfig);
  }

  async function getQuestionGrades(sessionId) {
    const sid = Number(sessionId);
    if (!Number.isFinite(sid) || sid <= 0) return null;
    const row = await q1(
      `SELECT
          session_id AS "sessionId",
          public.question_grades.token AS "token",
          s.exam_period_id AS "examPeriodId",
          COALESCE(q_writing, '') AS "qWriting",
          COALESCE(answers_json, '{}'::jsonb) AS "answersJson",
          speaking_grade AS "speakingGrade",
          writing_grade AS "writingGrade",
          total_grade AS "totalGrade",
          created_at_utc_ms AS "createdAtUtcMs"
       FROM public.question_grades
       JOIN public.sessions s ON s.id = public.question_grades.session_id
       WHERE public.question_grades.session_id = $1
       LIMIT 1;`,
      [sid]
    );
    return row || null;
  }

  async function verifyAdmin(username, password) {
    const u = String(username || "");
    const p = String(password || "");
    if (!u || !p) return false;
    const row = await q(`SELECT pass_hash FROM admins WHERE username = $1 LIMIT 1;`, [u]);
    if (!row.rows.length) return false;
    return verifyPassword(p, row.rows[0].pass_hash);
  }

  async function verifyExaminer(username, password) {
    const u = String(username || "");
    const p = String(password || "");
    if (!u || !p) return false;
    const row = await q(`SELECT pass_hash FROM examiners WHERE username = $1 LIMIT 1;`, [u]);
    if (!row.rows.length) return false;
    return verifyPassword(p, row.rows[0].pass_hash);
  }

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

    const sr = await q(`SELECT id, token, exam_period_id, COALESCE(disqualified, FALSE) AS disqualified FROM public.sessions WHERE id = $1`, [sid]);
    const s = sr.rows[0];
    if (!s) return null;

    if (s.disqualified) {
      await q(
        `INSERT INTO public.question_grades (session_id, exam_period_id, token, speaking_grade, writing_grade, total_grade, created_at_utc_ms)
         VALUES ($1, $2, $3, 0, 0, 0, $4)
         ON CONFLICT (session_id)
         DO UPDATE SET
           exam_period_id = EXCLUDED.exam_period_id,
           token = EXCLUDED.token,
           speaking_grade = 0,
           writing_grade = 0,
           total_grade = 0,
           created_at_utc_ms = EXCLUDED.created_at_utc_ms;`,
        [sid, s.exam_period_id, String(s.token || ""), Date.now()]
      );
      return { sessionId: sid, locked: true, disqualified: true, totalGrade: 0 };
    }

    await q(
      `INSERT INTO public.question_grades (session_id, exam_period_id, token, speaking_grade, writing_grade, created_at_utc_ms)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id)
       DO UPDATE SET
         exam_period_id = EXCLUDED.exam_period_id,
         token = EXCLUDED.token,
         speaking_grade = EXCLUDED.speaking_grade,
         writing_grade = EXCLUDED.writing_grade,
         created_at_utc_ms = EXCLUDED.created_at_utc_ms;`,
      [sid, s.exam_period_id, String(s.token || ""), spV, wrV, Date.now()]
    );

    const qg = await q1(
      `SELECT COALESCE(answers_json, '{}'::jsonb) AS answers_json,
              speaking_grade, writing_grade
       FROM public.question_grades
       WHERE session_id = $1
       LIMIT 1;`,
      [sid]
    );

    const payload = await getAdminTest(Number(s.exam_period_id) || 1);
    const ansObj = (qg && typeof qg.answers_json === "object" && qg.answers_json) || {};
    const spCalc = qg?.speaking_grade === null || qg?.speaking_grade === undefined ? 0 : Number(qg.speaking_grade);
    const wrCalc = qg?.writing_grade === null || qg?.writing_grade === undefined ? 0 : Number(qg.writing_grade);
    const graded = calculateWeightedGrade({
      payload,
      answers: ansObj,
      answerToText,
      speakingGrade: spCalc,
      writingGrade: wrCalc,
    });
    const final = graded.totalGrade;

    await q(
      `UPDATE public.question_grades
       SET total_grade = $1
       WHERE session_id = $2;`,
      [final, sid]
    );

    return {
      sessionId: sid,
      weights: graded.weights,
      listening: {
        earned: graded.listening.earned,
        max: graded.listening.max,
        percent: Math.round(graded.listening.percent * 10) / 10,
      },
      reading: {
        earned: graded.reading.earned,
        max: graded.reading.max,
        percent: Math.round(graded.reading.percent * 10) / 10,
      },
      writing: {
        earned: Math.round(graded.writing.earned * 10) / 10,
        max: graded.writing.max,
        percent: Math.round(graded.writing.percent * 10) / 10,
      },
      speakingGrade: spV,
      writingGrade: wrV,
      finalGrade: final,
    };
  }

  async function deleteCandidateBySessionId(sessionId) {
    const sid = Number(sessionId);
    if (!Number.isFinite(sid) || sid <= 0) throw new Error("Invalid session id");

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      const sr = await client.query(
        `SELECT id, candidate_id
         FROM public.sessions
         WHERE id = $1
         FOR UPDATE`,
        [sid]
      );
      if (!sr.rows.length) {
        await client.query("ROLLBACK");
        return { ok: false, deleted: 0 };
      }

      const candidateId = sr.rows[0].candidate_id ? Number(sr.rows[0].candidate_id) : null;
      if (Number.isFinite(candidateId) && candidateId > 0) {
        await client.query(
          `DELETE FROM public.question_grades
           WHERE session_id IN (SELECT id FROM public.sessions WHERE candidate_id = $1)`,
          [candidateId]
        );
        await client.query(
          `DELETE FROM public.speaking_slots
           WHERE session_id IN (SELECT id FROM public.sessions WHERE candidate_id = $1)`,
          [candidateId]
        );
        const sdel = await client.query(
          `DELETE FROM public.sessions WHERE candidate_id = $1`,
          [candidateId]
        );
        await client.query(`DELETE FROM public.candidates WHERE id = $1`, [candidateId]);
        await client.query("COMMIT");
        return { ok: true, deleted: Number(sdel.rowCount || 0) };
      }

      await client.query(`DELETE FROM public.question_grades WHERE session_id = $1`, [sid]);
      await client.query(`DELETE FROM public.speaking_slots WHERE session_id = $1`, [sid]);
      const sdel = await client.query(`DELETE FROM public.sessions WHERE id = $1`, [sid]);
      await client.query("COMMIT");
      return { ok: true, deleted: Number(sdel.rowCount || 0) };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }

  async function deleteSessionById(sessionId) {
    const sid = Number(sessionId);
    if (!Number.isFinite(sid) || sid <= 0) throw new Error("Invalid session id");

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      const sr = await client.query(
        `SELECT id, candidate_id
         FROM public.sessions
         WHERE id = $1
         FOR UPDATE`,
        [sid]
      );
      if (!sr.rows.length) {
        await client.query("ROLLBACK");
        return { ok: false, deleted: 0 };
      }

      const candidateId = sr.rows[0].candidate_id ? Number(sr.rows[0].candidate_id) : null;

      await client.query(`DELETE FROM public.question_grades WHERE session_id = $1`, [sid]);
      await client.query(`DELETE FROM public.speaking_slots WHERE session_id = $1`, [sid]);
      const sdel = await client.query(`DELETE FROM public.sessions WHERE id = $1`, [sid]);

      let candidateDeleted = false;
      if (Number.isFinite(candidateId) && candidateId > 0) {
        const c = await client.query(`SELECT COUNT(1) AS n FROM public.sessions WHERE candidate_id = $1`, [candidateId]);
        const n = Number(c.rows?.[0]?.n || 0);
        if (n <= 0) {
          await client.query(`DELETE FROM public.candidates WHERE id = $1`, [candidateId]);
          candidateDeleted = true;
        }
      }

      await client.query("COMMIT");
      return { ok: true, deleted: Number(sdel.rowCount || 0), candidateDeleted };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }

  async function deleteAllCoreData() {
    await q("BEGIN;");
    try {
      await q(
        "TRUNCATE public.speaking_slots, public.session_snapshots, public.session_listening_access, public.exam_security_events, public.proctoring_acks, public.examiner_assignments, public.question_grades, public.sessions, public.candidates RESTART IDENTITY CASCADE;"
      );
      await q("COMMIT;");
      return { ok: true };
    } catch (e) {
      try { await q("ROLLBACK;"); } catch {}
      throw e;
    }
  }

  return {
    listResults,
    getConfig,
    getQuestionGrades,
    verifyAdmin,
    verifyExaminer,
    setExaminerGrades,
    deleteCandidateBySessionId,
    deleteSessionById,
    deleteAllCoreData,
  };
}

module.exports = { createPgGradingHelpers };
