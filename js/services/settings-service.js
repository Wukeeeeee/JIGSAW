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

  const SettingsService = {
    /** hydrate store; returns settings object */
    load() {
      const settings = loadRaw();
      JIGSAW.Store.set({ settings });
      document.documentElement.dataset.theme = settings.appearance.theme === "light" ? "light" : "dark";
      return settings;
    },

    get() { return JIGSAW.Store.get().settings; },

    /** update(section, patch) → persists + notifies */
    update(section, patch) {
      const st = JIGSAW.Store.get();
      const next = deepMerge(st.settings, { [section]: patch });
      st.settings = next;
      JIGSAW.Store.notify("settings");
      if (section === "appearance" && patch.theme) {
        document.documentElement.dataset.theme = patch.theme === "light" ? "light" : "dark";
      }
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* storage unavailable */ }
    },

    reset() {
      const s = structuredClone(SETTINGS);
      JIGSAW.Store.get().settings = s;
      JIGSAW.Store.notify("settings");
      try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* noop */ }
    }
  };

  JIGSAW.SettingsService = SettingsService;
})();
