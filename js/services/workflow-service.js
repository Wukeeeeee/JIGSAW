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
      // 确保存在固定任务起点 START 节点
      if (wf && wf.nodes && !wf.nodes.some(n => n.agentType === "start")) {
        const hasOtherNodes = wf.nodes.length > 0;
        let minX = Infinity, minY = 80;
        if (hasOtherNodes) {
          wf.nodes.forEach(n => { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); });
        }
        const startX = hasOtherNodes ? Math.min(-280, minX - 290) : 80;
        const startY = hasOtherNodes ? minY : 80;
        const startNode = {
          id: convId + "-n-start",
          agentType: "start",
          category: "logic",
          name: "START · 任务起点",
          icon: "play",
          description: "工作流唯一固定源头：负责接收 Prompt 或初始任务目标向后派发。",
          modelId: "",
          systemPrompt: "【任务起点】工作流源头输入。",
          tools: [],
          input: "用户输入 / 任务目标",
          output: "初始任务提示词",
          status: "waiting",
          x: startX,
          y: startY
        };
        wf.nodes.unshift(startNode);
        // 如果有首个节点且没有连线，自动从起点连过去
        const firstAgent = wf.nodes.find(n => n.agentType !== "start");
        if (firstAgent && !wf.edges.some(e => e.to === firstAgent.id)) {
          wf.edges.unshift({ id: convId + "-e-start", from: startNode.id, to: firstAgent.id });
        }
      }
      return wf;
    },

    get(id) { return Store.get().workflows[id]; },

    /** available agent templates for adding new nodes */
    templates() {
      return Object.keys(AGENTS)
        .filter(k => AGENTS[k].category === "logic" || k === "custom_agent")
        .map(k => ({
          type: k,
          name: AGENTS[k].name,
          icon: AGENTS[k].icon,
          desc: AGENTS[k].desc,
          category: AGENTS[k].category || "agent"
        }));
    },

    isEditable(wf, nodeId) {
      const node = wf.nodes.find(n => n.id === nodeId);
      return !!node && node.status === "waiting";
    },

    addNode(wfId, agentType, x, y) {
      const wf = this.get(wfId);
      if (!wf || wf.running) return null;
      const a = AGENTS[agentType] || AGENTS.custom_agent || AGENTS.research;
      const id = uid(wfId + "-n");
      const active = JIGSAW.ModelService.getActive();
      const isLogic = a.category === "logic";
      const node = {
        id, agentType: a.type, category: a.category || "agent", name: a.name, icon: a.icon,
        description: a.desc, modelId: isLogic ? "" : ((active && active.id) || a.defaultModel),
        systemPrompt: a.systemPrompt, tools: isLogic ? [] : a.tools.slice(),
        input: "", output: "", status: "waiting", x, y,
        gateType: a.type.startsWith("gate_") ? a.type.replace("gate_", "").toUpperCase() : null,
        loopMax: a.type === "loop_ctrl" ? 3 : null,
        maxToolCalls: isLogic ? null : (a.maxToolCalls || 5),
        onError: "abort",
        skipped: false,
        fallbackValue: ""
      };
      wf.nodes.push(node);
      Store.notify("workflows");
      return node;
    },

    removeNode(wfId, nodeId) {
      const wf = this.get(wfId);
      if (!wf || wf.running) return false;
      const node = wf.nodes.find(n => n.id === nodeId);
      if (node && node.agentType === "start") return false; // 固定任务起点不可删除
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
      if (!this.isEditable(wf, nodeId) && ("name" in patch || "description" in patch || "systemPrompt" in patch || "tools" in patch || "modelId" in patch || "onError" in patch || "fallbackValue" in patch || "maxToolCalls" in patch)) {
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
      const toNode = wf.nodes.find(n => n.id === toId);
      if (toNode && toNode.agentType === "start") return false; // 任务起点不能被输入连线
      if (!this.isEditable(wf, fromId) || !this.isEditable(wf, toId)) return false;
      if (wf.edges.some(e => e.from === fromId && e.to === toId)) return false;
      const isLoop = this.createsCycle(wf, fromId, toId);
      wf.edges.push({ id: uid(wfId + "-e"), from: fromId, to: toId, isLoop });
      Store.notify("workflows");
      return true;
    },

    removeEdge(wfId, edgeId) {
      const wf = this.get(wfId);
      if (!wf || wf.running) return false;
      const edge = wf.edges.find(e => e.id === edgeId);
      if (!edge) return false;
      wf.edges = wf.edges.filter(e => e.id !== edgeId);
      const ui = Store.get().ui;
      if (ui.selectedEdgeId === edgeId) ui.selectedEdgeId = null;
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
      wf.nodes.forEach(n => {
        n.status = "waiting";
        n.skipped = false;
      });
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
