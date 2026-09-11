/* ============================================================
   JIGSAW — Chat view
   ============================================================ */
(function () {
  const { h, el, els, Icons, Markdown } = JIGSAW;
  const Store = JIGSAW.Store;

  let container = null;
  let convId = null;
  let bodyEl = null;
  let scrollEl = null;
  let inputTa = null;
  let msgEls = new Map(); // msgId -> element
  let unsubs = [];

  const uid = p => p + Math.random().toString(36).slice(2, 8);

  function timeLabel(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function scrollToBottom(force) {
    if (!scrollEl) return;
    const nearBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120;
    if (force || nearBottom) scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  /** 工具标签行：AI 这轮用过哪些工具（图标 + 名称） */
  function buildToolsRow(toolsUsed) {
    return h("div", { class: "msg-tools" },
      (toolsUsed || []).map(name => {
        const meta = JIGSAW.ToolService.getMeta(name);
        return h("span", { class: "msg-tool-tag" },
          Icons.icon((meta && meta.icon) || "tool", 11),
          h("span", null, (meta && meta.label) || name)
        );
      })
    );
  }

  function messageEl(msg, conv) {
    const isUser = msg.role === "user";
    const model = JIGSAW.ModelService.get(msg.modelId);
    const wrap = h("div", { class: "msg " + (isUser ? "msg-user" : "msg-assistant") + (msg.status === "streaming" ? " msg-sending" : ""), "data-mid": msg.id },
      h("div", { class: "msg-avatar" }, Icons.icon(isUser ? "user" : "jigsaw", 14)),
      h("div", { class: "msg-content" },
        h("div", { class: "msg-meta" },
          h("span", { class: "who" }, isUser ? "你" : "JIGSAW"),
          JIGSAW.Store.get().settings.appearance.showTimestamps ? h("span", { class: "time" }, timeLabel(msg.createdAt)) : null,
          h("span", { class: "model-tag" }, model ? model.name : "")
        ),
        isUser || !(msg.toolsUsed && msg.toolsUsed.length) ? null : buildToolsRow(msg.toolsUsed),
        h("div", { class: "msg-bubble" }, msg.text ? Markdown.render(msg.text) : (msg.status === "streaming" ? "" : "")),
        h("div", { class: "msg-actions" },
          h("button", { class: "icon-btn icon-btn-sm", "data-act": "copy", title: "复制" }, Icons.icon("copy", 13)),
          isUser ? null : h("button", { class: "icon-btn icon-btn-sm", "data-act": "regenerate", title: "重新生成" }, Icons.icon("refresh", 13))
        )
      )
    );

    if (!isUser) {
      const caret = h("span", { class: "caret" });
      const bubble = el(".msg-bubble", wrap);
      if (msg.status === "streaming") bubble.appendChild(caret);
    }

    const actions = els(".msg-actions [data-act]", wrap);
    actions.forEach(btn => {
      btn.addEventListener("click", () => {
        const act = btn.dataset.act;
        if (act === "copy") {
          navigator.clipboard.writeText(msg.text || msg.full || "").then(() => JIGSAW.Toast.show("已复制到剪贴板"));
        } else if (act === "regenerate") {
          JIGSAW.ChatService.regenerate(convId);
        }
      });
    });
    return wrap;
  }

  function syncMessages(conv, forceRebuild) {
    if (!bodyEl) return;
    const list = el(".chat-scroll", bodyEl);
    const messages = conv.messages;
    const seen = new Set();

    // update / create
    messages.forEach(msg => {
      seen.add(msg.id);
      let node = msgEls.get(msg.id);
      if (!node || !node.isConnected || forceRebuild) {
        if (node) { node.remove(); }
        node = messageEl(msg, conv);
        msgEls.set(msg.id, node);
        list.appendChild(node);
        scrollToBottom(true);
      } else {
        // live-update streaming bubble（每次更新都重渲染内容，done 后光标自然消失）
        const bubble = el(".msg-bubble", node);
        const isStream = msg.status === "streaming";
        bubble.innerHTML = msg.text ? Markdown.render(msg.text) : "";
        if (isStream) bubble.appendChild(h("span", { class: "caret" }));
        node.classList.toggle("msg-sending", isStream);
        // tools tag：流式开始时 toolsUsed 才就位，此时补上标签行
        const hasTools = msg.toolsUsed && msg.toolsUsed.length;
        let tagRow = el(".msg-tools", node);
        if (hasTools && !tagRow) { bubble.before(buildToolsRow(msg.toolsUsed)); }
        else if (!hasTools && tagRow) { tagRow.remove(); }
        // model tag update
        const tag = el(".model-tag", node);
        if (tag) tag.textContent = (JIGSAW.ModelService.get(msg.modelId) || {}).name || "";
      }
    });

    // remove stale
    msgEls.forEach((node, id) => {
      if (!seen.has(id)) { node.remove(); msgEls.delete(id); }
    });

    scrollToBottom(false);
  }

  function renderHeader(conv) {
    const header = el(".chat-header", container);
    header.innerHTML = "";
    header.append(
      h("button", { class: "icon-btn", "data-history": "1", title: "历史记录" }, Icons.icon("menu")),
      h("div", { class: "topbar-title", style: { flex: "1", textAlign: "center" } }, conv ? conv.title : ""),
      h("div", { class: "topbar-spacer" }),
      h("div", { class: "topbar", style: { border: "none", padding: "0" } },
        h("button", { class: "btn btn-sm", "data-wf": "1" }, Icons.icon("branch", 13), "工作流"),
        h("button", { class: "btn btn-sm", "data-tools": "1" }, Icons.icon("tool", 13), "工具"),
        h("button", { class: "icon-btn", "data-settings": "1", title: "设置" }, Icons.icon("sliders"))
      )
    );
    el("[data-history]", header).addEventListener("click", () => JIGSAW.HistoryDrawer.toggle());
    el("[data-wf]", header).addEventListener("click", () => JIGSAW.Router.navigate("/chat/" + convId + "/workflow"));
    el("[data-tools]", header).addEventListener("click", () => JIGSAW.Router.navigate("/tools"));
    el("[data-settings]", header).addEventListener("click", () => JIGSAW.Router.navigate("/settings"));
  }

  function renderInput(conv) {
    const bar = el(".chat-input-bar", container);
    bar.innerHTML = "";
    const activeId = conv ? conv.modelId : JIGSAW.ModelService.getActive().id;

    // 自绘直角下拉（原生 select 的弹出面板是圆角的，改不了，已替换）
    // 传“函数”而非数组：每次打开下拉都读取最新模型列表
    // 宽度随选中文字自适应，右缘贴紧发送按钮
    const sel = JIGSAW.Dropdown.create(() => JIGSAW.ModelService.list(), activeId, id => {
      if (conv) { conv.modelId = id; Store.notify("conversations"); }
      else JIGSAW.ModelService.setActive(id);
    });

    // ===================== 聊天输入框 =====================
    // ta 就是页面上的输入框。你打的每一个字，浏览器都存在 ta.value 里。
    const ta = h("textarea", { rows: "1", placeholder: "给 JIGSAW 发消息…" });
    const sendBtn = h("button", { class: "send-btn", "data-send": "1", title: "发送" }, Icons.icon("arrowUp", 16));

    const box = h("div", { class: "chat-input-box" },
      ta,
      h("div", { class: "chat-input-actions" }, sel, sendBtn)
    );

    // 队列状态框：正在回复时显示“正在回复 · 开始时间 · 还有 N 条排队”
    const queueEl = h("span", { class: "chat-queue hidden", "data-queue": "1" });

    const tools = h("div", { class: "chat-tools" },
      h("button", { class: "icon-btn icon-btn-sm", "data-new": "1", title: "新建对话" }, Icons.icon("plus-sm", 13)),
      queueEl,
      h("span", { style: { fontSize: "11px", color: "var(--text-4)", fontFamily: "var(--font-mono)" } }, "Enter 发送 · Shift+Enter 换行")
    );

    bar.append(h("div", { class: "chat-input-inner" }, box, tools));
    inputTa = ta;

    const autosize = () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(160, Math.max(24, ta.scrollHeight)) + "px";
    };
    ta.addEventListener("input", autosize);
    ta.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {   // 按回车（不按 Shift）= 发送
        e.preventDefault();
        const v = ta.value.trim();              // ★★★ 你输入的文字，就在这里被取到 ★★★
        if (!v) return;                         // 空内容不发送
        ta.value = ""; autosize();              // 清空输入框
        JIGSAW.ChatService.send(convId, v);     // ★★★ 把文字交给 ChatService 去发送 ★★★
      }
    });
    sendBtn.addEventListener("click", () => {   // 点发送按钮 = 和按回车走同一段路
      const v = ta.value.trim();                // 取输入框里的文字
      if (!v) return;
      ta.value = ""; autosize();
      JIGSAW.ChatService.send(convId, v);       // 交给 ChatService
    });
    el("[data-new]", tools).addEventListener("click", () => JIGSAW.Router.navigate("/"));

    setTimeout(() => ta.focus(), 30);
  }

  // 渲染队列状态框：空闲隐藏；回复中显示开始时间；有排队时显示条数
  function renderQueueStatus() {
    const qEl = el("[data-queue]", container);
    if (!qEl) return;
    const q = JIGSAW.ChatService.queueInfo();
    if (!q.busy) { qEl.classList.add("hidden"); qEl.textContent = ""; return; }
    const t = q.startedAt ? new Date(q.startedAt) : null;
    const time = t
      ? String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0")
      : "";
    const pending = q.pending > 0 ? " · 还有 " + q.pending + " 条排队" : "";
    qEl.textContent = "正在回复 · " + time + pending;
    qEl.classList.remove("hidden");
  }

  const Chat = {
    mount(root, params) {
      container = root;
      convId = params.id;
      // 工具缓存可能因后端当时未启动而为空（气泡工具标签退化成英文名+扳手图标）
      // → 每次进入聊天页静默补拉一次，让图标和中文名自愈
      if (JIGSAW.Http.isRemote() && JIGSAW.ToolService.list().length === 0) {
        JIGSAW.ToolService.load();
      }
      const conv = JIGSAW.ChatService.get(convId);
      if (!conv) { JIGSAW.Router.navigate("/"); return; }
      Store.set({ activeConversationId: convId });

      root.innerHTML = "";
      JIGSAW.setViewClass(root, "view-chat");
      const header = h("div", { class: "topbar chat-header" });
      bodyEl = h("div", { class: "chat-body" });
      scrollEl = bodyEl;
      const inputBar = h("div", { class: "chat-input-bar" });
      root.append(header, bodyEl, inputBar);

      renderHeader(conv);
      renderInput(conv);

      // initial messages
      const list = h("div", { class: "chat-scroll" });
      bodyEl.appendChild(list);
      msgEls = new Map();
      conv.messages.forEach(m => {
        const node = messageEl(m, conv);
        msgEls.set(m.id, node);
        list.appendChild(node);
      });
      scrollToBottom(true);

      unsubs = [
        Store.subscribe("messages", () => {
          const c = JIGSAW.ChatService.get(convId);
          if (c) syncMessages(c, false);
        }),
        Store.subscribe("conversations", () => {
          const c = JIGSAW.ChatService.get(convId);
          if (c) { renderHeader(c); }
        }),
        Store.subscribe("model", () => {
          const c = JIGSAW.ChatService.get(convId);
          if (c) renderInput(c);
        }),
        Store.subscribe("queue", () => renderQueueStatus())
      ];
    },

    unmount() {
      unsubs.forEach(u => u());
      unsubs = [];
      msgEls = new Map();
    }
  };

  JIGSAW.Views = JIGSAW.Views || {};
  JIGSAW.Views.Chat = Chat;
})();
