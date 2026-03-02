const https = require("https");
const http = require("http");

let LivekitAccessToken = null;
let LivekitRoomServiceClient = null;
try {
  ({ AccessToken: LivekitAccessToken, RoomServiceClient: LivekitRoomServiceClient } = require("livekit-server-sdk"));
} catch {}

function speakingVideoProvider() {
  const raw = String(process.env.SPEAKING_PROVIDER || "").trim().toLowerCase();
  if (!raw) return "mirotalk_p2p";
  if (raw === "selfhosted") return "mirotalk_p2p";
  if (raw === "self-hosted") return "mirotalk_p2p";
  if (raw === "mirotalk" || raw === "mirotalk-p2p") return "mirotalk_p2p";
  if (raw === "mirotalk_p2p" || raw === "jitsi" || raw === "talky" || raw === "livekit" || raw === "zoom") return raw;
  return "mirotalk_p2p";
}

function selfHostedMeetingBase() {
  const raw = String(
    process.env.SELF_HOSTED_MEETING_BASE_URL ||
      process.env.MEETING_BASE_URL ||
      process.env.PUBLIC_BASE_URL ||
      ""
  ).trim();
  return raw.replace(/\/+$/, "");
}

function selfHostedJitsiBase() {
  const raw = String(process.env.SELF_HOSTED_JITSI_BASE_URL || "").trim();
  return raw.replace(/\/+$/, "");
}

function selfHostedMiroTalkBase() {
  const explicit = String(
    process.env.SELF_HOSTED_MIROTALK_BASE_URL ||
      process.env.MIROTALK_P2P_BASE_URL ||
      ""
  ).trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const appBase = String(process.env.PUBLIC_BASE_URL || "").trim();
  if (appBase) {
    try {
      const u = new URL(appBase);
      return `${u.protocol}//meet.${u.host}`.replace(/\/+$/, "");
    } catch {}
  }

  return "https://p2p.mirotalk.com";
}

function talkyBase() {
  const raw = String(
    process.env.TALKY_BASE_URL ||
      process.env.SELF_HOSTED_TALKY_BASE_URL ||
      "https://talky.io"
  ).trim();
  return raw.replace(/\/+$/, "");
}

function livekitWsBase() {
  const raw = String(
    process.env.LIVEKIT_URL ||
      process.env.SELF_HOSTED_LIVEKIT_URL ||
      ""
  ).trim();
  return raw.replace(/\/+$/, "");
}

function livekitApiBase() {
  const explicit = String(process.env.LIVEKIT_API_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const wsBase = livekitWsBase();
  if (!wsBase) return "";
  return wsBase
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://")
    .replace(/\/+$/, "");
}

function normalizeRoomName(raw) {
  const room = String(raw || "").trim();
  if (!room) return "";
  return room.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120);
}

function normalizeParticipantName(raw) {
  const x = String(raw || "").trim();
  if (!x) return "";
  return x.replace(/[\r\n\t]/g, " ").slice(0, 80);
}

function livekitIdentityFromName(name) {
  const base = normalizeParticipantName(name).replace(/[^A-Za-z0-9_.-]/g, "-");
  const safe = (base || "guest").slice(0, 40);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${safe}-${Date.now()}-${rnd}`.slice(0, 96);
}

function ensureLivekitConfigured() {
  if (!LivekitAccessToken || !LivekitRoomServiceClient) {
    throw new Error("livekit_sdk_missing");
  }
  const wsUrl = livekitWsBase();
  const apiUrl = livekitApiBase();
  const apiKey = String(process.env.LIVEKIT_API_KEY || "").trim();
  const apiSecret = String(process.env.LIVEKIT_API_SECRET || "").trim();
  if (!wsUrl || !apiUrl || !apiKey || !apiSecret) {
    throw new Error("livekit_not_configured");
  }
  return { wsUrl, apiUrl, apiKey, apiSecret };
}

async function ensureLivekitRoomAndCapacity(room) {
  const cfg = ensureLivekitConfigured();
  const svc = new LivekitRoomServiceClient(cfg.apiUrl, cfg.apiKey, cfg.apiSecret);
  try {
    await svc.createRoom({
      name: room,
      maxParticipants: 2,
      emptyTimeout: 60 * 10,
    });
  } catch (e) {
    const msg = String(e?.message || "").toLowerCase();
    if (!msg.includes("already exists")) throw e;
  }
  const participants = await svc.listParticipants(room);
  const count = Array.isArray(participants) ? participants.length : 0;
  if (count >= 2) throw new Error("room_full");
  return { count };
}

async function createLivekitJoinToken(room, displayName) {
  const cfg = ensureLivekitConfigured();
  const identity = livekitIdentityFromName(displayName);
  const token = new LivekitAccessToken(cfg.apiKey, cfg.apiSecret, {
    identity,
    name: normalizeParticipantName(displayName) || identity,
    ttl: "2h",
  });
  token.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
  });
  return {
    wsUrl: cfg.wsUrl,
    token: await token.toJwt(),
    identity,
    name: normalizeParticipantName(displayName) || identity,
  };
}

function httpsJson(url, { method = "GET", headers = {}, body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + (u.search || ""),
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(buf.toString("utf8") || "null");
          } catch {}
          resolve({ status: Number(res.statusCode || 0), json, body: buf, headers: res.headers || {} });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy(new Error("timeout"));
      } catch {}
    });
    if (body) req.write(body);
    req.end();
  });
}

let _zoomAccessToken = "";
let _zoomAccessTokenExpiresAtUtcMs = 0;

function parseZoomConfig() {
  const accountId = String(process.env.ZOOM_ACCOUNT_ID || "").trim();
  const clientId = String(process.env.ZOOM_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.ZOOM_CLIENT_SECRET || "").trim();
  const hostEmail = String(process.env.ZOOM_HOST_EMAIL || "").trim();
  const hostUserId = String(process.env.ZOOM_HOST_USER_ID || "").trim();
  const timezone = String(process.env.ZOOM_TIMEZONE || "UTC").trim() || "UTC";

  const userId = hostUserId || hostEmail;
  const enabled = !!(accountId && clientId && clientSecret && userId);
  return { enabled, accountId, clientId, clientSecret, userId, timezone };
}

async function zoomGetAccessToken() {
  const cfg = parseZoomConfig();
  if (!cfg.enabled) throw new Error("zoom_not_configured");

  const now = Date.now();
  if (_zoomAccessToken && now + 60_000 < _zoomAccessTokenExpiresAtUtcMs) return _zoomAccessToken;

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`, "utf8").toString("base64");
  const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(cfg.accountId)}`;
  const r = await httpsJson(url, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}` },
    timeoutMs: 20000,
  });

  if (!(r.status >= 200 && r.status < 300) || !r.json?.access_token) {
    const msg = String(r.json?.reason || r.json?.error || r.json?.message || `zoom_oauth_failed_${r.status}`);
    throw new Error(msg);
  }

  const token = String(r.json.access_token || "");
  const expiresInSec = Number(r.json.expires_in || 0);
  _zoomAccessToken = token;
  _zoomAccessTokenExpiresAtUtcMs = now + Math.max(0, expiresInSec) * 1000;
  return token;
}

function toZoomIsoUtc(ms) {
  return new Date(Number(ms)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function createZoomMeetingForSlot(slot, { defaultDurationMinutes = 60 } = {}) {
  const cfg = parseZoomConfig();
  if (!cfg.enabled) throw new Error("zoom_not_configured");

  const startUtcMs = Number(slot?.startUtcMs || 0);
  if (!Number.isFinite(startUtcMs) || startUtcMs <= 0) throw new Error("zoom_invalid_start_time");

  const durationMinutes = Number(slot?.durationMinutes || defaultDurationMinutes || 0);
  const duration = Math.max(1, Math.min(12 * 60, Math.floor(durationMinutes) || 10));

  const candidateName = String(slot?.candidateName || "").trim();
  const topic = `ENG4SP Speaking${candidateName ? ` - ${candidateName}` : ""}`.slice(0, 190);

  const accessToken = await zoomGetAccessToken();
  const url = `https://api.zoom.us/v2/users/${encodeURIComponent(cfg.userId)}/meetings`;
  const body = {
    topic,
    type: 2,
    start_time: toZoomIsoUtc(startUtcMs),
    timezone: cfg.timezone,
    duration,
    settings: {
      waiting_room: true,
      join_before_host: false,
      mute_upon_entry: true,
      host_video: true,
      participant_video: true,
    },
  };

  const r = await httpsJson(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 20000,
  });

  if (!(r.status >= 200 && r.status < 300) || !r.json?.join_url) {
    const msg = String(r.json?.message || r.json?.error || `zoom_create_meeting_failed_${r.status}`);
    throw new Error(msg);
  }

  const meetingId = String(r.json.id || "").trim();
  const joinUrl = String(r.json.join_url || "").trim();
  const startUrl = String(r.json.start_url || "").trim() || joinUrl;
  return {
    meetingId,
    joinUrl,
    startUrl,
    metadata: {
      provider: "zoom",
      autoGenerated: true,
      hostUserId: cfg.userId,
      zoomMeetingId: meetingId,
      createdAtUtcMs: Date.now(),
    },
  };
}

function selfHostedMeetingRoomForSlot(slot) {
  const existing = String(slot?.meetingId || "").trim();
  if (existing) return existing;
  const sid = Number(slot?.sessionId || 0);
  const sl = Number(slot?.id || 0);
  const start = Number(slot?.startUtcMs || 0);
  const raw = `eng4-${sid > 0 ? `s${sid}` : `x${sl > 0 ? sl : "0"}`}-${start > 0 ? Math.floor(start / 1000) : Date.now()}`;
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120) || `eng4-${Date.now()}`;
}

async function createSelfHostedMeetingForSlot(slot) {
  const room = selfHostedMeetingRoomForSlot(slot);
  const provider = speakingVideoProvider();

  if (provider === "jitsi") {
    const base = selfHostedMeetingBase();
    const jitsiBase = selfHostedJitsiBase();
    const query = `room=${encodeURIComponent(room)}${jitsiBase ? `&base=${encodeURIComponent(jitsiBase)}` : ""}`;
    const joinUrl = base ? `${base}/meeting.html?${query}` : `/meeting.html?${query}`;
    return {
      meetingId: room,
      joinUrl,
      startUrl: joinUrl,
      metadata: {
        provider: "jitsi",
        autoGenerated: true,
        room,
        createdAtUtcMs: Date.now(),
      },
    };
  }

  if (provider === "talky") {
    const base = talkyBase();
    const joinUrl = `${base}/${encodeURIComponent(room)}`;
    return {
      meetingId: room,
      joinUrl,
      startUrl: joinUrl,
      metadata: {
        provider: "talky",
        autoGenerated: true,
        room,
        createdAtUtcMs: Date.now(),
      },
    };
  }

  if (provider === "livekit") {
    const base = selfHostedMeetingBase();
    const query = `room=${encodeURIComponent(room)}`;
    const joinUrl = base ? `${base}/meeting-livekit.html?${query}` : `/meeting-livekit.html?${query}`;
    return {
      meetingId: room,
      joinUrl,
      startUrl: joinUrl,
      metadata: {
        provider: "livekit",
        autoGenerated: true,
        room,
        maxParticipants: 2,
        createdAtUtcMs: Date.now(),
      },
    };
  }

  const mirotalkBase = selfHostedMiroTalkBase();
  const joinUrl = `${mirotalkBase}/join?room=${encodeURIComponent(room)}`;
  return {
    meetingId: room,
    joinUrl,
    startUrl: joinUrl,
    metadata: {
      provider: "mirotalk_p2p",
      autoGenerated: true,
      room,
      createdAtUtcMs: Date.now(),
    },
  };
}

async function createMeetingForSlot(slot, { defaultDurationMinutes = 60 } = {}) {
  const provider = speakingVideoProvider();
  if (provider === "zoom") return createZoomMeetingForSlot(slot, { defaultDurationMinutes });
  return createSelfHostedMeetingForSlot(slot);
}

module.exports = {
  speakingVideoProvider,
  createMeetingForSlot,
  normalizeRoomName,
  normalizeParticipantName,
  ensureLivekitRoomAndCapacity,
  createLivekitJoinToken,
};
