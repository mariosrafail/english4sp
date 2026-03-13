function createPgSessionFlowHelpers(deps) {
  const {
    q,
    q1,
    getPool,
    makeToken,
    assignSingleToLeastLoadedRandomTie,
    assignSessionsBalancedAcrossExaminers,
    ensureSessionAssignedExaminer,
    defaultOpenAtUtcMs,
    defaultDurationMinutes,
    getAdminTest,
  } = deps || {};

  async function createSession({ candidateName }) {
    const token = makeToken(10);
    const name = String(candidateName || "Candidate").trim() || "Candidate";
    const r = await q(
      `INSERT INTO public.sessions (token, name, submitted)
       VALUES ($1, $2, FALSE)
       RETURNING id`,
      [token, name]
    );
    return { token, sessionId: r.rows[0].id };
  }

  async function importCandidatesAndCreateSessions({ rows, examPeriodId, assignmentStrategy = "batch_even", onProgress } = {}) {
    const ep = Number(examPeriodId) || 1;
    if (!Number.isFinite(ep) || ep <= 0) throw new Error("Invalid exam period");

    const importPerRow = (() => {
      const raw = process.env.IMPORT_PROGRESS_PER_ROW;
      if (raw === undefined || raw === null || String(raw).trim() === "") return false;
      const v = String(raw).trim().toLowerCase();
      return ["1", "true", "yes", "y", "on"].includes(v);
    })();

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

    await q(
      `INSERT INTO exam_periods (id, name, open_at_utc_ms, duration_minutes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING;`,
      [ep, `Exam Period ${ep}`, defaultOpenAtUtcMs, defaultDurationMinutes]
    );

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      const created = [];

      if (!uniqRows.length) {
        await client.query("COMMIT");
        report("done");
        return { sessions: created };
      }

      if (importPerRow) {
        const canReuse = String(assignmentStrategy || "") !== "single_least_random";
        const candByEmail = new Map();

        processed = 0;
        report("candidates");
        for (const r of uniqRows) {
          const name = String(r?.name || "").trim();
          const email = String(r?.email || "").trim().toLowerCase();
          const country = String(r?.country || "").trim();
          if (!email) continue;

          const cand = await client.query(
            `INSERT INTO public.candidates (name, email, country)
             VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE
             SET name = EXCLUDED.name,
                 country = EXCLUDED.country
             RETURNING id, name, email, country;`,
            [name || null, email, country || null]
          );
          const c = cand.rows?.[0] || null;
          if (c && c.email) candByEmail.set(String(c.email).trim().toLowerCase(), c);

          processed += 1;
          report("candidates");
        }

        processed = 0;
        report("sessions");
        for (const r of uniqRows) {
          const email = String(r?.email || "").trim().toLowerCase();
          const c = candByEmail.get(email) || null;
          const cid = Number(c?.id || 0);
          if (!Number.isFinite(cid) || cid <= 0) continue;

          let existing = null;
          if (canReuse) {
            existing = await client.query(
              `SELECT id, token
               FROM public.sessions
               WHERE exam_period_id = $1 AND candidate_id = $2
               LIMIT 1;`,
              [ep, cid]
            );
          }
          const exRow = existing?.rows?.[0] || null;
          if (exRow && canReuse) {
            created.push({
              sessionId: exRow.id,
              token: exRow.token,
              examPeriodId: ep,
              candidateId: cid,
              name: c?.name || r.name || "",
              email: c?.email || r.email || "",
              country: c?.country || r.country || "",
              reused: true,
            });
          } else {
            let token = makeToken(10);
            let inserted = null;
            for (let i = 0; i < 5; i++) {
              try {
                const s = await client.query(
                  `INSERT INTO public.sessions (exam_period_id, candidate_id, token, name, submitted)
                   VALUES ($1, $2, $3, $4, FALSE)
                   RETURNING id;`,
                  [ep, cid, token, c?.name || r.name || "Candidate"]
                );
                inserted = s.rows?.[0] || null;
                break;
              } catch (e) {
                if (e && e.code === "23505") {
                  token = makeToken(10);
                  continue;
                }
                throw e;
              }
            }
            if (inserted && inserted.id) {
              created.push({
                sessionId: inserted.id,
                token,
                examPeriodId: ep,
                candidateId: cid,
                name: c?.name || r.name || "",
                email: c?.email || r.email || "",
                country: c?.country || r.country || "",
                reused: false,
              });
            }
          }

          processed += 1;
          report("sessions");
        }

        const sidsForAssign = created.map((x) => Number(x.sessionId));
        processed = total;
        report("assigning");
        if (String(assignmentStrategy || "") === "single_least_random") {
          for (const sid of sidsForAssign) {
            await assignSingleToLeastLoadedRandomTie({ sessionId: sid, examPeriodId: ep, client });
          }
        } else {
          await assignSessionsBalancedAcrossExaminers({
            sessionIds: sidsForAssign,
            examPeriodId: ep,
            client,
          });
        }

        const sidList = created
          .map((x) => Number(x.sessionId))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (sidList.length) {
          const asg = await client.query(
            `SELECT a.session_id, e.username
             FROM public.examiner_assignments a
             JOIN public.examiners e ON e.id = a.examiner_id
             WHERE a.session_id = ANY($1::int[]);`,
            [sidList]
          );
          const bySid = new Map((asg.rows || []).map((r) => [Number(r.session_id), String(r.username || "")]));
          for (const c of created) c.assignedExaminer = bySid.get(Number(c.sessionId)) || "";
        }

        await client.query("COMMIT");
        report("done");
        return { sessions: created };
      }

      const CHUNK = Math.max(50, Math.min(800, Math.floor(Number(process.env.IMPORT_DB_CHUNK_SIZE || 400))));
      const candByEmail = new Map();
      const candById = new Map();
      processed = 0;
      report("candidates");
      for (let i = 0; i < uniqRows.length; i += CHUNK) {
        const chunk = uniqRows.slice(i, i + CHUNK);
        const emails = chunk.map((r) => r.email);
        const names = chunk.map((r) => (r.name || null));
        const countries = chunk.map((r) => (r.country || null));

        const cand = await client.query(
          `WITH in_rows AS (
             SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[]) AS t(name, email, country)
           )
           INSERT INTO public.candidates (name, email, country)
           SELECT name, email, country FROM in_rows
           ON CONFLICT (email) DO UPDATE
           SET name = EXCLUDED.name,
               country = EXCLUDED.country
           RETURNING id, name, email, country;`,
          [names, emails, countries]
        );

        for (const c of cand.rows || []) {
          const e = String(c.email || "").trim().toLowerCase();
          if (e) candByEmail.set(e, c);
          const id = Number(c.id);
          if (Number.isFinite(id) && id > 0) candById.set(id, c);
        }
        processed = Math.min(total, i + chunk.length);
        report("candidates");
      }

      const candIds = Array.from(new Set(Array.from(candByEmail.values()).map((c) => Number(c.id)).filter((n) => Number.isFinite(n) && n > 0)));

      const canReuse = String(assignmentStrategy || "") !== "single_least_random";
      const existingByCandidateId = new Map();
      if (canReuse && candIds.length) {
        processed = 0;
        report("sessions_lookup");
        const existing = await client.query(
          `SELECT id, candidate_id, token
           FROM public.sessions
           WHERE exam_period_id = $1 AND candidate_id = ANY($2::bigint[]);`,
          [ep, candIds]
        );
        for (const s of existing.rows || []) {
          const cid = Number(s.candidate_id || 0);
          if (Number.isFinite(cid) && cid > 0 && !existingByCandidateId.has(cid)) existingByCandidateId.set(cid, s);
        }
        processed = total;
        report("sessions_lookup");
      }

      const toCreate = [];
      processed = 0;
      report("sessions");
      for (const r of uniqRows) {
        const c = candByEmail.get(String(r.email || "").trim().toLowerCase()) || null;
        const cid = Number(c?.id || 0);
        if (!Number.isFinite(cid) || cid <= 0) continue;
        const existing = canReuse ? existingByCandidateId.get(cid) : null;
        if (existing) {
          created.push({
            sessionId: existing.id,
            token: existing.token,
            examPeriodId: ep,
            candidateId: cid,
            name: c?.name || r.name || "",
            email: c?.email || r.email || "",
            country: c?.country || r.country || "",
            reused: true,
          });
          processed += 1;
          report("sessions");
        } else {
          toCreate.push({ candidateId: cid, name: String(c?.name || r.name || "Candidate") });
        }
      }

      let remaining = toCreate.slice();
      for (let attempt = 0; attempt < 5 && remaining.length; attempt++) {
        const REM_CHUNK = Math.max(50, Math.min(CHUNK, 800));
        const nextRemaining = [];
        for (let off = 0; off < remaining.length; off += REM_CHUNK) {
          const sub = remaining.slice(off, off + REM_CHUNK);
          const candIdArr = sub.map((x) => Number(x.candidateId));
          const nameArr = sub.map((x) => String(x.name || "Candidate"));
          const tokenArr = sub.map(() => makeToken(10));

          const ins = await client.query(
            `INSERT INTO public.sessions (exam_period_id, candidate_id, token, name, submitted)
             SELECT $1, x.candidate_id, x.token, x.name, FALSE
             FROM UNNEST($2::bigint[], $3::text[], $4::text[]) AS x(candidate_id, token, name)
             ON CONFLICT (token) DO NOTHING
             RETURNING id, candidate_id, token;`,
            [ep, candIdArr, tokenArr, nameArr]
          );

          const insertedByCandidate = new Map();
          for (const row of ins.rows || []) insertedByCandidate.set(Number(row.candidate_id), row);

          for (let i = 0; i < sub.length; i++) {
            const cid = Number(sub[i].candidateId);
            const row = insertedByCandidate.get(cid);
            if (row) {
              created.push({
                sessionId: row.id,
                token: row.token,
                examPeriodId: ep,
                candidateId: cid,
                name: sub[i].name || "",
                email: "",
                country: "",
                reused: false,
              });
              processed += 1;
              report("sessions");
            } else {
              nextRemaining.push(sub[i]);
            }
          }
        }
        remaining = nextRemaining;
      }

      for (const s of created) {
        if (s && s.reused === false && (!s.email || !s.country)) {
          const c = candById.get(Number(s.candidateId)) || null;
          if (c) {
            s.email = c.email;
            s.country = c.country || "";
            s.name = s.name || c.name || "";
          }
        }
      }

      const sidsForAssign = created.map((x) => Number(x.sessionId));
      processed = total;
      report("assigning");
      if (String(assignmentStrategy || "") === "single_least_random") {
        for (const sid of sidsForAssign) {
          await assignSingleToLeastLoadedRandomTie({ sessionId: sid, examPeriodId: ep, client });
        }
      } else {
        await assignSessionsBalancedAcrossExaminers({
          sessionIds: sidsForAssign,
          examPeriodId: ep,
          client,
        });
      }

      const sidList = created
        .map((x) => Number(x.sessionId))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (sidList.length) {
        const asg = await client.query(
          `SELECT a.session_id, e.username
           FROM public.examiner_assignments a
           JOIN public.examiners e ON e.id = a.examiner_id
           WHERE a.session_id = ANY($1::int[]);`,
          [sidList]
        );
        const bySid = new Map((asg.rows || []).map((r) => [Number(r.session_id), String(r.username || "")]));
        for (const c of created) c.assignedExaminer = bySid.get(Number(c.sessionId)) || "";
      }

      await client.query("COMMIT");
      report("done");
      return { sessions: created };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      throw e;
    } finally {
      client.release();
    }
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
      const letter = String.fromCharCode("a".charCodeAt(0) + idx);
      const max = Array.isArray(item.choices) ? item.choices.length : Infinity;
      if (idx >= max) return "";
      return letter;
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

  async function getSessionForExam(token) {
    const r = await q(
      `SELECT s.id, s.token, s.name, s.submitted,
              COALESCE(s.disqualified, FALSE) AS disqualified,
              qg.total_grade AS total_grade,
              (pa.session_id IS NOT NULL) AS proctoring_acked,
              s.exam_period_id,
              ep.open_at_utc_ms, ep.duration_minutes
       FROM public.sessions s
       LEFT JOIN public.exam_periods ep ON ep.id = s.exam_period_id
       LEFT JOIN public.question_grades qg ON qg.session_id = s.id
       LEFT JOIN public.proctoring_acks pa ON pa.session_id = s.id
       WHERE s.token = $1
       LIMIT 1`,
      [token]
    );
    const s = r.rows[0];
    if (!s) return null;

    const openAtUtc = Number(s.open_at_utc_ms);
    const durationMinutes = Number(s.duration_minutes);

    const payload = payloadForClientFromFull(await getAdminTest(Number(s.exam_period_id) || 1));
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
        id: s.id,
        token: s.token,
        candidateName: s.name,
        submitted: !!s.submitted,
        disqualified: !!s.disqualified,
        proctoringAcked: !!s.proctoring_acked,
        grade: s.total_grade === null || s.total_grade === undefined ? null : Number(s.total_grade),
        examPeriodId: Number(s.exam_period_id) || 1,
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

  async function getGateForToken(token) {
    const r = await q(
      `SELECT s.token, s.exam_period_id,
              ep.open_at_utc_ms, ep.duration_minutes
       FROM public.sessions s
       LEFT JOIN public.exam_periods ep ON ep.id = s.exam_period_id
       WHERE s.token = $1
       LIMIT 1;`,
      [token]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    const now = Date.now();
    const openAt = Number(row.open_at_utc_ms);
    const durMin = Number(row.duration_minutes);
    const openAtUtc = Number.isFinite(openAt) ? openAt : defaultOpenAtUtcMs;
    const durationMinutes = Number.isFinite(durMin) && durMin > 0 ? durMin : defaultDurationMinutes;
    const durMs = durationMinutes * 60 * 1000;
    const endAt = openAtUtc + durMs;
    const examPeriodId = Number(row.exam_period_id || 0) || 1;
    return {
      now,
      openAtUtc,
      durationMinutes,
      durMs,
      endAtUtc: endAt,
      examPeriodId,
    };
  }

  async function startSession(token) {
    const r = await q(`SELECT submitted FROM public.sessions WHERE token = $1`, [token]);
    const s = r.rows[0];
    if (!s) return null;
    if (s.submitted) return { status: "submitted" };
    return { status: "started" };
  }

  async function gradeAttempt({ examPeriodId, answers }) {
    const payload = await getAdminTest(Number(examPeriodId) || 1);
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

  async function submitAnswers(token, answers, clientMeta) {
    const s = await q1(
      `SELECT id, submitted, exam_period_id, COALESCE(disqualified, FALSE) AS disqualified
       FROM sessions
       WHERE token = $1
       ORDER BY id DESC
       LIMIT 1`,
      [token]
    );
    if (!s) return null;
    if (s.submitted) return { status: "submitted", disqualified: !!s.disqualified };

    const normAnswers = normalizeAnswers(answers);
    const reason = String(clientMeta?.reason || "").trim();
    const isDisqualified = /face_missing|tab_violation|disqual/i.test(reason);

    await q(
      `UPDATE sessions
       SET submitted = TRUE,
           disqualified = CASE WHEN $2::boolean THEN TRUE ELSE COALESCE(disqualified, FALSE) END
       WHERE id = $1`,
      [s.id, isDisqualified]
    );

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

    await q(
      `INSERT INTO question_grades (session_id, token, q_writing, answers_json, created_at_utc_ms)
       VALUES ($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT (session_id)
       DO UPDATE SET
         token = EXCLUDED.token,
         q_writing = EXCLUDED.q_writing,
         answers_json = EXCLUDED.answers_json,
         created_at_utc_ms = EXCLUDED.created_at_utc_ms`,
      [s.id, token, wVal, answersJson, Date.now()]
    );

    if (isDisqualified) {
      await q(
        `UPDATE public.question_grades
         SET speaking_grade = 0,
             writing_grade = 0,
             total_grade = 0,
             created_at_utc_ms = $2
         WHERE session_id = $1`,
        [s.id, Date.now()]
      );
    }

    return { status: "submitted", disqualified: isDisqualified };
  }

  async function listCandidatesForExaminer({ examinerUsername } = {}) {
    const u = String(examinerUsername || "").trim();
    if (!u) return [];
    const r = await q(
      `SELECT
          s.id AS "sessionId",
          s.token,
          s.submitted,
          COALESCE(s.disqualified, FALSE) AS "disqualified",
          COALESCE(qg.q_writing, '') AS "qWriting",
          qg.speaking_grade AS "speakingGrade",
          qg.writing_grade AS "writingGrade",
          s.exam_period_id AS "examPeriodId",
          COALESCE(ep.name, CONCAT('Exam Period ', s.exam_period_id::text)) AS "examPeriodName"
       FROM public.sessions s
       JOIN public.examiner_assignments ea ON ea.session_id = s.id
       JOIN public.examiners ex ON ex.id = ea.examiner_id
       LEFT JOIN public.question_grades qg ON qg.session_id = s.id
       LEFT JOIN public.exam_periods ep ON ep.id = s.exam_period_id
       WHERE ex.username = $1
       ORDER BY s.id DESC
       LIMIT 15000`,
      [u]
    );
    return r.rows;
  }

  async function examinerCanAccessSession({ sessionId, examinerUsername }) {
    const sid = Number(sessionId);
    const u = String(examinerUsername || "").trim();
    if (!Number.isFinite(sid) || sid <= 0 || !u) return false;
    const r = await q(
      `SELECT 1
       FROM public.examiner_assignments ea
       JOIN public.examiners ex ON ex.id = ea.examiner_id
       WHERE ea.session_id = $1
         AND ex.username = $2
       LIMIT 1;`,
      [sid, u]
    );
    return !!(r.rows && r.rows.length);
  }

  async function listCandidates() {
    const r = await q(
      `SELECT s.id AS "sessionId", s.name AS "candidateName",
              COALESCE(c.email, '') AS email, s.token, s.submitted,
              s.exam_period_id AS "examPeriodId",
              qg.total_grade AS "totalGrade",
              COALESCE(s.disqualified, FALSE) AS "disqualified",
              COALESCE(ex.username, '') AS "assignedExaminer"
       FROM public.sessions s
       LEFT JOIN public.candidates c ON c.id = s.candidate_id
       LEFT JOIN public.question_grades qg ON qg.session_id = s.id
       LEFT JOIN public.examiner_assignments ea ON ea.session_id = s.id
       LEFT JOIN public.examiners ex ON ex.id = ea.examiner_id
       ORDER BY s.id DESC
       LIMIT 15000`
    );
    return r.rows;
  }

  return {
    createSession,
    importCandidatesAndCreateSessions,
    normalizeAnswers,
    answerToText,
    buildStoredAnswers,
    payloadForClientFromFull,
    getSessionForExam,
    getGateForToken,
    startSession,
    gradeAttempt,
    submitAnswers,
    listCandidatesForExaminer,
    examinerCanAccessSession,
    listCandidates,
  };
}

module.exports = {
  createPgSessionFlowHelpers,
};
