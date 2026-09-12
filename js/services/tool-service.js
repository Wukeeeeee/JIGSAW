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
