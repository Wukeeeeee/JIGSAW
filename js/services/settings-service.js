/* ============================================================
   JIGSAW — SettingsService
   Persists configuration (localStorage). Mock implementation.
   ============================================================ */
(function () {
  const KEY = "jigsaw.settings.v1";
  const { SETTINGS } = JIGSAW.Mock;

  function loadRaw() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return deepMerge(structuredClone(SETTINGS), parsed);
      }
    } catch (e) { console.warn("settings load failed", e); }
    return structuredClone(SETTINGS);
  }

  function deepMerge(base, over) {
    const out = { ...base };
    for (const k in over) {
      if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k]) && base[k] && typeof base[k] === "object") {
        out[k] = deepMerge(base[k], over[k]);
      } else out[k] = over[k];
    }
    return out;
  }

  /** 把外观相关设置应用到页面：主题 / 字号 / 密度 */
  function applyAppearance(s) {
    const d = document.documentElement;
    d.dataset.theme = s.appearance.theme === "light" ? "light" : "dark";
    d.dataset.fontSize = s.appearance.fontSize || "medium";
    d.dataset.density = s.general.density || "comfortable";
  }

  const SettingsService = {
    /** hydrate store; returns settings object */
    load() {
      const settings = loadRaw();
      JIGSAW.Store.set({ settings });
      applyAppearance(settings);
      return settings;
    },

    get() { return JIGSAW.Store.get().settings; },

    /** update(section, patch) → persists + notifies */
    update(section, patch) {
      const st = JIGSAW.Store.get();
      const next = deepMerge(st.settings, { [section]: patch });
      st.settings = next;
      JIGSAW.Store.notify("settings");
      applyAppearance(next);
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* storage unavailable */ }
    },

    reset() {
      const s = structuredClone(SETTINGS);
      JIGSAW.Store.get().settings = s;
      JIGSAW.Store.notify("settings");
      applyAppearance(s);
      try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* noop */ }
    }
  };

  JIGSAW.SettingsService = SettingsService;
})();
