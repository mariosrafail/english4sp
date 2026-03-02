const fs = require("fs");
const path = require("path");
const { createNextcloudWebdavClient } = require("./nextcloud_webdav");

let _nextcloudClient = null;
function getNextcloudClient() {
  const shareUrl = String(process.env.NEXTCLOUD_SHARE_URL || "").trim();
  const baseWebdavUrl = String(process.env.NEXTCLOUD_WEBDAV_URL || "").trim();
  const username = String(process.env.NEXTCLOUD_WEBDAV_USER || "").trim();
  const password = String(process.env.NEXTCLOUD_WEBDAV_PASS || process.env.NEXTCLOUD_SHARE_PASSWORD || "");
  if (!shareUrl && !baseWebdavUrl) return null;
  if (_nextcloudClient) return _nextcloudClient;
  _nextcloudClient = createNextcloudWebdavClient({ shareUrl, baseWebdavUrl, username, password });
  return _nextcloudClient;
}

function isNextcloudMirrorRequired() {
  const raw = process.env.NEXTCLOUD_MIRROR_REQUIRED;
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  const v = String(raw).trim().toLowerCase();
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return true;
}

function isPublicFileStorageEnabled() {
  const raw = process.env.FILE_STORAGE_PUBLIC;
  if (raw === undefined || raw === null || String(raw).trim() === "") return false;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  return false;
}

function publicPrefix() {
  const raw = String(process.env.FILE_STORAGE_PUBLIC_PREFIX || "").trim();
  return (raw || "/storage").replace(/\/+$/, "");
}

function storageBaseDir() {
  const raw = String(process.env.FILE_STORAGE_DIR || "").trim();
  if (raw) return path.resolve(raw);
  return path.resolve(path.join(__dirname, "..", "storage"));
}

function ensureBaseDir() {
  const base = storageBaseDir();
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function safeRelPath(relPath) {
  const raw = String(relPath || "").trim().replace(/\\/g, "/");
  if (!raw) throw new Error("missing_path");
  if (raw.startsWith("/")) throw new Error("invalid_path");
  if (raw.includes("\0")) throw new Error("invalid_path");
  const parts = raw.split("/").filter(Boolean);
  if (parts.some((p) => p === "." || p === "..")) throw new Error("invalid_path");
  return parts.join("/");
}

function resolvePath(relPath) {
  const base = ensureBaseDir();
  const safe = safeRelPath(relPath);
  const abs = path.resolve(path.join(base, safe));
  if (!abs.startsWith(base + path.sep) && abs !== base) throw new Error("invalid_path");
  return { base, rel: safe, abs };
}

function ensureDirForFile(absPath) {
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
}

async function writeFile(relPath, data) {
  const { rel, abs } = resolvePath(relPath);
  ensureDirForFile(abs);
  await fs.promises.writeFile(abs, data);

  const nc = getNextcloudClient();
  if (nc) {
    try {
      await nc.putFile(rel, Buffer.isBuffer(data) ? data : Buffer.from(data || ""), { contentType: contentTypeForPath(rel) });
    } catch (e) {
      if (isNextcloudMirrorRequired()) throw e;
      console.warn("nextcloud_mirror_write_failed", { relPath: rel, message: String(e?.message || e) });
    }
  }
  return { relPath: rel, absPath: abs };
}

async function deleteFile(relPath) {
  const { abs } = resolvePath(relPath);
  try {
    await fs.promises.unlink(abs);
    const nc = getNextcloudClient();
    if (nc) {
      try {
        await nc.deleteFile(String(relPath || ""));
      } catch (e) {
        if (isNextcloudMirrorRequired()) throw e;
        console.warn("nextcloud_mirror_delete_failed", { relPath: String(relPath || ""), message: String(e?.message || e) });
      }
    }
    return true;
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return false;
    throw e;
  }
}

async function statFile(relPath) {
  const { abs, rel } = resolvePath(relPath);
  try {
    const s = await fs.promises.stat(abs);
    return { exists: true, relPath: rel, absPath: abs, size: Number(s.size || 0), mtimeMs: Number(s.mtimeMs || 0) };
  } catch (e) {
    if (e && e.code === "ENOENT") return { exists: false, relPath: rel, absPath: abs, size: 0, mtimeMs: 0 };
    throw e;
  }
}

function contentTypeForPath(relPath) {
  const p = String(relPath || "").toLowerCase();
  if (p.endsWith(".mp3")) return "audio/mpeg";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  if (p.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function publicUrlForPath(relPath) {
  if (!isPublicFileStorageEnabled()) return "";
  const safe = safeRelPath(relPath);
  const parts = safe.split("/").filter(Boolean).map((p) => encodeURIComponent(p));
  return `${publicPrefix()}/${parts.join("/")}`;
}

module.exports = {
  storageBaseDir,
  ensureBaseDir,
  safeRelPath,
  resolvePath,
  writeFile,
  deleteFile,
  statFile,
  contentTypeForPath,
  publicUrlForPath,
};
