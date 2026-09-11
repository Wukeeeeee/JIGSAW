/* ============================================================
   JIGSAW — 工具广场视图
   首页顶栏「工具」入口进入。只读展示 + 启用/禁用开关。
   ============================================================ */
(function () {
  const { h, el, Icons } = JIGSAW;

  let container = null;

  function card(t) {
    const params = (t.parameters && t.parameters.properties)
      ? Object.keys(t.parameters.properties) : [];
    const paramText = params.length ? "参数：" + params.join("、") : "无参数";

    const tog = h("div", { class: "toggle" + (t.enabled ? " on" : "") });
    tog.addEventListener("click", async () => {
      const next = !t.enabled;
      tog.classList.toggle("on", next);
      try {
        await JIGSAW.ToolService.toggle(t.name, next);
      } catch (e) {
        tog.classList.toggle("on", t.enabled);   // 失败回滚
        JIGSAW.Toast.show("切换失败：" + (e.message || ""));
      }
    });

    return h("div", { class: "tool-card" },
      h("div", { class: "tool-icon" }, Icons.icon(t.icon || "tool", 18)),
      h("div", { class: "tool-info" },
        h("div", { class: "tool-name" }, t.label || t.name),
        h("div", { class: "tool-desc" }, t.description || ""),
        h("div", { class: "tool-params" }, paramText)
      ),
      tog
    );
  }

  const Tools = {
    mount(c) {
      container = c;
      JIGSAW.setViewClass(container, "view-tools");
      container.innerHTML = "";

      const top = h("div", { class: "tools-top" },
        h("button", { class: "icon-btn", "data-back": "1", title: "返回" }, Icons.icon("back")),
        h("div", { class: "tools-title" }, "工具"),
        h("div", { class: "tools-top-spacer" })
      );
      const body = h("div", { class: "tools-body" },
        h("div", { class: "tools-sub" }, "启用的工具会被提供给 AI 调用；关闭后 AI 不再使用它。"),
        h("div", { class: "tool-master", "data-master": "1" },
          h("div", null,
            h("div", { class: "tm-label" }, "允许使用工具"),
            h("div", { class: "tm-desc" }, "关闭后 AI 不再调用任何工具（总开关）。")
          ),
          h("div", { class: "toggle" })
        ),
        h("div", { class: "tools-list", "data-list": "1" })
      );
      container.append(top, body);

      el("[data-back]", container).addEventListener("click", () => JIGSAW.Router.goBack());
      this.refresh();
    },

    async refresh() {
      const listEl = el("[data-list]", container);
      if (!listEl) return;
      listEl.innerHTML = "";

      // 本地 mock 模式：工具由后端管理，提示切数据源
      if (!JIGSAW.Http.isRemote()) {
        listEl.appendChild(h("div", { class: "tools-empty" },
          "当前为本地模式，工具由后端管理。请在 设置 → API 中把数据源切换为「后端 API」。"));
        return;
      }

      const loading = h("div", { class: "tools-empty" }, "加载中…");
      listEl.appendChild(loading);

      const tools = await JIGSAW.ToolService.load();
      loading.remove();

      // 总开关状态同步到顶部开关
      const master = el("[data-master]", container);
      if (master) {
        master.classList.toggle("off", !JIGSAW.ToolService.isEnabled());
        const tog = el(".toggle", master);
        tog.classList.toggle("on", JIGSAW.ToolService.isEnabled());
        tog.addEventListener("click", async () => {
          const next = !JIGSAW.ToolService.isEnabled();
          tog.classList.toggle("on", next);
          master.classList.toggle("off", !next);
          try {
            await JIGSAW.ToolService.setEnabled(next);
          } catch (e) {
            tog.classList.toggle("on", !next);
            master.classList.toggle("off", next);
            JIGSAW.Toast.show("切换失败：" + (e.message || ""));
          }
        });
      }

      if (!tools.length) {
        listEl.appendChild(h("div", { class: "tools-empty" }, "没有可用工具。"));
        return;
      }
      tools.forEach(t => listEl.appendChild(card(t)));
    }
  };

  JIGSAW.Views = JIGSAW.Views || {};
  JIGSAW.Views.Tools = Tools;
})();
