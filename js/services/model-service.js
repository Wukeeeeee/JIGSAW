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

  /**
   * 模型唯一性判据：接口地址 + 模型 ID。
   * 同 ID 不同地址（两家服务商都叫 deepseek-chat）是两个模型，要能并存；
   * 只有地址 + ID 都相同才算同一条，避免同步时一个模型变两条。
   */
  const modelKey = m => (m.baseUrl || "").trim().replace(/\/+$/, "").toLowerCase()
    + "::" + (m.modelId || "").trim();

  const ModelService = {
    /** built-in models only (fallback, never shown to the user) */
    builtin() { return MODELS; },

    /** user-defined custom models only — built-ins are reserved, not listed */
    list() {
      const custom = Store.get().settings.model.custom || [];
      // 去重兜底：老数据里可能因为 id 不一致存了同一模型的两份
      const seen = new Set();
      return custom.filter(m => {
        const k = modelKey(m);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).map(m => ({
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
      // 设置 → 模型 → 默认模型 优先（以前这一项设了根本不生效，新建会话用的是上一次选的）
      const dm = st.settings && st.settings.model ? st.settings.model.defaultModel : null;
      const d = this.byId(dm);
      if (d) return d;
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
          // 合并而非覆盖：后端有、本地没有 → 补进本地；
          // 本地独有的保留（可能是刚添加、还没同步到后端的）。
          // 判重用「接口地址 + 模型 ID」而不是 id —— 前端 id 是随机生成的，
          // 以前按 id 比对会让同一个模型在列表里出现两条。
          const byKey = new Map();
          local.forEach(m => byKey.set(modelKey(m), m));
          let changed = false;
          remote.forEach(m => {
            const key = modelKey(m);
            if (!byKey.has(key)) { byKey.set(key, { ...m, custom: true }); changed = true; }
          });
          if (changed) {
            JIGSAW.SettingsService.update("model", { custom: [...byKey.values()] });
          }
        })
        .catch(() => {});
    },

    _pushToServer(method, path, body) {
      // 模型同步独立于聊天数据源：有后端就写盘备份，没后端也不影响本地。
      // 但失败必须提示——否则用户以为存上了，实际只存在浏览器里，一清缓存就丢。
      JIGSAW.Http.request(path, { method, body })
        .catch(() => {
          if (JIGSAW.Toast) JIGSAW.Toast.show("模型已保存到本地，但后端同步失败（检查后端是否运行）");
        });
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
      // 带上前端生成的 id：后端沿用同一个 id，前后端就是同一条记录（同步时不会变两条）
      this._pushToServer("POST", "/api/models/custom", {
        id: rec.id,
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

    /** 按 id 取模型（用于界面显示；找不到返回 null，不再悄悄回退成第一个） */
    byId(id) {
      return id ? this.list().find(m => m.id === id) || null : null;
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
