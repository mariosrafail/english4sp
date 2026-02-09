const crypto = require("crypto");

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlJson(obj) {
  return b64url(Buffer.from(JSON.stringify(obj), "utf8"));
}

function fromB64url(str) {
  const s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, "base64").toString("utf8");
}

function getSecret() {
  const s = String(process.env.EXAMINER_SESSION_SECRET || "").trim();
  if (s) return s;
  // Fallback for local dev. For production, EXAMINER_SESSION_SECRET MUST be set.
  if (!global.__EXAMINER_SESSION_SECRET_FALLBACK__) {
    global.__EXAMINER_SESSION_SECRET_FALLBACK__ = crypto.randomBytes(32).toString("hex");
  }
  return global.__EXAMINER_SESSION_SECRET_FALLBACK__;
}

function sign(payloadB64) {
  const sig = crypto.createHmac("sha256", getSecret()).update(payloadB64).digest();
  return b64url(sig);
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function createExaminerToken(username, ttlMs = 8 * 60 * 60 * 1000) {
  const now = Date.now();
  const payload = { u: String(username || ""), exp: now + Number(ttlMs) };
  const payloadB64 = b64urlJson(payload);
  const sigB64 = sign(payloadB64);
  return `${payloadB64}.${sigB64}`;
}

function verifyExaminerToken(token) {
  const t = String(token || "").trim();
  const parts = t.split(".");
  if (parts.length !== 2) return { ok: false };
  const [payloadB64, sigB64] = parts;
  const expected = sign(payloadB64);
  if (!timingSafeEq(sigB64, expected)) return { ok: false };

  let payload;
  try {
    payload = JSON.parse(fromB64url(payloadB64));
  } catch {
    return { ok: false };
  }
  const exp = Number(payload?.exp);
  const u = String(payload?.u || "");
  if (!u || !Number.isFinite(exp)) return { ok: false };
  if (Date.now() > exp) return { ok: false, expired: true };
  return { ok: true, user: u, exp };
}

function parseCookies(req) {
  const h = String(req.headers.cookie || "");
  const out = {};
  for (const part of h.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function cookieOpts(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  const secure = proto === "https" || String(process.env.FORCE_SECURE_COOKIES || "").trim() === "1";
  return { secure };
}

function setExaminerAuthCookie(req, res, token) {
  const { secure } = cookieOpts(req);
  const parts = [
    `examiner_auth=${encodeURIComponent(String(token || ""))}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : null,
    "Max-Age=28800",
  ].filter(Boolean);
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearExaminerAuthCookie(req, res) {
  const { secure } = cookieOpts(req);
  const parts = [
    "examiner_auth=",
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : null,
    "Max-Age=0",
  ].filter(Boolean);
  res.setHeader("Set-Cookie", parts.join("; "));
}

// Small in-memory login rate limit (per IP)
const _rl = new Map();
function rateLimitExaminerLogin(req, res) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  const winMs = 60 * 1000;
  const max = 10;

  const rec = _rl.get(ip) || { c: 0, t: now };
  if (now - rec.t > winMs) {
    rec.c = 0;
    rec.t = now;
  }
  rec.c++;
  _rl.set(ip, rec);

  if (rec.c > max) {
    res.status(429).json({ error: "Too many attempts. Try again in 1 minute." });
    return false;
  }
  return true;
}

function getExaminerFromRequest(req) {
  const cookies = parseCookies(req);
  const tok = cookies.examiner_auth;
  return verifyExaminerToken(tok);
}

module.exports = {
  createExaminerToken,
  verifyExaminerToken,
  setExaminerAuthCookie,
  clearExaminerAuthCookie,
  rateLimitExaminerLogin,
  getExaminerFromRequest,
};
