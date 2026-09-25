/* ============================================================
   JIGSAW — ImageService
   List / select AI image generation models (compatible with OpenAI /v1/images/generations)
   ============================================================ */
(function () {
  const Store = JIGSAW.Store;

  const ImageService = {
    /** 读取已配置且带有有效 API Key 的生图模型列表 */
    list() {
      const img = (Store.get().settings && Store.get().settings.image) || {};
      let models = (Array.isArray(img.models) ? img.models : [])
        .filter(m => m && m.modelId && m.apiKey && m.apiKey.trim());

      if (!models.length) {
        const k = (img.apiKey || "").trim();
        if (k) {
          models = [{
            id: "im-agnes",
            name: img.provider || "Agnes AI (Flash)",
            modelId: img.modelId || "agnes-image-2.5-flash",
            baseUrl: img.baseUrl || "https://apihub.agnes-ai.com/v1",
            apiKey: k,
            aspectRatio: img.aspectRatio || "16:9"
          }];
        }
      }

      return models.map(m => ({
        id: m.id || m.modelId,
        name: m.name || m.modelId,
        desc: m.modelId + (m.aspectRatio ? (" · " + m.aspectRatio) : ""),
        modelId: m.modelId,
        baseUrl: m.baseUrl,
        apiKey: m.apiKey,
        aspectRatio: m.aspectRatio || "1:1"
      }));
    },

    get(id) {
      const all = this.list();
      if (id) {
        const m = all.find(x => x.id === id || x.modelId === id);
        if (m) return m;
      }
      return this.getActive();
    },

    getActive() {
      const img = (Store.get().settings && Store.get().settings.image) || {};
      const all = this.list();
      const activeId = img.activeModelId;
      if (activeId) {
        const found = all.find(x => x.id === activeId || x.modelId === activeId);
        if (found) return found;
      }
      return all[0] || null;
    },

    setActive(id) {
      const st = Store.get();
      if (!st.settings) st.settings = {};
      if (!st.settings.image) st.settings.image = {};
      st.settings.image.activeModelId = id;

      const active = this.get(id);
      if (active) {
        st.settings.image.provider = active.name;
        st.settings.image.modelId = active.modelId;
        st.settings.image.baseUrl = active.baseUrl;
        st.settings.image.apiKey = active.apiKey;
        st.settings.image.aspectRatio = active.aspectRatio || "1:1";
      }

      if (JIGSAW.SettingsService) {
        JIGSAW.SettingsService.update("image", st.settings.image);
      }
      if (JIGSAW.Http && JIGSAW.Http.isRemote()) {
        JIGSAW.Http.request("/api/settings", {
          method: "PUT",
          body: { image: st.settings.image }
        }).catch(() => {});
      }
      Store.notify("settings");
      Store.notify("image-model");
    },

    async syncFromServer() {
      if (!JIGSAW.Http || !JIGSAW.Http.isRemote()) return;
      try {
        const res = await JIGSAW.Http.request("/api/settings");
        if (res && res.image) {
          const st = Store.get();
          if (!st.settings) st.settings = {};
          const local = st.settings.image || {};
          const merged = { ...local, ...res.image };
          // R7：后端脱敏返回空 apiKey → 保留本地已有真 Key，避免同步洗掉
          if (!merged.apiKey && local.apiKey) merged.apiKey = local.apiKey;
          if (Array.isArray(merged.models)) {
            const localById = {};
            (local.models || []).forEach(m => { if (m && m.id) localById[m.id] = m; });
            merged.models.forEach(m => {
              if (m && !m.apiKey && localById[m.id] && localById[m.id].apiKey) {
                m.apiKey = localById[m.id].apiKey;
              }
            });
          }
          st.settings.image = merged;
          Store.notify("settings");
          Store.notify("image-model");
        }
      } catch (e) {}
    }
  };

  JIGSAW.ImageService = ImageService;
})();
