/* ============================================================
   JIGSAW — App entry
   Bootstraps store with mock data, registers routes,
   mounts history drawer + toasts.
   ============================================================ */
(function () {
  const { h, el, els, Icons } = JIGSAW;
  const Store = JIGSAW.Store;

  /* ---------- toast ---------- */
  const Toast = {
    root: null,
    init() {
      this.root = h("div", { class: "toast-root" });
      document.body.appendChild(this.root);
    },
    show(text) {
      const t = h("div", { class: "toast" }, Icons.icon("check", 13), h("span", null, text));
      this.root.appendChild(t);
      requestAnimationFrame(() => t.classList.add("show"));
      setTimeout(() => {
        t.classList.remove("show");
        setTimeout(() => t.remove(), 200);
      }, 2200);
    }
  };
  JIGSAW.Toast = Toast;

  /* ---------- bootstrap ---------- */
  function seed() {
    const st = Store.get();
    const { CONVERSATIONS, MODELS } = JIGSAW.Mock;

    st.models = MODELS.map(m => ({ ...m }));
    st.activeModelId = "jigsaw-ultra";
    st.activeConversationId = null;
    st.conversations = CONVERSATIONS.map(c => ({
      ...c,
      messages: c.messages.map(m => ({ ...m }))
    }));

    // materialize workflows (executed flag preserved)
    st.conversations.forEach(c => JIGSAW.WorkflowService.getForConversation(c.id));

    // apply saved settings on top
    JIGSAW.SettingsService.load();

    // 从后端拉回模型配置（持久化：清浏览器缓存也不丢模型）
    JIGSAW.ModelService.syncFromServer();

    // 从后端拉回会话列表（持久化：刷新页面后历史记录还在）
    JIGSAW.ChatService.loadRemote();
  }

  /* ---------- boot ---------- */
  function boot() {
    Toast.init();
    seed();

    const app = el("#app");
    const viewRoot = h("div", { id: "view" });
    const drawerRoot = h("div", { id: "history-root" });
    app.append(viewRoot, drawerRoot);

    JIGSAW.HistoryDrawer.init(drawerRoot);
    JIGSAW.Router.mount(viewRoot);

    // unload current view before navigating
    let currentView = null;
    let lastPath = null;
    const baseMount = JIGSAW.Router.render;
    const origNavigate = JIGSAW.Router.navigate;
    JIGSAW.Router.navigate = function (path) {
      const cur = location.hash.replace(/^#/, "") || "/";
      if (cur !== path) lastPath = cur;
      if (currentView && currentView.unmount) currentView.unmount();
      currentView = null;
      origNavigate.call(this, path);
    };
    JIGSAW.Router.goBack = function () {
      const target = (lastPath && !lastPath.startsWith("/settings")) ? lastPath : "/";
      JIGSAW.Router.navigate(target);
    };
    JIGSAW.Router.render = function () {
      if (currentView && currentView.unmount) currentView.unmount();
      currentView = null;
      baseMount.call(this);
    };

    JIGSAW.Router.register("#/", (container, params) => {
      currentView = JIGSAW.Views.Home;
      JIGSAW.Views.Home.mount(container, params);
    });
    JIGSAW.Router.register("#/chat/:id", (container, params) => {
      currentView = JIGSAW.Views.Chat;
      JIGSAW.Views.Chat.mount(container, params);
    });
    JIGSAW.Router.register("#/chat/:id/workflow", (container, params) => {
      currentView = JIGSAW.Views.Workflow;
      JIGSAW.Views.Workflow.mount(container, params);
    });
    JIGSAW.Router.register("#/settings", (container, params) => {
      currentView = JIGSAW.Views.Settings;
      JIGSAW.Views.Settings.mount(container, params);
    });

    JIGSAW.Router.register("#/tools", (container, params) => {
      currentView = JIGSAW.Views.Tools;
      JIGSAW.Views.Tools.mount(container, params);
    });

    JIGSAW.Router.render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
