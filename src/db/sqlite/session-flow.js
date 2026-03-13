function createSqliteSessionFlowHelpers(deps) {
  const {
    run,
    get,
    all,
    getTestPayloadFull,
    getAdminTest,
    getAppConfig,
    defaultOpenAtUtcMs,
    defaultDurationMinutes,
  } = deps;

  function makeToken() {
    return (
      Math.random().toString(36).slice(2, 8).toUpperCase() +
      Math.random().toString(36).slice(2, 6).toUpperCase()
    );
  }

  async function createSession({ candidateName, examPeriodId = 1 }) {
    const token = makeToken();
    const name = String(candidateName || "Candidate").trim() || "Candidate";
    const ep = Number(examPeriodId) || 1;

    const r = await run(
      `INSERT INTO sessions (exam_period_id, token, name, submitted) VALUES (?, ?, ?, 0)`,
      [ep, token, name]
    );
    const sessionId = Number(r && (r.lastID ?? r.lastId));
    return { token, sessionId };
  }

  async function importCandidatesAndCreateSessions({ rows, examPeriodId, assignmentStrategy = "batch_even", onProgress } = {}) {
    const ep = Number(examPeriodId) || 1;
    if (!Number.isFinite(ep) || ep <= 0) throw new Error("Invalid exam period");

    const inRows = Array.isArray(rows) ? rows : [];
    const workRows = inRows.filter((r) => String(r?.email || "").trim());

    const byEmail = new Map();
    for (const r of workRows) {
      const email = String(r?.email || "").trim().toLowerCase();
      if (!email) continue;
      byEmail.set(email, {
        email,
        name: String(r?.name || "").trim(),
        country: String(r?.country || "").trim(),
      });
    }
    const uniqRows = Array.from(byEmail.values());

    const total = uniqRows.length;
    let processed = 0;
    const report = (phase = "importing") => {
      if (typeof onProgress !== "function") return;
      try { onProgress({ processed, total, phase }); } catch {}
    };
    report("candidates");

    await run(
      `INSERT OR IGNORE INTO exam_periods (id, name, created_at_utc_ms) VALUES (?, ?, ?);`,
      [ep, `Exam Period ${ep}`, Date.now()]
    );

    await run("BEGIN;");
    try {
      const created = [];

      if (!uniqRows.length) {
        await run("COMMIT;");
        report("done");
        return { sessions: created };
      }

      const CHUNK = 200;
      for (let i = 0; i < uniqRows.length; i += CHUNK) {
        const chunk = uniqRows.slice(i, i + CHUNK);
        const now = Date.now();
        const valuesSql = chunk.map(() => "(?, ?, ?, ?)").join(",");
        const params = [];
        for (const r of chunk) params.push(r.name || null, r.email, r.country || null, now);
        await run(
          `INSERT INTO candidates (name, email, country, created_at_utc_ms)
           VALUES ${valuesSql}
           ON CONFLICT(email) DO UPDATE
           SET name = excluded.name,
               country = excluded.country;`,
          params
        );
        processed = Math.min(total, i + chunk.length);
        report("candidates");
      }

      const candByEmail = new Map();
      processed = 0;
      report("lookup");
      for (let i = 0; i < uniqRows.length; i += CHUNK) {
        const chunk = uniqRows.slice(i, i + CHUNK);
        const inSql = chunk.map(() => "?").join(",");
        const rowsOut = await all(
          `SELECT id, name, email, country FROM candidates WHERE email IN (${inSql});`,
          chunk.map((r) => r.email)
        );
        for (const c of rowsOut || []) {
          const email = String(c.email || "").trim().toLowerCase();
          if (email) candByEmail.set(email, c);
        }
        processed = Math.min(total, i + chunk.length);
        report("lookup");
      }

      const canReuse = String(assignmentStrategy || "") !== "single_least_random";
      const existingByCandidateId = new Map();
      if (canReuse) {
        const candIds = Array.from(
          new Set(Array.from(candByEmail.values()).map((c) => Number(c.id)).filter((n) => Number.isFinite(n) && n > 0))
        );
        const ID_CHUNK = 300;
        processed = 0;
        report("sessions_lookup");
        for (let i = 0; i < candIds.length; i += ID_CHUNK) {
          const ids = candIds.slice(i, i + ID_CHUNK);
          const inSql = ids.map(() => "?").join(",");
          const rowsOut = await all(
            `SELECT candidate_id AS candidateId, id AS sessionId, token AS token
             FROM sessions
             WHERE exam_period_id = ?
               AND candidate_id IN (${inSql});`,
            [ep, ...ids]
          );
          for (const s of rowsOut || []) {
            const cid = Number(s.candidateId || 0);
            if (Number.isFinite(cid) && cid > 0 && !existingByCandidateId.has(cid)) existingByCandidateId.set(cid, s);
          }
          processed = Math.min(total, i + ids.length);
          report("sessions_lookup");
        }
      }

      processed = 0;
      report("sessions");
      for (const r of uniqRows) {
        const email = String(r.email || "").trim().toLowerCase();
        const c = candByEmail.get(email) || null;
        const cid = Number(c?.id || 0);
        if (!Number.isFinite(cid) || cid <= 0) continue;

        const existing = canReuse ? existingByCandidateId.get(cid) : null;
        if (existing) {
          created.push({
            sessionId: Number(existing.sessionId),
            token: String(existing.token || ""),
            examPeriodId: ep,
            candidateId: cid,
            name: String(c?.name || r.name || ""),
            email: String(c?.email || r.email || ""),
            country: String(c?.country || r.country || ""),
            reused: true,
            assignedExaminer: "",
          });
          processed += 1;
          report("sessions");
          continue;
        }

        let token = makeToken();
        let sessionId = null;
        for (let i = 0; i < 6; i++) {
          try {
            const ins = await run(
              `INSERT INTO sessions (exam_period_id, candidate_id, token, name, submitted)
               VALUES (?, ?, ?, ?, 0);`,
              [ep, cid, token, String(c?.name || r.name || "Candidate")]
            );
            sessionId = Number(ins?.lastID || 0) || null;
            break;
          } catch (e) {
            const msg = String(e?.message || "");
            if (/UNIQUE|constraint/i.test(msg)) {
              token = makeToken();
              continue;
            }
            throw e;
          }
        }
        if (!sessionId) continue;

        created.push({
          sessionId,
          token,
          examPeriodId: ep,
          candidateId: cid,
          name: String(c?.name || r.name || ""),
          email: String(c?.email || r.email || ""),
          country: String(c?.country || r.country || ""),
          reused: false,
          assignedExaminer: "",
        });

        processed += 1;
        report("sessions");
      }

      await run("COMMIT;");
      processed = total;
      report("done");
      return { sessions: created };
    } catch (e) {
      try { await run("ROLLBACK;"); } catch {}
      throw e;
    }
  }

  async function getGateForToken(token) {
    const t = String(token || "").trim();
    if (!t) return null;
    const s = await get(`SELECT id, exam_period_id AS examPeriodId FROM sessions WHERE token = ? ORDER BY id DESC LIMIT 1;`, [t]);
    if (!s) return null;

    const cfg = getAppConfig();
    const now = Date.now();
    const openAtUtc = Number(cfg?.openAtUtc ?? defaultOpenAtUtcMs);
    const durationMinutes = Number(cfg?.durationMinutes ?? defaultDurationMinutes);
    const durMinOk = Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : defaultDurationMinutes;
    const openOk = Number.isFinite(openAtUtc) && openAtUtc > 0 ? openAtUtc : defaultOpenAtUtcMs;
    const durMs = durMinOk * 60 * 1000;
    const endAtUtc = openOk + durMs;

    const examPeriodId = Number(s?.examPeriodId || 0) || 1;
    return { now, openAtUtc: openOk, durationMinutes: durMinOk, durMs, endAtUtc, examPeriodId };
  }

  async function getSessionForExam(token) {
    const t = String(token || "").trim();
    if (!t) return null;

    const row = await get(
      `SELECT s.id, s.token, s.name, s.submitted, COALESCE(s.disqualified, 0) AS disqualified,
              s.exam_period_id AS exam_period_id,
              q.total_grade AS total_grade,
              EXISTS(SELECT 1 FROM proctoring_acks pa WHERE pa.session_id = s.id) AS proctoring_acked
       FROM sessions s
       LEFT JOIN question_grades q ON q.session_id = s.id
       WHERE s.token = ?
       ORDER BY s.id DESC
       LIMIT 1;`,
      [t]
    );
    if (!row) return null;

    const cfg = getAppConfig();
    const openAtUtc = Number(cfg?.openAtUtc ?? defaultOpenAtUtcMs);
    const durationMinutes = Number(cfg?.durationMinutes ?? defaultDurationMinutes);

    const payload = payloadForClientFromFull(await getAdminTest(Number(row.exam_period_id) || 1));
    try {
      for (const sec of payload.sections || []) {
        for (const item of sec.items || []) {
          if (item && String(item.type || "") === "listening-mcq") {
            delete item.audioUrl;
          }
        }
      }
    } catch {}

    return {
      session: {
        id: Number(row.id),
        token: String(row.token || ""),
        candidateName: String(row.name || ""),
        submitted: Number(row.submitted) === 1,
        disqualified: Number(row.disqualified) === 1,
        proctoringAcked: Number(row.proctoring_acked) === 1,
        grade: row.total_grade === null || row.total_grade === undefined ? null : Number(row.total_grade),
        examPeriodId: Number(row.exam_period_id) || 1,
        openAtUtc: Number.isFinite(openAtUtc) ? openAtUtc : defaultOpenAtUtcMs,
        durationMinutes: Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : defaultDurationMinutes,
      },
      test: {
        id: 1,
        title: "English Test",
        payload,
      },
    };
  }

  async function startSession(token) {
    const t = String(token || "").trim();
    if (!t) return null;
    const s = await get(`SELECT submitted FROM sessions WHERE token = ? ORDER BY id DESC LIMIT 1;`, [t]);
    if (!s) return null;
    if (Number(s.submitted) === 1) return { status: "submitted" };
    return { status: "started" };
  }

  async function ensureSessionAssignedExaminer(_opts = {}) {
    return "";
  }

  function normalizeAnswers(answers) {
    if (!answers || typeof answers !== "object") return {};
    return answers;
  }

  function answerToText(item, raw) {
    if (!item) return "";

    if (item.type === "mcq" || item.type === "listening-mcq") {
      const idx = Number(raw);
      if (!Number.isFinite(idx) || idx < 0) return "";
      const max = Array.isArray(item.choices) ? item.choices.length : Infinity;
      if (idx >= max) return "";
      return String.fromCharCode("a".charCodeAt(0) + idx);
    }

    if (item.type === "tf") {
      if (raw === "" || raw === null || raw === undefined) return "";
      const val = raw === true || raw === "true" || raw === "True" || raw === 1 || raw === "1";
      return val ? "true" : "false";
    }

    if (item.type === "short") {
      return String(raw ?? "").trim();
    }

    return String(raw ?? "").trim();
  }

  function buildStoredAnswers(payload, normAnswers) {
    const out = {};
    for (const sec of payload.sections || []) {
      for (const item of sec.items || []) {
        if (!item || !item.id || item.type === "info" || item.type === "drag-words") continue;
        out[item.id] = answerToText(item, normAnswers?.[item.id]);
      }
    }
    return out;
  }

  function payloadForClientFromFull(full) {
    const payload = JSON.parse(JSON.stringify(full || {}));
    for (const sec of payload.sections || []) {
      for (const item of sec.items || []) {
        delete item.correctIndex;
        delete item.correct;
        delete item.correctText;
      }
    }
    return payload;
  }

  async function gradeAttempt(answers) {
    const payload = getTestPayloadFull();
    let score = 0;
    let maxScore = 0;
    const breakdown = [];

    for (const sec of payload.sections || []) {
      for (const item of sec.items || []) {
        const pts = Number(item.points || 0);
        maxScore += pts;

        const a = answers[item.id];
        let earned = 0;
        let ok = false;

        if (item.type === "mcq" || item.type === "listening-mcq") {
          const idx = Number(a);
          ok = Number.isFinite(idx) && idx === item.correctIndex;
          earned = ok ? pts : 0;
        } else if (item.type === "tf") {
          const val = a === true || a === "true" || a === "True";
          ok = val === item.correct;
          earned = ok ? pts : 0;
        } else if (item.type === "short") {
          const s = String(a || "").trim().toLowerCase();
          const expected = String(item.correctText || "").trim().toLowerCase();
          ok = expected.length > 0 && s === expected;
          earned = ok ? pts : 0;
        }

        score += earned;
        breakdown.push({ id: item.id, earned, pts, ok });
      }
    }

    const percent = maxScore > 0 ? Math.round((score / maxScore) * 1000) / 10 : 0;
    return { score, maxScore, percent, breakdown };
  }

  async function submitAnswers(token, answers) {
    const s = await get(`SELECT id, submitted, exam_period_id FROM sessions WHERE token = ? ORDER BY s.id DESC LIMIT 1`, [token]);
    if (!s) return null;
    if (s.submitted) return { status: "submitted" };

    const normAnswers = normalizeAnswers(answers);

    await run(`UPDATE sessions SET submitted = 1 WHERE id = ?`, [s.id]);

    const payload = await getAdminTest(Number(s.exam_period_id) || 1);

    let wVal = "";
    try {
      for (const sec of payload.sections || []) {
        for (const item of sec.items || []) {
          if (item && item.id === "q4") {
            wVal = answerToText(item, normAnswers?.[item.id]);
          }
        }
      }
    } catch {}

    const storedAnswers = buildStoredAnswers(payload, normAnswers);
    const answersJson = JSON.stringify(storedAnswers);

    const existing = await get(`SELECT id FROM question_grades WHERE session_id = ? LIMIT 1;`, [s.id]);
    if (existing) {
      await run(
        `UPDATE question_grades
         SET token = ?, q_writing = ?, answers_json = ?, created_at_utc_ms = ?
         WHERE session_id = ?`,
        [token, wVal, answersJson, Date.now(), s.id]
      );
    } else {
      await run(
        `INSERT INTO question_grades (session_id, token, q_writing, answers_json, created_at_utc_ms)
         VALUES (?, ?, ?, ?, ?)`,
        [s.id, token, wVal, answersJson, Date.now()]
      );
    }

    return { status: "submitted" };
  }

  async function listCandidates({ examPeriodId } = {}) {
    const ep = examPeriodId ? Number(examPeriodId) : null;
    const rows = await all(
      ep
        ? `SELECT s.id AS sessionId, s.exam_period_id AS examPeriodId, s.name AS candidateName,
                 COALESCE(c.email, '') AS email, s.token, s.submitted,
                 q.total_grade AS totalGrade, COALESCE(s.disqualified, 0) AS disqualified,
                 '' AS assignedExaminer
           FROM sessions s
           LEFT JOIN candidates c ON c.id = s.candidate_id
           LEFT JOIN question_grades q ON q.session_id = s.id
           WHERE s.exam_period_id = ?
           ORDER BY s.id DESC
           LIMIT 5000`
        : `SELECT s.id AS sessionId, s.exam_period_id AS examPeriodId, s.name AS candidateName,
                 COALESCE(c.email, '') AS email, s.token, s.submitted,
                 q.total_grade AS totalGrade, COALESCE(s.disqualified, 0) AS disqualified,
                 '' AS assignedExaminer
           FROM sessions s
           LEFT JOIN candidates c ON c.id = s.candidate_id
           LEFT JOIN question_grades q ON q.session_id = s.id
           ORDER BY s.id DESC
           LIMIT 5000`,
      ep ? [ep] : []
    );
    return rows;
  }

  async function listCandidatesForExaminer({ examPeriodId } = {}) {
    const ep = examPeriodId ? Number(examPeriodId) : null;
    const sql = ep
      ? `SELECT
           s.id AS sessionId,
           s.exam_period_id AS examPeriodId,
           COALESCE(epd.name, 'Exam Period ' || s.exam_period_id) AS examPeriodName,
           s.token,
           s.submitted,
           COALESCE(q.q_writing, '') AS qWriting,
           q.speaking_grade AS speakingGrade,
           q.writing_grade AS writingGrade
         FROM sessions s
         LEFT JOIN question_grades q ON q.session_id = s.id
         LEFT JOIN exam_periods epd ON epd.id = s.exam_period_id
         WHERE s.exam_period_id = ?
         ORDER BY s.id DESC
         LIMIT 5000`
      : `SELECT
           s.id AS sessionId,
           s.exam_period_id AS examPeriodId,
           COALESCE(epd.name, 'Exam Period ' || s.exam_period_id) AS examPeriodName,
           s.token,
           s.submitted,
           COALESCE(q.q_writing, '') AS qWriting,
           q.speaking_grade AS speakingGrade,
           q.writing_grade AS writingGrade
         FROM sessions s
         LEFT JOIN question_grades q ON q.session_id = s.id
         LEFT JOIN exam_periods epd ON epd.id = s.exam_period_id
         ORDER BY s.id DESC
         LIMIT 5000`;

    return await all(sql, ep ? [ep] : []);
  }

  return {
    createSession,
    importCandidatesAndCreateSessions,
    getGateForToken,
    getSessionForExam,
    startSession,
    ensureSessionAssignedExaminer,
    normalizeAnswers,
    answerToText,
    buildStoredAnswers,
    payloadForClientFromFull,
    gradeAttempt,
    submitAnswers,
    listCandidates,
    listCandidatesForExaminer,
  };
}

module.exports = { createSqliteSessionFlowHelpers };
