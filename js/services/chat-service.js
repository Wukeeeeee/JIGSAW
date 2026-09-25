/* ============================================================
   JIGSAW — ChatService
   Conversations + messages. Mock: canned responses with
   streaming. Swap for a real LLM-backed implementation.
   ============================================================ */
(function () {
  const Store = JIGSAW.Store;
  const { pickCanned } = JIGSAW.Mock;
  const WorkflowService = JIGSAW.WorkflowService;

  const uid = p => p + Math.random().toString(36).slice(2, 9);
  const now = () => new Date().toISOString();

  // 每个任务"已经弹过的提问序号"：防止同一个问题被反复弹窗
  JIGSAW._askShownSeq = JIGSAW._askShownSeq || {};

  function detectTemplate(text) {
    return "void";
  }

  const ChatService = {
    list() {
      return Store.get().conversations.slice()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },

    get(id) { return Store.get().conversations.find(c => c.id === id) || null; },

    /**
     * loadRemote() → 启动时从后端拉会话列表，填进前端 store
     * 这样刷新页面后，历史记录显示的是后端文件里持久化的会话。
     */
    async loadRemote() {
      if (!JIGSAW.Http.isRemote()) return;          // 本地 mock 模式不用拉
      try {
        const data = await JIGSAW.Http.listConversations();
        const remote = data.conversations || [];
        if (!remote.length) return;
        const st = Store.get();
        remote.forEach(rc => {                       // 后端数据覆盖前端（id 相同就更新）
          const i = st.conversations.findIndex(l => l.id === rc.id);
          if (i >= 0) st.conversations[i] = rc; else st.conversations.push(rc);
        });
        Store.notify("conversations");
      } catch (e) {
        console.warn("拉取会话列表失败", e);          // 后端没起不影响本地 mock 使用
      }
    },

    create({ title, text, modelId, imageModelId }) {
      const convId = uid("c");
      const template = detectTemplate(text);
      const conv = {
        id: convId, title: title || text.slice(0, 48) || "New chat",
        modelId: modelId || Store.get().activeModelId,
        imageModelId: imageModelId || (JIGSAW.ImageService && JIGSAW.ImageService.getActive() ? JIGSAW.ImageService.getActive().id : ""),
        createdAt: now(), messages: [],
        workflowTemplate: template, workflowExecuted: false
      };
      Store.get().conversations.push(conv);
      WorkflowService.getForConversation(convId); // materialize workflow
      Store.set({ activeConversationId: convId });
      Store.notify("conversations");
      if (text && text.trim()) {
        this.send(convId, text);
      }
      return conv;
    },

    remove(id) {
      const st = Store.get();
      st.conversations = st.conversations.filter(c => c.id !== id);
      delete st.workflows["wf-" + id];
      if (st.activeConversationId === id) st.activeConversationId = null;
      Store.notify("conversations");
      Store.notify("workflows");
      // 远程模式下同步通知后端删除，否则重启应用后端又把会话拉回来
      if (JIGSAW.Http.isRemote()) {
        JIGSAW.Http.deleteConversation(id).catch(err => {
          JIGSAW.Toast && JIGSAW.Toast.show("删除失败：" + err.message);
        });
        // 同步删除后端工作流，防止 workflows.json 残留孤儿画布
        JIGSAW.Http.request("/api/workflows/" + encodeURIComponent("wf-" + id), {
          method: "DELETE"
        }).catch(() => {});
      }
    },

    rename(id, title) {
      const conv = this.get(id);
      if (!conv) return;
      conv.title = title;
      const wf = JIGSAW.WorkflowService && JIGSAW.WorkflowService.getForConversation(id);
      if (wf) wf.name = title;
      Store.notify("conversations");
      Store.notify("workflows");
    },

    touch(id) {
      const conv = this.get(id);
      if (conv) { conv.createdAt = now(); Store.notify("conversations"); }
    },

    /**
     * ============ 消息队列（按会话隔离，跨会话并行） ============
     * - 同一个会话：正在回复时再发 → 排队，等当前这条完成后自动接着发（一次只跑一条）。
     * - 不同会话 / 不同模型：各跑各的，互不等待（后端也是并发 Worker）。
     *   以前用全局 _busy，导致"另一个会话还在跑，这边发消息就只能干等"。
     */
    _active: new Map(),    // convId -> { startedAt, taskId, cancel() }
    _queue: [],            // [{ id, convId, text, opts, placeholder }]
    _startedAt: null,      // 最近一次开始的时间（兼容旧调用）

    /** 队列状态：busy=有任务在跑；pending=还有几条排队；active=正在跑几个会话 */
    queueInfo() {
      const active = this._active.size;
      let startedAt = null;
      this._active.forEach(r => { if (startedAt === null || r.startedAt < startedAt) startedAt = r.startedAt; });
      return { busy: active > 0, pending: this._queue.length, active, startedAt: startedAt };
    },

    /** 某个会话是否正在回复 */
    isBusy(convId) { return this._active.has(convId); },

    _syncQueue() { Store.notify("queue"); },

    /** 排队中的消息（还没发给后端的几条）—— 任务队列面板据此提供查看 / 编辑 / 删除 */
    listQueued() {
      return this._queue.map(q => ({
        id: q.id,
        convId: q.convId,
        conversation: (this.get(q.convId) || {}).title || "",
        text: q.text
      }));
    },

    /** 修改一条排队中的消息（尚未发送，改完按新内容发出去） */
    updateQueued(id, text) {
      const q = this._queue.find(x => x.id === id);
      if (!q) return false;
      q.text = text;
      if (q.placeholder && q.placeholder.userMsg) q.placeholder.userMsg.text = text;
      Store.notify("messages");
      return true;
    },

    /** 删除一条排队中的消息（连同会话里"排队中…"的占位气泡一起移除） */
    removeQueued(id) {
      const i = this._queue.findIndex(x => x.id === id);
      if (i < 0) return false;
      const q = this._queue[i];
      this._queue.splice(i, 1);
      const conv = this.get(q.convId);
      if (conv && q.placeholder) {
        conv.messages = conv.messages.filter(m =>
          m !== q.placeholder.userMsg && m !== q.placeholder.asstMsg);
        Store.notify("messages");
      }
      this._syncQueue();
      return true;
    },

    /**
     * 终止：cancel(convId) 停指定会话；不传 convId 时停当前唯一/最早的那条。
     * 实际收尾逻辑由 _doSend 为每条任务单独塞进 _active 记录里。
     */
    cancel(convId) {
      let rec = convId ? this._active.get(convId) : null;
      if (!rec) {   // 没指定 → 取最早开始的那条
        this._active.forEach(r => { if (!rec || r.startedAt < rec.startedAt) rec = r; });
      }
      if (!rec || typeof rec.cancel !== "function") return Promise.resolve();
      return rec.cancel();
    },

    _shift() {
      // 找一个"所属会话当前空闲"的排队消息发出去 → 不同会话可同时跑
      if (!this._queue.length) { this._syncQueue(); return; }
      const i = this._queue.findIndex(q => !this._active.has(q.convId));
      if (i < 0) { this._syncQueue(); return; }
      const next = this._queue.splice(i, 1)[0];
      this._doSend(next.convId, next.text, next.opts, next.placeholder);
    },

    /**
     * send(convId, text, { onDone }) → 发送一条消息
     * 该会话正在回复时调用 → 自动排队（返回 null），完成后接着发。
     * 别的会话在跑不影响本条 —— 各自独立。
     * 排队时也立即把"你的消息 + 排队中"显示出来，避免发出去毫无反应。
     */
    send(convId, text, opts) {
      if (this._active.has(convId)) {
        const item = { id: uid("q"), convId, text, opts: opts || {} };
        item.placeholder = this._appendPlaceholder(convId, text);
        this._queue.push(item);
        this._syncQueue();
        return null;
      }
      return this._doSend(convId, text, opts);
    },

    /** 把用户消息 + "排队中"占位立即渲染进会话（直发与排队共用） */
    _appendPlaceholder(convId, text) {
      const conv = this.get(convId);
      if (!conv) return null;
      const model = JIGSAW.ModelService.forConversation(convId);
      const modelId = model ? model.id : null;
      const userMsg = { id: uid("m"), role: "user", text, modelId, status: "done", createdAt: now() };
      conv.messages.push(userMsg);
      this.touch(convId);
      const asstMsg = { id: uid("m"), role: "assistant", text: "", thinkingText: "排队中…", thinkingStatus: "running", full: "", modelId, status: "queued", createdAt: now() };
      conv.messages.push(asstMsg);
      Store.notify("messages");
      return { userMsg, asstMsg };
    },

    _doSend(convId, text, opts, placeholder) {
      const conv = this.get(convId);
      if (!conv) return null;
      // 本条任务登记进"进行中"集合（按会话隔离：别的会话不受影响）
      const rec = { startedAt: Date.now(), taskId: null, cancel: null };
      this._active.set(convId, rec);
      this._startedAt = rec.startedAt;

      // 当前会话用的模型对象（设置 → 模型 里添加的自定义模型）
      const model = JIGSAW.ModelService.forConversation(convId);
      const modelId = model ? model.id : null;

      // 排队路径：占位消息已存在 → 复用（用户消息已在会话里，不再重复加）
      // 直发路径：新建用户消息 + 占位
      let userMsg = null, asstMsg = null;
      if (placeholder && placeholder.userMsg && placeholder.asstMsg) {
        userMsg = placeholder.userMsg;
        asstMsg = placeholder.asstMsg;
        asstMsg.status = "streaming";
        asstMsg.text = "";
        asstMsg.thinkingText = "思考中…";
        asstMsg.thinkingStatus = "running";
      } else {
        userMsg = { id: uid("m"), role: "user", text, modelId, status: "done", createdAt: now() };
        conv.messages.push(userMsg);
        asstMsg = { id: uid("m"), role: "assistant", text: "", thinkingText: "思考中…", thinkingStatus: "running", full: "", modelId, status: "streaming", createdAt: now() };
        conv.messages.push(asstMsg);
      }
      this.touch(convId);
      Store.notify("messages");

      // 本条完成后：回调 → 从"进行中"移除 → 接着发下一条排队消息
      const done = (asstMsg) => {
        this._active.delete(convId);
        if (this._active.size === 0) this._startedAt = null;
        // 这一轮可能用过工具 → 顺手刷新统计（设置 → 统计 / 工具详情页的数字才跟得上）
        if (JIGSAW.Http.isRemote() && JIGSAW.ToolService) {
          JIGSAW.ToolService.loadStats().catch(() => {});
        }
        if (opts && opts.onDone) opts.onDone(asstMsg);
        this._syncQueue();
        this._shift();
      };

      // ★ 本条任务的终止状态：每次发送独立一份，避免下一条继承上一条的取消
      let cancelled = false;
      let localTaskId = null;
      let settled = false;      // 本条是否已收尾（防止重复 done）
      let stopTimers = null;    // 由远程分支赋值：一次清掉轮询 / 计时器

      /** 收尾：气泡定格 → 释放 busy → 接着发下一条排队消息 */
      const settle = (text) => {
        if (settled) return;
        settled = true;
        if (stopTimers) stopTimers();
        asstMsg.status = "done";
        asstMsg.thinkingStatus = "done";
        if (text !== undefined) asstMsg.text = asstMsg.full = text;
        Store.notify("messages");
        done(asstMsg);

        // 同步持久化至后端（mode 一并带上：工作流会话刷新后仍走画布链路）
        if (JIGSAW.Http && JIGSAW.Http.isRemote()) {
          const curConv = ChatService.get(convId);
          if (curConv && curConv.messages) {
            JIGSAW.Http.request("/api/chat/conversations/" + encodeURIComponent(convId) + "/messages", {
              method: "PUT",
              body: { messages: curConv.messages, mode: curConv.mode || "" }
            }).catch(() => {});
          }
        }
      };

      /**
       * 终止本条任务（排队中 / 思考中 / 等待回答 / 正在打字都能停）。
       * 即使还没拿到后端 task_id（Http.chat 尚未返回），也先在前端收尾并释放队列，
       * 等 task_id 到手再补一次后端终止 —— 保证"点了终止就有反应"，不会好像没生效。
       */
      rec.cancel = () => {
        if (settled) return Promise.resolve();
        cancelled = true;
        const p = localTaskId
          ? JIGSAW.Http.cancelTask(localTaskId).catch(e => console.warn("终止失败", e))
          : Promise.resolve();
        settle("已终止");
        return p;
      };

      // ③ 拿到回复全文后，逐字显示（模拟打字效果，不是真流式）
      const stream = (full) => {
        asstMsg.full = full;
        asstMsg.replyStarted = true;
        asstMsg.thinkingStatus = "done";
        const speed = Store.get().settings.workflow.executionSpeed;
        const msPerChunk = speed === "slow" ? 34 : speed === "fast" ? 10 : 18;
        const chunk = speed === "slow" ? 2 : 4;
        let pos = 0;
        const timer = setInterval(() => {
          if (settled) { clearInterval(timer); return; }   // 已被终止 → 立刻停止打字

          // ★ 针对 Markdown 图片 ![alt](url) 或 HTML <img ...> 标签：
          // 如果遇到完整的图片语法，一次性步进输出完整标签，绝不拆分打字！
          // 避免展示撕裂残破的 markdown 路径字符串，并避免高频销毁 <img> 造成剧烈上下抖动
          if (full.slice(pos).startsWith("![")) {
            const endParen = full.indexOf(")", pos);
            if (endParen !== -1 && endParen - pos < 3000) {
              pos = endParen + 1;
            } else {
              pos = Math.min(full.length, pos + chunk);
            }
          } else if (full.slice(pos).startsWith("<img")) {
            const endTag = full.indexOf(">", pos);
            if (endTag !== -1 && endTag - pos < 3000) {
              pos = endTag + 1;
            } else {
              pos = Math.min(full.length, pos + chunk);
            }
          } else {
            pos = Math.min(full.length, pos + chunk);
          }

          asstMsg.text = full.slice(0, pos);
          Store.notify("messages");
          if (pos >= full.length) {
            clearInterval(timer);
            settle();                                       // 保留已显示的全文并收尾
          }
        }, msPerChunk);
      };

      // ② 决定回复从哪来：
      // - 后端可达 + 非显式工作流会话 → 后端 Agent 主链路（工具循环 / AskUser / 权限 / 任务队列）
      // - 显式工作流会话（主页「画布编排」创建时 conv.mode = "workflow"）→ 画布链路
      // - 后端不可达（本地模式）→ 保持浏览器直连链路
      // 旧版用 workflowTemplate / 关键词正则判断，而 detectTemplate 恒返回 "void"（真值），
      // 导致普通聊天几乎全部误入工作流分支，后端主链路形同虚设 —— 现在工作流只认显式 mode。
      const wf = JIGSAW.WorkflowService && JIGSAW.WorkflowService.getForConversation(convId);
      const isWorkflowPath = !JIGSAW.Http.isRemote() || (conv && conv.mode === "workflow" && !!wf);

      if (JIGSAW.Http.isRemote() && !isWorkflowPath) {
        // ===== 数据源 = 后端 API（单 Agent 异步问答） =====
        // Http.chat() 只把消息寄给后端并拿到 task_id（毫秒级返回）
        // 然后每 2 秒轮询任务状态，实时显示：排队中 → 正在调用 XX 工具 → 完成
        JIGSAW.Http.chat(convId, text, model)
          .then(res => {
            const taskId = res.task_id;
            if (!taskId) { settle("后端未返回任务编号：" + (res.message || "")); return; }
            localTaskId = taskId;
            rec.taskId = taskId;
            if (cancelled || settled) {
              // 拿到 task_id 之前就被终止了 → 补一次后端终止，不再接管 UI
              JIGSAW.Http.cancelTask(taskId).catch(e => console.warn("终止失败", e));
              return;
            }

            // ★ 等待时长本地连续计时：每秒刷新一次（不依赖 2s 轮询，显示平滑）
            let statusText = "";   // 轮询写基准文案（排队中/思考中/…）
            const applyWait = () => {
              if (settled || asstMsg.status !== "streaming") return;
              const waitSec = Math.floor((Date.now() - rec.startedAt) / 1000);
              asstMsg.thinkingText = statusText + (waitSec > 3 ? `（已等待 ${waitSec}s）` : "");
              asstMsg.thinkingDuration = waitSec;
              // 若正式回答尚未开始流式输出，保持 text 为空（由 msg-thought 显示进度）
              if (!asstMsg.replyStarted && !asstMsg.text) {
                // 不向 asstMsg.text 乱填草稿
              }
              Store.notify("messages");
            };
            const waitTimer = setInterval(applyWait, 1000);

            const poll = setInterval(() => {
              if (settled) return;
              JIGSAW.Http.getTask(taskId).then(t => {
                if (settled) return;      // 已在别处收尾（用户终止等）→ 忽略这次结果
                if (!t) { settle("任务不存在（后端可能重启过）"); return; }
                if (t.status === "cancelled") {
                  // 用户点了"终止"：气泡直接收尾
                  settle("已终止");
                } else if (t.status === "done") {
                  if (stopTimers) stopTimers();
                  asstMsg.toolsUsed = t.toolsUsed || [];   // 这轮用过的工具名，气泡展示
                  stream(t.reply || "（后端未返回内容）");
                } else if (t.status === "failed") {
                  settle("任务失败：" + (t.error || "未知错误"));
                } else {
                  // ★ 实时状态：排队中（第 N 位）/ 正在调用 XX 工具 / 思考中 / 等待用户回答
                  asstMsg.status = "streaming";
                  // ★ AskUser / 风险确认：AI 想问你问题 → 弹窗
                  // 用"提问序号"判断是不是新问题：同一个问题只弹一次。
                  // （后端答完题会把 pendingQuestion 清掉，序号是双保险，
                  //   避免状态还没清干净时把旧问题又弹一遍）
                  const qSeq = (t.pendingQuestionSeq != null)
                    ? t.pendingQuestionSeq : String(t.pendingQuestion);
                  // 已经有别的任务的弹窗开着（并发场景）→ 这次不弹，也不记序号，
                  // 等下一轮轮询再试，避免"这个问题被永久跳过、任务一直挂着"
                  const modalBusyElsewhere = JIGSAW.AskModalBusy && JIGSAW.AskModalBusy !== taskId;
                  if (t.pendingQuestion && !modalBusyElsewhere && !JIGSAW.AskModalBusy
                      && JIGSAW._askShownSeq[taskId] !== qSeq) {
                    JIGSAW._askShownSeq[taskId] = qSeq;   // 防重复弹窗（轮询 2s 一次）
                    JIGSAW.AskModalBusy = taskId;
                    JIGSAW.AskModal.show(t.pendingQuestion, taskId, {
                      risk: !!t.pendingRisk,
                      options: t.pendingOptions || []
                    })
                      .then(res => {
                        if (JIGSAW.AskModalBusy === taskId) JIGSAW.AskModalBusy = null;
                        if (res && res.answer !== null && res.answer !== undefined) {
                          // 回答（含风险确认的"不再提醒"勾选状态）→ 交回后端唤醒任务
                          JIGSAW.Http.answerTask(taskId, res.answer, res.noMore)
                            .catch(e => console.warn("提交回答失败", e));
                        } else if (res === null) {
                          // 用户取消 → 传空 = 告诉后端"用户取消了"，立即唤醒
                          JIGSAW.Http.answerTask(taskId, "")
                            .catch(e => console.warn("提交回答失败", e));
                        }
                      })
                      .catch(() => { if (JIGSAW.AskModalBusy === taskId) JIGSAW.AskModalBusy = null; });
                  }
                  const pos = (t.status === "pending" && t.queue_position > 0)
                    ? `（第 ${t.queue_position} 位）` : "";
                  statusText = t.status === "pending"
                    ? `排队中${pos}…`
                    : (t.pendingQuestion ? "等待用户回答…" : (t.activity || "思考中…"));
                  applyWait();   // 立即刷新一次（不等 1s timer）
                }
              }).catch(err => {
                settle("请求任务状态失败：" + err.message + "（可在设置 → API 中检查接口地址或数据源）");
              });
            }, 2000);

            stopTimers = () => { clearInterval(waitTimer); clearInterval(poll); };
          })
          .catch(err => {
            settle("请求后端失败：" + err.message + "（可在设置 → API 中检查接口地址或数据源）");
          });
      } else {
        // ===== 数据源 = 本地工作流 / 多 Agent 驱动 =====
        const wf = JIGSAW.WorkflowService && JIGSAW.WorkflowService.getForConversation(convId);
        if (wf && JIGSAW.ExecutionService) {
          (async () => {
            // 如果当前工作流只有起点/空画布，或用户明确提出重新编排/重新规划：由 Captain Agent 自主规划拓扑并绘制！
            const needAutoPlan = !wf.nodes || wf.nodes.length <= 1 || /重新编排|重新规划|重新建图|自主规划|规划拓扑/i.test(text);
            if (needAutoPlan) {
              asstMsg.thinkingText = "Captain Agent 正在分析任务意图，自主规划并绘制多 Agent 拓扑…";
              Store.notify("messages");
              await JIGSAW.WorkflowService.autoPlanWorkflow(wf.id, text);
            }

            // 1. 将用户的输入文本作为初始任务 Prompt 注入 START 起点节点
            const startNode = wf.nodes.find(n => n.agentType === "start") || wf.nodes[0];
            if (startNode) {
              startNode.output = text;
            }

            // 2. 调度多 Agent 工作流，由 ExecutionService 并发执行并将成果回传至对话
            await JIGSAW.ExecutionService.start(convId);
            settle();
          })().catch(err => {
            settle("多 Agent 调度异常：" + (err.message || err));
          });
        } else {
          stream(pickCanned(text));
        }
      }

      return asstMsg;
    },

    /** re-run the last user message (regenerate) */
    regenerate(convId) {
      const conv = this.get(convId);
      if (!conv) return;
      const lastUser = [...conv.messages].reverse().find(m => m.role === "user");
      if (!lastUser) return;
      // remove trailing assistant messages
      while (conv.messages.length && conv.messages[conv.messages.length - 1].role === "assistant") conv.messages.pop();
      this.send(convId, lastUser.text);
    },

    /** wipe history of a conversation */
    clear(convId) {
      const conv = this.get(convId);
      if (conv) { conv.messages = []; Store.notify("messages"); }
    }
  };

  JIGSAW.ChatService = ChatService;
})();
