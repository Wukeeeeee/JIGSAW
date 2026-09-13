/* ============================================================
   JIGSAW — 首页视图（欢迎页 / 空状态）
   ============================================================ */
(function () {
  const { h, el, Icons } = JIGSAW;
  const Store = JIGSAW.Store;

  let ta = null;

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
            h("div", { class: "home-input" },
              h("textarea", { rows: "1", placeholder: "给 JIGSAW 发消息…", "data-input": "1"}),
              h("div", { class: "home-input-actions" },
                h("button", { class: "cwd-btn", "data-cwd": "1", title: "选择目录，进入项目工作" }, "项目"),
                h("div", { class: "home-input-actions-right" },
                  h("div", { class: "perm-dd", "data-perm-dd": "1", title: "权限级别" }),
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

      // 聚焦输入框
      setTimeout(() => ta.focus(), 50);
    },

    unmount() { }
  };

  JIGSAW.Views = JIGSAW.Views || {};
  JIGSAW.Views.Home = Home;
})();
