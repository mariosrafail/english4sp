export function qs(sel, root=document){ return root.querySelector(sel); }
export function qsa(sel, root=document){ return [...root.querySelectorAll(sel)]; }

export function fmtTime(sec){
  sec = Math.max(0, Math.floor(sec));
  const m = String(Math.floor(sec/60)).padStart(2,"0");
  const s = String(sec%60).padStart(2,"0");
  return `${m}:${s}`;
}

export function escapeHtml(str){
  return String(str ?? "").replace(/[&<>"']/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

export async function apiGet(url, { busy, busyText = "Loading..." } = {}){
  const autoBusy = String(url || "").startsWith("/api/admin") || String(url || "").startsWith("/api/examiner");
  const doBusy = busy === undefined ? autoBusy : !!busy;
  const stop = doBusy ? busyStart(busyText) : (() => {});
  try {
    const r = await fetch(url, { credentials:"same-origin" });
    const j = await r.json().catch(()=> ({}));
    if (r.status === 401 && String(url || "").startsWith("/api/admin")) {
      // Not logged in, send to landing.
      location.href = "/index.html";
      throw new Error("Not authenticated");
    }
    if (r.status === 401 && String(url || "").startsWith("/api/examiner")) {
      location.href = "/examiners.html";
      throw new Error("Not authenticated");
    }
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  } finally { stop(); }
}

export async function apiPost(url, body, { busy, busyText = "Working..." } = {}){
  const autoBusy = String(url || "").startsWith("/api/admin") || String(url || "").startsWith("/api/examiner");
  const doBusy = busy === undefined ? autoBusy : !!busy;
  const stop = doBusy ? busyStart(busyText) : (() => {});
  try {
    const r = await fetch(url, {
      method:"POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(body || {}),
      credentials:"same-origin"
    });
    const j = await r.json().catch(()=> ({}));
    if (r.status === 401 && String(url || "").startsWith("/api/admin")) {
      location.href = "/index.html";
      throw new Error("Not authenticated");
    }
    if (r.status === 401 && String(url || "").startsWith("/api/examiner")) {
      location.href = "/examiners.html";
      throw new Error("Not authenticated");
    }
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  } finally { stop(); }
}

export function nowMs(){ return Date.now(); }

let _busyCount = 0;
let _busyTimer = null;
let _busyHideTimer = null;
let _busyOverlay = null;
let _busyTextEl = null;
let _busyTextForParent = "Loading...";
let _busyTextLast = "Loading...";
let _busyShownAtMs = 0;

const BUSY_SHOW_DELAY_MS = 260;
const BUSY_MIN_VISIBLE_MS = 320;

function isEmbeddedContext() {
  try {
    const sp = new URLSearchParams(location.search || "");
    if (sp.get("embed") === "1") return true;
  } catch {}
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function postParentBusy(action, text) {
  try {
    if (!isEmbeddedContext()) return false;
    if (!window.parent || window.parent === window) return false;
    window.parent.postMessage({ type: "embed:busy", action, text: String(text || "") }, location.origin);
    return true;
  } catch {
    return false;
  }
}

let _dialogSeq = 0;
const _pendingParentDialogs = new Map(); // id -> resolve(result)
let _parentDialogListenerInstalled = false;

function ensureParentDialogListener() {
  if (_parentDialogListenerInstalled) return;
  _parentDialogListenerInstalled = true;
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    const data = event.data || {};
    if (!data || data.type !== "embed:dialog:result") return;
    const id = String(data.id || "");
    if (!id) return;
    const resolve = _pendingParentDialogs.get(id);
    if (!resolve) return;
    _pendingParentDialogs.delete(id);
    try { resolve(!!data.result); } catch {}
  });
}

function requestParentDialog(payload) {
  try {
    if (!isEmbeddedContext()) return null;
    if (!window.parent || window.parent === window) return null;
    ensureParentDialogListener();
    _dialogSeq += 1;
    const id = `${Date.now()}_${_dialogSeq}_${Math.random().toString(16).slice(2)}`;
    window.parent.postMessage({ type: "embed:dialog", id, ...payload }, location.origin);
    return new Promise((resolve) => {
      _pendingParentDialogs.set(id, resolve);
      // Safety timeout: if parent never responds, fall back to local behavior.
      setTimeout(() => {
        if (!_pendingParentDialogs.has(id)) return;
        _pendingParentDialogs.delete(id);
        resolve(null);
      }, 30_000);
    });
  } catch {
    return null;
  }
}

function ensureBusyOverlay() {
  if (_busyOverlay && _busyTextEl) return { overlay: _busyOverlay, textEl: _busyTextEl };

  // Prefer the admin page overlay if present.
  const existing = document.querySelector("#adminBusyOverlay");
  if (existing) {
    _busyOverlay = existing;
    _busyTextEl = document.querySelector("#adminBusyText");
    return { overlay: _busyOverlay, textEl: _busyTextEl };
  }

  const overlay = document.createElement("div");
  overlay.id = "codexBusyOverlay";
  overlay.className = "adminBusyOverlay";
  overlay.style.display = "none";
  overlay.setAttribute("aria-live", "polite");
  overlay.setAttribute("aria-busy", "true");

  const card = document.createElement("div");
  card.className = "adminBusyCard";

  const spinner = document.createElement("div");
  spinner.className = "adminBusySpinner";
  spinner.setAttribute("aria-hidden", "true");

  const text = document.createElement("div");
  text.className = "adminBusyText";
  text.textContent = "Loading...";

  card.appendChild(spinner);
  card.appendChild(text);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  _busyOverlay = overlay;
  _busyTextEl = text;
  return { overlay, textEl: text };
}

export function busyStart(text = "Loading...") {
  const embedded = isEmbeddedContext();
  let overlay = null;
  let textEl = null;
  let parentShown = false;
  if (!embedded) {
    const o = ensureBusyOverlay();
    overlay = o.overlay;
    textEl = o.textEl;
  }
  _busyCount += 1;
  _busyTextForParent = String(text || "Loading...");
  _busyTextLast = String(text || "Loading...");
  if (textEl) textEl.textContent = String(text || "Loading...");

  if (_busyTimer) {
    clearTimeout(_busyTimer);
    _busyTimer = null;
  }
  if (_busyHideTimer) {
    clearTimeout(_busyHideTimer);
    _busyHideTimer = null;
  }

  // Avoid flicker for fast operations.
  if (_busyCount === 1) {
    _busyTimer = setTimeout(() => {
      _busyTimer = null;
      if (_busyCount > 0) {
        if (embedded) {
          const ok = postParentBusy("start", _busyTextForParent);
          if (ok) parentShown = true;
          if (!ok) {
            const o = ensureBusyOverlay();
            overlay = o.overlay;
            textEl = o.textEl;
            if (textEl) textEl.textContent = _busyTextForParent;
            if (overlay) {
              overlay.style.display = "flex";
              _busyShownAtMs = Date.now();
            }
          }
        } else if (overlay) {
          overlay.style.display = "flex";
          _busyShownAtMs = Date.now();
        }
      }
    }, BUSY_SHOW_DELAY_MS);
  }

  return function stop() {
    _busyCount = Math.max(0, _busyCount - 1);
    if (_busyCount === 0) {
      if (_busyTimer) {
        clearTimeout(_busyTimer);
        _busyTimer = null;
      }
      if (embedded && parentShown) postParentBusy("stop", "");
      const hideLocal = () => {
        try { if (overlay) overlay.style.display = "none"; } catch {}
        _busyShownAtMs = 0;
      };
      const elapsed = _busyShownAtMs ? (Date.now() - _busyShownAtMs) : 0;
      if (overlay && overlay.style && overlay.style.display === "flex" && elapsed < BUSY_MIN_VISIBLE_MS) {
        _busyHideTimer = setTimeout(() => {
          _busyHideTimer = null;
          if (_busyCount === 0) hideLocal();
        }, Math.max(0, BUSY_MIN_VISIBLE_MS - elapsed));
      } else {
        hideLocal();
      }
    }
  };
}

function makeDialogBase({ title, message }) {
  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.background = "rgba(11,16,32,0.45)";
  overlay.style.zIndex = "10050";
  overlay.style.display = "flex";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.padding = "16px";

  const card = document.createElement("div");
  card.className = "card";
  card.style.width = "min(520px, 100%)";
  // Ensure dialogs look correct even inside embedded pages (which override .card styles).
  card.style.background = "#fff";
  card.style.border = "var(--border)";
  card.style.borderRadius = "14px";
  card.style.padding = "18px 16px";
  card.style.boxShadow = "0 22px 70px rgba(0,0,0,0.22)";
  card.style.maxHeight = "min(72vh, 720px)";
  card.style.overflow = "auto";

  const h = document.createElement("h2");
  h.style.margin = "0 0 8px 0";
  h.textContent = String(title || "Notice");
  card.appendChild(h);

  const p = document.createElement("p");
  p.className = "muted";
  p.style.margin = "0";
  p.style.whiteSpace = "pre-wrap";
  p.textContent = String(message || "");
  card.appendChild(p);

  overlay.appendChild(card);
  return { overlay, card };
}

export function uiAlert(message, { title = "Notice", okText = "OK" } = {}) {
  return new Promise((resolve) => {
    const showLocal = () => {
      const { overlay, card } = makeDialogBase({ title, message });
      const actions = document.createElement("div");
      actions.style.display = "flex";
      actions.style.gap = "10px";
      actions.style.justifyContent = "flex-end";
      actions.style.marginTop = "14px";

      const okBtn = document.createElement("button");
      okBtn.className = "btn primary";
      okBtn.type = "button";
      okBtn.style.width = "auto";
      okBtn.style.minWidth = "100px";
      okBtn.textContent = String(okText || "OK");

      const close = () => {
        document.removeEventListener("keydown", onKey);
        overlay.remove();
        resolve(true);
      };
      const onKey = (e) => {
        if (e.key === "Escape" || e.key === "Enter") {
          e.preventDefault();
          close();
        }
      };
      okBtn.addEventListener("click", close);
      document.addEventListener("keydown", onKey);

      actions.appendChild(okBtn);
      card.appendChild(actions);
      document.body.appendChild(overlay);
      okBtn.focus();
    };

    const parentP = requestParentDialog({ kind: "alert", title, message, okText });
    if (parentP) {
      parentP.then((v) => {
        if (v === null) return showLocal();
        resolve(true);
      });
      return;
    }

    showLocal();
  });
}

export function uiConfirm(message, { title = "Confirm", yesText = "Yes", noText = "No", danger = false } = {}) {
  return new Promise((resolve) => {
    const showLocal = () => {
      const { overlay, card } = makeDialogBase({ title, message });
      const actions = document.createElement("div");
      actions.style.display = "flex";
      actions.style.gap = "10px";
      actions.style.justifyContent = "flex-end";
      actions.style.marginTop = "14px";

      const noBtn = document.createElement("button");
      noBtn.className = "btn";
      noBtn.type = "button";
      noBtn.style.width = "auto";
      noBtn.style.minWidth = "100px";
      noBtn.textContent = String(noText || "No");

      const yesBtn = document.createElement("button");
      yesBtn.className = "btn primary";
      yesBtn.type = "button";
      yesBtn.style.width = "auto";
      yesBtn.style.minWidth = "100px";
      yesBtn.textContent = String(yesText || "Yes");
      if (danger) {
        yesBtn.style.setProperty("--btnBase", "rgba(239,68,68,0.10)");
        yesBtn.style.setProperty("--btnBorder", "rgba(239,68,68,0.55)");
        yesBtn.style.setProperty("--btnText", "rgba(185,28,28,1)");
        yesBtn.style.setProperty("--btnFill", "rgba(239,68,68,1)");
        yesBtn.style.setProperty("--btnFillActive", "rgba(220,38,38,1)");
      }

      const done = (val) => {
        document.removeEventListener("keydown", onKey);
        overlay.remove();
        resolve(!!val);
      };
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          done(false);
        } else if (e.key === "Enter") {
          e.preventDefault();
          done(true);
        }
      };

      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) done(false);
      });
      noBtn.addEventListener("click", () => done(false));
      yesBtn.addEventListener("click", () => done(true));
      document.addEventListener("keydown", onKey);

      actions.appendChild(noBtn);
      actions.appendChild(yesBtn);
      card.appendChild(actions);
      document.body.appendChild(overlay);
      noBtn.focus();
    };

    const parentP = requestParentDialog({ kind: "confirm", title, message, yesText, noText, danger: !!danger });
    if (parentP) {
      parentP.then((v) => {
        if (v === null) return showLocal();
        resolve(!!v);
      });
      return;
    }

    showLocal();
  });
}

export function uiPrompt(message, defaultValue = "", {
  title = "Input",
  placeholder = "",
  okText = "OK",
  cancelText = "Cancel",
} = {}) {
  return new Promise((resolve) => {
    const { overlay, card } = makeDialogBase({ title, message });

    const input = document.createElement("input");
    input.className = "input mono";
    input.type = "text";
    input.value = String(defaultValue ?? "");
    input.placeholder = String(placeholder || "");
    input.style.marginTop = "6px";
    card.appendChild(input);

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "10px";
    actions.style.justifyContent = "flex-end";
    actions.style.marginTop = "14px";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.type = "button";
    cancelBtn.style.width = "auto";
    cancelBtn.style.minWidth = "100px";
    cancelBtn.textContent = String(cancelText || "Cancel");

    const okBtn = document.createElement("button");
    okBtn.className = "btn primary";
    okBtn.type = "button";
    okBtn.style.width = "auto";
    okBtn.style.minWidth = "100px";
    okBtn.textContent = String(okText || "OK");

    const done = (val) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        done(String(input.value || ""));
      }
    };

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) done(null);
    });
    cancelBtn.addEventListener("click", () => done(null));
    okBtn.addEventListener("click", () => done(String(input.value || "")));
    document.addEventListener("keydown", onKey);

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    card.appendChild(actions);
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}
