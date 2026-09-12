/* ============================================================
   JIGSAW — QueuePanel（任务队列面板）
   查看所有排队中 / 处理中的任务，每条都可终止（✕）。
   每 2 秒自动刷新；列表空了自动关闭。
   黑白灰、直角、1px 细线，与全局设计语言一致。
   ============================================================ */
(function () {
  const { h, el, Icons } = JIGSAW;

  let overlay = null;
  let timer = null;
  let busy = false;   // 防重复终止

  const statusLabel = t => {
    if (t.status === "running") return t.pendingQuestion ? "等待回答" : (t.activity || "处理中");
    return t.queue_position > 0 ? `排队中（第 ${t.queue_position} 位）` : "排队中";
  };

  function buildRow(t, onRefresh) {
    const row = h("div", { class: "qp-row" }, null);
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
        onRefresh();
      } catch (e) {
        JIGSAW.Toast.show("终止失败：" + (e.message || ""));
      } finally {
        busy = false;
      }
    });
    row.append(badge, info, stop);
    return row;
  }

  async function refresh() {
    if (!overlay) return;
    const listEl = el(".qp-list", overlay);
    if (!listEl) return;
    let tasks = [];
    try { tasks = await JIGSAW.Http.listTasks(); }
    catch (e) { listEl.innerHTML = ""; listEl.appendChild(h("div", { class: "qp-empty" }, "无法连接后端")); return; }

    listEl.innerHTML = "";
    if (!tasks.length) {
      listEl.appendChild(h("div", { class: "qp-empty" }, "当前没有排队或处理中的任务"));
      close();   // 全处理完 → 自动关面板
      return;
    }
    tasks.forEach(t => listEl.appendChild(buildRow(t, refresh)));
  }

  function open() {
    if (overlay) { refresh(); return; }
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
  }

  JIGSAW.QueuePanel = { open, close };
})();
