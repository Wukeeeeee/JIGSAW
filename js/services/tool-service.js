/* ============================================================
   JIGSAW — ToolService
   工具元数据缓存：从后端 /api/tools 拉一次，前端各处（工具广场、
   聊天气泡工具标签、工作流节点选工具）共用同一份数据。
   ============================================================ */
(function () {
  let cache = [];
  let enabled = true;   // 总开关：是否允许 AI 使用工具

  const ToolService = {
    /** 从后端拉工具列表（含启用状态）与总开关，失败时保留旧缓存 */
    async load() {
      if (!JIGSAW.Http.isRemote()) return cache;   // 本地 mock 模式没有后端工具
      try {
        const data = await JIGSAW.Http.listTools();
        cache = data.tools || [];
        enabled = data.enabled !== false;
      } catch (e) {
        console.warn("拉取工具列表失败", e);
      }
      return cache;
    },

    list() { return cache; },

    /** 总开关状态 */
    isEnabled() { return enabled; },

    /** 设置总开关；成功后更新本地状态 */
    async setEnabled(v) {
      const r = await JIGSAW.Http.setToolsEnabled(v);
      if (r && r.ok) enabled = v;
      return r;
    },

    getMeta(name) { return cache.find(t => t.name === name) || null; },

    /** 切换开关；成功后更新本地缓存 */
    async toggle(name, enabled) {
      const r = await JIGSAW.Http.toggleTool(name, enabled);
      if (r && r.ok) {
        const t = this.getMeta(name);
        if (t) t.enabled = enabled;
      }
      return r;
    }
  };

  JIGSAW.ToolService = ToolService;
})();
