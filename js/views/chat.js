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

  function buildThoughtEl(msg) {
    const hasThinking = !!(msg.thinkingText || (msg.steps && msg.steps.length) || msg.thinkingStatus === "running");
    if (!hasThinking) return null;

    const isRunning = msg.thinkingStatus === "running" || (msg.status === "streaming" && !msg.text);
    const wrap = h("div", { class: "msg-thought" + (isRunning ? " is-running" : " is-done") });

    const icon = isRunning
      ? h("span", { class: "msg-thought-spinner" }, Icons.icon("sparkles", 13))
      : h("span", { style: { color: "var(--success, #10b981)" } }, Icons.icon("check", 13));

    const titleText = msg.thinkingText || (isRunning ? "多 Agent 协同调度执行中…" : "多 Agent 协同任务已完成");

    const badge = h("span", {
      class: "msg-thought-badge " + (isRunning ? "badge-running" : "badge-done")
    }, isRunning ? "协同运行中" : "已完成");

    const header = h("div", { class: "msg-thought-header" },
      h("div", { class: "msg-thought-left" },
        icon,
        h("span", { class: "text" }, titleText)
      ),
      h("div", { class: "msg-thought-right" }, badge)
    );
    wrap.appendChild(header);

    if (msg.steps && msg.steps.length > 0) {
      const stepsWrap = h("div", { class: "msg-thought-steps" });
      msg.steps.forEach(st => {
        const isStepRunning = st.status === "running";
        const isStepErr = st.status === "error";
        const stBadge = h("span", {
          class: "msg-thought-badge " + (isStepRunning ? "badge-running" : (isStepErr ? "badge-error" : "badge-done"))
        }, isStepRunning ? "执行中" : (isStepErr ? "异常" : "完成"));

        const summary = (st.args && (st.args.摘要 || st.args.类型 || st.args.判定 || st.args.状态)) || "";
        const stepRow = h("div", { class: "msg-thought-step" },
          h("div", { class: "msg-thought-step-left" },
            Icons.icon("agent", 12),
            h("span", { class: "msg-thought-step-name" }, st.name),
            summary ? h("span", { class: "msg-thought-step-desc" }, `· ${summary}`) : null
          ),
          h("div", { class: "msg-thought-step-right" }, stBadge)
        );
        stepsWrap.appendChild(stepRow);
      });
      wrap.appendChild(stepsWrap);
    }

    return wrap;
  }

  function messageEl(msg, conv) {
    const isUser = msg.role === "user";
    // 用 byId：模型被删掉后不再"张冠李戴"显示成列表里第一个模型
    const model = JIGSAW.ModelService.byId(msg.modelId);
    const thoughtEl = !isUser ? buildThoughtEl(msg) : null;
    const wrap = h("div", { class: "msg " + (isUser ? "msg-user" : "msg-assistant") + (msg.status === "streaming" ? " msg-sending" : ""), "data-mid": msg.id },
      h("div", { class: "msg-avatar" }, Icons.icon(isUser ? "user" : "jigsaw", 14)),
      h("div", { class: "msg-content" },
        h("div", { class: "msg-meta" },
          h("span", { class: "who" }, isUser ? "你" : "JIGSAW"),
          JIGSAW.Store.get().settings.appearance.showTimestamps ? h("span", { class: "time" }, timeLabel(msg.createdAt)) : null,
          h("span", { class: "model-tag" }, model ? model.name : "")
        ),
        isUser || !(msg.toolsUsed && msg.toolsUsed.length) ? null : buildToolsRow(msg.toolsUsed),
        thoughtEl,
        h("div", { class: "msg-bubble" }, msg.text ? Markdown.render(msg.text) : (msg.status === "streaming" ? "" : "")),
        h("div", { class: "msg-actions" },
          h("button", { class: "icon-btn icon-btn-sm", "data-act": "copy", title: "复制" }, Icons.icon("copy", 13)),
          isUser ? null : h("button", { class: "icon-btn icon-btn-sm", "data-act": "regenerate", title: "重新生成" }, Icons.icon("refresh", 13)),
          (isUser || msg.status !== "streaming") ? null : h("button", { class: "icon-btn icon-btn-sm msg-cancel", "data-act": "cancel", title: "终止此任务" }, Icons.icon("x", 13))
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
        } else if (act === "cancel") {
          JIGSAW.ChatService.cancel(convId);
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
        const isUser = msg.role === "user";
        // live-update streaming bubble（每次更新都重渲染内容，done 后光标自然消失）
        const bubble = el(".msg-bubble", node);
        const isStream = msg.status === "streaming";
        bubble.innerHTML = msg.text ? Markdown.render(msg.text) : "";
        if (isStream) bubble.appendChild(h("span", { class: "caret" }));
        node.classList.toggle("msg-sending", isStream);

        // thought panel update (实时动态更新多 Agent 执行与思考卡片)
        let thoughtNode = el(".msg-thought", node);
        const newThought = !isUser ? buildThoughtEl(msg) : null;
        if (newThought) {
          if (thoughtNode) {
            thoughtNode.replaceWith(newThought);
          } else {
            bubble.before(newThought);
          }
        } else if (thoughtNode) {
          thoughtNode.remove();
        }

        // tools tag：流式开始时 toolsUsed 才就位，此时补上标签行
        const hasTools = msg.toolsUsed && msg.toolsUsed.length;
        let tagRow = el(".msg-tools", node);
        if (hasTools && !tagRow) { bubble.before(buildToolsRow(msg.toolsUsed)); }
        else if (!hasTools && tagRow) { tagRow.remove(); }
        // model tag update
        const tag = el(".model-tag", node);
        if (tag) tag.textContent = (JIGSAW.ModelService.byId(msg.modelId) || {}).name || "";
        // 终止按钮：streaming（排队/思考/等回答）时显示，完成/失败后移除
        let cancelBtn = el(".msg-cancel", node);
        if (isStream && !cancelBtn) {
          const cb = h("button", { class: "icon-btn icon-btn-sm msg-cancel", "data-act": "cancel", title: "终止此任务" }, Icons.icon("x", 13));
          const actions = el(".msg-actions", node);
          if (actions) { actions.appendChild(cb); cb.addEventListener("click", () => JIGSAW.ChatService.cancel(convId)); }
        } else if (!isStream && cancelBtn) {
          cancelBtn.remove();
        }
      }
    });

    // remove stale
    msgEls.forEach((node, id) => {
      if (!seen.has(id)) { node.remove(); msgEls.delete(id); }
    });

    scrollToBottom(false);
  }

  function buildTitleEl(conv) {
    const currentTitle = (conv ? conv.title : "") || "未命名对话";
    const wrap = h("div", { class: "topbar-title-wrap", title: "点击编辑标题" },
      h("span", { class: "topbar-title" }, currentTitle),
      h("span", { class: "topbar-title-edit-icon" }, Icons.icon("edit", 11))
    );

    wrap.addEventListener("click", (e) => {
      e.stopPropagation();
      if (wrap.querySelector("input")) return;

      const input = h("input", {
        type: "text",
        class: "topbar-title-input",
        value: currentTitle,
        maxlength: "60"
      });

      wrap.innerHTML = "";
      wrap.appendChild(input);
      input.focus();
      input.select();

      let committed = false;
      const finish = (commit) => {
        if (committed) return;
        committed = true;
        const val = input.value.trim();
        if (commit && val && val !== currentTitle) {
          JIGSAW.ChatService.rename(convId, val);
          JIGSAW.Toast.show("标题已更新");
        } else {
          wrap.innerHTML = "";
          wrap.append(
            h("span", { class: "topbar-title" }, currentTitle),
            h("span", { class: "topbar-title-edit-icon" }, Icons.icon("edit", 11))
          );
        }
      };

      input.addEventListener("click", ke => ke.stopPropagation());
      input.addEventListener("keydown", ke => {
        ke.stopPropagation();
        if (ke.key === "Enter") {
          ke.preventDefault();
          finish(true);
        } else if (ke.key === "Escape") {
          ke.preventDefault();
          finish(false);
        }
      });

      input.addEventListener("blur", () => finish(true));
    });

    return wrap;
  }

  function renderHeader(conv) {
    const header = el(".chat-header", container);
    header.innerHTML = "";

    header.append(
      h("div", { class: "topbar-left-group" },
        h("button", { class: "icon-btn", "data-home": "1", title: "返回主页" }, Icons.icon("home", 14)),
        h("button", { class: "icon-btn", "data-history": "1", title: "历史记录" }, Icons.icon("menu")),
        h("div", { class: "topbar-divider" }),
        buildTitleEl(conv)
      ),
      h("div", { class: "topbar-right-group" },
        h("button", { class: "btn btn-sm", "data-tools": "1" }, Icons.icon("tool", 13), "工具"),
        h("button", { class: "btn btn-sm", "data-kb": "1" }, Icons.icon("book", 13), "知识库"),
        h("button", { class: "icon-btn", "data-settings": "1", title: "设置" }, Icons.icon("sliders"))
      )
    );

    el("[data-home]", header).addEventListener("click", () => JIGSAW.Router.navigate("/"));
    el("[data-history]", header).addEventListener("click", () => JIGSAW.HistoryDrawer.toggle());
    el("[data-tools]", header).addEventListener("click", () => JIGSAW.Router.navigate("/tools"));
    el("[data-kb]", header).addEventListener("click", () => JIGSAW.Router.navigate("/knowledge"));
    el("[data-settings]", header).addEventListener("click", () => JIGSAW.Router.navigate("/settings"));
  }

  function renderInput(conv) {
    const bar = el(".chat-input-bar", container);
    // 重渲染输入框会清空用户正在打的字 → 先把草稿存下来，渲染完再放回去
    const oldTa = el(".chat-input-box textarea", bar);
    const draft = oldTa ? oldTa.value : "";
    const wasFocused = oldTa && document.activeElement === oldTa;
    bar.innerHTML = "";
    const activeId = conv ? conv.modelId : JIGSAW.ModelService.getActive().id;

    // 自绘直角下拉（原生 select 的弹出面板是圆角的，改不了，已替换）
    // 传“函数”而非数组：每次打开下拉都读取最新模型列表
    // 宽度随选中文字自适应，右缘贴紧发送按钮
    const sel = JIGSAW.Dropdown.create(() => JIGSAW.ModelService.list(), activeId, id => {
      if (conv) { conv.modelId = id; Store.notify("conversations"); }
      else JIGSAW.ModelService.setActive(id);
    });

    // AI 绘图模型选择器（与文本模型并列）
    const activeImgId = () => (conv && conv.imageModelId) || (JIGSAW.ImageService && JIGSAW.ImageService.getActive() ? JIGSAW.ImageService.getActive().id : "");
    const imgSel = JIGSAW.Dropdown.create(
      () => (JIGSAW.ImageService ? JIGSAW.ImageService.list() : []),
      activeImgId,
      id => {
        if (conv) { conv.imageModelId = id; Store.notify("conversations"); }
        if (JIGSAW.ImageService) JIGSAW.ImageService.setActive(id);
      },
      { icon: "image", placeholder: "生图模型", emptyText: "未配置生图模型", title: "AI 绘图模型 (Image Model)" }
    );

    // ===================== 聊天输入框 =====================
    // ta 就是页面上的输入框。你打的每一个字，浏览器都存在 ta.value 里。
    const ta = h("textarea", { rows: "1", placeholder: "给 JIGSAW 发消息…" });
    const sendBtn = h("button", { class: "send-btn", "data-send": "1", title: "发送" }, Icons.icon("arrowUp", 16));

    // "项目"按钮（同首页）：选目录进入项目工作；点 × 退出
    const cwdBtn = h("button", { class: "cwd-btn", "data-cwd": "1", title: "选择目录，进入项目工作" }, "项目");
    // 队列状态徽标（发送按钮旁，data-queue 唯一）：空闲隐藏；回复中显示"正在回复 · +N"
    // 点击它 → 打开任务队列面板（可展开查看 / 编辑 / 删除排队中的消息）
    const queueEl = h("span", { class: "chat-queue hidden", "data-queue": "1", role: "button",
      title: "查看任务队列：展开、编辑或删除排队中的消息" });
    queueEl.addEventListener("click", () => JIGSAW.QueuePanel.open());
    const shortPath = p => { const parts = String(p || "").split(/[\\/]+/).filter(Boolean); return parts[parts.length - 1] || ""; };
    const refreshCwd = () => {
      const on = JIGSAW.ToolService.isCwdProject();
      const p = JIGSAW.ToolService.cwdDisplay();
      cwdBtn.classList.toggle("on", on);
      cwdBtn.textContent = "";
      cwdBtn.appendChild(document.createTextNode(on ? "项目 · " + shortPath(p) : "项目"));
      if (on) {
        const x = document.createElement("span");
        x.className = "cwd-x";
        x.title = "退出项目工作";
        x.setAttribute("role", "button");
        x.innerHTML = Icons.icon("x", 11);
        cwdBtn.appendChild(x);
      }
      cwdBtn.title = on ? ("shell 命令在 " + p + " 执行，点 × 退出") : "选择目录，进入项目工作";
    };
    // 权限级别选择器（始终询问 / 按需确认 / 全部允许），模型选择器左边
    const renderPermDD = () => {
      const slot = el("[data-perm-dd]", view);
      if (!slot || slot.hasChildNodes()) return;
      const dd = JIGSAW.Dropdown.create(
        JIGSAW.ToolService.permissionOptions(),
        JIGSAW.ToolService.permission(),
        id => {
          JIGSAW.ToolService.setPermission(id)
            .then(r => { if (!r || !r.ok) JIGSAW.Toast.show("权限设置失败"); })
            .catch(e => JIGSAW.Toast.show("权限设置失败：" + (e.message || "")));
        },
        { icon: "shield" }
      );
      slot.appendChild(dd);
    };

    const loadTools = () => {
      if (JIGSAW.Http.isRemote()) JIGSAW.ToolService.load().then(() => { refreshCwd(); renderPermDD(); });
      else { refreshCwd(); renderPermDD(); }   // 本地模式也渲染图标与默认权限
    };
    loadTools();
    cwdBtn.addEventListener("click", async (e) => {
      if (e.target.closest(".cwd-x")) {
        cwdBtn.classList.toggle("on", false);
        try { await JIGSAW.ToolService.setCwdProject(false); refreshCwd(); }
        catch (err) { cwdBtn.classList.toggle("on", true); JIGSAW.Toast.show("退出失败：" + (err.message || "")); }
        return;
      }
      if (cwdBtn.classList.contains("busy")) return;
      cwdBtn.classList.add("busy");
      try {
        const r = await JIGSAW.ToolService.pickCwdProject();
        if (r && r.ok) { refreshCwd(); JIGSAW.Toast.show("已进入项目工作：" + r.path); }
        else if (r && r.error) {
          const path = prompt("后端无法弹出目录选择框，请手动输入工作目录路径：", JIGSAW.ToolService.cwdDisplay());
          if (path && path.trim()) {
            const r2 = await JIGSAW.ToolService.setCwdPath(path.trim());
            if (r2 && r2.ok) { refreshCwd(); JIGSAW.Toast.show("已进入项目工作：" + path.trim()); }
          }
        }
      } catch (err) {
        JIGSAW.Toast.show("目录选择失败：" + (err.message || ""));
      } finally {
        cwdBtn.classList.remove("busy");
      }
    });

    const box = h("div", { class: "chat-input-box" },
      ta,
      h("div", { class: "chat-input-actions" },
        cwdBtn,
        h("div", { class: "chat-input-actions-right" },
          h("div", { class: "perm-dd", "data-perm-dd": "1", title: "权限级别" }),
          h("div", { class: "img-dd", title: "AI 绘图模型" }, imgSel),
          sel,
          sendBtn
        )
      )
    );

    const tools = h("div", { class: "chat-tools" },
      h("button", { class: "icon-btn icon-btn-sm", "data-new": "1", title: "新建对话" }, Icons.icon("plus-sm", 13)),
      h("button", { class: "icon-btn icon-btn-sm", "data-qp": "1", title: "任务队列（排队/处理中）" }, Icons.icon("list", 13)),
      queueEl,
      h("span", { style: { fontSize: "11px", color: "var(--text-4)", fontFamily: "var(--font-mono)" } }, "Enter 发送 · Shift+Enter 换行")
    );

    bar.append(h("div", { class: "chat-input-inner" }, box, tools));
    inputTa = ta;

    // 恢复草稿（模型切换等重渲染时，用户打了一半的字不会被吃掉）
    if (draft) { ta.value = draft; }

    const autosize = () => {
      ta.style.height = "0px";                       // 先归零，强制重新计算内容高度
      const h = Math.min(160, Math.max(32, ta.scrollHeight));
      ta.style.height = h + "px";
      ta.style.overflowY = h >= 160 ? "auto" : "hidden";
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
    el("[data-qp]", tools).addEventListener("click", () => JIGSAW.QueuePanel.open());

    autosize();
    if (wasFocused) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    else setTimeout(() => ta.focus(), 30);   // 首次进入聊天页：自动聚焦输入框
  }

  // 渲染队列状态徽标（发送按钮旁）：空闲隐藏；回复中显示"正在回复"；有排队时显示条数
  // 徽标可点击 → 打开任务队列面板（排队消息在那里展开 / 编辑 / 删除）
  function renderQueueStatus() {
    const qEl = el("[data-queue]", container);
    if (!qEl) return;
    const q = JIGSAW.ChatService.queueInfo();
    if (!q.busy) { qEl.classList.add("hidden"); qEl.textContent = ""; return; }
    const pending = q.pending > 0 ? " · +" + q.pending : "";
    // 多个会话/模型并行时，说清楚同时在跑几条
    const head = (q.active || 1) > 1 ? `${q.active} 个回复中` : "正在回复";
    qEl.textContent = head + pending + " ›";
    qEl.classList.remove("hidden");
  }

  function openLightbox(src, rawSrc, alt) {
    const old = document.querySelector(".img-lightbox");
    if (old) old.remove();

    const titleText = alt || (rawSrc ? rawSrc.split("/").pop().split("\\").pop() : "图片预览");

    const copyBtn = h("button", { class: "img-lightbox-btn", title: "复制图片地址或原始路径" },
      Icons.icon("copy", 12),
      h("span", null, "复制路径")
    );
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const textToCopy = rawSrc || src;
      navigator.clipboard.writeText(textToCopy).then(() => JIGSAW.Toast.show("已复制路径：" + textToCopy));
    });

    const openBtn = h("button", { class: "img-lightbox-btn", title: "在新标签页打开原图" },
      Icons.icon("arrowUpRight", 12),
      h("span", null, "原图打开")
    );
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.open(src, "_blank");
    });

    const closeBtn = h("button", { class: "img-lightbox-btn btn-close", title: "关闭 (Esc)" },
      Icons.icon("x", 14)
    );

    const lightbox = h("div", { class: "img-lightbox" },
      h("div", { class: "img-lightbox-topbar" },
        h("div", { class: "img-lightbox-title", title: titleText }, titleText),
        h("div", { class: "img-lightbox-actions" }, copyBtn, openBtn, closeBtn)
      ),
      h("div", { class: "img-lightbox-body" },
        h("img", { class: "img-lightbox-img", src, alt: titleText })
      )
    );

    const close = () => {
      window.removeEventListener("keydown", onKey);
      lightbox.remove();
    };

    const onKey = (e) => {
      if (e.key === "Escape") close();
    };

    closeBtn.addEventListener("click", close);
    el(".img-lightbox-body", lightbox).addEventListener("click", (e) => {
      if (e.target !== el(".img-lightbox-img", lightbox)) {
        close();
      }
    });

    window.addEventListener("keydown", onKey);
    document.body.appendChild(lightbox);
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
      const switchFloat = h("div", { class: "view-switch-float" },
        h("button", { class: "view-switch-tab active", "data-tab": "chat", title: "当前：对话视图" },
          Icons.icon("message", 13),
          h("span", null, "对话")
        ),
        h("button", { class: "view-switch-tab", "data-tab": "workflow", title: "切换至工作流画布" },
          Icons.icon("branch", 13),
          h("span", null, "工作流")
        )
      );
      bodyEl = h("div", { class: "chat-body" });
      scrollEl = bodyEl;
      const inputBar = h("div", { class: "chat-input-bar" });
      root.append(header, switchFloat, bodyEl, inputBar);

      el("[data-tab='workflow']", switchFloat).addEventListener("click", () => JIGSAW.Router.navigate("/chat/" + convId + "/workflow"));

      renderHeader(conv);
      renderInput(conv);

      // initial messages
      const list = h("div", { class: "chat-scroll" });
      bodyEl.appendChild(list);

      // 图片点击呼出大图预览灯箱
      list.addEventListener("click", e => {
        const wrap = e.target.closest(".msg-img-wrap");
        if (wrap) {
          const img = el("img", wrap);
          const src = wrap.dataset.imgSrc || (img && img.src);
          const rawSrc = wrap.dataset.rawSrc || src;
          const alt = wrap.dataset.alt || (img && img.alt) || "";
          if (src) openLightbox(src, rawSrc, alt);
        }
      });

      // 图片自然加载完毕时，若用户正处于底部，平滑吸附到底部（用户手动向上翻看时不抢夺视角）
      list.addEventListener("load", e => {
        if (e.target && e.target.tagName === "IMG") {
          scrollToBottom(false);
        }
      }, true);

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
        Store.subscribe("image-model", () => {
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
      const lb = document.querySelector(".img-lightbox");
      if (lb) lb.remove();
    }
  };

  JIGSAW.Views = JIGSAW.Views || {};
  JIGSAW.Views.Chat = Chat;
})();
