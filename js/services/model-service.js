/* ============================================================
   JIGSAW — ModelService
   List / select models, including user-defined custom models
   (OpenAI-compatible endpoints). Swap internals for a real
   provider later — the UI only depends on this interface.
   ============================================================ */
(function () {
  const { MODELS } = JIGSAW.Mock;
  const Store = JIGSAW.Store;
  const uid = p => p + Math.random().toString(36).slice(2, 9);

  const ModelService = {
    /** built-in models only (fallback, never shown to the user) */
    builtin() { return MODELS; },

    /** user-defined custom models only — built-ins are reserved, not listed */
    list() {
      const custom = Store.get().settings.model.custom || [];
      return custom.map(m => ({
        id: m.id,
        name: m.name,
        desc: m.baseUrl || "OpenAI 兼容 · 自定义",
        model: m.modelId,
        custom: true,
        baseUrl: m.baseUrl,
        apiKey: m.apiKey
      }));
    },

    get(id) {
      const all = this.list();
      if (id) {
        const m = all.find(x => x.id === id);
        if (m) return m;
      }
      return all[0] || MODELS[0];
    },

    getActive() {
      const st = Store.get();
      return this.get(st.activeModelId);
    },

    setActive(id) {
      Store.set({ activeModelId: id });
      Store.notify("model");
    },

    /** model used by a given conversation */
    forConversation(convId) {
      const st = Store.get();
      const conv = st.conversations.find(c => c.id === convId);
      return this.get(conv ? conv.modelId : st.activeModelId);
    },

    /** populate a <select> with custom models; no models → disabled placeholder */
    populate(sel, selectedId) {
      const models = this.list();
      sel.innerHTML = "";
      if (!models.length) {
        const opt = document.createElement("option");
        opt.value = ""; opt.disabled = true; opt.selected = true;
        opt.textContent = "未配置模型 · 到设置添加";
        sel.appendChild(opt);
        sel.disabled = true;
        return;
      }
      sel.disabled = false;
      models.forEach(m => {
        const opt = document.createElement("option");
        opt.value = m.id;
        if (m.id === selectedId) opt.selected = true;
        opt.textContent = m.name;
        sel.appendChild(opt);
      });
    },

    /* ---- 自定义模型（OpenAI 兼容接口） ---- */

    /**
     * 后端同步（持久化）：模型同时写进后端文件（backend/data/models.json），
     * 清浏览器缓存 / 重开 App 都不丢。
     * - 启动时调用 syncFromServer()：本地没有模型而后端有 → 拉回来
     * - 增删改时 fire-and-forget 同步到后端
     */
    syncFromServer() {
      // 与“聊天数据源”解耦：无论 mock / remote 都尝试从后端拉模型，
      // 后端没开就静默跳过（catch）。清浏览器缓存后靠它恢复模型。
      return JIGSAW.Http.request("/api/models")
        .then(res => {
          const remote = (res.models || []).map(m => ({ ...m, custom: true }));
          if (!remote.length) return;
          const st = Store.get();
          const local = st.settings.model.custom || [];
          // 本地有 → 保留本地（后端是备份）；本地空 → 用后端恢复
          if (!local.length) {
            JIGSAW.SettingsService.update("model", { custom: remote });
          }
        })
        .catch(() => {});
    },

    _pushToServer(method, path, body) {
      // 模型同步独立于聊天数据源：有后端就写盘备份，没后端也不影响本地
      JIGSAW.Http.request(path, { method, body })
        .catch(() => {});
    },

    /** { name, modelId, baseUrl, apiKey } */
    addCustom(m) {
      const st = Store.get();
      const custom = (st.settings.model.custom || []).slice();
      const rec = {
        id: uid("cm"), name: m.name || m.modelId,
        modelId: m.modelId, baseUrl: m.baseUrl, apiKey: m.apiKey || "",
        createdAt: new Date().toISOString()
      };
      custom.push(rec);
      JIGSAW.SettingsService.update("model", { custom });
      this._pushToServer("POST", "/api/models/custom", {
        name: rec.name, modelId: rec.modelId, baseUrl: rec.baseUrl, apiKey: rec.apiKey
      });
      return rec;
    },

    /** 编辑已添加的自定义模型：按 id 合并 patch（名称/模型ID/BaseURL/APIKey） */
    updateCustom(id, patch) {
      const st = Store.get();
      const custom = (st.settings.model.custom || []).map(m =>
        m.id === id ? { ...m, ...patch } : m
      );
      JIGSAW.SettingsService.update("model", { custom });
      this._pushToServer("PUT", "/api/models/custom/" + encodeURIComponent(id), {
        name: patch.name, modelId: patch.modelId, baseUrl: patch.baseUrl, apiKey: patch.apiKey
      });
      return custom.find(m => m.id === id);
    },

    removeCustom(id) {
      const st = Store.get();
      const custom = (st.settings.model.custom || []).filter(m => m.id !== id);
      JIGSAW.SettingsService.update("model", { custom });
      this._pushToServer("DELETE", "/api/models/custom/" + encodeURIComponent(id), null);
      // 若当前激活的是被删模型，回退为未选择（选择器显示占位）
      if (st.activeModelId === id) {
        st.activeModelId = null;        Store.notify("model");
      }
    }
  };

  JIGSAW.ModelService = ModelService;
})();
