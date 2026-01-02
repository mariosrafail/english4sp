import { qs } from "/app.js";
  const tokenEl = qs("#token");
  const msg = qs("#msg");

  function show(text, cls){
    msg.style.display = "block";
    msg.textContent = text;
    msg.className = "notice " + (cls || "");
  }

  qs("#go").addEventListener("click", ()=>{
    const t = tokenEl.value.trim();
    if (!t) return show("Please enter a token.", "bad");
    location.href = `/exam.html?token=${encodeURIComponent(t)}`;
  });
