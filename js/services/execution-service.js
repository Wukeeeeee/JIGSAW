/* ============================================================
   JIGSAW — ExecutionService
   Simulates agent workflow execution in topological order.
   Locks nodes as they complete (completed/running not editable).
   ============================================================ */
(function () {
  const Store = JIGSAW.Store;
  const WorkflowService = JIGSAW.WorkflowService;

  const runs = new Map(); // wfId -> timer handle

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  const ExecutionService = {
    isRunning(convId) {
      const wf = WorkflowService.getForConversation(convId);
      return !!(wf && wf.running);
    },

    status(convId) {
      const wf = WorkflowService.getForConversation(convId);
      if (!wf) return { running: false, done: 0, total: 0 };
      const done = wf.nodes.filter(n => n.status === "success" || n.status === "failed").length;
      return { running: wf.running, done, total: wf.nodes.length };
    },

    /** run the whole pipeline sequentially */
    async start(convId) {
      const wf = WorkflowService.getForConversation(convId);
      if (!wf || wf.running) return;

      // reset then run
      wf.nodes.forEach(n => { n.status = "waiting"; });
      wf.running = true;
      wf.executed = false;
      Store.notify("workflows");

      const speed = Store.get().settings.workflow.executionSpeed;
      const base = speed === "slow" ? 2600 : speed === "fast" ? 800 : 1500;

      // topological order: keep original node order (chain), then any stragglers
      const ordered = [];
      const froms = new Set(wf.edges.map(e => e.from));
      wf.edges.forEach(e => {
        if (!ordered.includes(e.from)) ordered.push(e.from);
        if (!ordered.includes(e.to)) ordered.push(e.to);
      });
      wf.nodes.forEach(n => { if (!ordered.includes(n.id)) ordered.push(n.id); });

      for (const nodeId of ordered) {
        const node = wf.nodes.find(n => n.id === nodeId);
        if (!node) continue;
        node.status = "running";
        Store.notify("workflows");
        await delay(base + Math.random() * 500);
        node.status = "success";
        Store.notify("workflows");
        await delay(120);
      }

      wf.running = false;
      wf.executed = true;
      Store.notify("workflows");
      if (runs.has(wf.id)) { clearTimeout(runs.get(wf.id)); runs.delete(wf.id); }
    },

    /** soft stop: mark remaining waiting as failed */
    stop(convId) {
      const wf = WorkflowService.getForConversation(convId);
      if (!wf || !wf.running) return;
      const handle = runs.get(wf.id);
      if (handle) { clearTimeout(handle); runs.delete(wf.id); }
      wf.nodes.forEach(n => { if (n.status === "waiting") n.status = "failed"; });
      wf.running = false;
      Store.notify("workflows");
    }
  };

  JIGSAW.ExecutionService = ExecutionService;
})();
