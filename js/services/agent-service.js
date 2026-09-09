/* ============================================================
   JIGSAW — AgentService
   Agent template registry. Swappable against a real catalog.
   ============================================================ */
(function () {
  const { AGENTS } = JIGSAW.Mock;

  const AgentService = {
    list() { return Object.values(AGENTS); },
    get(type) { return AGENTS[type] || AGENTS.research; },
    icon(type) { return (AGENTS[type] && AGENTS[type].icon) || "dot"; }
  };

  JIGSAW.AgentService = AgentService;
})();
