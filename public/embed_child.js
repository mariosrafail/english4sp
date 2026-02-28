function isEmbedded() {
  try {
    const sp = new URLSearchParams(location.search || "");
    return sp.get("embed") === "1";
  } catch {
    return false;
  }
}

function postHeight() {
  if (!isEmbedded()) return;
  const height = Math.max(
    document.documentElement?.scrollHeight || 0,
    document.body?.scrollHeight || 0
  );
  try {
    window.parent?.postMessage({ type: "embed:height", height }, location.origin);
  } catch {}
}

function setupEmbedChild() {
  if (!isEmbedded()) return;
  document.documentElement?.classList.add("embed");
  document.body?.classList.add("embed");

  for (const el of Array.from(document.querySelectorAll("[data-embed-hide]"))) {
    el.style.display = "none";
  }

  // ResizeObserver catches dynamic UI (tables, overlays, etc).
  try {
    const ro = new ResizeObserver(() => postHeight());
    ro.observe(document.documentElement);
  } catch {}

  window.addEventListener("load", () => postHeight());
  window.addEventListener("resize", () => postHeight());

  // Fallback (cheap) in case observers don't fire (fonts, async rendering).
  let n = 0;
  const t = setInterval(() => {
    postHeight();
    n += 1;
    if (n >= 10) clearInterval(t);
  }, 250);
}

setupEmbedChild();
