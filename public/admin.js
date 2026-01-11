import { apiGet, apiPost, qs, escapeHtml } from "./app.js";

  const elName = qs("#candidateName");
  const elGen = qs("#btnGenerate");
  const elOut = qs("#out");

  const elOpenDT = qs("#openDT");
  const elOpenUtcPreview = qs("#openUtcPreview");
  const elDurMin = qs("#durationMin");
  const elSave = qs("#btnSaveCfg");
  const elCfgOut = qs("#cfgOut");

  const elServerNow = qs("#serverNow");
  const elWindowLine = qs("#windowLine");

  const ATHENS_TZ = "Europe/Athens";

  function fmtAthensStamp(ms){
    const d = new Date(Number(ms));
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: ATHENS_TZ,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    return fmt.format(d);
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

  function minutesFromCfg(cfg){
    const m = Number(cfg?.durationMinutes);
    if (Number.isFinite(m) && m > 0) return Math.round(m);
    const s = Number(cfg?.durationSeconds);
    if (Number.isFinite(s) && s > 0) return Math.max(1, Math.round(s / 60));
    return 60;
  }

  async function loadCfg(){
    const cfg = await apiGet("/api/admin/config");
    elServerNow.textContent = fmtAthensStamp(cfg.serverNow);
    elOpenDT.value = toDatetimeLocalValue(cfg.openAtUtc);
    elOpenUtcPreview.textContent = fmtAthensStamp(cfg.openAtUtc);
    elDurMin.value = String(minutesFromCfg(cfg));

    const durMin = minutesFromCfg(cfg);
    const endAt = Number(cfg.openAtUtc) + Number(durMin) * 60 * 1000;
    elWindowLine.textContent = `${fmtAthensStamp(cfg.openAtUtc)}  to  ${fmtAthensStamp(endAt)}`;
  }

  function updateOpenPreview(){
    const ms = parseDatetimeLocalToMs(elOpenDT.value);
    elOpenUtcPreview.textContent = ms == null ? '-' : fmtAthensStamp(ms);
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
        <div style="margin-top:8px;"><a class="mono" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></div>
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

      const durMinutes = Number(elDurMin.value || 0);
      if (!Number.isFinite(durMinutes) || durMinutes <= 0) throw new Error("Invalid duration");

      const out = await apiPost("/api/admin/config", { openAtUtc: openMs, durationMinutes: Math.round(durMinutes) });

      elCfgOut.innerHTML = `<span class="ok">Saved.</span>`;
      elServerNow.textContent = fmtAthensStamp(out.serverNow);
      elOpenUtcPreview.textContent = fmtAthensStamp(out.openAtUtc);

      const durMin = minutesFromCfg(out);
      const endAt = Number(out.openAtUtc) + Number(durMin) * 60 * 1000;
      elWindowLine.textContent = `${fmtAthensStamp(out.openAtUtc)}  to  ${fmtAthensStamp(endAt)}`;
    } catch (e) {
      elCfgOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
    } finally {
      elSave.disabled = false;
    }
  });

  loadCfg().catch(e=>{
    elCfgOut.innerHTML = `<span class="bad">Failed to load config: ${escapeHtml(e.message || String(e))}</span>`;
  });
