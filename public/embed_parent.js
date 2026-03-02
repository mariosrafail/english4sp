function setupEmbedAutoHeight() {
  const iframes = () => Array.from(document.querySelectorAll("iframe.admin-embed-frame"));

  let busyCount = 0;
  let busyOverlay = null;
  let busyTextEl = null;
  let busyShownAtMs = 0;
  let busyHideTimer = null;

  const BUSY_MIN_VISIBLE_MS = 320;

  let reviewOverlay = null;
  let reviewModal = null;
  let reviewTitleEl = null;
  let reviewMetaEl = null;
  let reviewBodyEl = null;
  let reviewCloseBtn = null;
  let reviewKeyHandlerInstalled = false;

  function clampText(s, maxLen = 800) {
    const t = String(s || "");
    return t.length > maxLen ? `${t.slice(0, maxLen)}...` : t;
  }

  function ensureBusyOverlay() {
    if (busyOverlay && busyTextEl) return { overlay: busyOverlay, textEl: busyTextEl };
    const existing = document.querySelector("#adminBusyOverlay");
    if (existing) {
      busyOverlay = existing;
      busyTextEl = document.querySelector("#adminBusyText");
      return { overlay: busyOverlay, textEl: busyTextEl };
    }

    const overlay = document.createElement("div");
    overlay.id = "adminBusyOverlay";
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
    text.id = "adminBusyText";
    text.className = "adminBusyText";
    text.textContent = "Loading...";

    card.appendChild(spinner);
    card.appendChild(text);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    busyOverlay = overlay;
    busyTextEl = text;
    return { overlay, textEl: text };
  }

  function ensureReviewOverlay() {
    if (reviewOverlay && reviewModal && reviewTitleEl && reviewBodyEl) {
      return {
        overlay: reviewOverlay,
        modal: reviewModal,
        titleEl: reviewTitleEl,
        metaEl: reviewMetaEl,
        bodyEl: reviewBodyEl,
        closeBtn: reviewCloseBtn,
      };
    }

    const overlay = document.createElement("div");
    overlay.className = "reviewOverlay";
    overlay.style.display = "none";

    const modal = document.createElement("div");
    modal.className = "reviewModal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    const closeBtn = document.createElement("button");
    closeBtn.className = "reviewCloseBtn";
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "X";

    const title = document.createElement("h2");
    title.id = "parentReviewTitle";
    title.style.marginTop = "0";

    const meta = document.createElement("div");
    meta.className = "small";

    const body = document.createElement("div");
    body.className = "reviewBody";

    modal.appendChild(closeBtn);
    modal.appendChild(title);
    modal.appendChild(meta);
    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const close = () => {
      try { overlay.style.display = "none"; } catch {}
      try { body.innerHTML = ""; } catch {}
      try { meta.innerHTML = ""; } catch {}
      try { title.textContent = ""; } catch {}
      try { document.body.style.overflow = ""; } catch {}
    };

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    closeBtn.addEventListener("click", close);

    if (!reviewKeyHandlerInstalled) {
      reviewKeyHandlerInstalled = true;
      window.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (!overlay || overlay.style.display !== "flex") return;
        e.preventDefault();
        close();
      });
    }

    reviewOverlay = overlay;
    reviewModal = modal;
    reviewTitleEl = title;
    reviewMetaEl = meta;
    reviewBodyEl = body;
    reviewCloseBtn = closeBtn;
    return { overlay, modal, titleEl: title, metaEl: meta, bodyEl: body, closeBtn };
  }

  function openReview({ title, metaHtml, bodyHtml }) {
    const o = ensureReviewOverlay();
    if (o.titleEl) o.titleEl.textContent = clampText(title || "Candidate Review", 200);
    if (o.metaEl) o.metaEl.innerHTML = String(metaHtml || "");
    if (o.bodyEl) o.bodyEl.innerHTML = String(bodyHtml || "");
    try { document.body.style.overflow = "hidden"; } catch {}
    if (o.overlay) o.overlay.style.display = "flex";
  }

  function setHeightForFrame(frame, height) {
    const h = Number(height);
    if (!Number.isFinite(h) || h <= 0) return;
    const clamped = Math.max(220, Math.min(h, 20000));
    frame.style.height = `${clamped}px`;
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    const data = event.data || {};
    if (!data) return;

    if (data.type === "embed:review") {
      const action = String(data.action || "open").trim().toLowerCase();
      if (action === "close") {
        const o = ensureReviewOverlay();
        try { if (o.overlay) o.overlay.style.display = "none"; } catch {}
        try { document.body.style.overflow = ""; } catch {}
        return;
      }

      openReview({
        title: data.title || "Candidate Review",
        metaHtml: data.metaHtml || "",
        bodyHtml: data.bodyHtml || "",
      });
      return;
    }

    if (data.type === "embed:busy") {
      const action = String(data.action || "").toLowerCase();
      const { overlay, textEl } = ensureBusyOverlay();
      if (action === "start") {
        busyCount += 1;
        if (busyHideTimer) {
          clearTimeout(busyHideTimer);
          busyHideTimer = null;
        }
        if (textEl && data.text) textEl.textContent = String(data.text);
        if (overlay) {
          if (overlay.style.display !== "flex") busyShownAtMs = Date.now();
          overlay.style.display = "flex";
        }
      } else if (action === "stop") {
        busyCount = Math.max(0, busyCount - 1);
        if (busyCount === 0) {
          const hide = () => {
            try { if (overlay) overlay.style.display = "none"; } catch {}
            busyShownAtMs = 0;
          };
          const elapsed = busyShownAtMs ? (Date.now() - busyShownAtMs) : 0;
          if (overlay && overlay.style && overlay.style.display === "flex" && elapsed < BUSY_MIN_VISIBLE_MS) {
            busyHideTimer = setTimeout(() => {
              busyHideTimer = null;
              if (busyCount === 0) hide();
            }, Math.max(0, BUSY_MIN_VISIBLE_MS - elapsed));
          } else {
            hide();
          }
        }
      }
      return;
    }

    if (data.type === "embed:dialog") {
      const id = String(data.id || "");
      const kind = String(data.kind || "");
      if (!id || (kind !== "confirm" && kind !== "alert")) return;

      const title = clampText(data.title || (kind === "confirm" ? "Confirm" : "Notice"), 140);
      const message = clampText(data.message || "", 2000);
      const yesText = clampText(data.yesText || "Yes", 40);
      const noText = clampText(data.noText || "No", 40);
      const okText = clampText(data.okText || "OK", 40);
      const danger = !!data.danger;
      const targetWin = event.source;

      const overlay = document.createElement("div");
      overlay.style.position = "fixed";
      overlay.style.inset = "0";
      overlay.style.background = "rgba(11,16,32,0.45)";
      overlay.style.zIndex = "10060";
      overlay.style.display = "flex";
      overlay.style.alignItems = "center";
      overlay.style.justifyContent = "center";
      overlay.style.padding = "16px";

      const card = document.createElement("div");
      card.className = "card";
      card.style.width = "min(520px, 100%)";
      card.style.background = "#fff";
      card.style.border = "var(--border)";
      card.style.borderRadius = "14px";
      card.style.padding = "18px 16px";
      card.style.boxShadow = "0 22px 70px rgba(0,0,0,0.22)";
      card.style.maxHeight = "min(72vh, 720px)";
      card.style.overflow = "auto";

      const h = document.createElement("h2");
      h.style.margin = "0 0 8px 0";
      h.textContent = title;
      card.appendChild(h);

      const p = document.createElement("p");
      p.className = "muted";
      p.style.margin = "0";
      p.style.whiteSpace = "pre-wrap";
      p.textContent = message;
      card.appendChild(p);

      const actions = document.createElement("div");
      actions.style.display = "flex";
      actions.style.gap = "10px";
      actions.style.justifyContent = "flex-end";
      actions.style.marginTop = "14px";

      const sendResult = (result) => {
        try { overlay.remove(); } catch {}
        try { targetWin?.postMessage({ type: "embed:dialog:result", id, result: !!result }, location.origin); } catch {}
      };

      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          sendResult(false);
        } else if (e.key === "Enter") {
          e.preventDefault();
          sendResult(true);
        }
      };

      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) sendResult(false);
      });
      document.addEventListener("keydown", onKey, { once: true });

      if (kind === "alert") {
        const okBtn = document.createElement("button");
        okBtn.className = "btn primary";
        okBtn.type = "button";
        okBtn.style.width = "auto";
        okBtn.style.minWidth = "100px";
        okBtn.textContent = okText;
        okBtn.addEventListener("click", () => sendResult(true));
        actions.appendChild(okBtn);
        card.appendChild(actions);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        okBtn.focus();
        return;
      }

      const noBtn = document.createElement("button");
      noBtn.className = "btn";
      noBtn.type = "button";
      noBtn.style.width = "auto";
      noBtn.style.minWidth = "100px";
      noBtn.textContent = noText;
      noBtn.addEventListener("click", () => sendResult(false));

      const yesBtn = document.createElement("button");
      yesBtn.className = "btn primary";
      yesBtn.type = "button";
      yesBtn.style.width = "auto";
      yesBtn.style.minWidth = "100px";
      yesBtn.textContent = yesText;
      if (danger) {
        yesBtn.style.setProperty("--btnBase", "rgba(239,68,68,0.10)");
        yesBtn.style.setProperty("--btnBorder", "rgba(239,68,68,0.55)");
        yesBtn.style.setProperty("--btnText", "rgba(185,28,28,1)");
        yesBtn.style.setProperty("--btnFill", "rgba(239,68,68,1)");
        yesBtn.style.setProperty("--btnFillActive", "rgba(220,38,38,1)");
      }
      yesBtn.addEventListener("click", () => sendResult(true));

      actions.appendChild(noBtn);
      actions.appendChild(yesBtn);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      noBtn.focus();
      return;
    }

    if (data.type !== "embed:height") return;

    const srcWin = event.source;
    const frame = iframes().find((f) => f.contentWindow === srcWin);
    if (!frame) return;
    setHeightForFrame(frame, data.height);
  });

  window.addEventListener("load", () => {
    for (const f of iframes()) {
      // Give a reasonable default in case the child script is blocked for any reason.
      if (!f.style.height) f.style.height = "360px";
    }
  });
}

setupEmbedAutoHeight();
