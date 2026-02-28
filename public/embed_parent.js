function setupEmbedAutoHeight() {
  const iframes = () => Array.from(document.querySelectorAll("iframe.admin-embed-frame"));

  function setHeightForFrame(frame, height) {
    const h = Number(height);
    if (!Number.isFinite(h) || h <= 0) return;
    const clamped = Math.max(220, Math.min(h, 20000));
    frame.style.height = `${clamped}px`;
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    const data = event.data || {};
    if (!data || data.type !== "embed:height") return;

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
