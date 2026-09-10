/* ============================================================
   JIGSAW — 首页视图（欢迎页 / 空状态）
   ============================================================ */
(function () {
  const { h, el, Icons } = JIGSAW;
  const Store = JIGSAW.Store;

  let ta = null;
  let statusTimer = null;

  /* 后端连接状态指示（输入框内、模型选择器前的小方块）：白=已连接，灰=未连接 */
  function setStatus(mode, label, statusLine) {
    statusLine.dataset.status = mode;
    statusLine.title = label;
  }
  function pingBackend(statusLine) {
    if (!statusLine.isConnected) {            // 已离开首页 → 停止轮询
      if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
      return;
    }
    JIGSAW.Http.health()
      .then(() => setStatus("on", "后端已连接", statusLine))
      .catch(() => setStatus("off", "后端未连接", statusLine));
  }

  function submit(text) {
    text = (text || "").trim();
    if (!text) return;
    const conv = JIGSAW.ChatService.create({ text });
    JIGSAW.Router.navigate("/chat/" + conv.id);
  }

  function renderModelSelect() {
    // 自绘直角下拉（原生 select 的弹出面板是圆角的，改不了，已替换）
    // 传“函数”而非数组：每次打开下拉都读取最新模型列表
    // 宽度随选中文字自适应，右缘贴紧发送按钮
    const dd = JIGSAW.Dropdown.create(() => JIGSAW.ModelService.list(), JIGSAW.ModelService.getActive().id, id => JIGSAW.ModelService.setActive(id));
    return dd;
  }

  const Home = {
    mount(container) {
      JIGSAW.setViewClass(container, "view-home");
      container.innerHTML = "";

      const st = Store.get();
      const showTagline = st.settings.appearance.showHomeTagline;

      const view = h("div", { class: "view-home" },
        h("div", { class: "home-top" },
          h("button", { class: "icon-btn", "data-history": "1", title: "历史记录" }, Icons.icon("menu")),
          h("div", { class: "home-brand-line" },
            h("span", { class: "jigsaw-mark" },
              h("span", { class: "cell" }), h("span", { class: "cell" }),
              h("span", { class: "cell" }), h("span", { class: "cell" })
            ),
            h("span", null, "JIGSAW")
          ),
          h("button", { class: "icon-btn", "data-settings": "1", title: "设置" }, Icons.icon("sliders"))
        ),

        h("div", { class: "home-center" },
          h("div", { class: "jigsaw-mark" },
            h("span", { class: "cell" }), h("span", { class: "cell" }),
            h("span", { class: "cell" }), h("span", { class: "cell" })
          ),
          h("div", { class: "home-wordmark" }, "JIGSAW"),

          h("div", { class: "home-input-wrap" },
            h("div", { class: "home-input" },
              h("textarea", { rows: "1", placeholder: "给 JIGSAW 发消息…", "data-input": "1"}),
              h("div", { class: "home-input-actions" },
                h("span", { class: "home-status", "data-status": "checking", title: "正在检查后端连接…" }),
                renderModelSelect(),
                h("button", { class: "send-btn", "data-send": "1", title: "发送" }, Icons.icon("arrowUp", 16))
              )
            )
          )
        )
      );
      container.appendChild(view);

      ta = el(".home-input textarea", view);
      const send = el("[data-send]", view);

      const autosize = () => {
        ta.style.height = "auto";
        ta.style.height = Math.min(180, Math.max(24, ta.scrollHeight)) + "px";
      };
      ta.addEventListener("input", autosize);
      ta.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(ta.value); }
      });
      send.addEventListener("click", () => submit(ta.value));

      el("[data-history]", view).addEventListener("click", () => JIGSAW.HistoryDrawer.toggle());
      el("[data-settings]", view).addEventListener("click", () => JIGSAW.Router.navigate("/settings"));

      // 后端连接状态：立即检查 + 每 20s 轮询
      const statusLine = el(".home-status", view);
      if (statusTimer) clearInterval(statusTimer);
      pingBackend(statusLine);
      statusTimer = setInterval(() => pingBackend(statusLine), 20000);

      // 聚焦输入框
      setTimeout(() => ta.focus(), 50);
    },

    unmount() {
      if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    }
  };

  JIGSAW.Views = JIGSAW.Views || {};
  JIGSAW.Views.Home = Home;
})();
