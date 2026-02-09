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

export async function apiGet(url){
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
}

export async function apiPost(url, body){
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
}

export function nowMs(){ return Date.now(); }

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

  const h = document.createElement("h2");
  h.style.marginTop = "0";
  h.textContent = String(title || "Notice");
  card.appendChild(h);

  const p = document.createElement("p");
  p.className = "muted";
  p.style.marginTop = "6px";
  p.style.whiteSpace = "pre-wrap";
  p.textContent = String(message || "");
  card.appendChild(p);

  overlay.appendChild(card);
  return { overlay, card };
}

export function uiAlert(message, { title = "Notice", okText = "OK" } = {}) {
  return new Promise((resolve) => {
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
  });
}

export function uiConfirm(message, { title = "Confirm", yesText = "Yes", noText = "No" } = {}) {
  return new Promise((resolve) => {
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
