/* ============================================================
   JIGSAW — 首页视图（欢迎页 / 空状态）
   ============================================================ */
(function () {
  const { h, el, els, Icons } = JIGSAW;
  const Store = JIGSAW.Store;

  let ta = null;
  let currentMode = "chat"; // "chat" | "workflow"

  let imgDd = null;
  let modelDd = null;
  let unsubs = [];

  async function submit(text) {
    text = (text || "").trim();
    if (currentMode === "chat") {
      if (!text) return;
      const activeImg = JIGSAW.ImageService && JIGSAW.ImageService.getActive();
      const activeModel = JIGSAW.ModelService && JIGSAW.ModelService.getActive();
      const conv = JIGSAW.ChatService.create({
        text,
        modelId: activeModel ? activeModel.id : undefined,
        imageModelId: activeImg ? activeImg.id : undefined
      });
      JIGSAW.Router.navigate("/chat/" + conv.id);
    } else {
      // 画布编排模式：
      // 如果输入了内容，按回车或点击直接自动规划生成完整的多智能体工作流！
      const title = text ? text.slice(0, 48) : "未命名工作流";
      const conv = JIGSAW.ChatService.create({ title, text: "" });
      const wf = JIGSAW.WorkflowService.getForConversation(conv.id);
      if (text && wf) {
        const startNode = wf.nodes && wf.nodes.find(n => n.agentType === "start");
        if (startNode) {
          startNode.output = text;
          Store.notify("workflows");
        }
        const activeModel = JIGSAW.ModelService && JIGSAW.ModelService.getActive();
        const sendBtn = el("[data-send]");
        if (sendBtn) {
          sendBtn.disabled = true;
          sendBtn.innerHTML = Icons.icon("loader", 16);
        }
        try {
          await JIGSAW.WorkflowService.autoPlanWorkflow(wf.id, text, activeModel ? activeModel.id : undefined);
        } catch (err) {
          console.warn("主页直接生成工作流异常，进入画布手动编排:", err);
        }
      }
      JIGSAW.Router.navigate("/chat/" + conv.id + "/workflow");
    }
  }

  function renderImageModelSelect() {
    imgDd = JIGSAW.Dropdown.create(
      () => (JIGSAW.ImageService ? JIGSAW.ImageService.list() : []),
      () => (JIGSAW.ImageService && JIGSAW.ImageService.getActive() ? JIGSAW.ImageService.getActive().id : ""),
      id => { if (JIGSAW.ImageService) JIGSAW.ImageService.setActive(id); },
      { icon: "image", placeholder: "生图模型", emptyText: "未配置生图模型", title: "AI 绘图模型 (Image Model)" }
    );
    return imgDd;
  }

  function renderModelSelect() {
    modelDd = JIGSAW.Dropdown.create(
      () => JIGSAW.ModelService.list(),
      () => (JIGSAW.ModelService && JIGSAW.ModelService.getActive() ? JIGSAW.ModelService.getActive().id : ""),
      id => JIGSAW.ModelService.setActive(id)
    );
    return modelDd;
  }

  const Home = {
    mount(container) {
      JIGSAW.setViewClass(container, "view-home");
      container.innerHTML = "";
      currentMode = "chat"; // 每次挂载重置为默认对话模式

      const st = Store.get();
      const showTagline = st.settings.appearance.showHomeTagline;

      const view = h("div", { class: "view-home" },
        h("div", { class: "home-top" },
          h("button", { class: "icon-btn", "data-history": "1", title: "历史记录" }, Icons.icon("menu")),
          h("div", { class: "home-top-right" },
            h("button", { class: "icon-btn", "data-tools": "1", title: "工具" }, Icons.icon("tool")),
            h("button", { class: "icon-btn", "data-kb": "1", title: "知识库" }, Icons.icon("book")),
            h("button", { class: "icon-btn", "data-settings": "1", title: "设置" }, Icons.icon("sliders"))
          )
        ),

        h("div", { class: "home-center" },
          h("div", { class: "jigsaw-mark" },
            h("span", { class: "cell" }), h("span", { class: "cell" }),
            h("span", { class: "cell" }), h("span", { class: "cell" })
          ),
          h("div", { class: "home-wordmark" }, "JIGSAW"),

          h("div", { class: "home-input-wrap" },
            h("div", { class: "home-mode-switch" },
              h("button", { class: "home-mode-tab active", "data-mode": "chat", type: "button" },
                Icons.icon("message", 12),
                h("span", null, "对话模式 · Chat")
              ),
              h("button", { class: "home-mode-tab", "data-mode": "workflow", type: "button" },
                Icons.icon("branch", 12),
                h("span", null, "画布编排 · Workflow")
              )
            ),
            h("div", { class: "home-input" },
              h("textarea", { rows: "1", placeholder: "给 JIGSAW 发消息…", "data-input": "1"}),
              h("div", { class: "home-input-actions" },
                h("button", { class: "cwd-btn", "data-cwd": "1", title: "选择目录，进入项目工作" }, "项目"),
                h("div", { class: "home-input-actions-right" },
                  h("div", { class: "perm-dd", "data-perm-dd": "1", title: "权限级别" }),
                  h("div", { class: "img-dd", title: "AI 绘图模型" }, renderImageModelSelect()),
                  renderModelSelect(),
                  h("button", { class: "send-btn", "data-send": "1", title: "发送" }, Icons.icon("arrowUp", 16))
                )
              )
            )
          )
        )
      );
      container.appendChild(view);

      ta = el(".home-input textarea", view);
      const send = el("[data-send]", view);

      const autosize = () => {
        ta.style.height = "0px";                       // 先归零，强制重新计算内容高度
        const h = Math.min(180, Math.max(28, ta.scrollHeight));
        ta.style.height = h + "px";
        ta.style.overflowY = h >= 180 ? "auto" : "hidden";
      };
      ta.addEventListener("input", autosize);
      ta.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(ta.value); }
      });
      send.addEventListener("click", () => submit(ta.value));

      // 双模式切换逻辑
      const modeTabs = els(".home-mode-tab", view);
      const updateMode = mode => {
        currentMode = mode;
        modeTabs.forEach(t => t.classList.toggle("active", t.dataset.mode === mode));
        if (mode === "chat") {
          ta.placeholder = "给 JIGSAW 发消息…";
          send.title = "发送";
          send.innerHTML = Icons.icon("arrowUp", 16);
          send.classList.remove("send-btn-wf");
        } else {
          ta.placeholder = "设定工作流初始任务目标（可选，留空直接进入空白画布）…";
          send.title = "开启工作流编排";
          send.innerHTML = Icons.icon("arrowUpRight", 16);
          send.classList.add("send-btn-wf");
        }
      };
      modeTabs.forEach(tab => {
        tab.addEventListener("click", () => {
          updateMode(tab.dataset.mode);
          ta.focus();
        });
      });

      el("[data-history]", view).addEventListener("click", () => JIGSAW.HistoryDrawer.toggle());
      el("[data-tools]", view).addEventListener("click", () => JIGSAW.Router.navigate("/tools"));
      el("[data-kb]", view).addEventListener("click", () => JIGSAW.Router.navigate("/knowledge"));
      el("[data-settings]", view).addEventListener("click", () => JIGSAW.Router.navigate("/settings"));

      // "项目"按钮：未开启点它 → 选目录进入；已开启点主体 → 换目录；点 × → 退出
      const cwdBtn = el("[data-cwd]", view);
      const shortPath = p => { const parts = String(p || "").split(/[\\/]+/).filter(Boolean); return parts[parts.length - 1] || ""; };
      const refreshCwd = () => {
        if (!cwdBtn) return;
        const on = JIGSAW.ToolService.isCwdProject();
        const p = JIGSAW.ToolService.cwdDisplay();
        cwdBtn.classList.toggle("on", on);
        // 重建内容：folder 图标 + 文字 +（开启时）右侧 ×
        cwdBtn.textContent = "";
        const ic = document.createElement("span");
        ic.className = "cwd-ico";
        ic.innerHTML = Icons.icon("folder", 13);
        cwdBtn.appendChild(ic);
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
      if (JIGSAW.Http.isRemote()) {
        JIGSAW.ToolService.load().then(() => { refreshCwd(); renderPermDD(); });   // 异步取后端状态，取到后刷新
      } else {
        refreshCwd();   // 本地模式：同样渲染 folder 图标与默认权限
        renderPermDD();
      }
      cwdBtn.addEventListener("click", async (e) => {
        // 点 × → 退出项目工作
        if (e.target.closest(".cwd-x")) {
          cwdBtn.classList.toggle("on", false);
          try { await JIGSAW.ToolService.setCwdProject(false); refreshCwd(); }
          catch (err) { cwdBtn.classList.toggle("on", true); JIGSAW.Toast.show("退出失败：" + (err.message || "")); }
          return;
        }
        // 弹系统目录选择框（未开启 = 进入；已开启 = 换目录）
        if (cwdBtn.classList.contains("busy")) return;
        cwdBtn.classList.add("busy");
        try {
          const r = await JIGSAW.ToolService.pickCwdProject();
          if (r && r.ok) {
            refreshCwd();
            JIGSAW.Toast.show("已进入项目工作：" + r.path);
          } else if (r && r.error) {
            // 后端弹框失败 → 手动输入路径兜底
            const path = prompt("后端无法弹出目录选择框，请手动输入工作目录路径：", JIGSAW.ToolService.cwdDisplay());
            if (path && path.trim()) {
              const r2 = await JIGSAW.ToolService.setCwdPath(path.trim());
              if (r2 && r2.ok) { refreshCwd(); JIGSAW.Toast.show("已进入项目工作：" + path.trim()); }
            }
          }
          // 用户取消选择 → 什么都不做
        } catch (e) {
          JIGSAW.Toast.show("目录选择失败：" + (e.message || ""));
        } finally {
          cwdBtn.classList.remove("busy");
        }
      });

      // 监听模型与配置变更，自动刷新下拉选框
      unsubs = [
        Store.subscribe("settings", () => {
          if (imgDd && imgDd.render) imgDd.render();
          if (modelDd && modelDd.render) modelDd.render();
        }),
        Store.subscribe("image-model", () => {
          if (imgDd && imgDd.render) imgDd.render();
        }),
        Store.subscribe("model", () => {
          if (modelDd && modelDd.render) modelDd.render();
        })
      ];

      // 聚焦输入框
      setTimeout(() => ta.focus(), 50);
    },

    unmount() {
      unsubs.forEach(u => typeof u === "function" && u());
      unsubs = [];
    }
  };

  JIGSAW.Views = JIGSAW.Views || {};
  JIGSAW.Views.Home = Home;
})();
