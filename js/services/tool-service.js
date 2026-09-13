/* ============================================================
   JIGSAW — ToolService
   工具元数据缓存：从后端 /api/tools 拉一次，前端各处（工具广场、
   聊天气泡工具标签、工作流节点选工具）共用同一份数据。
   ============================================================ */
(function () {
  let cache = [];
  let enabled = true;   // 总开关：是否允许 AI 使用工具
  let permission = "allow";  // 权限级别：ask=始终询问 / auto=按需确认 / allow=全部允许
  let cwdProject = false;  // "进入项目工作"：shell 命令在自定义工作目录执行
  let cwdPath = "";        // 用户自定义工作目录（空 = 项目根目录）
  let projectRoot = "";    // 后端返回的项目根目录（显示用）
  let riskAck = false;     // 风险确认弹窗是否已勾选"不再提醒"（true=不再弹）
  // 工具调用统计：{ since, tz, calls:{工具名:次数}, lastUsed:{工具名:时间}, total }
  let stats = { since: "", tz: "", calls: {}, lastUsed: {}, total: 0 };
  let statsLoaded = false;  // 是否成功从后端拿到过统计（拿不到时界面要给明确提示）

  // 权限级别选项（工具广场选择器用，文案与 Claude Code 权限菜单一致）
  const PERMISSION_OPTIONS = [
    { id: "ask",   name: "始终询问", desc: "每次调用工具前都询问" },
    { id: "auto",  name: "按需确认", desc: "只针对有风险的操作进行询问" },
    { id: "allow", name: "全部允许", desc: "不受限制，直接执行" }
  ];

  const ToolService = {
    /** 从后端拉工具列表（含启用状态）与总开关，失败时保留旧缓存 */
    async load() {
      if (!JIGSAW.Http.isRemote()) return cache;   // 本地 mock 模式没有后端工具
      try {
        const data = await JIGSAW.Http.listTools();
        cache = data.tools || [];
        enabled = data.enabled !== false;
        permission = data.permission || "allow";
        riskAck = !!data.riskAck;
        cwdProject = !!data.cwdProject;
        cwdPath = data.cwdPath || "";
        projectRoot = data.projectRoot || "";
      } catch (e) {
        console.warn("拉取工具列表失败", e);
      }
      return cache;
    },

    list() { return cache; },

    /** 权限级别选项（工具广场选择器用） */
    permissionOptions() { return PERMISSION_OPTIONS; },

    /** 当前权限级别 */
    permission() { return permission; },

    /** 设置权限级别；成功后更新本地状态 */
    async setPermission(level) {
      const r = await JIGSAW.Http.setToolsPermission(level);
      if (r && r.ok) permission = level;
      return r;
    },

    /** 风险确认弹窗是否已勾选"不再提醒"（true = 风险操作直接执行、不再弹窗） */
    riskAck() { return riskAck; },

    /** 设置"不再提醒"；成功后更新本地状态（关闭勾选即恢复每次提醒） */
    async setRiskAck(v) {
      const r = await JIGSAW.Http.setRiskAck(v);
      if (r && r.ok) riskAck = !!r.riskAck;
      return r;
    },

    /* ============ 工具调用统计（设置 → 统计 / 工具详情页用） ============ */

    /** 当前缓存的统计快照 */
    stats() { return stats; },

    /** 是否成功拿到过统计（false = 后端没返回，通常是后端没重启/新接口未生效） */
    hasStats() { return statsLoaded; },

    /** 某个工具被调用的次数 */
    countOf(name) { return Number((stats.calls || {})[name] || 0); },

    /** 从后端拉一次统计；失败保留旧缓存 */
    async loadStats() {
      if (!JIGSAW.Http.isRemote()) return stats;
      try {
        const r = await JIGSAW.Http.stats();
        if (r && typeof r === "object") {
          stats = {
            since: r.since || "",
            tz: r.tz || "",
            calls: r.calls || {},
            lastUsed: r.lastUsed || {},
            total: Number(r.total || 0)
          };
          statsLoaded = true;
        }
      } catch (e) {
        console.warn("拉取调用统计失败", e);
      }
      return stats;
    },

    /** 重置统计（次数清零 + 起始时间改为当前时刻）；成功后刷新本地缓存 */
    async resetStats() {
      const r = await JIGSAW.Http.resetStats();
      if (r && r.ok) {
        stats = {
          since: r.since || "",
          tz: r.tz || "",
          calls: r.calls || {},
          lastUsed: r.lastUsed || {},
          total: Number(r.total || 0)
        };
        statsLoaded = true;
      }
      return r;
    },

    /**
     * 把 ISO 时间格式化成「YYYYMMDD HH:mm:ss 时区」，如 20260914 00:49:26 UTC+08:00
     * tzLabel 不传时用当前统计快照里的时区标签。
     */
    fmtTime(iso, tzLabel) {
      if (!iso) return "—";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      const p = n => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())} ` +
                    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      const tz = tzLabel === undefined ? (stats.tz || "") : (tzLabel || "");
      return tz ? stamp + " " + tz : stamp;
    },

    /** 统计起始时刻的展示文本 */
    sinceText() { return this.fmtTime(stats.since); },

    /** 总开关状态 */
    isEnabled() { return enabled; },

    /** 设置总开关；成功后更新本地状态 */
    async setEnabled(v) {
      const r = await JIGSAW.Http.setToolsEnabled(v);
      if (r && r.ok) enabled = v;
      return r;
    },

    /** 一键允许/禁用所有工具；成功后更新本地缓存 */
    async enableAll(v) {
      const r = await JIGSAW.Http.enableAllTools(v);
      if (r && r.ok) cache.forEach(t => { t.enabled = v; });
      return r;
    },

    /** "进入项目工作"开关状态 */
    isCwdProject() { return cwdProject; },

    /** 设置"进入项目工作"；成功后更新本地状态 */
    async setCwdProject(v) {
      const r = await JIGSAW.Http.setCwdProject(v);
      if (r && r.ok) cwdProject = v;
      return r;
    },

    /** 自定义工作目录（空 = 项目根目录） */
    cwdPath() { return cwdPath; },

    /** 当前工作目录显示文本：自定义目录或项目根 */
    cwdDisplay() { return cwdPath || projectRoot || ""; },

    /** 弹系统目录选择框（后端）；选中后自动开启并保存 */
    async pickCwdProject() {
      const r = await JIGSAW.Http.pickCwdProject();
      if (r && r.ok) {
        cwdProject = true;
        cwdPath = r.path || "";
      }
      return r;
    },

    /** 手动设置工作目录路径（不弹框） */
    async setCwdPath(path) {
      const r = await JIGSAW.Http.setCwdPath(path);
      if (r && r.ok) {
        cwdProject = true;
        cwdPath = path;
      }
      return r;
    },

    /** 项目根目录（后端返回，用于界面提示） */
    projectRoot() { return projectRoot; },

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
