/* ============================================================
   JIGSAW — QueuePanel（任务队列面板）
   两类条目，都能点开看全文：
     1) 处理中 / 排队中的后端任务 —— 可终止（✕）
     2) 排队中还没发出去的消息   —— 可编辑 / 删除
   每 2 秒自动刷新；列表空了自动关闭。
   黑白灰、直角、1px 细线，与全局设计语言一致。
   ============================================================ */
(function () {
  const { h, el, Icons } = JIGSAW;

  let overlay = null;
  let timer = null;
  let busy = false;             // 防重复终止
  const expanded = new Set();   // 展开了全文的行（跨刷新保留）
  let lastSig = "";             // 列表签名：内容没变就不重建（保留展开状态与滚动位置）

  /** 后端任务的状态文案 */
  const statusLabel = t => {
    if (t.status === "running") return t.pendingQuestion ? "等待回答" : (t.activity || "处理中");
    return t.queue_position > 0 ? `排队中（第 ${t.queue_position} 位）` : "排队中";
  };

  /** 展开箭头（点整行头切换） */
  const chevEl = key =>
    h("span", { class: "qp-chev" }, Icons.icon(expanded.has(key) ? "chev-down" : "chev-right", 12));

  /** 行外壳：头部可点击展开 / 收起，正文默认收起 */
  function shell(key, head, bodyInner) {
    const row = h("div", { class: "qp-row" + (expanded.has(key) ? " open" : "") }, null);
    const body = h("div", { class: "qp-body" }, null);
    if (bodyInner) body.appendChild(bodyInner);
    row.append(head, body);
    head.addEventListener("click", e => {
      if (e.target.closest("button")) return;      // 点按钮不触发展开
      const open = !expanded.has(key);
      if (open) expanded.add(key); else expanded.delete(key);
      row.classList.toggle("open", open);
      const c = el(".qp-chev", head);
      if (c) c.innerHTML = Icons.icon(open ? "chev-down" : "chev-right", 12);
    });
    return row;
  }

  /* ---------- ① 后端任务行（处理中 / 排队中）---------- */
  function buildTaskRow(t, onRefresh) {
    const key = "t:" + t.task_id;
    const badge = h("span", { class: "qp-badge " + (t.status === "running" ? "run" : "wait") },
      t.status === "running" ? "●" : "○");
    const info = h("div", { class: "qp-info" },
      h("div", { class: "qp-text" }, t.message || "(空消息)"),
      h("div", { class: "qp-sub" },
        statusLabel(t),
        t.pendingQuestion ? " · 需要你确认" : ""
      )
    );
    const stop = h("button", { class: "qp-stop", type: "button", title: "终止此任务" },
      Icons.icon("x", 12));
    stop.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      try {
        await JIGSAW.Http.cancelTask(t.task_id);
        expanded.delete(key);
        JIGSAW.Toast.show("已终止该任务");
        onRefresh();
      } catch (e) {
        JIGSAW.Toast.show("终止失败：" + (e.message || ""));
      } finally {
        busy = false;
      }
    });
    const head = h("div", { class: "qp-head-row" }, badge, info, chevEl(key), stop);
    const body = h("div", { class: "qp-message" }, t.messageFull || t.message || "(空消息)");
    return shell(key, head, body);
  }

  /* ---------- ② 前端排队中的消息行（尚未发送）---------- */
  function buildQueuedRow(q, onRefresh) {
    const key = "q:" + q.id;
    const badge = h("span", { class: "qp-badge wait" }, "○");
    const info = h("div", { class: "qp-info" },
      h("div", { class: "qp-text" }, q.text || "(空消息)"),
      h("div", { class: "qp-sub" },
        "排队中（尚未发送）· 可编辑 / 删除",
        q.conversation ? " · " + q.conversation : ""
      )
    );

    const edit = h("button", { class: "qp-act", type: "button", title: "修改这条消息" },
      Icons.icon("edit", 12));
    edit.addEventListener("click", async () => {
      const v = await JIGSAW.PromptModal.prompt({
        title: "修改排队中的消息",
        initial: q.text,
        placeholder: "消息内容",
        okText: "保存"
      });
      if (v === null) return;                       // 取消
      JIGSAW.ChatService.updateQueued(q.id, v);
      JIGSAW.Toast.show("已修改排队消息");
      onRefresh();
    });

    const del = h("button", { class: "qp-act", type: "button", title: "删除这条消息" },
      Icons.icon("trash", 12));
    del.addEventListener("click", async () => {
      const ok = await JIGSAW.PromptModal.confirm({
        title: "删除排队消息",
        message: "删除后这条消息不会再发给 AI。确定删除吗？",
        okText: "删除",
        danger: true
      });
      if (!ok) return;
      JIGSAW.ChatService.removeQueued(q.id);
      expanded.delete(key);
      JIGSAW.Toast.show("已删除排队消息");
      onRefresh();
    });

    const head = h("div", { class: "qp-head-row" }, badge, info, chevEl(key), edit, del);
    const body = h("div", { class: "qp-message" }, q.text || "(空消息)");
    return shell(key, head, body);
  }

  /* ---------- 刷新 ---------- */
  function signature(tasks, queued, offline) {
    return JSON.stringify([
      offline,
      tasks.map(t => [t.task_id, t.status, t.queue_position, t.activity, t.pendingQuestion, t.messageFull]),
      queued.map(q => [q.id, q.text])
    ]);
  }

  async function refresh() {
    if (!overlay) return;
    const listEl = el(".qp-list", overlay);
    if (!listEl) return;

    let tasks = [];
    let offline = false;
    try { tasks = await JIGSAW.Http.listTasks(); }
    catch (e) { offline = true; }
    const queued = JIGSAW.ChatService.listQueued();

    if (!tasks.length && !queued.length) {
      listEl.innerHTML = "";
      listEl.appendChild(h("div", { class: "qp-empty" },
        offline ? "无法连接后端" : "当前没有排队或处理中的任务"));
      if (!offline) close();     // 全处理完 → 自动关面板
      return;
    }

    const sig = signature(tasks, queued, offline);
    if (sig === lastSig) return;   // 内容没变 → 不重建，保留展开状态与滚动位置
    lastSig = sig;

    // 清掉已不存在行的展开状态
    const alive = new Set([
      ...tasks.map(t => "t:" + t.task_id),
      ...queued.map(q => "q:" + q.id)
    ]);
    Array.from(expanded).forEach(k => { if (!alive.has(k)) expanded.delete(k); });

    const scrollTop = listEl.scrollTop;
    listEl.innerHTML = "";
    if (offline) listEl.appendChild(h("div", { class: "qp-note" }, "无法连接后端，仅显示本地排队消息"));
    if (queued.length) {
      listEl.appendChild(h("div", { class: "qp-group" }, "排队中的消息（可编辑 / 删除）"));
      queued.forEach(q => listEl.appendChild(buildQueuedRow(q, refresh)));
    }
    if (tasks.length) {
      listEl.appendChild(h("div", { class: "qp-group" }, "处理中的任务（可终止）"));
      tasks.forEach(t => listEl.appendChild(buildTaskRow(t, refresh)));
    }
    listEl.scrollTop = scrollTop;
  }

  function open() {
    if (overlay) { refresh(); return; }
    lastSig = "";                  // 重新打开时强制重建
    overlay = h("div", { class: "qp-overlay" }, null);
    const panel = h("div", { class: "qp-panel" }, null);
    const head = h("div", { class: "qp-head" },
      h("span", { class: "qp-title" }, "任务队列"),
      h("button", { class: "icon-btn icon-btn-sm", type: "button", title: "关闭", "data-close": "1" },
        Icons.icon("x", 13))
    );
    const list = h("div", { class: "qp-list" }, null);
    panel.append(head, list);
    overlay.append(panel);
    document.body.appendChild(overlay);
    el("[data-close]", panel).addEventListener("click", close);
    overlay.addEventListener("mousedown", e => { if (e.target === overlay) close(); });
    refresh();
    timer = setInterval(refresh, 2000);
  }

  function close() {
    if (timer) { clearInterval(timer); timer = null; }
    if (overlay) { overlay.remove(); overlay = null; }
    lastSig = "";
  }

  JIGSAW.QueuePanel = { open, close };
})();
