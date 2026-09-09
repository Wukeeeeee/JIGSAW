/* ============================================================
   JIGSAW — Hash Router
   Routes:
     #/                     → Home
     #/chat/:id             → Chat
     #/chat/:id/workflow    → Workflow
     #/settings             → Settings
   ============================================================ */
(function () {
  const routes = [];
  let container = null;

  function parse(hash) {
    const h = (hash || "").replace(/^#\/?/, "");
    const parts = h.split("/").filter(Boolean);
    for (const r of routes) {
      const m = r.match(parts);
      if (m) return { route: r, params: m };
    }
    return { route: null, params: {} };
  }

  const Router = {
    register(pattern, handler) { routes.push({ pattern, match: toRegex(pattern), handler }); },

    current() { return parse(location.hash); },

    mount(el) { container = el; },

    navigate(path) {
      if (location.hash === "#" + path) { this.render(); return; }
      location.hash = path;
    },

    /** re-render current route (also called on hashchange) */
    render() {
      if (!container) return;
      const { route, params } = parse(location.hash);
      container.innerHTML = "";
      if (route && route.handler) {
        route.handler(container, params);
      } else {
        // default → home
        const r = routes.find(r => r.pattern === "#/");
        if (r) r.handler(container, {});
      }
    }
  };

  function toRegex(pattern) {
    const parts = pattern.replace(/^#\/?/, "").split("/").filter(Boolean);
    return function (pathParts) {
      if (parts.length !== pathParts.length) return null;
      const params = {};
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].startsWith(":")) params[parts[i].slice(1)] = decodeURIComponent(pathParts[i]);
        else if (parts[i] !== pathParts[i]) return null;
      }
      return params;
    };
  }

  window.addEventListener("hashchange", () => Router.render());
  JIGSAW.Router = Router;
})();
