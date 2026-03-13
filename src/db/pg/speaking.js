function createPgSpeakingHelpers(deps) {
  const {
    q,
    q1,
    ensureSessionAssignedExaminer,
    speakingSlotDurationMinutes,
  } = deps || {};

  function normalizeSpeakingSlotRow(row = {}) {
    let metadata = row.meeting_metadata_json;
    if (typeof metadata === "string") {
      try { metadata = JSON.parse(metadata); } catch { metadata = null; }
    }
    if (!metadata || typeof metadata !== "object") metadata = null;
    return {
      id: Number(row.id),
      examPeriodId: row.exam_period_id === null || row.exam_period_id === undefined ? null : Number(row.exam_period_id),
      sessionId: row.session_id === null || row.session_id === undefined ? null : Number(row.session_id),
      candidateId: row.candidate_id === null || row.candidate_id === undefined ? null : Number(row.candidate_id),
      candidateName: String(row.candidate_name || row.session_candidate_name || ""),
      sessionToken: String(row.session_token || ""),
      startUtcMs: Number(row.start_utc_ms),
      endUtcMs: Number(row.end_utc_ms),
      videoProvider: String(row.video_provider || "manual"),
      examinerUsername: String(row.examiner_username || row.assigned_examiner || ""),
      meetingId: String(row.meeting_id || ""),
      joinUrl: String(row.join_url || ""),
      startUrl: String(row.start_url || ""),
      meetingMetadata: metadata,
      status: String(row.status || "scheduled"),
      createdAtUtcMs: Number(row.created_at_utc_ms || 0),
      updatedAtUtcMs: Number(row.updated_at_utc_ms || 0),
    };
  }

  async function listSessionsMissingSpeakingSlot(examPeriodId) {
    const ep = Number(examPeriodId);
    if (!Number.isFinite(ep) || ep <= 0) return [];
    const r = await q(
      `SELECT s.id AS "sessionId",
              s.name AS "candidateName",
              s.exam_period_id AS "examPeriodId",
              s.token AS token,
              s.candidate_id AS "candidateId"
       FROM public.sessions s
       LEFT JOIN public.speaking_slots os ON os.session_id = s.id
       WHERE s.exam_period_id = $1
         AND os.id IS NULL
       ORDER BY s.id ASC;`,
      [ep]
    );
    return Array.isArray(r?.rows) ? r.rows : [];
  }

  async function getSessionScheduleDefaults(sessionId) {
    const sid = Number(sessionId);
    if (!Number.isFinite(sid) || sid <= 0) return null;
    const row = await q1(
      `SELECT s.id, s.name, s.exam_period_id
       FROM public.sessions s
       WHERE s.id = $1
       LIMIT 1;`,
      [sid]
    );
    if (!row) return null;
    const examinerUsername = await ensureSessionAssignedExaminer({
      sessionId: Number(row.id),
      examPeriodId: Number(row.exam_period_id),
    });
    return {
      sessionId: Number(row.id),
      examPeriodId: Number(row.exam_period_id || 0) || null,
      candidateName: String(row.name || ""),
      examinerUsername: String(examinerUsername || ""),
      durationMinutes: Number(speakingSlotDurationMinutes || 60),
    };
  }

  async function listExaminers() {
    const r = await q(
      `SELECT id, username
       FROM public.examiners
       ORDER BY id ASC;`
    );
    return (r.rows || []).map((row) => ({
      id: Number(row.id),
      username: String(row.username || ""),
    }));
  }

  async function listSpeakingSlots({ examPeriodId, examinerUsername, fromUtcMs, toUtcMs, limit } = {}) {
    const filters = [];
    const params = [];
    const ep = Number(examPeriodId);
    if (Number.isFinite(ep) && ep > 0) {
      params.push(ep);
      filters.push(`COALESCE(os.exam_period_id, s.exam_period_id) = $${params.length}`);
    }
    const examiner = String(examinerUsername || "").trim();
    if (examiner) {
      params.push(examiner);
      filters.push(`COALESCE(NULLIF(os.examiner_username, ''), ex.username, '') = $${params.length}`);
    }
    const from = Number(fromUtcMs);
    if (Number.isFinite(from) && from > 0) {
      params.push(from);
      filters.push(`os.end_utc_ms >= $${params.length}`);
    }
    const to = Number(toUtcMs);
    if (Number.isFinite(to) && to > 0) {
      params.push(to);
      filters.push(`os.start_utc_ms <= $${params.length}`);
    }
    const limRaw = Number(limit);
    const lim = Number.isFinite(limRaw) && limRaw > 0 ? Math.min(5000, Math.round(limRaw)) : 1500;
    params.push(lim);

    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const r = await q(
      `SELECT
          os.*,
          s.name AS session_candidate_name,
          s.token AS session_token,
          s.exam_period_id AS session_exam_period_id,
          ea.examiner_id AS assignment_examiner_id,
          ex.username AS assigned_examiner
       FROM public.speaking_slots os
       LEFT JOIN public.sessions s ON s.id = os.session_id
       LEFT JOIN public.examiner_assignments ea ON ea.session_id = os.session_id
       LEFT JOIN public.examiners ex ON ex.id = ea.examiner_id
       ${where}
       ORDER BY os.start_utc_ms ASC, os.id ASC
       LIMIT $${params.length};`,
      params
    );
    return (r.rows || []).map(normalizeSpeakingSlotRow);
  }

  async function getSpeakingSlotById(id) {
    const slotId = Number(id);
    if (!Number.isFinite(slotId) || slotId <= 0) return null;
    const row = await q1(
      `SELECT
          os.*,
          s.name AS session_candidate_name,
          s.token AS session_token,
          s.exam_period_id AS session_exam_period_id,
          ea.examiner_id AS assignment_examiner_id,
          ex.username AS assigned_examiner
       FROM public.speaking_slots os
       LEFT JOIN public.sessions s ON s.id = os.session_id
       LEFT JOIN public.examiner_assignments ea ON ea.session_id = os.session_id
       LEFT JOIN public.examiners ex ON ex.id = ea.examiner_id
       WHERE os.id = $1
       LIMIT 1;`,
      [slotId]
    );
    return row ? normalizeSpeakingSlotRow(row) : null;
  }

  async function createSpeakingSlot(input = {}) {
    const now = Date.now();
    const sessionId = Number(input.sessionId);
    let session = null;
    if (Number.isFinite(sessionId) && sessionId > 0) {
      session = await q1(
        `SELECT s.id, s.exam_period_id, s.candidate_id, s.name
         FROM public.sessions s
         WHERE s.id = $1
         LIMIT 1;`,
        [sessionId]
      );
      if (!session) throw new Error("Session not found");
    }

    const providedStart = Number(input.startUtcMs);
    const providedEnd = Number(input.endUtcMs);
    const durationMinutes = Number(speakingSlotDurationMinutes || 60);
    if (!Number.isFinite(providedStart) || providedStart <= 0) throw new Error("Invalid start time");
    const endUtcMs = Number.isFinite(providedEnd) && providedEnd > providedStart
      ? providedEnd
      : (Number.isFinite(durationMinutes) && durationMinutes > 0 ? providedStart + durationMinutes * 60 * 1000 : NaN);
    if (!Number.isFinite(endUtcMs) || endUtcMs <= providedStart) throw new Error("Invalid end time");

    const examPeriodIdRaw = Number(input.examPeriodId);
    const examPeriodId = Number.isFinite(examPeriodIdRaw) && examPeriodIdRaw > 0
      ? examPeriodIdRaw
      : Number(session?.exam_period_id || 0);
    const candidateId = session?.candidate_id ? Number(session.candidate_id) : null;
    const candidateName = session ? String(session.name || "").trim() : String(input.candidateName || "").trim();
    if (!candidateName) throw new Error("Candidate name is required");

    const videoProvider = String(input.videoProvider || "manual").trim().toLowerCase() || "manual";
    const status = String(input.status || "scheduled").trim().toLowerCase() || "scheduled";
    let examinerUsername = "";
    if (session) {
      examinerUsername = await ensureSessionAssignedExaminer({
        sessionId: Number(session.id),
        examPeriodId: Number(session.exam_period_id),
      });
    } else {
      examinerUsername = String(input.examinerUsername || "").trim();
    }

    if (examinerUsername) {
      const ex = await q1(`SELECT 1 FROM public.examiners WHERE username = $1 LIMIT 1;`, [examinerUsername]);
      if (!ex) throw new Error("Invalid examiner username");
    }

    let meetingMetadata = input.meetingMetadata;
    if (meetingMetadata && typeof meetingMetadata !== "object") {
      try { meetingMetadata = JSON.parse(String(meetingMetadata)); } catch { meetingMetadata = null; }
    }
    if (!meetingMetadata || typeof meetingMetadata !== "object") meetingMetadata = null;

    const meetingIdVal = String(input.meetingId || "").trim() || null;
    const joinUrlVal = String(input.joinUrl || "").trim() || null;
    const startUrlVal = String(input.startUrl || "").trim() || null;

    const r = await q(
      `INSERT INTO public.speaking_slots
        (exam_period_id, session_id, candidate_id, candidate_name, start_utc_ms, end_utc_ms, video_provider,
         examiner_username, meeting_id, join_url, start_url, meeting_metadata_json, status, created_at_utc_ms, updated_at_utc_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)
       RETURNING *;`,
      [
        Number.isFinite(examPeriodId) && examPeriodId > 0 ? examPeriodId : null,
        session ? Number(session.id) : null,
        Number.isFinite(candidateId) && candidateId > 0 ? candidateId : null,
        candidateName,
        providedStart,
        endUtcMs,
        videoProvider,
        examinerUsername || null,
        meetingIdVal,
        joinUrlVal,
        startUrlVal,
        meetingMetadata ? JSON.stringify(meetingMetadata) : null,
        status,
        now,
        now,
      ]
    );
    const createdId = Number(r.rows?.[0]?.id || 0);
    if (createdId > 0) {
      const full = await getSpeakingSlotById(createdId);
      if (full) return full;
    }
    return normalizeSpeakingSlotRow(r.rows[0]);
  }

  async function updateSpeakingSlot({ id, ...input } = {}) {
    const slotId = Number(id);
    if (!Number.isFinite(slotId) || slotId <= 0) throw new Error("Invalid slot id");
    const existing = await q1(`SELECT * FROM public.speaking_slots WHERE id = $1 LIMIT 1;`, [slotId]);
    if (!existing) return null;

    const next = {
      examPeriodId: existing.exam_period_id === null || existing.exam_period_id === undefined ? null : Number(existing.exam_period_id),
      sessionId: existing.session_id === null || existing.session_id === undefined ? null : Number(existing.session_id),
      candidateId: existing.candidate_id === null || existing.candidate_id === undefined ? null : Number(existing.candidate_id),
      candidateName: String(existing.candidate_name || ""),
      startUtcMs: Number(existing.start_utc_ms),
      endUtcMs: Number(existing.end_utc_ms),
      videoProvider: String(existing.video_provider || "manual"),
      examinerUsername: String(existing.examiner_username || ""),
      meetingId: String(existing.meeting_id || ""),
      joinUrl: String(existing.join_url || ""),
      startUrl: String(existing.start_url || ""),
      status: String(existing.status || "scheduled"),
      meetingMetadata: existing.meeting_metadata_json || null,
    };

    if (Object.prototype.hasOwnProperty.call(input, "sessionId")) {
      const sid = Number(input.sessionId);
      if (!Number.isFinite(sid) || sid <= 0) {
        next.sessionId = null;
        next.candidateId = null;
      } else {
        const s = await q1(
          `SELECT id, exam_period_id, candidate_id, name
           FROM public.sessions
           WHERE id = $1
           LIMIT 1;`,
          [sid]
        );
        if (!s) throw new Error("Session not found");
        next.sessionId = Number(s.id);
        next.candidateId = s.candidate_id === null || s.candidate_id === undefined ? null : Number(s.candidate_id);
        next.candidateName = String(s.name || next.candidateName);
        next.examinerUsername = await ensureSessionAssignedExaminer({
          sessionId: Number(s.id),
          examPeriodId: Number(s.exam_period_id),
        });
        if (!Object.prototype.hasOwnProperty.call(input, "examPeriodId")) {
          next.examPeriodId = Number(s.exam_period_id || next.examPeriodId || 0) || null;
        }
      }
    }

    if (Object.prototype.hasOwnProperty.call(input, "examPeriodId")) {
      const ep = Number(input.examPeriodId);
      next.examPeriodId = Number.isFinite(ep) && ep > 0 ? ep : null;
    }
    if (Object.prototype.hasOwnProperty.call(input, "candidateName")) {
      const nm = String(input.candidateName || "").trim();
      if (!nm) throw new Error("Candidate name is required");
      next.candidateName = nm;
    }
    if (Object.prototype.hasOwnProperty.call(input, "startUtcMs")) {
      const v = Number(input.startUtcMs);
      if (!Number.isFinite(v) || v <= 0) throw new Error("Invalid start time");
      next.startUtcMs = v;
    }
    if (
      Object.prototype.hasOwnProperty.call(input, "startUtcMs") ||
      Object.prototype.hasOwnProperty.call(input, "endUtcMs") ||
      Object.prototype.hasOwnProperty.call(input, "durationMinutes")
    ) {
      next.endUtcMs = next.startUtcMs + Number(speakingSlotDurationMinutes || 60) * 60 * 1000;
    }
    if (!Number.isFinite(next.endUtcMs) || next.endUtcMs <= next.startUtcMs) throw new Error("Invalid end time");

    if (Object.prototype.hasOwnProperty.call(input, "videoProvider")) {
      next.videoProvider = String(input.videoProvider || "manual").trim().toLowerCase() || "manual";
    }
    if (Object.prototype.hasOwnProperty.call(input, "status")) {
      next.status = String(input.status || "scheduled").trim().toLowerCase() || "scheduled";
    }
    if (Object.prototype.hasOwnProperty.call(input, "examinerUsername")) {
      next.examinerUsername = String(input.examinerUsername || "").trim();
    }
    if (next.examinerUsername) {
      const ex = await q1(`SELECT 1 FROM public.examiners WHERE username = $1 LIMIT 1;`, [next.examinerUsername]);
      if (!ex) throw new Error("Invalid examiner username");
    }
    if (Object.prototype.hasOwnProperty.call(input, "meetingId")) next.meetingId = String(input.meetingId || "").trim();
    if (Object.prototype.hasOwnProperty.call(input, "joinUrl")) next.joinUrl = String(input.joinUrl || "").trim();
    if (Object.prototype.hasOwnProperty.call(input, "startUrl")) next.startUrl = String(input.startUrl || "").trim();

    if (Object.prototype.hasOwnProperty.call(input, "meetingMetadata")) {
      let mm = input.meetingMetadata;
      if (mm && typeof mm !== "object") {
        try { mm = JSON.parse(String(mm)); } catch { mm = null; }
      }
      next.meetingMetadata = mm && typeof mm === "object" ? mm : null;
    }

    const r = await q(
      `UPDATE public.speaking_slots
       SET exam_period_id = $2,
           session_id = $3,
           candidate_id = $4,
           candidate_name = $5,
           start_utc_ms = $6,
           end_utc_ms = $7,
           video_provider = $8,
           examiner_username = $9,
           meeting_id = $10,
           join_url = $11,
           start_url = $12,
           meeting_metadata_json = $13::jsonb,
           status = $14,
           updated_at_utc_ms = $15
       WHERE id = $1
       RETURNING *;`,
      [
        slotId,
        next.examPeriodId,
        next.sessionId,
        next.candidateId,
        next.candidateName,
        next.startUtcMs,
        next.endUtcMs,
        next.videoProvider,
        next.examinerUsername || null,
        next.meetingId || null,
        next.joinUrl || null,
        next.startUrl || null,
        next.meetingMetadata ? JSON.stringify(next.meetingMetadata) : null,
        next.status,
        Date.now(),
      ]
    );
    if (!r.rows.length) return null;
    const full = await getSpeakingSlotById(slotId);
    return full || normalizeSpeakingSlotRow(r.rows[0]);
  }

  async function deleteSpeakingSlot(id) {
    const slotId = Number(id);
    if (!Number.isFinite(slotId) || slotId <= 0) throw new Error("Invalid slot id");
    const r = await q(`DELETE FROM public.speaking_slots WHERE id = $1;`, [slotId]);
    return { ok: true, deleted: Number(r.rowCount || 0) };
  }

  async function getSpeakingJoinBySessionToken(token) {
    const tok = String(token || "").trim();
    if (!tok) return null;
    const now = Date.now();

    const row = await q1(
      `SELECT
          os.*,
          s.token AS session_token,
          s.name AS session_candidate_name
       FROM public.speaking_slots os
       JOIN public.sessions s ON s.id = os.session_id
       WHERE s.token = $1
       ORDER BY
         CASE
           WHEN $2 BETWEEN os.start_utc_ms AND os.end_utc_ms THEN 0
           WHEN $2 < os.start_utc_ms THEN 1
           ELSE 2
         END ASC,
         CASE
           WHEN $2 < os.start_utc_ms THEN os.start_utc_ms - $2
           ELSE $2 - os.end_utc_ms
         END ASC,
         os.id DESC
       LIMIT 1;`,
      [tok, now]
    );
    if (!row) return null;
    return normalizeSpeakingSlotRow(row);
  }

  return {
    listSessionsMissingSpeakingSlot,
    getSessionScheduleDefaults,
    listExaminers,
    listSpeakingSlots,
    getSpeakingSlotById,
    createSpeakingSlot,
    updateSpeakingSlot,
    deleteSpeakingSlot,
    getSpeakingJoinBySessionToken,
  };
}

module.exports = {
  createPgSpeakingHelpers,
};
