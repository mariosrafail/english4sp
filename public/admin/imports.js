export function createAdminImportHelpers(deps) {
  const {
    apiGetNoBusy,
    apiPost,
    escapeHtml,
    getSelectedExamPeriodId,
    buildSelect,
    showAdminBusy,
    hideAdminBusy,
    setAdminBusyText,
    setAdminBusyProgress,
    delay,
    countryCodesSet,
    elDrop,
    elBrowse,
    elFile,
    elFileName,
    elImport,
    elOut,
    elSingleName,
    elSingleEmail,
    elSingleCountry,
    elCreateSingle,
    elSingleOut,
    elImportPeriodOverlay,
    elImportPeriodSelect,
    elImportPeriodCancel,
    elImportPeriodConfirm,
    elImportPeriodTitle,
    elImportPeriodSubtitle,
    state,
  } = deps;

  function setFile(f) {
    if (!f) {
      if (elFileName) elFileName.textContent = "No file selected";
      return;
    }
    if (elFileName) elFileName.textContent = f.name || "selected";
  }

  function askImportExamPeriodId(defaultId, mode = "candidates") {
    return new Promise((resolve) => {
      const periods = Array.isArray(state.periods) ? state.periods : [];
      if (!elImportPeriodOverlay || !elImportPeriodSelect || !periods.length) {
        resolve(Number(defaultId) || 1);
        return;
      }

      const pick = Number(defaultId) || Number(periods[0]?.id) || 1;
      buildSelect(elImportPeriodSelect, periods, pick);
      elImportPeriodSelect.value = String(pick);
      const singular = String(mode || "").toLowerCase() === "candidate";
      if (elImportPeriodTitle) {
        elImportPeriodTitle.textContent = singular ? "Select Exam Period for Candidate" : "Select Exam Period for Candidates";
      }
      if (elImportPeriodSubtitle) {
        elImportPeriodSubtitle.textContent = singular
          ? "Select where this candidate should be placed."
          : "Select where imported candidates should be placed.";
      }
      elImportPeriodOverlay.style.display = "flex";

      const cleanup = () => {
        elImportPeriodOverlay.style.display = "none";
        elImportPeriodConfirm?.removeEventListener("click", onConfirm);
        elImportPeriodCancel?.removeEventListener("click", onCancel);
        elImportPeriodOverlay.removeEventListener("click", onOverlayClick);
      };
      const onConfirm = () => {
        const v = Number(elImportPeriodSelect.value || pick);
        cleanup();
        resolve(Number.isFinite(v) && v > 0 ? v : pick);
      };
      const onCancel = () => {
        cleanup();
        resolve(null);
      };
      const onOverlayClick = (e) => {
        if (e.target === elImportPeriodOverlay) onCancel();
      };

      elImportPeriodConfirm?.addEventListener("click", onConfirm);
      elImportPeriodCancel?.addEventListener("click", onCancel);
      elImportPeriodOverlay.addEventListener("click", onOverlayClick);
    });
  }

  function wireFilePicker() {
    elBrowse?.addEventListener("click", () => elFile?.click());
    elFile?.addEventListener("change", () => {
      const f = elFile.files && elFile.files[0];
      setFile(f);
    });

    if (!elDrop) return;

    ["dragenter", "dragover"].forEach((evt) => {
      elDrop.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        elDrop.classList.add("dragover");
      });
    });

    ["dragleave", "drop"].forEach((evt) => {
      elDrop.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        elDrop.classList.remove("dragover");
      });
    });

    elDrop.addEventListener("drop", (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      try {
        const dt = new DataTransfer();
        dt.items.add(f);
        elFile.files = dt.files;
      } catch {}
      setFile(f);
    });
  }

  function wireExcelImport() {
    if (!elImport) return;
    elImport.addEventListener("click", async () => {
      try {
        elImport.disabled = true;
        if (elOut) elOut.textContent = "Processing...";

        const f = elFile.files && elFile.files[0];
        if (!f) throw new Error("Select an Excel file first");

        const defaultEp = getSelectedExamPeriodId();
        const ep = await askImportExamPeriodId(defaultEp, "candidates");
        if (!ep) {
          if (elOut) elOut.innerHTML = `<span class="muted">Import cancelled.</span>`;
          return;
        }
        if (!Number.isFinite(ep) || ep <= 0) throw new Error("Invalid exam period id");

        const fd = new FormData();
        fd.append("file", f);
        fd.append("examPeriodId", String(ep));

        showAdminBusy("Processing... Importing. Loaded 0/0");
        const r = await fetch("/api/admin/import-excel/job/start", {
          method: "POST",
          body: fd,
          credentials: "same-origin",
        });

        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${r.status}`);
        }

        const start = await r.json().catch(() => ({}));
        let job = start?.job || null;
        const jobId = String(job?.jobId || "").trim();
        if (!jobId) throw new Error("Import job did not start.");

        const initialTotal = Math.max(0, Number(job?.total || 0));
        if (initialTotal > 0) setAdminBusyText(`Processing... Importing. Loaded 0/${initialTotal}`);
        setAdminBusyProgress(0, null);

        const phaseLabel = (p) => {
          const ph = String(p || "").trim().toLowerCase();
          if (ph === "candidates") return "Upserting candidates";
          if (ph === "lookup") return "Reading candidates";
          if (ph === "sessions_lookup") return "Checking existing sessions";
          if (ph === "sessions") return "Creating sessions";
          if (ph === "assigning") return "Assigning examiners";
          if (ph === "speaking") return "Speaking slots";
          if (ph === "exporting") return "Preparing export";
          if (ph === "done") return "Finalizing";
          if (ph === "queued") return "Starting";
          return "Importing";
        };

        const phaseWeights = {
          queued: 0.00,
          candidates: 0.20,
          lookup: 0.06,
          sessions_lookup: 0.06,
          sessions: 0.20,
          assigning: 0.05,
          speaking: 0.38,
          exporting: 0.05,
          done: 0.00,
          error: 0.00,
        };
        const phaseOrder = ["queued", "candidates", "lookup", "sessions_lookup", "sessions", "assigning", "speaking", "exporting", "done"];

        const computePercent = (phaseRaw, processed, total) => {
          const ph = String(phaseRaw || "").trim().toLowerCase();
          if (ph === "done" || ph === "error") return 100;

          const idx = phaseOrder.indexOf(ph);
          const curW = Number(phaseWeights[ph] || 0);
          const curP = Number(total) > 0 ? Math.max(0, Math.min(1, Number(processed) / Number(total))) : 0;

          let base = 0;
          if (idx > 0) {
            for (let i = 0; i < idx; i++) base += Number(phaseWeights[phaseOrder[i]] || 0);
          }
          const pct = (base + (curW * curP)) * 100;
          return Math.max(0, Math.min(99.9, pct));
        };

        let lastText = "";
        let lastPct = null;
        let lastPctAt = 0;
        let lastEta = null;
        for (let i = 0; i < 1800; i++) {
          if (!job || !job.done) {
            const st = await apiGetNoBusy(`/api/admin/import-excel/job/${encodeURIComponent(jobId)}`);
            job = st?.job || job;
          }

          const processed = Number(job?.processed || 0);
          const total = Number(job?.total || 0);
          const phaseRaw = String(job?.phase || "").trim().toLowerCase();
          const ph = phaseLabel(phaseRaw);
          const verb = phaseRaw === "speaking"
            ? "Speaking"
            : (phaseRaw === "sessions" ? "Created" : "Progress");

          const text = total > 0
            ? `Processing... ${ph}. ${verb} ${Math.min(processed, total)}/${total}`
            : `Processing... ${ph}`;

          if (text !== lastText) {
            setAdminBusyText(text);
            lastText = text;
          }

          const pct = computePercent(phaseRaw, processed, total);
          let eta = null;
          const now = Date.now();
          if (lastPct !== null && lastPctAt > 0 && now > lastPctAt) {
            const dt = (now - lastPctAt) / 1000;
            const dp = pct - lastPct;
            const rate = dt > 0 ? (dp / dt) : 0;
            if (rate > 0.05) {
              const remain = Math.max(0, 100 - pct);
              eta = Math.min(12 * 3600, Math.round(remain / rate));
            }
          }
          lastPct = pct;
          lastPctAt = now;
          if (eta === null && lastEta != null) eta = lastEta;
          lastEta = eta;
          setAdminBusyProgress(pct, eta);

          if (job && job.done) break;
          const wait = phaseRaw === "speaking" ? 250 : 160;
          await delay(wait);
        }

        if (!job) throw new Error("Import status unavailable.");
        if (String(job.error || "").trim()) throw new Error(String(job.error));
        if (String(job.phase || "") === "error") throw new Error("Import failed.");

        setAdminBusyText("Downloading export...");
        const dl = await fetch(`/api/admin/import-excel/job/${encodeURIComponent(jobId)}/download`, {
          method: "GET",
          credentials: "same-origin",
        });
        if (!dl.ok) {
          const j = await dl.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${dl.status}`);
        }

        const blob = await dl.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `sessions_examperiod_${ep}.xlsx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        const speakingCreated = Number(job?.speakingCreated || 0);
        const speakingFailed = Number(job?.speakingFailed || 0);
        const speakingErr = String(job?.speakingError || "").trim();
        const speakingNote = (speakingCreated > 0 || speakingFailed > 0 || speakingErr)
          ? ` Speaking slots: created ${Math.max(0, speakingCreated)}, failed ${Math.max(0, speakingFailed)}.${speakingErr ? ` Error: ${escapeHtml(speakingErr)}` : ""}`
          : "";
        if (elOut) {
          elOut.innerHTML = `<span class="ok">Done. Download started.</span>${speakingNote ? `<br><span class="${speakingFailed > 0 || speakingErr ? "bad" : "ok"}">${speakingNote}</span>` : ""}`;
        }
      } catch (e) {
        if (elOut) elOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
      } finally {
        hideAdminBusy();
        elImport.disabled = false;
      }
    });
  }

  function wireSingleCandidateCreate() {
    if (!elCreateSingle) return;
    elCreateSingle.addEventListener("click", async () => {
      try {
        elCreateSingle.disabled = true;
        if (elSingleOut) elSingleOut.textContent = "Creating...";

        const defaultEp = getSelectedExamPeriodId();
        const ep = await askImportExamPeriodId(defaultEp, "candidate");
        if (!ep) {
          if (elSingleOut) elSingleOut.innerHTML = `<span class="muted">Creation cancelled.</span>`;
          return;
        }
        if (!Number.isFinite(ep) || ep <= 0) throw new Error("Invalid exam period id");

        const name = String(elSingleName?.value || "").trim();
        const email = String(elSingleEmail?.value || "").trim();
        const country = String(elSingleCountry?.value || "").trim().toUpperCase();
        if (!email) throw new Error("Email is required");
        if (country && !countryCodesSet.has(country)) {
          throw new Error("Invalid country code. Use ISO alpha-2 (e.g. GR, US, DE).");
        }

        showAdminBusy("Creating candidate link. Don't close this page. Please wait...");
        const out = await apiPost("/api/admin/create-candidate", {
          name,
          email,
          country,
          examPeriodId: ep,
        });

        if (elSingleOut) {
          const status = out?.reused ? "Existing candidate/session reused." : "Candidate created.";
          const link = String(out?.url || "").trim();
          const speakingLink = String(out?.speakingUrl || "").trim();
          const speakingErr = String(out?.speakingAutoError || "").trim();
          const speakingLine = speakingLink
            ? `<br>Speaking: <a class="mono" href="${escapeHtml(speakingLink)}" target="_blank" rel="noopener">Open</a>`
            : "";
          const errLine = speakingErr ? `<br><span class="bad">Speaking link auto-generation failed: ${escapeHtml(speakingErr)}</span>` : "";
          const examLine = link
            ? `<a class="mono" href="${escapeHtml(link)}" target="_blank" rel="noopener">Open</a>`
            : `<span class="muted">-</span>`;
          elSingleOut.innerHTML = `<span class="ok">${escapeHtml(status)}</span><br>Exam: ${examLine}${speakingLine}${errLine}`;
        }
      } catch (e) {
        if (elSingleOut) {
          elSingleOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
        }
      } finally {
        hideAdminBusy();
        elCreateSingle.disabled = false;
      }
    });
  }

  function wireImports() {
    wireFilePicker();
    wireExcelImport();
    wireSingleCandidateCreate();
  }

  return {
    askImportExamPeriodId,
    wireImports,
  };
}
