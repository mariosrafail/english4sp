import { apiGet, apiPost, qs, escapeHtml } from "./app.js";

  const elName = qs("#candidateName");
  const elGen = qs("#btnGenerate");
  const elOut = qs("#out");

  const elOpenDT = qs("#openDT");
  const elOpenUtcPreview = qs("#openUtcPreview");
  const elDurMin = qs("#durationMin");
  const elDurSec = qs("#durationSec");
  const elSave = qs("#btnSaveCfg");
  const elCfgOut = qs("#cfgOut");

  const elServerNow = qs("#serverNow");
  const elWindowLine = qs("#windowLine");

  function toIsoZ(ms){
    const d = new Date(Number(ms));
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const pad = (n)=> String(n).padStart(2,'0');
    const dd = pad(d.getUTCDate());
    const mon = months[d.getUTCMonth()];
    const yyyy = d.getUTCFullYear();
    const hh = pad(d.getUTCHours());
    const mm = pad(d.getUTCMinutes());
    return `${dd} ${mon} ${yyyy}, ${hh}:${mm} UTC`;
  }

  function toDatetimeLocalValue(ms){
    const d = new Date(Number(ms));
    const pad = (n)=> String(n).padStart(2,'0');
    const y = d.getFullYear();
    const m = pad(d.getMonth()+1);
    const day = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    return `${y}-${m}-${day}T${hh}:${mm}`;
  }

  // datetime-local has no timezone. We treat its value as LOCAL time and convert to UTC ms.
  function parseDatetimeLocalToMs(v){
    const s = String(v || '').trim();
    if (!s) return null;
    const d = new Date(s);
    const ms = d.getTime();
    if (!Number.isFinite(ms)) return null;
    return ms;
  }

  function syncDurFields(from){
    const min = Number(elDurMin.value || 0);
    const sec = Number(elDurSec.value || 0);
    if (from === "min"){
      elDurSec.value = String(Math.max(1, Math.round(min * 60)));
    } else if (from === "sec"){
      elDurMin.value = String(Math.max(1, Math.round(sec / 60)));
    }
  }

  elDurMin.addEventListener("input", ()=> syncDurFields("min"));
  elDurSec.addEventListener("input", ()=> syncDurFields("sec"));

  async function loadCfg(){
    const cfg = await apiGet("/api/admin/config");
    elServerNow.textContent = toIsoZ(cfg.serverNow);
    elOpenDT.value = toDatetimeLocalValue(cfg.openAtUtc);
    elOpenUtcPreview.textContent = toIsoZ(cfg.openAtUtc);
    elDurSec.value = String(cfg.durationSeconds || 3600);
    syncDurFields("sec");

    const endAt = Number(cfg.openAtUtc) + Number(cfg.durationSeconds || 0) * 1000;
    elWindowLine.textContent = `${toIsoZ(cfg.openAtUtc)}  to  ${toIsoZ(endAt)}`;
  }

  function updateOpenPreview(){
    const ms = parseDatetimeLocalToMs(elOpenDT.value);
    elOpenUtcPreview.textContent = ms == null ? '-' : toIsoZ(ms);
  }

  elOpenDT.addEventListener('input', updateOpenPreview);

  elGen.addEventListener("click", async () => {
    try {
      elGen.disabled = true;
      elOut.textContent = "Generating...";
      const data = await apiPost("/api/admin/create-session", { candidateName: elName.value });
      const url = data.url || "";
      elOut.innerHTML = `
        <div><span class="muted">Session:</span> <span class="mono">${escapeHtml(String(data.sessionId))}</span></div>
        <div style="margin-top:8px;"><a class="mono" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(location.origin + url)}</a></div>
      `;
    } catch (e) {
      elOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
    } finally {
      elGen.disabled = false;
    }
  });

  elSave.addEventListener("click", async () => {
    try {
      elSave.disabled = true;
      elCfgOut.innerHTML = "";
      const openMs = parseDatetimeLocalToMs(elOpenDT.value);
      if (openMs === null) throw new Error("Invalid open date/time");

      const durSeconds = Number(elDurSec.value || 0);
      if (!Number.isFinite(durSeconds) || durSeconds <= 0) throw new Error("Invalid duration");

      const out = await apiPost("/api/admin/config", { openAtUtc: openMs, durationSeconds: durSeconds });

      elCfgOut.innerHTML = `<span class="ok">Saved.</span>`;
      elServerNow.textContent = toIsoZ(out.serverNow);
      elOpenUtcPreview.textContent = toIsoZ(out.openAtUtc);
      const endAt = Number(out.openAtUtc) + Number(out.durationSeconds || 0) * 1000;
      elWindowLine.textContent = `${toIsoZ(out.openAtUtc)}  to  ${toIsoZ(endAt)}`;
    } catch (e) {
      elCfgOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
    } finally {
      elSave.disabled = false;
    }
  });

  loadCfg().catch(e=>{
    elCfgOut.innerHTML = `<span class="bad">Failed to load config: ${escapeHtml(e.message || String(e))}</span>`;
  });
