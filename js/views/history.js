/* ============================================================
   JIGSAW — History Drawer
   Click-to-open overlay panel (never visible by default).
   ============================================================ */
(function () {
  const { h, el, els, esc, Icons } = JIGSAW;
  const Store = JIGSAW.Store;

  let root = null;
  let listEl = null;
  let query = "";

  const DAY = 86400e3;
  function groupKey(iso) {
    const d = new Date(iso);
    const nowD = new Date();
    const startToday = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate()).getTime();
    const t = d.getTime();
    if (t >= startToday) return "今天";
    if (t >= startToday - DAY) return "昨天";
    return "更早";
  }
  const GROUP_ORDER = ["今天", "昨天", "更早"];

  function timeLabel(iso) {
    const d = new Date(iso);
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    if (d.getTime() >= startToday.getTime()) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { month: "numeric", day: "numeric" });
  }

  function renderList() {
    if (!listEl) return;
    const convs = JIGSAW.ChatService.list().filter(c => {
      if (!query) return true;
      return c.title.toLowerCase().includes(query.toLowerCase());
    });

    if (!convs.length) {
      listEl.innerHTML = "";
      listEl.appendChild(h("div", { class: "drawer-empty" },
        Icons.icon("message", 28),
        h("div", null, query ? "没有匹配的对话" : "暂无对话")
      ));
      return;
    }

    const groups = {};
    convs.forEach(c => { const k = groupKey(c.createdAt); (groups[k] = groups[k] || []).push(c); });
    const activeId = Store.get().activeConversationId;

    const frag = document.createDocumentFragment();
    GROUP_ORDER.forEach(k => {
      if (!groups[k] || !groups[k].length) return;
      frag.appendChild(h("div", { class: "group-label" }, k));
      groups[k].forEach(c => {
        frag.appendChild(h("div", { class: "conv-row" },
          h("button", {
            class: "conv-item" + (c.id === activeId ? " active" : ""),
            "data-id": c.id
          },
            h("span", { class: "conv-meta" },
              h("span", { class: "conv-title" }, c.title),
              h("span", { class: "conv-time" }, timeLabel(c.createdAt))
            )
          ),
          h("button", { class: "icon-btn conv-rename", "data-rename-id": c.id, title: "重命名会话" }, Icons.icon("edit", 12)),
          h("button", { class: "icon-btn conv-wf", "data-wf-id": c.id, title: "打开工作流画布" }, Icons.icon("branch", 12)),
          h("button", { class: "icon-btn conv-del", "data-del-id": c.id, title: "删除会话" }, Icons.icon("trash", 13))
        ));
      });
    });
    listEl.innerHTML = "";
    listEl.appendChild(frag);

    function startRename(id, rowEl) {
      const c = JIGSAW.ChatService.get(id);
      if (!c) return;
      const metaEl = el(".conv-meta", rowEl);
      if (!metaEl || el(".conv-rename-input", metaEl)) return;

      const currentTitle = c.title || "";
      const input = h("input", {
        type: "text",
        class: "conv-rename-input",
        value: currentTitle,
        maxlength: "60"
      });

      metaEl.innerHTML = "";
      metaEl.appendChild(input);
      input.focus();
      input.select();

      let committed = false;
      const finish = (commit) => {
        if (committed) return;
        committed = true;
        const val = input.value.trim();
        if (commit && val && val !== currentTitle) {
          JIGSAW.ChatService.rename(id, val);
          JIGSAW.Toast.show("已重命名为：" + val);
        }
        renderList();
      };

      input.addEventListener("click", e => e.stopPropagation());
      input.addEventListener("mousedown", e => e.stopPropagation());
      input.addEventListener("dblclick", e => e.stopPropagation());
      input.addEventListener("keydown", e => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      });
      input.addEventListener("blur", () => finish(true));
    }

    els(".conv-item", listEl).forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        Store.set({ activeConversationId: id });
        Store.notify("conversations");
        setOpen(false);
        JIGSAW.Router.navigate("/chat/" + id);
      });
    });

    els(".conv-rename", listEl).forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const id = btn.dataset.renameId;
        const row = btn.closest(".conv-row");
        if (row) startRename(id, row);
      });
    });

    els(".conv-title", listEl).forEach(titleSpan => {
      titleSpan.addEventListener("dblclick", e => {
        e.stopPropagation();
        const row = titleSpan.closest(".conv-row");
        const item = titleSpan.closest(".conv-item");
        if (row && item) startRename(item.dataset.id, row);
      });
    });

    els(".conv-wf", listEl).forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const id = btn.dataset.wfId;
        Store.set({ activeConversationId: id });
        Store.notify("conversations");
        setOpen(false);
        JIGSAW.Router.navigate("/chat/" + id + "/workflow");
      });
    });

    els(".conv-del", listEl).forEach(del => {
      del.addEventListener("click", e => {
        e.stopPropagation();
        const id = del.dataset.delId;
        JIGSAW.ChatService.remove(id);
        JIGSAW.Toast.show("已删除会话");
        if (location.hash.includes("/chat/" + id)) JIGSAW.Router.navigate("/");
        renderList();
      });
    });
  }

  function setOpen(open) {
    const st = Store.get();
    if (st.ui.historyOpen === open) return;
    st.ui.historyOpen = open;
    if (open) renderList();
    Store.notify("ui");
    root.querySelector(".drawer-backdrop").classList.toggle("open", open);
    root.querySelector(".drawer").classList.toggle("open", open);
  }

  const HistoryDrawer = {
    init(container) {
      root = container;
      container.innerHTML = "";

      const backdrop = h("div", { class: "drawer-backdrop" });
      const drawer = h("div", { class: "drawer" },
        h("div", { class: "drawer-header" },
          h("div", { class: "drawer-new-row" },
            h("button", {
              class: "btn btn-primary btn-sm",
              "data-new": "1"
            }, Icons.icon("plus-sm", 14), "新建对话"),
            h("button", {
              class: "btn btn-sm",
              "data-new-wf": "1",
              title: "直接创建空白工作流编排"
            }, Icons.icon("branch", 13), "新建工作流")
          ),
          h("div", { class: "drawer-search" },
            Icons.icon("search", 14),
            h("input", { type: "text", placeholder: "搜索会话或工作流…" })
          )
        ),
        h("div", { class: "drawer-body" })
      );
      listEl = drawer.querySelector(".drawer-body");
      container.append(backdrop, drawer);

      backdrop.addEventListener("click", () => setOpen(false));
      drawer.querySelector("[data-new]").addEventListener("click", () => {
        setOpen(false);
        JIGSAW.Router.navigate("/");
      });
      drawer.querySelector("[data-new-wf]").addEventListener("click", () => {
        setOpen(false);
        const conv = JIGSAW.ChatService.create({ title: "未命名工作流", text: "" });
        JIGSAW.Router.navigate("/chat/" + conv.id + "/workflow");
      });
      const search = drawer.querySelector("input");
      search.addEventListener("input", () => { query = search.value.trim(); renderList(); });
      search.addEventListener("keydown", e => { if (e.key === "Escape") setOpen(false); });

      // follow store open/close requests
      Store.subscribe("ui", () => {
        const want = Store.get().ui.historyOpen;
        backdrop.classList.toggle("open", !!want);
        drawer.classList.toggle("open", !!want);
      });
      Store.subscribe("conversations", () => {
        if (Store.get().ui.historyOpen) renderList();
      });
    },

    open() { setOpen(true); },
    close() { setOpen(false); },
    toggle() { setOpen(!Store.get().ui.historyOpen); },
    refresh() { renderList(); }
  };

  JIGSAW.HistoryDrawer = HistoryDrawer;
})();
