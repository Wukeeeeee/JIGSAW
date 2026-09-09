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
          h("button", { class: "icon-btn conv-del", "data-del-id": c.id, title: "删除对话" }, Icons.icon("trash", 13))
        ));
      });
    });
    listEl.innerHTML = "";
    listEl.appendChild(frag);

    els(".conv-item", listEl).forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        Store.set({ activeConversationId: id });
        Store.notify("conversations");
        setOpen(false);
        JIGSAW.Router.navigate("/chat/" + id);
      });
    });

    els(".conv-del", listEl).forEach(del => {
      del.addEventListener("click", e => {
        e.stopPropagation();
        const id = del.dataset.delId;
        JIGSAW.ChatService.remove(id);
        JIGSAW.Toast.show("已删除对话");
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
          h("button", {
            class: "btn btn-primary btn-sm",
            "data-new": "1"
          }, Icons.icon("plus-sm", 14), "新建对话"),
          h("div", { class: "drawer-search" },
            Icons.icon("search", 14),
            h("input", { type: "text", placeholder: "搜索对话…" })
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
      const search = drawer.querySelector("input");
      search.addEventListener("input", () => { query = search.value.trim(); renderList(); });
      search.addEventListener("keydown", e => { if (e.key === "Escape") setOpen(false); });

      // follow store open/close requests
      Store.subscribe("ui", () => {
        const want = Store.get().ui.historyOpen;
        backdrop.classList.toggle("open", !!want);
        drawer.classList.toggle("open", !!want);
      });
    },

    open() { setOpen(true); },
    close() { setOpen(false); },
    toggle() { setOpen(!Store.get().ui.historyOpen); },
    refresh() { renderList(); }
  };

  JIGSAW.HistoryDrawer = HistoryDrawer;
})();
