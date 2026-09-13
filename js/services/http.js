/* ============================================================
   JIGSAW — Http (HTTP client for the FastAPI backend)
   Frontend talks to the backend only when Settings → API →
   数据源 = 后端 API. Base URL comes from settings.api.baseUrl.
   ============================================================ */
(function () {
  const Store = JIGSAW.Store;

  function apiSettings() {
    return Store.get().settings.api || {};
  }

  function base() {
    return (apiSettings().baseUrl || "http://127.0.0.1:8000").replace(/\/+$/, "");
  }

  function isRemote() {
    return apiSettings().mode === "remote";
  }

  async function request(path, opts) {
    opts = opts || {};   // 允许只传路径的 GET（如拉取模型列表）
    const init = {
      method: opts.method || "GET",
      cache: "no-store"
    };
    // ★ 打包：把要传的数据（对象）变成"文字"（JSON 字符串）
    //   比如 {conversation_id:"c-tokyo", message:"你好"} → {"conversation_id":"c-tokyo","message":"你好"}
    //   两个程序之间只能传文字，所以必须先把对象变成文字
    //   FormData（文件上传）例外：不设 Content-Type（浏览器自动带 boundary），body 原样传
    if (opts.body !== undefined) {
      if (typeof FormData !== "undefined" && opts.body instanceof FormData) {
        init.body = opts.body;
      } else {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(opts.body);
      }
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (opts.timeout || 12000));
    init.signal = ctrl.signal;
    try {
      // ★ 寄信：fetch = 浏览器把"信"寄到后端地址
      //   base() = 后端地址（http://127.0.0.1:8000）
      //   path   = 后端哪个信箱（/api/chat/messages）
      const res = await fetch(base() + path, init);
      clearTimeout(timer);
      // ★ 拆回信：后端返回的也是文字，再变回对象（data）
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data && (data.detail || data.message)) || ("HTTP " + res.status);
        throw new Error(msg);
      }
      return data;
    } catch (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") throw new Error("请求超时");
      throw e;
    }
  }

  const Http = {
    base, isRemote, request,

    /**
     * chat(conversationId, message, model) → 创建异步聊天任务
     * 寄一封信到  http://127.0.0.1:8000/api/chat/messages
     * 后端立即回信 { task_id }（不等 AI 算完），然后前端轮询 getTask()。
     */
    chat(conversationId, message, model) {
      const body = { conversation_id: conversationId, message };
      if (model && model.model) {
        body.model = {
          model: model.model,          // 模型名，如 "gpt-4o"
          baseUrl: model.baseUrl || "", // OpenAI 兼容接口地址
          apiKey: model.apiKey || ""    // 密钥
        };
      }
      // 采样温度：来自 设置 → 模型 → 采样温度，随消息一起发给后端
      const temp = Store.get().settings.model.temperature;
      if (typeof temp === "number") body.temperature = temp;
      // 只等后端创建任务（毫秒级），不等 AI 处理；AI 结果靠轮询拿
      return request("/api/chat/messages", { method: "POST", body, timeout: 15000 });
    },

    /** GET /api/chat/tasks/{taskId} → 任务状态（排队/处理中/完成+回复/实时工具调用） */
    getTask(taskId) {
      return request("/api/chat/tasks/" + encodeURIComponent(taskId), { timeout: 10000 });
    },

    /** POST /api/chat/tasks/{taskId}/answer → 回答 AskUser 的问题，唤醒任务 */
    answerTask(taskId, answer, noMore) {
      const body = { answer };
      if (noMore) body.noMore = true;   // 风险确认弹窗勾了"不再提醒"
      return request("/api/chat/tasks/" + encodeURIComponent(taskId) + "/answer", {
        method: "POST", body
      });
    },

    /** POST /api/chat/tasks/{taskId}/cancel → 终止任务（排队/处理中都可） */
    cancelTask(taskId) {
      return request("/api/chat/tasks/" + encodeURIComponent(taskId) + "/cancel", {
        method: "POST", body: {}
      });
    },

    /** GET /api/chat/tasks → 所有排队中/处理中的任务（队列面板用） */
    listTasks() {
      return request("/api/chat/tasks", { method: "GET" }).then(r => (r && r.tasks) || []);
    },

    /** GET /api/health → { status }：测试后端是否活着 */
    health() {
      return request("/api/health", { timeout: 5000 });
    },

    /** GET /api/chat/conversations → 从后端拉全部会话（含消息） */
    listConversations() {
      return request("/api/chat/conversations");
    },

    /** DELETE /api/chat/conversations/{id} → 删除会话（历史记录） */
    deleteConversation(id) {
      return request("/api/chat/conversations/" + encodeURIComponent(id), { method: "DELETE", timeout: 10000 });
    },

    /** GET /api/tools → 从后端拉全部工具（含启用状态），工具广场用 */
    listTools() {
      return request("/api/tools");
    },

    /** POST /api/tools/enabled → 总开关：允许/不允许 AI 使用任何工具 */
    setToolsEnabled(enabled) {
      return request("/api/tools/enabled", { method: "POST", body: { enabled } });
    },

    enableAllTools(enabled) {
      return request("/api/tools/enable-all", { method: "POST", body: { enabled } });
    },

    setToolsPermission(level) {
      return request("/api/tools/permission", { method: "POST", body: { level } });
    },

    /** POST /api/tools/risk-ack → "不再提醒"开关：true=风险操作不再弹窗，false=恢复提醒 */
    setRiskAck(enabled) {
      return request("/api/tools/risk-ack", { method: "POST", body: { enabled } });
    },

    /** POST /api/tools/cwd-project → "进入项目工作"开关（shell 命令在自定义工作目录执行） */
    setCwdProject(enabled) {
      return request("/api/tools/cwd-project", { method: "POST", body: { enabled } });
    },

    /** POST /api/tools/cwd-pick → 后端弹系统目录选择框；选中即保存并开启 */
    pickCwdProject() {
      return request("/api/tools/cwd-pick", { method: "POST", body: {}, timeout: 300000 });
    },

    /** POST /api/tools/cwd-path → 手动设置工作目录路径 */
    setCwdPath(path) {
      return request("/api/tools/cwd-path", { method: "POST", body: { path }, timeout: 15000 });
    },

    /** POST /api/tools/{name}/toggle → 切换工具启用/禁用 */
    toggleTool(name, enabled) {
      return request("/api/tools/" + encodeURIComponent(name) + "/toggle", { method: "POST", body: { enabled } });
    },

    /** GET /api/stats → 工具调用统计（起始时刻 / 各工具次数 / 最近一次） */
    stats() {
      return request("/api/stats");
    },

    /** POST /api/stats/reset → 重置统计（次数清零，起始时间改为当前时刻） */
    resetStats() {
      return request("/api/stats/reset", { method: "POST", body: {} });
    },

    /* ============ 知识库（本地文件系统 CRUD） ============ */
    kbTree() {
      return request("/api/knowledge/tree");
    },
    kbCreateFolder(name) {
      return request("/api/knowledge/folder", { method: "POST", body: { name } });
    },
    kbRenameFolder(name, newName) {
      return request("/api/knowledge/folder", { method: "PUT", body: { name, newName } });
    },
    kbDeleteFolder(folder) {
      return request("/api/knowledge/folder?folder=" + encodeURIComponent(folder), { method: "DELETE" });
    },
    kbCreateDoc(folder, name, content) {
      return request("/api/knowledge/doc", { method: "POST", body: { folder, name, content: content || "" } });
    },
    kbReadDoc(folder, name) {
      return request("/api/knowledge/doc?folder=" + encodeURIComponent(folder) + "&name=" + encodeURIComponent(name));
    },
    kbSaveDoc(folder, name, content) {
      return request("/api/knowledge/doc", { method: "PUT", body: { folder, name, content: content || "" } });
    },
    kbRenameDoc(folder, name, newName) {
      return request("/api/knowledge/doc/rename", { method: "PUT", body: { folder, name, newName } });
    },
    kbDeleteDoc(folder, name) {
      return request("/api/knowledge/doc?folder=" + encodeURIComponent(folder) + "&name=" + encodeURIComponent(name), { method: "DELETE" });
    },
    kbRoot() {
      return request("/api/knowledge/root");
    },
    kbPickRoot() {
      return request("/api/knowledge/root/pick", { method: "POST", body: {}, timeout: 300000 });
    },
    kbUpload(folder, file) {
      const fd = new FormData();
      fd.append("file", file);
      return request("/api/knowledge/upload?folder=" + encodeURIComponent(folder), { method: "POST", body: fd, timeout: 300000 });
    }
  };

  JIGSAW.Http = Http;
})();
