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
      headers: { "Content-Type": "application/json" },
      cache: "no-store"
    };
    // ★ 打包：把要传的数据（对象）变成"文字"（JSON 字符串）
    //   比如 {conversation_id:"c-tokyo", message:"你好"} → {"conversation_id":"c-tokyo","message":"你好"}
    //   两个程序之间只能传文字，所以必须先把对象变成文字
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
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
     * chat(conversationId, message, model) → 把聊天文字寄给后端
     * 等于寄一封信到  http://127.0.0.1:8000/api/chat/messages
     * 信的内容：{ conversation_id: 哪个会话, message: 你输入的文字, model: 设置里选的模型 }
     * 后端回信：{ reply: "AI 回复的文字" }
     *
     * model 是可选参数，结构：{ model: 模型名, baseUrl: 接口地址, apiKey: 密钥 }
     * 它来自设置 → 模型 里你添加的自定义模型。后端收到后用它来调 AI。
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
      return request("/api/chat/messages", { method: "POST", body });
    },

    /** GET /api/health → { status }：测试后端是否活着 */
    health() {
      return request("/api/health", { timeout: 5000 });
    }
  };

  JIGSAW.Http = Http;
})();
