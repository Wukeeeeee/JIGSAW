/* ============================================================
   JIGSAW — WorkflowService
   Read / mutate workflows (nodes, edges, positions).
   Lock rule: only nodes with status "waiting" are editable.
   ============================================================ */
(function () {
  const { buildWorkflow, TEMPLATE_META, AGENTS } = JIGSAW.Mock;
  const Store = JIGSAW.Store;

  const uid = p => p + Math.random().toString(36).slice(2, 8);

  const WorkflowService = {
    TEMPLATE_META,

    /** get workflow for conversation, lazily creating from its template */
    getForConversation(convId) {
      const st = Store.get();
      let wf = st.workflows["wf-" + convId];
      if (!wf) {
        const conv = st.conversations.find(c => c.id === convId);
        const tplKey = (conv && conv.workflowTemplate) || "default";
        const executed = !!(conv && conv.workflowExecuted);
        wf = buildWorkflow(convId, tplKey, executed);
        st.workflows[wf.id] = wf;
        Store.notify("workflows");
      }
      return wf;
    },

    get(id) { return Store.get().workflows[id]; },

    /** available agent templates for adding new nodes */
    templates() {
      return Object.keys(AGENTS).map(k => ({ type: k, name: AGENTS[k].name, icon: AGENTS[k].icon, desc: AGENTS[k].desc }));
    },

    isEditable(wf, nodeId) {
      const node = wf.nodes.find(n => n.id === nodeId);
      return !!node && node.status === "waiting";
    },

    addNode(wfId, agentType, x, y) {
      const wf = this.get(wfId);
      if (!wf || wf.running) return null;
      const a = AGENTS[agentType] || AGENTS.research;
      const id = uid(wfId + "-n");
      // 模板里的 defaultModel 是占位的假 id（jigsaw-ultra 之类），
      // 新建节点直接用当前实际可用的模型，省得每个节点都显示"未选择模型"
      const active = JIGSAW.ModelService.getActive();
      const node = {
        id, agentType: a.type, name: a.name, icon: a.icon,
        description: a.desc, modelId: (active && active.id) || a.defaultModel,
        systemPrompt: a.systemPrompt, tools: a.tools.slice(),
        input: "", output: "", status: "waiting", x, y
      };
      wf.nodes.push(node);
      Store.notify("workflows");
      return node;
    },

    removeNode(wfId, nodeId) {
      const wf = this.get(wfId);
      if (!wf || wf.running) return false;
      if (!this.isEditable(wf, nodeId)) return false;
      wf.nodes = wf.nodes.filter(n => n.id !== nodeId);
      wf.edges = wf.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
      const ui = Store.get().ui;
      if (ui.selectedNodeId === nodeId) ui.selectedNodeId = null;
      Store.notify("workflows");
      return true;
    },

    updateNode(wfId, nodeId, patch) {
      const wf = this.get(wfId);
      const node = wf && wf.nodes.find(n => n.id === nodeId);
      if (!node) return false;
      if (!this.isEditable(wf, nodeId) && ("name" in patch || "description" in patch || "systemPrompt" in patch || "tools" in patch || "modelId" in patch)) {
        return false; // locked content
      }
      Object.assign(node, patch);
      Store.notify("workflows");
      return true;
    },

    moveNode(wfId, nodeId, x, y) {
      const wf = this.get(wfId);
      const node = wf && wf.nodes.find(n => n.id === nodeId);
      if (!node || wf.running) return;
      if (!this.isEditable(wf, nodeId)) return;
      node.x = Math.round(x); node.y = Math.round(y);
      Store.notify("workflows");
    },

    addEdge(wfId, fromId, toId) {
      const wf = this.get(wfId);
      if (!wf || wf.running) return false;
      if (fromId === toId) return false;
      if (!this.isEditable(wf, fromId) || !this.isEditable(wf, toId)) return false;
      if (wf.edges.some(e => e.from === fromId && e.to === toId)) return false;
      if (this.createsCycle(wf, fromId, toId)) return false;
      wf.edges.push({ id: uid(wfId + "-e"), from: fromId, to: toId });
      Store.notify("workflows");
      return true;
    },

    removeEdge(wfId, edgeId) {
      const wf = this.get(wfId);
      if (!wf || wf.running) return false;
      const edge = wf.edges.find(e => e.id === edgeId);
      if (!edge) return false;
      if (!this.isEditable(wf, edge.from) || !this.isEditable(wf, edge.to)) return false;
      wf.edges = wf.edges.filter(e => e.id !== edgeId);
      Store.notify("workflows");
      return true;
    },

    /** cycle check: would to→from path exist already? */
    createsCycle(wf, fromId, toId) {
      const adj = {};
      wf.edges.forEach(e => { (adj[e.from] = adj[e.from] || []).push(e.to); });
      const seen = new Set();
      const stack = [toId];
      while (stack.length) {
        const n = stack.pop();
        if (n === fromId) return true;
        if (seen.has(n)) continue;
        seen.add(n);
        (adj[n] || []).forEach(t => stack.push(t));
      }
      return false;
    },

    /** unlock all nodes back to waiting (before re-run) */
    reset(wfId) {
      const wf = this.get(wfId);
      if (!wf || wf.running) return;
      wf.nodes.forEach(n => { n.status = "waiting"; });
      wf.executed = false;
      Store.notify("workflows");
    },

    rename(wfId, name) {
      const wf = this.get(wfId);
      if (!wf) return;
      wf.name = name;
      Store.notify("workflows");
    }
  };

  JIGSAW.WorkflowService = WorkflowService;
})();
