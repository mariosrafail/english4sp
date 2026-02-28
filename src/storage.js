const fs = require("fs");
const path = require("path");

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
  return { relPath: rel, absPath: abs };
}

async function deleteFile(relPath) {
  const { abs } = resolvePath(relPath);
  try {
    await fs.promises.unlink(abs);
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

module.exports = {
  storageBaseDir,
  ensureBaseDir,
  safeRelPath,
  resolvePath,
  writeFile,
  deleteFile,
  statFile,
  contentTypeForPath,
};

