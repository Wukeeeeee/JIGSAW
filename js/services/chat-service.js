/* ============================================================
   JIGSAW — ChatService
   Conversations + messages. Mock: canned responses with
   streaming. Swap for a real LLM-backed implementation.
   ============================================================ */
(function () {
  const Store = JIGSAW.Store;
  const { pickCanned } = JIGSAW.Mock;
  const WorkflowService = JIGSAW.WorkflowService;

  const uid = p => p + Math.random().toString(36).slice(2, 9);
  const now = () => new Date().toISOString();

  function detectTemplate(text) {
    const s = text.toLowerCase();
    if (s.includes("gis") || s.includes("satellite") || s.includes("flood") || s.includes("map ")) return "gis";
    return "default";
  }

  const ChatService = {
    list() {
      return Store.get().conversations.slice()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },

    get(id) { return Store.get().conversations.find(c => c.id === id) || null; },

    create({ title, text, modelId }) {
      const convId = uid("c");
      const template = detectTemplate(text);
      const conv = {
        id: convId, title: title || text.slice(0, 48) || "New chat",
        modelId: modelId || Store.get().activeModelId,
        createdAt: now(), messages: [],
        workflowTemplate: template, workflowExecuted: false
      };
      Store.get().conversations.push(conv);
      WorkflowService.getForConversation(convId); // materialize workflow
      Store.set({ activeConversationId: convId });
      Store.notify("conversations");
      if (text && text.trim()) {
        this.send(convId, text);
      }
      return conv;
    },

    remove(id) {
      const st = Store.get();
      st.conversations = st.conversations.filter(c => c.id !== id);
      delete st.workflows["wf-" + id];
      if (st.activeConversationId === id) st.activeConversationId = null;
      Store.notify("conversations");
      Store.notify("workflows");
    },

    rename(id, title) {
      const conv = this.get(id);
      if (!conv) return;
      conv.title = title;
      Store.notify("conversations");
    },

    touch(id) {
      const conv = this.get(id);
      if (conv) { conv.createdAt = now(); Store.notify("conversations"); }
    },

    /**
     * ============ 消息队列（类似 Grok）：一次只发一条，多发的排队依次执行 ============
     * 正在回复时再发消息，不会并行：进队列等当前这条完成后自动接着发。
     */
    _busy: false,
    _queue: [],        // [{ convId, text, opts }]
    _startedAt: null,  // 当前正在处理这条的开始时间（毫秒）

    /** 队列状态：busy=正在回复；pending=还有几条排队；startedAt=当前这条开始时间 */
    queueInfo() {
      return { busy: this._busy, pending: this._queue.length, startedAt: this._startedAt };
    },

    _syncQueue() { Store.notify("queue"); },

    _shift() {
      // 当前空闲且队列里有消息 → 取出下一条发送
      if (this._busy || !this._queue.length) { this._syncQueue(); return; }
      const next = this._queue.shift();
      this._doSend(next.convId, next.text, next.opts);
    },

    /**
     * send(convId, text, { onDone }) → 发送一条消息
     * 正在回复时调用 → 自动排队（返回 null），完成后接着发，绝不并行。
     */
    send(convId, text, opts) {
      if (this._busy) {
        this._queue.push({ convId, text, opts });
        this._syncQueue();
        return null;
      }
      return this._doSend(convId, text, opts);
    },

    _doSend(convId, text, opts) {
      const conv = this.get(convId);
      if (!conv) return null;
      this._busy = true;
      this._startedAt = Date.now();

      // 当前会话用的模型对象（设置 → 模型 里添加的自定义模型）
      const model = JIGSAW.ModelService.forConversation(convId);
      const modelId = model.id;

      // ① 把"你输入的文字"记进这个会话的消息列表（前端本地记录）
      const userMsg = { id: uid("m"), role: "user", text, modelId, status: "done", createdAt: now() };
      conv.messages.push(userMsg);
      this.touch(convId);
      Store.notify("messages");

      // 先占一个"正在回复"的空位，后面流式填充
      const asstMsg = { id: uid("m"), role: "assistant", text: "", full: "", modelId, status: "streaming", createdAt: now() };
      conv.messages.push(asstMsg);
      Store.notify("messages");

      // 本条完成后：回调 → 释放 busy → 接着发下一条排队消息
      const done = (asstMsg) => {
        if (opts && opts.onDone) opts.onDone(asstMsg);
        this._busy = false;
        this._startedAt = null;
        this._syncQueue();
        this._shift();
      };

      // ③ 拿到回复全文后，逐字显示（模拟打字效果，不是真流式）
      const stream = (full) => {
        asstMsg.full = full;
        const speed = Store.get().settings.workflow.executionSpeed;
        const msPerChunk = speed === "slow" ? 34 : speed === "fast" ? 10 : 18;
        const chunk = speed === "slow" ? 2 : 4;
        let pos = 0;
        const timer = setInterval(() => {
          pos = Math.min(full.length, pos + chunk);
          asstMsg.text = full.slice(0, pos);
          Store.notify("messages");
          if (pos >= full.length) {
            clearInterval(timer);
            asstMsg.status = "done";
            Store.notify("messages");
            done(asstMsg);
          }
        }, msPerChunk);
      };

      // ② 决定回复从哪来
      if (JIGSAW.Http.isRemote()) {
        // ===== 数据源 = 后端 API =====
        // Http.chat(convId, text) 会做这样一件事（信使）：
        //   fetch("http://127.0.0.1:8000/api/chat/messages", {
        //     method: "POST",
        //     body: JSON.stringify({ conversation_id: convId, message: text })
        //   })
        // 也就是把你输入的文字打包成 JSON，寄给 FastAPI 后端。
        // 后端算好回复后返回 { reply: "..." }，这里拿到的是 res.reply。
        JIGSAW.Http.chat(convId, text, model)
          .then(res => stream(res.reply || "（后端未返回内容）"))
          .catch(err => {
            // 后端连不上 / 报错时，显示错误提示，不崩溃
            asstMsg.status = "done";
            asstMsg.text = asstMsg.full = "请求后端失败：" + err.message + "（可在设置 → API 中检查接口地址或数据源）";
            Store.notify("messages");
            done(asstMsg);
          });
      } else {
        // ===== 数据源 = 本地 Mock =====
        // 不联网，前端直接从预置回复里挑一段
        stream(pickCanned(text));
      }

      return asstMsg;
    },

    /** re-run the last user message (regenerate) */
    regenerate(convId) {
      const conv = this.get(convId);
      if (!conv) return;
      const lastUser = [...conv.messages].reverse().find(m => m.role === "user");
      if (!lastUser) return;
      // remove trailing assistant messages
      while (conv.messages.length && conv.messages[conv.messages.length - 1].role === "assistant") conv.messages.pop();
      this.send(convId, lastUser.text);
    },

    /** wipe history of a conversation */
    clear(convId) {
      const conv = this.get(convId);
      if (conv) { conv.messages = []; Store.notify("messages"); }
    }
  };

  JIGSAW.ChatService = ChatService;
})();
