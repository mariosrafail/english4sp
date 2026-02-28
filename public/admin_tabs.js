function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

function getTabFromHash() {
  const h = String(location.hash || "").replace(/^#/, "").trim();
  if (!h) return null;
  if (h.startsWith("tab=")) return h.slice(4).trim() || null;
  return h;
}

function setHash(tabName) {
  const v = String(tabName || "").trim();
  if (!v) return;
  const target = `#tab=${encodeURIComponent(v)}`;
  if (location.hash === target) return;
  history.replaceState(null, "", target);
}

function setActiveTab(tabName, { focus = false, updateHash = true } = {}) {
  const name = String(tabName || "").trim();
  const tabs = qsa('button.admin-tab[data-admin-tab]');
  const panels = qsa('[data-admin-panel]');
  if (!tabs.length || !panels.length) return;

  const foundTab = tabs.find((t) => String(t.dataset.adminTab || "") === name) || tabs[0];
  const activeName = String(foundTab.dataset.adminTab || "");

  for (const t of tabs) {
    const isActive = String(t.dataset.adminTab || "") === activeName;
    t.setAttribute("aria-selected", isActive ? "true" : "false");
    t.tabIndex = isActive ? 0 : -1;
  }

  for (const p of panels) {
    const isActive = String(p.dataset.adminPanel || "") === activeName;
    if (isActive) p.removeAttribute("hidden");
    else p.setAttribute("hidden", "");
  }

  if (updateHash) setHash(activeName);
  if (focus) foundTab.focus();
}

function setupAdminTabs() {
  const tabs = qsa('button.admin-tab[data-admin-tab]');
  if (!tabs.length) return;

  const elLogout = document.getElementById("btnAdminLogout");
  elLogout?.addEventListener("click", async () => {
    try {
      await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin" });
    } catch {}
    location.href = "/";
  });

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      setActiveTab(tab.dataset.adminTab, { focus: false, updateHash: true });
    });

    tab.addEventListener("keydown", (e) => {
      const key = e.key;
      const idx = tabs.indexOf(tab);
      const prev = () => tabs[(idx - 1 + tabs.length) % tabs.length];
      const next = () => tabs[(idx + 1) % tabs.length];

      if (key === "ArrowLeft" || key === "ArrowUp") {
        e.preventDefault();
        const t = prev();
        setActiveTab(t.dataset.adminTab, { focus: true, updateHash: true });
        return;
      }
      if (key === "ArrowRight" || key === "ArrowDown") {
        e.preventDefault();
        const t = next();
        setActiveTab(t.dataset.adminTab, { focus: true, updateHash: true });
        return;
      }
      if (key === "Home") {
        e.preventDefault();
        setActiveTab(tabs[0].dataset.adminTab, { focus: true, updateHash: true });
        return;
      }
      if (key === "End") {
        e.preventDefault();
        setActiveTab(tabs[tabs.length - 1].dataset.adminTab, { focus: true, updateHash: true });
        return;
      }
      if (key === "Enter" || key === " ") {
        e.preventDefault();
        setActiveTab(tab.dataset.adminTab, { focus: true, updateHash: true });
      }
    });
  }

  const initial = getTabFromHash();
  setActiveTab(initial || tabs[0].dataset.adminTab, { focus: false, updateHash: true });

  window.addEventListener("hashchange", () => {
    const target = getTabFromHash();
    if (!target) return;
    setActiveTab(target, { focus: false, updateHash: false });
  });
}

setupAdminTabs();
