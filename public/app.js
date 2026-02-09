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
