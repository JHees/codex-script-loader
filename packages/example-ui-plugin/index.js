(() => {
  "use strict";

  const INSTALL_KEY = "__codexScriptLoaderExampleUi";
  const VERSION = "1.0.0";
  const STYLE_ID = "codex-script-loader-example-ui-style";
  const BADGE_ID = "codex-script-loader-example-ui-badge";
  const STORAGE_KEY = "show-status-badge";
  const scriptLoadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const loaderApi = api;

  const previous = globalThis[INSTALL_KEY];
  if (previous && typeof previous.stop === "function") {
    try {
      previous.stop();
    } catch (error) {
      console.warn("[Loader example UI] previous lifecycle cleanup failed", error);
    }
  }

  if (!loaderApi) {
    console.warn("[Loader example UI] injected Loader API is unavailable");
    return;
  }

  let pageHandle = null;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BADGE_ID} {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 30;
        padding: 6px 10px;
        border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
        border-radius: 999px;
        background: var(--color-background-primary, Canvas);
        color: var(--color-text-primary, CanvasText);
        font: 500 12px/1.2 system-ui, sans-serif;
        box-shadow: 0 4px 16px rgb(0 0 0 / 12%);
        pointer-events: none;
      }
      [data-loader-example-settings] {
        display: grid;
        gap: 12px;
      }
      [data-loader-example-settings] label {
        display: flex;
        align-items: center;
        gap: 8px;
      }
    `;
    document.head.appendChild(style);
  }

  function badgeEnabled() {
    return loaderApi.storage.get(STORAGE_KEY, false) === true;
  }

  function syncBadge() {
    document.getElementById(BADGE_ID)?.remove();
    if (!badgeEnabled()) return;
    const badge = document.createElement("div");
    badge.id = BADGE_ID;
    badge.textContent = "Example plugin active";
    document.body.appendChild(badge);
  }

  function setBadgeEnabled(enabled) {
    loaderApi.storage.set(STORAGE_KEY, Boolean(enabled));
    syncBadge();
  }

  function renderSettings(root) {
    root.replaceChildren();
    root.dataset.loaderExampleSettings = "true";

    const section = document.createElement("section");
    section.dataset.loaderExampleSettings = "content";
    const heading = document.createElement("h2");
    heading.textContent = "Example UI plugin";
    const description = document.createElement("p");
    description.textContent = "This small Loader-owned package demonstrates manifest permissions, settings registration, local storage, DOM cleanup, and hot-reload lifecycle handling.";
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = badgeEnabled();
    checkbox.dataset.loaderExampleBadgeToggle = "true";
    checkbox.addEventListener("change", () => setBadgeEnabled(checkbox.checked));
    const labelText = document.createElement("span");
    labelText.textContent = "Show an example status badge";
    label.append(checkbox, labelText);
    section.append(heading, description, label);
    root.appendChild(section);

    return () => {
      delete root.dataset.loaderExampleSettings;
      root.replaceChildren();
    };
  }

  ensureStyle();
  syncBadge();
  pageHandle = loaderApi.settings?.registerPage?.({
    id: "main",
    title: "Example plugin",
    description: "Reference implementation shipped with Codex Script Loader.",
    render: renderSettings,
  }) || null;

  globalThis[INSTALL_KEY] = {
    version: VERSION,
    scriptLoadId,
    setBadgeEnabled,
    stop() {
      pageHandle?.unregister?.();
      pageHandle = null;
      document.getElementById(BADGE_ID)?.remove();
      document.getElementById(STYLE_ID)?.remove();
      if (globalThis[INSTALL_KEY]?.scriptLoadId === scriptLoadId) {
        delete globalThis[INSTALL_KEY];
      }
    },
  };

  loaderApi.log?.info?.("example UI plugin started", { version: VERSION, scriptLoadId });
})();
