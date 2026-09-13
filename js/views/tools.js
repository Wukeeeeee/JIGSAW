/* ============================================================
   JIGSAW — 工具广场视图
   首页顶栏「工具」入口进入。左侧工具列表 + 右侧选中工具详情面板。
   ============================================================ */
(function () {
  const { h, el, Icons } = JIGSAW;

  let container = null;
  let selected = null;   // 当前选中工具名

  /* ---------- 左侧：工具卡片 ---------- */
  function card(t) {
    const params = (t.parameters && t.parameters.properties)
      ? Object.keys(t.parameters.properties) : [];
    const paramText = params.length ? "参数：" + params.join("、") : "无参数";

    const tog = h("div", { class: "toggle" + (t.enabled ? " on" : "") });
    tog.addEventListener("click", async e => {
      e.stopPropagation();
      const next = !t.enabled;
      tog.classList.toggle("on", next);
      try {
        await JIGSAW.ToolService.toggle(t.name, next);
        if (selected === t.name) renderDetail();   // 详情面板同步
      } catch (e2) {
        tog.classList.toggle("on", t.enabled);
        JIGSAW.Toast.show("切换失败：" + (e2.message || ""));
      }
    });

    const c = h("div", { class: "tool-card" + (selected === t.name ? " selected" : "") },
      h("div", { class: "tool-icon" }, Icons.icon(t.icon || "tool", 18)),
      h("div", { class: "tool-info" },
        h("div", { class: "tool-name" }, t.label || t.name),
        h("div", { class: "tool-desc" }, t.description || ""),
        h("div", { class: "tool-params" }, paramText)
      ),
      tog
    );
    c.addEventListener("click", () => {
      selected = t.name;
      render();
    });
    return c;
  }

  /* ---------- 右侧：详情面板 ---------- */
  function paramRow(name, def, required) {
    const type = def.type || "any";
    const dflt = def.default !== undefined ? String(def.default) : "";
    return h("div", { class: "td-row" },
      h("div", { class: "td-name" }, name + (required ? " *" : "")),
      h("div", { class: "td-type" }, type),
      h("div", { class: "td-desc" }, (def.description || "无说明") + (dflt ? `（默认 ${dflt}）` : ""))
    );
  }

  function renderDetail() {
    const wrap = el("[data-detail]", container);
    if (!wrap) return;
    wrap.innerHTML = "";

    const t = JIGSAW.ToolService.getMeta(selected);
    if (!t) {
      wrap.appendChild(h("div", { class: "td-empty" }, "从左侧选择一个工具查看详情"));
      return;
    }

    // 参数表
    const p = (t.parameters && t.parameters.properties) || {};
    const req = (t.parameters && t.parameters.required) || [];
    const names = Object.keys(p);
    const paramsBox = names.length
      ? h("div", { class: "td-section" },
          h("div", { class: "td-sec-title" }, "参数"),
          h("div", { class: "td-rows" }, names.map(n => paramRow(n, p[n], req.includes(n))))
        )
      : h("div", { class: "td-section" },
          h("div", { class: "td-sec-title" }, "参数"),
          h("div", { class: "td-note" }, "无参数")
        );

    // 启用开关
    const tog = h("div", { class: "toggle" + (t.enabled ? " on" : "") });
    tog.addEventListener("click", async () => {
      const next = !t.enabled;
      tog.classList.toggle("on", next);
      try {
        await JIGSAW.ToolService.toggle(t.name, next);
        render();   // 列表开关同步
      } catch (e) {
        tog.classList.toggle("on", t.enabled);
        JIGSAW.Toast.show("切换失败：" + (e.message || ""));
      }
    });

    const panel = h("div", { class: "td-panel" },
      h("div", { class: "td-head" },
        h("div", { class: "td-big-icon" }, Icons.icon(t.icon || "tool", 22)),
        h("div", { class: "td-title" },
          h("div", { class: "td-name-lg" }, t.label || t.name),
          h("div", { class: "td-id" }, t.name)
        )
      ),
      h("div", { class: "td-section" },
        h("div", { class: "td-sec-title" }, "描述"),
        h("div", { class: "td-note" }, t.description || "无描述")
      ),
      paramsBox,
      h("div", { class: "td-section" },
        h("div", { class: "td-sec-title" }, "启用"),
        h("div", { class: "td-switch" },
          h("span", null, "允许 AI 调用此工具"),
          tog
        )
      ),
      statsBox(t)
    );
    wrap.appendChild(panel);
  }

  /** 调用统计区块：真实次数 + 最近一次 + 统计起始时刻（可在 设置 → 统计 重置） */
  function statsBox(t) {
    const TS = JIGSAW.ToolService;
    const st = TS.stats() || {};
    const n = TS.countOf(t.name);
    const last = (st.lastUsed || {})[t.name];
    const statRow = (k, v) => h("div", { class: "td-stat" },
      h("span", { class: "td-stat-k" }, k),
      h("span", { class: "td-stat-v" }, v)
    );
    return h("div", { class: "td-section" },
      h("div", { class: "td-sec-title" }, "调用统计"),
      statRow("累计调用", n + " 次"),
      statRow("最近一次", last ? TS.fmtTime(last) : "—"),
      statRow("统计起始", TS.sinceText()),
      h("div", { class: "td-note", style: { marginTop: "var(--sp-2)" } },
        "统计自上述时刻开始记录；重置入口在 设置 → 统计。")
    );
  }

  /* ---------- 主渲染 ---------- */
  function render() {
    if (!container) return;

    const listEl = el("[data-list]", container);
    if (listEl) {
      listEl.innerHTML = "";
      const tools = JIGSAW.ToolService.list();
      if (!tools.length) {
        listEl.appendChild(h("div", { class: "tools-empty" }, "没有可用工具。"));
      } else {
        tools.forEach(t => listEl.appendChild(card(t)));
      }
    }
    renderDetail();
  }

  const Tools = {
    mount(c) {
      container = c;
      selected = null;
      JIGSAW.setViewClass(container, "view-tools");
      container.innerHTML = "";

      const top = h("div", { class: "tools-top" },
        h("button", { class: "icon-btn", "data-back": "1", title: "返回" }, Icons.icon("back")),
        h("div", { class: "tools-title" }, "工具"),
        h("div", { class: "tools-top-spacer" })
      );
      const body = h("div", { class: "tools-body" },
        h("div", { class: "tools-left" },
          h("div", { class: "tools-sub" }, "启用的工具会被提供给 AI 调用；点击工具查看详情与参数。"),
          h("div", { class: "tool-master", "data-master": "1" },
            h("div", null,
              h("div", { class: "tm-label" }, "允许使用工具"),
              h("div", { class: "tm-desc" }, "关闭后 AI 不再调用任何工具（总开关）。")
            ),
            h("div", { class: "toggle" })
          ),
          h("div", { class: "tool-master", "data-riskack": "1" },
            h("div", null,
              h("div", { class: "tm-label" }, "风险操作提醒"),
              h("div", { class: "tm-desc" }, "关：每次风险操作都弹窗确认。开：已勾选「不再提醒」，风险操作直接执行。")
            ),
            h("div", { class: "toggle" })
          ),
          h("div", { class: "tools-list", "data-list": "1" })
        ),
        h("div", { class: "tools-detail", "data-detail": "1" })
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
        const d = el("[data-detail]", container);
        if (d) { d.innerHTML = ""; d.appendChild(h("div", { class: "td-empty" }, "无详情")); }
        return;
      }

      const loading = h("div", { class: "tools-empty" }, "加载中…");
      listEl.appendChild(loading);

      const tools = await JIGSAW.ToolService.load();
      await JIGSAW.ToolService.loadStats();     // 调用统计（详情面板显示次数/起始时刻）
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

      // "不再提醒"状态同步到风险提醒开关（勾选过 → 打开）
      const riskBox = el("[data-riskack]", container);
      if (riskBox) {
        const tog = el(".toggle", riskBox);
        tog.classList.toggle("on", JIGSAW.ToolService.riskAck());
        riskBox.classList.toggle("off", !JIGSAW.ToolService.riskAck());
        tog.addEventListener("click", async () => {
          const next = !JIGSAW.ToolService.riskAck();
          tog.classList.toggle("on", next);
          riskBox.classList.toggle("off", !next);
          try {
            await JIGSAW.ToolService.setRiskAck(next);
            JIGSAW.Toast.show(next ? "已开启：风险操作不再提醒" : "已恢复：风险操作每次提醒");
          } catch (e) {
            tog.classList.toggle("on", !next);
            riskBox.classList.toggle("off", next);
            JIGSAW.Toast.show("设置失败：" + (e.message || ""));
          }
        });
      }

      render();
    }
  };

  JIGSAW.Views = JIGSAW.Views || {};
  JIGSAW.Views.Tools = Tools;
})();
