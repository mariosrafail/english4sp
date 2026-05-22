const crypto = require("crypto");

function createSqliteProctoringHelpers(deps) {
  const { get, run, all, getProctoringConfig } = deps;

  function makeListeningTicket() {
    return crypto.randomBytes(24).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function issueListeningTicket(token, { maxPlays = 1, ttlMs = 20 * 60 * 1000 } = {}) {
    const t = String(token || "").trim();
    if (!t) return null;
    const s = await get(`SELECT id, submitted, exam_period_id FROM sessions WHERE token = ? ORDER BY id DESC LIMIT 1;`, [t]);
    if (!s) return null;
    if (Number(s.submitted) === 1) return { ok: false, blocked: true, reason: "submitted" };

    const sid = Number(s.id);
    const now = Date.now();
    const ttl = Number(ttlMs);
    const ttlOk = Number.isFinite(ttl) && ttl > 5000 ? Math.min(60 * 60 * 1000, Math.round(ttl)) : 20 * 60 * 1000;
    const max = Number(maxPlays);
    const maxOk = Number.isFinite(max) && max > 0 ? Math.min(3, Math.round(max)) : 1;

    await run("BEGIN;");
    try {
      const row = await get(
        `SELECT play_count AS playCount, ticket, ticket_expires_utc_ms AS expires
         FROM session_listening_access
         WHERE session_id = ? LIMIT 1;`,
        [sid]
      );
      const playCount = Number(row?.playCount || 0);
      const ticket = String(row?.ticket || "");
      const expires = Number(row?.expires || 0);
      if (ticket && Number.isFinite(expires) && expires > now + 5000) {
        await run("COMMIT;");
        return { ok: true, ticket, expiresAtUtcMs: expires, playCount, maxPlays: maxOk, examPeriodId: Number(s.exam_period_id) || 1 };
      }
      if (playCount >= maxOk) {
        await run("COMMIT;");
        return { ok: false, blocked: true, reason: "max_plays", playCount, maxPlays: maxOk };
      }

      const nextTicket = makeListeningTicket();
      const nextCount = playCount + 1;
      const nextExp = now + ttlOk;
      await run(
        `INSERT INTO session_listening_access (session_id, play_count, ticket, ticket_expires_utc_ms, updated_at_utc_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE
         SET play_count = excluded.play_count,
             ticket = excluded.ticket,
             ticket_expires_utc_ms = excluded.ticket_expires_utc_ms,
             updated_at_utc_ms = excluded.updated_at_utc_ms;`,
        [sid, nextCount, nextTicket, nextExp, now]
      );
      await run("COMMIT;");
      return { ok: true, ticket: nextTicket, expiresAtUtcMs: nextExp, playCount: nextCount, maxPlays: maxOk, examPeriodId: Number(s.exam_period_id) || 1 };
    } catch (e) {
      try { await run("ROLLBACK;"); } catch {}
      throw e;
    }
  }

  async function verifyListeningTicket(token, ticket) {
    const t = String(token || "").trim();
    const tk = String(ticket || "").trim();
    if (!t || !tk) return null;
    const row = await get(
      `SELECT s.id AS sessionId, s.exam_period_id AS examPeriodId, s.submitted AS submitted,
              a.ticket AS ticket, a.ticket_expires_utc_ms AS expires
       FROM sessions s
       LEFT JOIN session_listening_access a ON a.session_id = s.id
       WHERE s.token = ?
       ORDER BY s.id DESC
       LIMIT 1;`,
      [t]
    );
    if (!row) return null;
    if (Number(row.submitted) === 1) return { ok: false, blocked: true, reason: "submitted" };
    const exp = Number(row.expires || 0);
    if (!row.ticket || String(row.ticket) !== tk) return { ok: false, blocked: true, reason: "bad_ticket" };
    if (!Number.isFinite(exp) || exp <= Date.now()) return { ok: false, blocked: true, reason: "expired" };
    return { ok: true, sessionId: Number(row.sessionId), examPeriodId: Number(row.examPeriodId) || 1, expiresAtUtcMs: exp };
  }

  async function addExamSecurityEvent(token, { eventType, payload } = {}) {
    const t = String(token || "").trim();
    const type = String(eventType || "").trim().slice(0, 80);
    if (!t || !type) return null;
    const s = await get(
      `SELECT id, exam_period_id, candidate_id
       FROM sessions
       WHERE token = ?
       ORDER BY id DESC
       LIMIT 1;`,
      [t]
    );
    if (!s) return null;

    const rawPayload = payload && typeof payload === "object" ? payload : {};
    const safePayload = JSON.stringify(rawPayload).slice(0, 12000);
    const out = await run(
      `INSERT INTO exam_security_events
         (session_id, exam_period_id, candidate_id, event_type, payload_json, created_at_utc_ms)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [
        Number(s.id),
        Number(s.exam_period_id || 0) || null,
        s.candidate_id === null || s.candidate_id === undefined ? null : Number(s.candidate_id),
        type,
        safePayload,
        Date.now(),
      ]
    );
    return { ok: true, id: Number(out?.lastID || 0) || null };
  }

  async function listExamSecurityEvents({ sessionId, limit = 200 } = {}) {
    const sid = Number(sessionId);
    if (!Number.isFinite(sid) || sid <= 0) return [];
    const lim = Number(limit);
    const n = Number.isFinite(lim) && lim > 0 ? Math.min(1000, Math.round(lim)) : 200;
    const rows = await all(
      `SELECT id,
              session_id AS sessionId,
              exam_period_id AS examPeriodId,
              candidate_id AS candidateId,
              event_type AS eventType,
              payload_json AS payload,
              created_at_utc_ms AS createdAtUtcMs
       FROM exam_security_events
       WHERE session_id = ?
       ORDER BY id DESC
       LIMIT ?;`,
      [sid, n]
    );
    return Array.isArray(rows) ? rows.map((r) => {
      let payload = {};
      try { payload = JSON.parse(String(r.payload || "{}")); } catch {}
      return { ...r, payload };
    }) : [];
  }

  async function hasProctoringAck(token) {
    const t = String(token || "").trim();
    if (!t) return false;
    const r = await get(`SELECT 1 FROM proctoring_acks WHERE token = ? LIMIT 1;`, [t]);
    return !!r;
  }

  async function recordProctoringAck(token, { noticeVersion } = {}) {
    const t = String(token || "").trim();
    if (!t) return null;
    const v = String(noticeVersion || "").trim() || getProctoringConfig().noticeVersion;

    const s = await get(`SELECT id, token FROM sessions WHERE token = ? ORDER BY id DESC LIMIT 1;`, [t]);
    if (!s) return null;

    const sid = Number(s.id);
    const ts = Date.now();
    try {
      await run(
        `INSERT INTO proctoring_acks (session_id, token, notice_version, acked_at_utc_ms)
         VALUES (?, ?, ?, ?);`,
        [sid, t, v, ts]
      );
    } catch {
      await run(
        `UPDATE proctoring_acks SET notice_version = ?, acked_at_utc_ms = ? WHERE session_id = ?;`,
        [v, ts, sid]
      );
    }

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

    const s = await get(`SELECT id FROM sessions WHERE token = ? ORDER BY id DESC LIMIT 1;`, [t]);
    if (!s) return null;
    const sid = Number(s.id);

    await run("BEGIN;");
    try {
      const c = await get(`SELECT COUNT(1) AS n FROM session_snapshots WHERE session_id = ?;`, [sid]);
      const n = Number(c?.n || 0);
      if (n >= limit) {
        await run("COMMIT;");
        return { ok: false, limited: true, count: n, remaining: 0 };
      }

      const ins = await run(
        `INSERT INTO session_snapshots (session_id, token, reason, remote_path, created_at_utc_ms)
         VALUES (?, ?, ?, ?, ?);`,
        [sid, t, rsn, rp, Date.now()]
      );

      await run("COMMIT;");
      const next = n + 1;
      return { ok: true, limited: false, snapshotId: Number(ins?.lastID || 0) || null, count: next, remaining: Math.max(0, limit - next) };
    } catch (e) {
      try { await run("ROLLBACK;"); } catch {}
      throw e;
    }
  }

  async function listSessionSnapshots({ limit = 200, examPeriodId, sessionId } = {}) {
    const lim = Number(limit);
    const n = Number.isFinite(lim) && lim > 0 ? Math.min(2000, Math.round(lim)) : 200;
    const ep = examPeriodId === undefined || examPeriodId === null ? null : Number(examPeriodId);
    const sid = sessionId === undefined || sessionId === null ? null : Number(sessionId);

    const where = [];
    const params = [];
    if (Number.isFinite(ep) && ep > 0) { where.push("s.exam_period_id = ?"); params.push(ep); }
    if (Number.isFinite(sid) && sid > 0) { where.push("ss.session_id = ?"); params.push(sid); }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = await all(
      `SELECT ss.id AS id,
              ss.session_id AS sessionId,
              ss.token AS token,
              s.name AS candidateName,
              s.exam_period_id AS examPeriodId,
              s.submitted AS submitted,
              ss.reason AS reason,
              ss.remote_path AS remotePath,
              ss.created_at_utc_ms AS createdAtUtcMs
       FROM session_snapshots ss
       JOIN sessions s ON s.id = ss.session_id
       ${w}
       ORDER BY ss.id DESC
       LIMIT ?;`,
      [...params, n]
    );
    return Array.isArray(rows) ? rows : [];
  }

  async function getSessionSnapshotById(id) {
    const sid = Number(id);
    if (!Number.isFinite(sid) || sid <= 0) return null;
    return await get(
      `SELECT ss.id AS id,
              ss.session_id AS sessionId,
              ss.token AS token,
              s.name AS candidateName,
              s.exam_period_id AS examPeriodId,
              s.submitted AS submitted,
              ss.reason AS reason,
              ss.remote_path AS remotePath,
              ss.created_at_utc_ms AS createdAtUtcMs
       FROM session_snapshots ss
       JOIN sessions s ON s.id = ss.session_id
       WHERE ss.id = ?
       LIMIT 1;`,
      [sid]
    );
  }

  async function deleteSessionSnapshotById(id) {
    const sid = Number(id);
    if (!Number.isFinite(sid) || sid <= 0) return false;
    const r = await run(`DELETE FROM session_snapshots WHERE id = ?;`, [sid]);
    return Number(r?.changes || 0) > 0;
  }

  async function listSnapshotSessions({ limit = 5000, examPeriodId, submittedOnly } = {}) {
    const lim = Number(limit);
    const n = Number.isFinite(lim) && lim > 0 ? Math.min(20000, Math.round(lim)) : 5000;
    const ep = examPeriodId === undefined || examPeriodId === null ? null : Number(examPeriodId);
    const subOnly = submittedOnly === undefined || submittedOnly === null ? null : !!submittedOnly;

    const where = [];
    const params = [];
    if (Number.isFinite(ep) && ep > 0) { where.push("s.exam_period_id = ?"); params.push(ep); }
    if (subOnly === true) { where.push("s.submitted = 1"); }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = await all(
      `SELECT s.id AS sessionId,
              s.token AS token,
              s.name AS candidateName,
              s.exam_period_id AS examPeriodId,
              s.submitted AS submitted,
              COUNT(ss.id) AS snapshotCount,
              MAX(ss.created_at_utc_ms) AS latestSnapshotUtcMs
       FROM sessions s
       JOIN session_snapshots ss ON ss.session_id = s.id
       ${w}
       GROUP BY s.id, s.token, s.name, s.exam_period_id, s.submitted
       ORDER BY latestSnapshotUtcMs DESC, s.id DESC
       LIMIT ?;`,
      [...params, n]
    );
    return Array.isArray(rows) ? rows : [];
  }

  async function presencePing(_token, _status) {
    return true;
  }

  return {
    issueListeningTicket,
    verifyListeningTicket,
    addExamSecurityEvent,
    listExamSecurityEvents,
    hasProctoringAck,
    recordProctoringAck,
    addSessionSnapshot,
    listSessionSnapshots,
    getSessionSnapshotById,
    deleteSessionSnapshotById,
    listSnapshotSessions,
    presencePing,
  };
}

module.exports = { createSqliteProctoringHelpers };
