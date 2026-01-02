import { apiGet, qs } from "./app.js";

  const elQ = qs("#q");
  const elClear = qs("#clear");
  const elSort = qs("#sort");
  const elOnlyDone = qs("#onlyDone");
  const elTbody = qs("#tbody");
  const elPageNum = qs("#pageNum");
  const elPageMax = qs("#pageMax");
  const elPrev = qs("#prev");
  const elNext = qs("#next");
  const elKpiTotal = qs("#kpiTotal");
  const elKpiFiltered = qs("#kpiFiltered");

  let allRows = [];
  let filtered = [];
  let page = 1;
  const PAGE_SIZE = 20;

  // Prevent UI freezes / white screen when users type fast or data is large.
  // We debounce filtering and avoid re-entrant renders.
  let applyTimer = null;
  let isApplying = false;
  let pendingApply = false;

  function scheduleApply(){
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(()=>{
      if (isApplying) { pendingApply = true; return; }
      try {
        isApplying = true;
        applyFilters(false);
      } catch (e) {
        elTbody.innerHTML = `<tr><td colspan="4" class="bad">Search error: ${escapeHtml(e?.message || String(e))}</td></tr>`;
      } finally {
        isApplying = false;
        if (pendingApply) { pendingApply = false; scheduleApply(); }
      }
    }, 60);
  }

  function normalize(x){
    return String(x || "").trim().toLowerCase();
  }

  function submittedFmt(submitted){
    return submitted ? '<span class="ok">Yes</span>' : '<span class="muted">No</span>';
  }

  function gradeFmt(grade){
    if (grade == null) return '<span class="muted">-</span>';
    return `<span class="mono">${escapeHtml(String(grade))}</span><span class="muted">%</span>`;
  }

  function escapeHtml(s){
    return String(s ?? "").replace(/[&<>"']/g, (ch)=>({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[ch]));
  }

  function applySort(rows){
    const mode = elSort.value;
    const out = [...rows];

    if (mode === "grade") {
      out.sort((a,b)=>{
        const ra = Number(a.grade ?? -1);
        const rb = Number(b.grade ?? -1);
        if (rb !== ra) return rb - ra;
        return Number(b.sessionId||0) - Number(a.sessionId||0);
      });
      return out;
    }

    if (mode === "name") {
      out.sort((a,b)=> normalize(a.candidateName).localeCompare(normalize(b.candidateName)) || (Number(a.sessionId||0) - Number(b.sessionId||0)));
      return out;
    }

    // most recent (default): newest session id first
    out.sort((a,b)=> Number(b.sessionId||0) - Number(a.sessionId||0));
    return out;
  }

  function applyFilters(resetPage=true){
    const qRaw = String(elQ.value || "");
    const q = normalize(qRaw);
    const qKey = q.replace(/[^a-z0-9]/g, "");
    let rows = allRows;

    if (elOnlyDone?.checked) {
      rows = rows.filter(r => !!r.submitted);
    }

    if (q){
      rows = rows.filter(r => {
        const name = normalize(r.candidateName);
        const sid = String(r.sessionId || "");
        const token = normalize(r.token || "");
        const sidPad = sid.padStart(6,"0");
        const idLabel = `s-${sidPad}`;

        // Single robust haystack, works for name, ID, token, and many input formats.
        const hay = `${name} ${token} ${sid} ${sidPad} ${idLabel} s${sidPad}`;
        if (hay.includes(q)) return true;

        // Alnum-only fallback for typing like "S000123", "s 000123", etc.
        if (!qKey) return false;
        const hayKey = hay.replace(/[^a-z0-9]/g, "");
        return hayKey.includes(qKey);
      });
    }

    rows = applySort(rows);

    filtered = rows;
    elKpiTotal.textContent = String(allRows.length);
    elKpiFiltered.textContent = String(filtered.length);

    if (resetPage) page = 1;
    render();
  }

  function render(){
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(page, totalPages);

    const start = (page - 1) * PAGE_SIZE;
    const slice = filtered.slice(start, start + PAGE_SIZE);

    if (!slice.length){
      elTbody.innerHTML = `<tr><td colspan="4" class="muted">No results</td></tr>`;
    } else {
      elTbody.innerHTML = slice.map(r => {
        const id = Number(r.sessionId || 0);
        const idLabel = `S-${String(id).padStart(6,"0")}`;
        return `
          <tr>
            <td><span class="pill mono">${escapeHtml(idLabel)}</span></td>
            <td><span class="mono">${escapeHtml(r.candidateName || "")}</span></td>
            <td><span class="mono">${escapeHtml(r.token || "")}</span></td>
            <td>${submittedFmt(!!r.submitted)}</td>
            <td>${gradeFmt(r.grade)}</td>
          </tr>
        `;
      }).join("");
    }

    elPageNum.textContent = String(page);
    elPageMax.textContent = String(totalPages);
    elPrev.disabled = page <= 1;
    elNext.disabled = page >= totalPages;

    // Click row -> open latest attempt details if exists (via results page behavior),
    // For now: open admin panel results by filtering token (future).
  }

  async function load(){
    elTbody.innerHTML = `<tr><td colspan="4" class="muted">Loading...</td></tr>`;
    allRows = await apiGet("/api/admin/candidates");
    applyFilters(false);
  }

  // Auto refresh every 5 seconds (keeps current filters and page).
  async function autoRefresh(){
    try{
      const fresh = await apiGet("/api/admin/candidates");
      // Only update if length or last id changed (cheap heuristic).
      if (!Array.isArray(allRows) || fresh.length !== allRows.length || (fresh[0]?.sessionId !== allRows[0]?.sessionId)) {
        allRows = fresh;
        applyFilters(false);
      }
    }catch(e){
      // keep UI as-is on refresh errors
      console.warn("autoRefresh failed:", e);
    }
  }

  setInterval(autoRefresh, 5000);
  window.addEventListener("focus", autoRefresh);
  document.addEventListener("visibilitychange", ()=>{ if (!document.hidden) autoRefresh(); });



  elQ.addEventListener("input", scheduleApply);

// Some browsers fire "search" when clicking the X in a search field.
  elQ.addEventListener("search", ()=> scheduleApply());

  elSort.addEventListener("change", scheduleApply);
  elOnlyDone.addEventListener("change", scheduleApply);

  elClear.addEventListener("click", ()=>{
    elQ.value = "";
    applyFilters(false);
    elQ.focus();
  });

  elPrev.addEventListener("click", ()=>{ page = Math.max(1, page-1); render(); });
  elNext.addEventListener("click", ()=>{ page = page+1; render(); });

  load().catch(e=>{
    elTbody.innerHTML = `<tr><td colspan="4" class="bad">Failed to load: ${escapeHtml(e.message || String(e))}</td></tr>`;
  });
