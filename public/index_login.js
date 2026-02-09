import { qs, escapeHtml } from "/app.js";

const u = qs("#username");
const p = qs("#password");
const btn = qs("#loginBtn");
const logout = qs("#logoutBtn");
const msg = qs("#msg");

function show(text, cls){
  msg.style.display = "block";
  msg.textContent = text;
  msg.className = "notice " + (cls || "");
}

async function refreshMe(){
  const r = await fetch("/api/admin/me", { credentials: "same-origin" });
  if (!r.ok) return { ok:false };
  const j = await r.json().catch(()=>({}));
  return j;
}

async function onLogin(){
  msg.style.display = "none";
  btn.disabled = true;
  try{
    const username = u.value.trim();
    const password = p.value.trim();
    if (!username || !password) return show("Please enter username and password.", "bad");

    const r = await fetch("/api/admin/login", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ username, password }),
      credentials:"same-origin"
    });
    const j = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);

    show("Logged in. Redirecting...", "ok");
    setTimeout(()=>{ location.href = "/admin.html"; }, 300);
  }catch(e){
    show(String(e?.message || e), "bad");
  }finally{
    btn.disabled = false;
  }
}

async function onLogout(){
  logout.disabled = true;
  try{
    await fetch("/api/admin/logout", { method:"POST", credentials:"same-origin" });
    show("Logged out.", "ok");
    logout.style.display = "none";
  }finally{
    logout.disabled = false;
  }
}

btn.addEventListener("click", onLogin);
p.addEventListener("keydown", (e)=>{ if (e.key === "Enter") onLogin(); });
u.addEventListener("keydown", (e)=>{ if (e.key === "Enter") onLogin(); });
logout.addEventListener("click", onLogout);

(async ()=>{
  const me = await refreshMe();
  if (me.ok){
    logout.style.display = "inline-block";
    show(`Already logged in as ${escapeHtml(me.user)}.`, "ok");
  }
})();
