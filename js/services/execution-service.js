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
      const done = wf.nodes.filter(n => n.status === "success" || n.status === "failed" || n.status === "skipped").length;
      return { running: wf.running, done, total: wf.nodes.length };
    },

    /** run the whole pipeline sequentially */
    async start(convId) {
      const wf = WorkflowService.getForConversation(convId);
      if (!wf || wf.running) return;

      // reset then run
      wf.nodes.forEach(n => {
        n.status = "waiting";
        n.skipped = false;
      });
      wf.running = true;
      wf.executed = false;
      Store.notify("workflows");

      // 中断令牌：stop() 置 cancelled=true，循环检测后立即停
      const token = { cancelled: false };
      runs.set(wf.id, token);

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

      try {
        for (const nodeId of ordered) {
          if (token.cancelled) break;
          const node = wf.nodes.find(n => n.id === nodeId);
          if (!node) continue;
          node.status = "running";
          Store.notify("workflows");
          await delay(base + Math.random() * 500);
          if (token.cancelled) { node.status = "failed"; break; }

          // 容错与异常处理：若该节点模拟异常或发生故障
          if (node.simulateError) {
            if (node.onError === "skip") {
              node.status = "skipped";
              node.skipped = true;
              node.output = node.fallbackValue || JSON.stringify({
                status: "skipped",
                skipped: true,
                message: "【容错策略生效】调用异常，已自动跳过该节点并放行下游。"
              }, null, 2);
              Store.notify("workflows");
              await delay(120);
              continue; // 容错成功，不中断流水线
            } else if (node.onError === "fallback") {
              node.status = "skipped";
              node.skipped = true;
              node.output = node.fallbackValue || "【兜底数据】服务未响应，注入预设备选数据继续执行。";
              Store.notify("workflows");
              await delay(120);
              continue; // 容错成功，不中断流水线
            } else {
              node.status = "failed";
              node.skipped = false;
              node.output = "【异常报错】节点执行失败且未开启自动容错，流水线已终止。";
              Store.notify("workflows");
              break; // 中断报错
            }
          }

          node.status = "success";
          node.skipped = false;
          Store.notify("workflows");
          await delay(120);
        }
      } finally {
        // 无论正常完成还是被 stop，都要释放锁，否则画布永久不可编辑
        runs.delete(wf.id);
        wf.running = false;
        Store.notify("workflows");
      }

      if (!token.cancelled) {
        wf.executed = true;
        Store.notify("workflows");
      }
    },

    /** soft stop: mark remaining waiting/running as failed and break the loop */
    stop(convId) {
      const wf = WorkflowService.getForConversation(convId);
      if (!wf) return;
      const token = runs.get(wf.id);
      if (token) token.cancelled = true;   // 真正的中断信号
      wf.nodes.forEach(n => { if (n.status === "waiting" || n.status === "running") n.status = "failed"; });
      wf.running = false;
      Store.notify("workflows");
    },

    /** 启动自愈：页面刷新/切换导致上次运行中断时，解锁卡死的画布 */
    recover(convId) {
      const wf = WorkflowService.getForConversation(convId);
      if (!wf || !wf.running) return;
      // 本页面没有活动运行，但 wf.running 为 true → 上次运行已经死了，强制解锁
      if (!runs.has(wf.id)) {
        wf.running = false;
        wf.nodes.forEach(n => { if (n.status === "running") n.status = "waiting"; });
        Store.notify("workflows");
      }
    }
  };

  JIGSAW.ExecutionService = ExecutionService;
})();
