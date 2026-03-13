const crypto = require("crypto");

function createPgProctoringHelpers(deps) {
  const {
    q,
    q1,
    getPool,
    getProctoringConfig,
  } = deps || {};

  async function hasProctoringAck(token) {
    const t = String(token || "").trim();
    if (!t) return false;
    const r = await q(`SELECT 1 FROM public.proctoring_acks WHERE token = $1 LIMIT 1;`, [t]);
    return !!(r.rows && r.rows.length);
  }

  async function recordProctoringAck(token, { noticeVersion } = {}) {
    const t = String(token || "").trim();
    if (!t) return null;
    const v = String(noticeVersion || "").trim() || getProctoringConfig().noticeVersion;

    const s = await q1(`SELECT id FROM public.sessions WHERE token = $1 LIMIT 1;`, [t]);
    if (!s) return null;

    await q(
      `INSERT INTO public.proctoring_acks (session_id, token, notice_version)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id)
       DO UPDATE SET notice_version = EXCLUDED.notice_version, acked_at = now();`,
      [Number(s.id), t, v]
    );
    return { ok: true };
  }

  async function addSessionSnapshot(token, { reason, remotePath, max = 10 } = {}) {
    const t = String(token || "").trim();
    if (!t) return null;
    const rsn = String(reason || "").trim() || "unknown";
    const rp = String(remotePath || "").trim();
    if (!rp) throw new Error("remote_path_required");

    const maxN = Number(max);
    const limit = Number.isFinite(maxN) && maxN > 0 ? Math.round(maxN) : 10;

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      const s = await client.query(`SELECT id FROM public.sessions WHERE token = $1 LIMIT 1;`, [t]);
      const row = s.rows?.[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      const sid = Number(row.id);

      const c = await client.query(`SELECT COUNT(1)::int AS n FROM public.session_snapshots WHERE session_id = $1;`, [sid]);
      const n = Number(c.rows?.[0]?.n || 0);
      if (n >= limit) {
        await client.query("COMMIT");
        return { ok: false, limited: true, count: n, remaining: 0 };
      }

      const ins = await client.query(
        `INSERT INTO public.session_snapshots (session_id, token, reason, remote_path)
         VALUES ($1, $2, $3, $4)
         RETURNING id;`,
        [sid, t, rsn, rp]
      );

      await client.query("COMMIT");
      const next = n + 1;
      const snapshotId = ins?.rows?.[0]?.id ? Number(ins.rows[0].id) : null;
      return { ok: true, limited: false, snapshotId, count: next, remaining: Math.max(0, limit - next) };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }

  async function listSessionSnapshots({ limit = 200, examPeriodId, sessionId } = {}) {
    const lim = Number(limit);
    const n = Number.isFinite(lim) && lim > 0 ? Math.min(2000, Math.round(lim)) : 200;
    const ep = examPeriodId === undefined || examPeriodId === null ? null : Number(examPeriodId);
    const sid = sessionId === undefined || sessionId === null ? null : Number(sessionId);

    const where = [];
    const params = [];
    if (Number.isFinite(ep) && ep > 0) { params.push(ep); where.push(`s.exam_period_id = $${params.length}`); }
    if (Number.isFinite(sid) && sid > 0) { params.push(sid); where.push(`ss.session_id = $${params.length}`); }
    params.push(n);
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const r = await q(
      `SELECT ss.id AS id,
              ss.session_id AS "sessionId",
              ss.token AS token,
              s.name AS "candidateName",
              s.exam_period_id AS "examPeriodId",
              s.submitted AS submitted,
              ss.reason AS reason,
              ss.remote_path AS "remotePath",
              (EXTRACT(EPOCH FROM ss.created_at) * 1000)::bigint AS "createdAtUtcMs"
       FROM public.session_snapshots ss
       JOIN public.sessions s ON s.id = ss.session_id
       ${w}
       ORDER BY ss.id DESC
       LIMIT $${params.length};`,
      params
    );
    return Array.isArray(r?.rows) ? r.rows : [];
  }

  async function getSessionSnapshotById(id) {
    const sid = Number(id);
    if (!Number.isFinite(sid) || sid <= 0) return null;
    const r = await q(
      `SELECT ss.id AS id,
              ss.session_id AS "sessionId",
              ss.token AS token,
              s.name AS "candidateName",
              s.exam_period_id AS "examPeriodId",
              s.submitted AS submitted,
              ss.reason AS reason,
              ss.remote_path AS "remotePath",
              (EXTRACT(EPOCH FROM ss.created_at) * 1000)::bigint AS "createdAtUtcMs"
       FROM public.session_snapshots ss
       JOIN public.sessions s ON s.id = ss.session_id
       WHERE ss.id = $1
       LIMIT 1;`,
      [sid]
    );
    return r?.rows?.[0] || null;
  }

  async function deleteSessionSnapshotById(id) {
    const sid = Number(id);
    if (!Number.isFinite(sid) || sid <= 0) return false;
    const r = await q(`DELETE FROM public.session_snapshots WHERE id = $1;`, [sid]);
    return Number(r?.rowCount || 0) > 0;
  }

  async function listSnapshotSessions({ limit = 5000, examPeriodId, submittedOnly } = {}) {
    const lim = Number(limit);
    const n = Number.isFinite(lim) && lim > 0 ? Math.min(20000, Math.round(lim)) : 5000;
    const ep = examPeriodId === undefined || examPeriodId === null ? null : Number(examPeriodId);
    const subOnly = submittedOnly === undefined || submittedOnly === null ? null : !!submittedOnly;

    const where = [];
    const params = [];
    if (Number.isFinite(ep) && ep > 0) { params.push(ep); where.push(`s.exam_period_id = $${params.length}`); }
    if (subOnly === true) { where.push(`s.submitted = TRUE`); }
    params.push(n);
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const r = await q(
      `SELECT s.id AS "sessionId",
              s.name AS "candidateName",
              s.token AS token,
              s.exam_period_id AS "examPeriodId",
              s.submitted AS submitted,
              COUNT(ss.id)::int AS "snapshotCount",
              MAX((EXTRACT(EPOCH FROM ss.created_at) * 1000)::bigint) AS "lastSnapshotAtUtcMs"
       FROM public.sessions s
       JOIN public.session_snapshots ss ON ss.session_id = s.id
       ${w}
       GROUP BY s.id, s.name, s.token, s.exam_period_id, s.submitted
       ORDER BY MAX(ss.id) DESC
       LIMIT $${params.length};`,
      params
    );
    return Array.isArray(r?.rows) ? r.rows : [];
  }

  function makeListeningTicket() {
    return crypto.randomBytes(24).toString("base64url");
  }

  async function issueListeningTicket(token, { maxPlays = 1, ttlMs = 20 * 60 * 1000 } = {}) {
    const t = String(token || "").trim();
    if (!t) return { ok: false, blocked: true, reason: "bad_token" };

    const maxPlaysNum = Number(maxPlays);
    const maxOk = Number.isFinite(maxPlaysNum) && maxPlaysNum > 0 ? Math.max(1, Math.min(20, Math.floor(maxPlaysNum))) : 1;
    const ttlNum = Number(ttlMs);
    const ttlOk = Number.isFinite(ttlNum) && ttlNum > 5_000 ? Math.max(5_000, Math.min(ttlNum, 24 * 60 * 60 * 1000)) : (20 * 60 * 1000);

    const s = await q1(
      `SELECT id, submitted, exam_period_id
       FROM public.sessions
       WHERE token = $1
       LIMIT 1;`,
      [t]
    );
    if (!s) return { ok: false, blocked: true, reason: "bad_token" };
    if (!!s.submitted) return { ok: false, blocked: true, reason: "submitted" };

    const sid = Number(s.id);
    const now = Date.now();
    const existing = await q1(
      `SELECT play_count::int AS play_count, ticket, ticket_expires_utc_ms::bigint AS expires
       FROM public.session_listening_access
       WHERE session_id = $1
       LIMIT 1;`,
      [sid]
    );

    const playCount = Number(existing?.play_count || 0);
    const exp = Number(existing?.expires || 0);
    if (existing && existing.ticket && Number.isFinite(exp) && exp > now) {
      if (playCount < maxOk) {
        return { ok: true, ticket: existing.ticket, expiresAtUtcMs: exp, playCount, maxPlays: maxOk, examPeriodId: Number(s.exam_period_id) || 1 };
      }
      return { ok: false, blocked: true, reason: "max_plays", playCount, maxPlays: maxOk };
    }

    const nextTicket = makeListeningTicket();
    const nextExp = now + ttlOk;
    const nextCount = playCount + 1;
    await q(
      `INSERT INTO public.session_listening_access (session_id, play_count, ticket, ticket_expires_utc_ms, updated_at_utc_ms)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id)
       DO UPDATE SET
         play_count = EXCLUDED.play_count,
         ticket = EXCLUDED.ticket,
         ticket_expires_utc_ms = EXCLUDED.ticket_expires_utc_ms,
         updated_at_utc_ms = EXCLUDED.updated_at_utc_ms;`,
      [sid, nextCount, nextTicket, nextExp, now]
    );

    return { ok: true, ticket: nextTicket, expiresAtUtcMs: nextExp, playCount: nextCount, maxPlays: maxOk, examPeriodId: Number(s.exam_period_id) || 1 };
  }

  async function verifyListeningTicket(token, ticket) {
    const t = String(token || "").trim();
    const tk = String(ticket || "").trim();
    if (!t || !tk) return { ok: false, blocked: true, reason: "bad_ticket" };

    const row = await q1(
      `SELECT s.id AS "sessionId", s.exam_period_id AS "examPeriodId", s.submitted AS submitted,
              la.ticket AS ticket, la.ticket_expires_utc_ms::bigint AS expires
       FROM public.sessions s
       LEFT JOIN public.session_listening_access la ON la.session_id = s.id
       WHERE s.token = $1
       LIMIT 1;`,
      [t]
    );
    if (!row) return { ok: false, blocked: true, reason: "bad_token" };

    const exp = Number(row.expires || 0);
    if (!!row.submitted) return { ok: false, blocked: true, reason: "submitted" };
    if (!row.ticket || String(row.ticket) !== tk) return { ok: false, blocked: true, reason: "bad_ticket" };
    if (!Number.isFinite(exp) || exp <= Date.now()) return { ok: false, blocked: true, reason: "expired" };
    return { ok: true, sessionId: Number(row.sessionId), examPeriodId: Number(row.examPeriodId) || 1, expiresAtUtcMs: exp };
  }

  return {
    hasProctoringAck,
    recordProctoringAck,
    addSessionSnapshot,
    listSessionSnapshots,
    getSessionSnapshotById,
    deleteSessionSnapshotById,
    listSnapshotSessions,
    issueListeningTicket,
    verifyListeningTicket,
  };
}

module.exports = {
  createPgProctoringHelpers,
};
