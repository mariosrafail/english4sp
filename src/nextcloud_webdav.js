function normalizeBaseWebdavUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  // Support:
  // - Share link: https://host/s/<token>
  // - WebDAV root: https://host/public.php/webdav/
  // - WebDAV root: https://host/remote.php/dav/files/<user>/ (not used here)
  try {
    const u = new URL(s);
    if (/\/public\.php\/webdav\/?$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/+$/, "") + "/";
      return u.toString();
    }
    // If it's a share link, derive public WebDAV endpoint.
    if (/\/s\/[^/]+\/?$/i.test(u.pathname)) {
      u.pathname = "/public.php/webdav/";
      u.search = "";
      u.hash = "";
      return u.toString();
    }
    // Fallback: assume user passed a base; just ensure trailing slash.
    u.pathname = u.pathname.replace(/\/+$/, "") + "/";
    return u.toString();
  } catch {
    return "";
  }
}

function shareTokenFromShareUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    const m = u.pathname.match(/\/s\/([^/]+)\/?$/i);
    return m && m[1] ? String(m[1]) : "";
  } catch {
    return "";
  }
}

function encodeDavPath(relPath) {
  const raw = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = raw.split("/").filter(Boolean).map((p) => encodeURIComponent(p));
  return parts.join("/");
}

function buildAuthHeader(username, password) {
  const u = String(username || "");
  const p = String(password || "");
  const tok = Buffer.from(`${u}:${p}`, "utf8").toString("base64");
  return `Basic ${tok}`;
}

async function davFetch(url, { method, headers, body } = {}) {
  const r = await fetch(url, {
    method: method || "GET",
    headers: headers || {},
    body,
  });
  return r;
}

function createNextcloudWebdavClient({
  shareUrl,
  baseWebdavUrl,
  username,
  password,
  userAgent = "eng4sp-nextcloud-webdav",
} = {}) {
  const base = normalizeBaseWebdavUrl(baseWebdavUrl || shareUrl);
  if (!base) throw new Error("nextcloud_webdav_missing_base_url");

  const u = String(username || "").trim() || shareTokenFromShareUrl(shareUrl);
  const p = String(password || "");
  if (!u) throw new Error("nextcloud_webdav_missing_username");

  const auth = buildAuthHeader(u, p);

  function urlFor(relPath) {
    const p2 = encodeDavPath(relPath);
    return base + p2;
  }

  async function mkcol(relDirPath) {
    const rel = String(relDirPath || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!rel) return;
    const url = urlFor(rel + "/");
    const r = await davFetch(url, {
      method: "MKCOL",
      headers: {
        Authorization: auth,
        "User-Agent": userAgent,
      },
    });
    if (r.status === 201) return;
    // 405 Method Not Allowed if already exists; 409 if parent missing.
    if (r.status === 405) return;
    const txt = await r.text().catch(() => "");
    throw new Error(`nextcloud_mkcol_failed:${r.status}:${txt.slice(0, 180)}`);
  }

  async function ensureDirsForFile(relFilePath) {
    const rel = String(relFilePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
    const idx = rel.lastIndexOf("/");
    if (idx <= 0) return;
    const dir = rel.slice(0, idx);
    const parts = dir.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      try {
        await mkcol(cur);
      } catch (e) {
        // If parent missing, continue creating; MKCOL on deeper path may 409.
        // We'll retry by ensuring parents sequentially anyway.
        throw e;
      }
    }
  }

  async function putFile(relFilePath, buf, { contentType = "application/octet-stream" } = {}) {
    const rel = String(relFilePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel) throw new Error("nextcloud_put_missing_path");
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || "");
    await ensureDirsForFile(rel);
    const url = urlFor(rel);
    const r = await davFetch(url, {
      method: "PUT",
      headers: {
        Authorization: auth,
        "User-Agent": userAgent,
        "Content-Type": contentType,
      },
      body: b,
    });
    if (r.ok) return true;
    const txt = await r.text().catch(() => "");
    throw new Error(`nextcloud_put_failed:${r.status}:${txt.slice(0, 180)}`);
  }

  async function deleteFile(relFilePath) {
    const rel = String(relFilePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel) throw new Error("nextcloud_delete_missing_path");
    const url = urlFor(rel);
    const r = await davFetch(url, {
      method: "DELETE",
      headers: {
        Authorization: auth,
        "User-Agent": userAgent,
      },
    });
    if (r.status === 204 || r.status === 200) return true;
    if (r.status === 404) return false;
    const txt = await r.text().catch(() => "");
    throw new Error(`nextcloud_delete_failed:${r.status}:${txt.slice(0, 180)}`);
  }

  return {
    baseWebdavUrl: base,
    username: u,
    putFile,
    deleteFile,
  };
}

module.exports = {
  createNextcloudWebdavClient,
};

