/* ============================================================
   JIGSAW — 设置视图
   常规 · 外观 · 模型 · API · 工作流 · 关于
   ============================================================ */
(function () {
  const { h, el, els, Icons } = JIGSAW;
  const Store = JIGSAW.Store;

  const SECTIONS = [
    { id: "general", label: "常规", icon: "sliders" },
    { id: "appearance", label: "外观", icon: "eye-off" },
    { id: "model", label: "模型", icon: "cpu" },
    { id: "api", label: "API", icon: "key" },
    { id: "workflow", label: "工作流", icon: "branch" },
    { id: "stats", label: "统计", icon: "database" },
    { id: "about", label: "关于", icon: "jigsaw" }
  ];

  let container = null;
  let contentEl = null;
  let current = "general";
  let unsubs = [];

  /* ---- 控件 ---- */
  function row(label, desc, control) {
    return h("div", { class: "setting-row" },
      h("div", null, h("div", { class: "sr-label" }, label), desc ? h("div", { class: "sr-desc" }, desc) : null),
      h("div", { class: "sr-control" }, control)
    );
  }

  function textInput(value, onInput) {
    const i = h("input", { class: "input", type: "text", value });
    i.addEventListener("input", () => onInput(i.value));
    return i;
  }

  function selectCtrl(options, value, onChange) {
    // 自绘直角下拉，与输入框同宽对齐（原生 select 弹出面板是圆角的，改不了）
    const opts = options.map(([v, l]) => ({ id: v, name: l }));
    return JIGSAW.Dropdown.create(opts, value, onChange, { stretch: true });
  }

  function toggleCtrl(on, onChange) {
    const t = h("div", { class: "toggle" + (on ? " on" : "") });
    t.addEventListener("click", () => { t.classList.toggle("on"); onChange(t.classList.contains("on")); });
    return t;
  }

  function rangeCtrl(value, min, max, step, onChange) {
    const val = h("span", { class: "range-val" }, String(value));
    const r = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) });
    r.addEventListener("input", () => { val.textContent = r.value; onChange(parseFloat(r.value)); });
    return h("div", { style: { display: "flex", alignItems: "center", gap: "var(--sp-2)" } }, r, val);
  }

  /* ---- 各分区 ---- */
  function sectionGeneral(s) {
    return [
      h("div", { class: "settings-section-title" }, "常规"),
      h("div", { class: "settings-card" },
        row("工作区名称", "显示在标题栏与窗口标题中。",
          textInput(s.general.workspaceName, v => JIGSAW.SettingsService.update("general", { workspaceName: v }))),
        row("密度", "控制界面元素之间的间距。",
          selectCtrl([["compact", "紧凑"], ["comfortable", "宽松"]], s.general.density, v => JIGSAW.SettingsService.update("general", { density: v })))
      )
    ];
  }

  function sectionAppearance(s) {
    return [
      h("div", { class: "settings-section-title" }, "外观"),
      h("div", { class: "settings-section-sub" }, "纯灰度配色，不使用任何强调色。"),
      h("div", { class: "settings-card" },
        row("主题", "深色或浅色单色。",
          selectCtrl([["dark", "深色"], ["light", "浅色"]], s.appearance.theme, v => JIGSAW.SettingsService.update("appearance", { theme: v }))),
        row("字号", "基础文字大小。",
          selectCtrl([["small", "小"], ["medium", "中"], ["large", "大"]], s.appearance.fontSize, v => JIGSAW.SettingsService.update("appearance", { fontSize: v }))),
        row("显示时间戳", "在对话中显示消息时间。",
          toggleCtrl(s.appearance.showTimestamps, v => JIGSAW.SettingsService.update("appearance", { showTimestamps: v })))
      )
    ];
  }

  function sectionModel(s) {
    // 默认模型下拉：自绘直角，选项来自用户已添加的自定义模型
    const defaultSel = JIGSAW.Dropdown.create(
      () => JIGSAW.ModelService.list().map(m => ({ id: m.id, name: m.name })),
      s.model.defaultModel,
      v => JIGSAW.SettingsService.update("model", { defaultModel: v }),
      { stretch: true }
    );
    return [
      h("div", { class: "settings-section-title" }, "模型"),
      h("div", { class: "settings-section-sub" }, "模型由你在下方 API 分区自行添加，这里设置新建会话的默认模型。"),
      h("div", { class: "settings-card" },
        row("默认模型", "用于新建会话。", defaultSel),
        row("视觉能力", "允许输入图片。",
          toggleCtrl(s.model.visionEnabled, v => JIGSAW.SettingsService.update("model", { visionEnabled: v }))),
        row("工具调用", "允许 Agent 节点调用工具。",
          toggleCtrl(s.model.toolsEnabled, v => JIGSAW.SettingsService.update("model", { toolsEnabled: v }))),
        row("采样温度", "模拟回复的随机程度。",
          rangeCtrl(s.model.temperature, 0, 1, 0.1, v => JIGSAW.SettingsService.update("model", { temperature: v })))
      )
    ];
  }

  function sectionApi(s) {
    const testBtn = h("button", { class: "btn btn-sm" }, "测试");
    const onTest = async () => {
      if (JIGSAW.Http.isRemote()) {
        testBtn.disabled = true;
        testBtn.textContent = "测试中…";
        try {
          const res = await JIGSAW.Http.health();
          JIGSAW.SettingsService.update("api", { connected: true });
          JIGSAW.Toast.show("后端已连接：" + (res.service || "OK"));
        } catch (e) {
          JIGSAW.SettingsService.update("api", { connected: false });
          JIGSAW.Toast.show("连接失败：" + e.message);
        }
        testBtn.disabled = false;
        testBtn.textContent = "测试";
      } else {
        JIGSAW.Toast.show("当前为本地 Mock 模式，切换到「后端 API」后可测试连接");
      }
    };
    testBtn.addEventListener("click", onTest);

    /* ---- 自定义模型（OpenAI 兼容接口）---- */
    const fName = textInput("", () => {});
    const fModel = textInput("", () => {});
    const fBase = textInput("", () => {});
    const fKey = textInput("", () => {});
    fKey.type = "password";

    // editingId = null → 新增模式；有值 → 正在编辑该模型
    let editingId = null;

    const doSave = () => {
      const modelId = fModel.value.trim();
      if (!modelId) { JIGSAW.Toast.show("请填写模型 ID"); return; }
      const payload = {
        name: fName.value.trim() || modelId,
        modelId,
        baseUrl: fBase.value.trim() || "https://api.openai.com/v1",
        apiKey: fKey.value.trim()
      };
      if (editingId) {
        JIGSAW.ModelService.updateCustom(editingId, payload);
        JIGSAW.Toast.show("已保存模型修改");
      } else {
        JIGSAW.ModelService.addCustom(payload);
        JIGSAW.Toast.show("已添加自定义模型");
      }
      // 保存后 store 变更会自动重渲染本页，表单随之清空回到“添加”模式
    };

    const resetForm = () => {
      editingId = null;
      fName.value = ""; fModel.value = ""; fBase.value = ""; fKey.value = "";
      addBtn.textContent = "添加模型";
      cancelBtn.style.display = "none";
      fName.focus();
    };

    const addBtn = h("button", { class: "btn btn-sm btn-primary" }, "添加模型");
    addBtn.addEventListener("click", doSave);
    const cancelBtn = h("button", { class: "btn btn-sm", style: { display: "none" } }, "取消");
    cancelBtn.addEventListener("click", resetForm);
    fModel.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });

    const cmForm = h("div", { class: "cm-form" },
      h("div", { class: "field" }, h("label", null, "名称"), fName),
      h("div", { class: "field" }, h("label", null, "模型 ID（如 gpt-4o）"), fModel),
      h("div", { class: "field full" }, h("label", null, "Base URL"), fBase),
      h("div", { class: "field full" }, h("label", null, "API Key"), fKey),
      h("div", { class: "field full", style: { alignItems: "flex-start" } }, addBtn, cancelBtn)
    );

    const custom = s.model.custom || [];
    const cmList = h("div", null,
      custom.length ? custom.map(m =>
        h("div", { class: "custom-model-row" },
          h("div", { class: "cm-info" },
            h("div", { class: "cm-name" }, m.name),
            h("div", { class: "cm-meta" }, m.modelId + " · " + (m.baseUrl || ""))
          ),
          h("div", { class: "cm-actions" },
            h("button", { class: "icon-btn", "data-edit-cm": m.id, title: "设置模型" }, Icons.icon("edit", 13)),
            h("button", { class: "icon-btn", "data-del-cm": m.id, title: "删除模型" }, Icons.icon("trash", 13))
          )
        )
      ) : h("div", { class: "cm-empty" }, "还没有自定义模型——添加后即可在输入框旁的模型选择器中使用。")
    );

    // “设置”按钮：把该模型的值回填到上方表单，进入编辑模式
    els("[data-edit-cm]", cmList).forEach(b => b.addEventListener("click", () => {
      const m = (Store.get().settings.model.custom || []).find(x => x.id === b.dataset.editCm);
      if (!m) return;
      editingId = m.id;
      fName.value = m.name || "";
      fModel.value = m.modelId || "";
      fBase.value = m.baseUrl || "";
      fKey.value = m.apiKey || "";
      addBtn.textContent = "保存修改";
      cancelBtn.style.display = "";
      cmForm.scrollIntoView({ behavior: "smooth", block: "center" });
      fName.focus();
    }));

    return [
      h("div", { class: "settings-section-title" }, "API"),
      h("div", { class: "settings-section-sub" }, "为你的真实 LLM / Agent 运行时预留，当前为模拟实现。"),
      h("div", { class: "settings-card" },
        row("数据源", "本地 Mock 直接在前端模拟回复；后端 API 将聊天请求发送到 FastAPI 服务。",
          selectCtrl([["mock", "本地 Mock"], ["remote", "后端 API"]], s.api.mode, v => JIGSAW.SettingsService.update("api", { mode: v }))),
        row("服务商", "后端服务提供商。",
          selectCtrl([["openai", "OpenAI 兼容"], ["custom", "自定义"]], s.api.provider, v => JIGSAW.SettingsService.update("api", { provider: v }))),
        row("接口地址", "前端连接后端服务的地址（本地后端为 http://127.0.0.1:8000）。",
          textInput(s.api.baseUrl, v => JIGSAW.SettingsService.update("api", { baseUrl: v }))),
        row("连接状态", "测试连接会向后端 /api/health 发送探测请求。",
          h("span", { class: "badge " + (s.api.connected ? "badge-success" : "badge-waiting") }, s.api.connected ? "已连接" : "未连接"))
      ),
      h("div", { class: "settings-card" },
        row("测试连接", "向配置的接口发送探测请求。", testBtn)
      ),
      h("div", { class: "settings-section-title", style: { marginTop: "var(--sp-5)" } }, "自定义模型"),
      h("div", { class: "settings-section-sub" }, "添加 OpenAI 兼容接口的模型，添加后可在首页与聊天的模型选择器中选用。"),
      h("div", { class: "settings-card" }, cmForm),
      h("div", { class: "settings-card", style: { borderTop: "1px solid var(--line-1)" } }, cmList)
    ];
  }

  function sectionWorkflow(s) {
    return [
      h("div", { class: "settings-section-title" }, "工作流"),
      h("div", { class: "settings-card" },
        row("默认模板", "新建会话使用的 Agent 链。",
          selectCtrl(Object.entries(JIGSAW.WorkflowService.TEMPLATE_META).map(([k, m]) => [k, m.name]), s.workflow.defaultTemplate, v => JIGSAW.SettingsService.update("workflow", { defaultTemplate: v }))),
        row("执行速度", "节点执行的模拟速度。",
          selectCtrl([["slow", "慢"], ["normal", "正常"], ["fast", "快"]], s.workflow.executionSpeed, v => JIGSAW.SettingsService.update("workflow", { executionSpeed: v }))),
        row("自动运行", "每次回复后自动启动工作流。",
          toggleCtrl(s.workflow.autoRun, v => JIGSAW.SettingsService.update("workflow", { autoRun: v }))),
        row("网格大小", "画布网格单元的尺寸（像素）。",
          rangeCtrl(s.workflow.gridSize, 20, 80, 10, v => JIGSAW.SettingsService.update("workflow", { gridSize: v })))
      )
    ];
  }

  /* ---- 统计：工具调用次数 + 记录起始时刻 + 重置 ---- */
  function sectionStats(s) {
    const TS = JIGSAW.ToolService;
    const st = TS.stats() || {};
    const calls = st.calls || {};
    const total = Number(st.total || 0);
    const rows = Object.keys(calls)
      .map(k => [k, Number(calls[k] || 0)])
      .filter(pair => pair[1] > 0)
      .sort((a, b) => b[1] - a[1]);

    const resetBtn = h("button", { class: "btn btn-sm" }, "重置统计");
    resetBtn.addEventListener("click", async () => {
      const ok = await JIGSAW.PromptModal.confirm({
        title: "重置调用统计",
        message: "所有工具的调用次数会清零，并把「记录起始」更新为当前时刻。确定重置吗？",
        okText: "重置"
      });
      if (!ok) return;
      resetBtn.disabled = true;
      try {
        await TS.resetStats();
        JIGSAW.Toast.show("已重置统计");
        renderContent();
      } catch (e) {
        JIGSAW.Toast.show("重置失败：" + (e.message || ""));
      } finally {
        resetBtn.disabled = false;
      }
    });

    const countsBox = rows.length
      ? rows.map(([name, v]) => {
          const meta = TS.getMeta(name);
          return h("div", { class: "stat-line" },
            h("span", { class: "stat-line-name" }, (meta && meta.label) || name),
            h("span", { class: "stat-line-val" }, v + " 次")
          );
        })
      : h("div", { class: "stat-empty" }, "还没有调用记录。让 AI 用一次工具就会出现在这里。");

    // 拿不到统计（多为后端没重启、新接口未生效）时，给明确提示而不是干瘪的"—"
    const missing = JIGSAW.Http.isRemote() && !TS.hasStats();
    const sinceLine = missing
      ? "未获取到统计 —— 请重启后端（本次更新新增了 /api/stats 接口）。"
      : "该统计自 " + TS.sinceText() + " 开始记录（每 3 秒自动刷新）。";

    return [
      h("div", { class: "settings-section-title" }, "统计"),
      // ★ 起始时刻放在标题正下方：一眼能看到，不用滚动
      h("div", { class: "settings-section-sub" + (missing ? " stat-warn" : "") }, sinceLine),
      h("div", { class: "settings-card" },
        row("记录起始", "统计自该时刻开始记录（重置统计会同时更新它）。",
          h("span", { class: "stat-value" }, missing ? "—" : TS.sinceText())),
        row("累计调用", "所有工具的调用次数总和。",
          h("span", { class: "stat-value" }, total + " 次")),
        row("重置统计", "清零所有计数，并把记录起始时间更新为当前时刻。", resetBtn)
      ),
      h("div", { class: "settings-section-title", style: { marginTop: "var(--sp-5)" } }, "各工具调用次数"),
      h("div", { class: "settings-card" }, countsBox)
    ];
  }

  function sectionAbout(s) {
    return [
      h("div", { class: "settings-section-title" }, "关于"),
      h("div", { class: "settings-card" },
        h("div", { class: "about-block", style: { padding: "var(--sp-5)" } },
          h("div", { class: "about-logo" },
            h("div", { class: "jigsaw-mark" },
              h("span", { class: "cell" }), h("span", { class: "cell" }),
              h("span", { class: "cell" }), h("span", { class: "cell" })
            ),
            h("div", null,
              h("div", { class: "headline", style: { fontSize: "18px", fontWeight: "700", letterSpacing: ".2em" } }, "JIGSAW"),
              h("div", { class: "about-version" }, "v" + s.about.version + " · " + s.about.build)
            )
          ),
          h("div", { class: "about-links" },
            h("a", { class: "link", href: "https://github.com/Wukeeeeee/JIGSAW", target: "_blank", rel: "noopener" }, Icons.icon("link", 13), "文档"),
            h("a", { class: "link", href: "https://github.com/Wukeeeeee/JIGSAW", target: "_blank", rel: "noopener" }, Icons.icon("code", 13), "源代码")
          )
        )
      ),
      h("div", { class: "settings-section-sub", style: { marginTop: "var(--sp-3)" } },
        "JIGSAW 是一个前端外壳。对话与工作流服务均为模拟实现，替换服务层即可接入你自己的 AI 运行时。")
    ];
  }

  const RENDERERS = { general: sectionGeneral, appearance: sectionAppearance, model: sectionModel, api: sectionApi, workflow: sectionWorkflow, stats: sectionStats, about: sectionAbout };

  /* ---- 视图 ---- */
  function renderContent(keepScroll) {
    const s = Store.get().settings;
    const scrollTop = contentEl.scrollTop;   // 自动刷新时别把用户滚动位置重置掉
    contentEl.innerHTML = "";
    const inner = h("div", { class: "settings-inner" });
    RENDERERS[current](s).forEach(n => inner.appendChild(n));
    contentEl.appendChild(inner);

    // 自定义模型删除
    els('[data-del-cm]', contentEl).forEach(b => b.addEventListener("click", async () => {
      const m = (Store.get().settings.model.custom || []).find(x => x.id === b.dataset.delCm);
      const ok = await JIGSAW.PromptModal.confirm({
        title: "删除模型",
        message: `删除模型「${m ? m.name : b.dataset.delCm}」？已用它开的会话会回退到其他模型。`,
        okText: "删除",
        danger: true
      });
      if (!ok) return;
      JIGSAW.ModelService.removeCustom(b.dataset.delCm);
      JIGSAW.Toast.show("已删除自定义模型");
    }));

    if (keepScroll) contentEl.scrollTop = scrollTop;
  }

  /* 统计页自动刷新：以前只在进入页面时拉一次，工具调用后数字永远是旧的 */
  let statsTimer = null;
  function startStatsPolling() {
    stopStatsPolling();
    if (!JIGSAW.Http.isRemote()) return;
    statsTimer = setInterval(() => {
      if (current !== "stats") { stopStatsPolling(); return; }
      JIGSAW.ToolService.loadStats().catch(() => {});   // 拿到新数据会广播 "stats"
    }, 3000);
  }
  function stopStatsPolling() {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  }

  const Settings = {
    mount(root) {
      container = root;
      JIGSAW.setViewClass(root, "view-settings");
      root.innerHTML = "";

      const top = h("div", { class: "topbar settings-topbar" },
        h("button", { class: "icon-btn", "data-back-s": "1", title: "返回" }, Icons.icon("back")),
        h("div", { class: "topbar-title", style: { marginLeft: "var(--sp-1)" } }, "设置")
      );

      const nav = h("div", { class: "settings-nav" });
      SECTIONS.forEach(sec => {
        const item = h("button", { class: "settings-nav-item" + (sec.id === current ? " active" : ""), "data-sec": sec.id },
          Icons.icon(sec.icon, 14), h("span", null, sec.label));
        item.addEventListener("click", () => {
          current = sec.id;
          els(".settings-nav-item", nav).forEach(x => x.classList.toggle("active", x.dataset.sec === current));
          renderContent();
          // 统计页：先渲染缓存，再拉一次最新统计，并开始 3 秒自动刷新
          if (sec.id === "stats") {
            JIGSAW.ToolService.loadStats().then(() => renderContent()).catch(() => {});
            startStatsPolling();
          } else {
            stopStatsPolling();
          }
        });
        nav.appendChild(item);
      });

      contentEl = h("div", { class: "settings-content" });
      const body = h("div", { class: "settings-body" });
      body.append(nav, contentEl);
      root.append(top, body);
      renderContent();

      el("[data-back-s]", root).addEventListener("click", () => JIGSAW.Router.goBack());

      unsubs.push(Store.subscribe("settings", renderContent));
      // 统计有更新（工具被调用 / 任务完成）→ 正在看统计页就立刻重画
      unsubs.push(Store.subscribe("stats", () => {
        if (current === "stats") renderContent(true);
      }));

      // 直接落在统计页时：拉一次并开启自动刷新
      if (current === "stats") {
        JIGSAW.ToolService.loadStats().then(() => renderContent()).catch(() => {});
        startStatsPolling();
      }
    },

    unmount() {
      stopStatsPolling();
      unsubs.forEach(u => u());
      unsubs = [];
    }
  };

  JIGSAW.Views = JIGSAW.Views || {};
  JIGSAW.Views.Settings = Settings;
})();
