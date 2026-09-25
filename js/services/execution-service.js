/* ============================================================
   JIGSAW — ExecutionService
   Simulates agent workflow execution in topological/branch order.
   Locks nodes as they complete (completed/running not editable).
   Supports multi-port conditional branching (IF, Loop, Try-Catch),
   active edge flow animation, and upstream-downstream data piping.
   ============================================================ */
(function () {
  const Store = JIGSAW.Store;
  const WorkflowService = JIGSAW.WorkflowService;

  const runs = new Map(); // wfId -> timer handle

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // R6 第一步：节点"大脑"在后端跑（工具循环 / 权限门控 / AskUser 挂起 / 可取消），
  // 浏览器不再直连 LLM —— API Key 不进入节点执行链路，只传 model_id。
  function pollNodeTask(taskId) {
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        JIGSAW.Http.getTask(taskId).then(t => {
          if (!t) { clearInterval(timer); reject(new Error("任务不存在（后端可能重启过）")); return; }
          if (t.status === "cancelled") { clearInterval(timer); reject(new Error("节点已被用户终止")); return; }
          if (t.status === "failed") { clearInterval(timer); reject(new Error(t.error || "节点执行失败")); return; }
          if (t.status === "done") { clearInterval(timer); resolve(t.reply || "（节点完成，但无文字输出）"); return; }
          // AskUser / 风险确认：与聊天轮询共用同一套防重弹窗机制
          const qSeq = (t.pendingQuestionSeq != null) ? t.pendingQuestionSeq : String(t.pendingQuestion);
          const busyElsewhere = JIGSAW.AskModalBusy && JIGSAW.AskModalBusy !== taskId;
          if (t.pendingQuestion && !busyElsewhere && !JIGSAW.AskModalBusy
              && JIGSAW._askShownSeq[taskId] !== qSeq) {
            JIGSAW._askShownSeq[taskId] = qSeq;
            JIGSAW.AskModalBusy = taskId;
            JIGSAW.AskModal.show(t.pendingQuestion, taskId, {
              risk: !!t.pendingRisk,
              options: t.pendingOptions || []
            })
              .then(res => {
                if (JIGSAW.AskModalBusy === taskId) JIGSAW.AskModalBusy = null;
                if (res && res.answer !== null && res.answer !== undefined) {
                  JIGSAW.Http.answerTask(taskId, res.answer, res.noMore).catch(() => {});
                } else if (res === null) {
                  JIGSAW.Http.answerTask(taskId, "").catch(() => {});
                }
              })
              .catch(() => { if (JIGSAW.AskModalBusy === taskId) JIGSAW.AskModalBusy = null; });
          }
        }).catch(err => {
          clearInterval(timer);
          reject(new Error("轮询节点任务失败：" + (err.message || err)));
        });
      }, 1500);
    });
  }

  // 后端节点执行：解析模型 id → 创建节点任务 → 轮询取回输出（agent 节点与条件判定共用）
  async function runBackendNode(node, wf) {
    let modelId = node.modelId || "";
    if (!modelId && JIGSAW.ModelService) {
      const active = JIGSAW.ModelService.getActive();
      if (active) modelId = active.id;
    }
    if (!modelId) {
      throw new Error("未配置可用对话模型（请到 设置 → 模型 添加并填写密钥）");
    }

    const convId = (wf && (wf.conversationId || String(wf.id || "").replace(/^wf-/, ""))) || "";
    let taskId;
    try {
      const res = await JIGSAW.Http.runNodeTask(convId, node, modelId);
      taskId = res && res.task_id;
    } catch (e) {
      throw new Error("创建节点任务失败：" + (e.message || e));
    }
    if (!taskId) throw new Error("后端未返回节点任务编号");
    return await pollNodeTask(taskId);
  }

  async function callModelForNode(node, wf) {
    // 条件节点：后端 LLM 真判定（只回 true/false），不再本地预设判定。
    // 判定失败如实抛错 → 节点 failed → 下游分支熔断（与普通节点失败一致）。
    if (node.agentType === "condition_if") {
      const question = (node.description || node.name || "").trim() || "上游成果是否满足继续条件？";
      const judgeNode = Object.assign({}, node, {
        name: "条件判定 · " + (node.name || "分支"),
        systemPrompt:
          "你是多智能体工作流中的条件判定器。请基于上游各节点流转输入，对下面的判定问题给出结论。\n" +
          "判定问题：" + question +
          "\n【输出硬性要求】只输出小写 true 或 false，禁止输出任何其他文字、解释或标点。",
        tools: [],
        maxToolCalls: 1,
        suppressAskUser: true
      });
      const reply = await runBackendNode(judgeNode, wf);
      const isTrue = /\btrue\b/i.test(reply);
      const isFalse = /\bfalse\b/i.test(reply);
      if (isTrue === isFalse) {
        throw new Error("条件判定输出无法解析（应为 true/false）：" + String(reply).slice(0, 80));
      }
      node.conditionOutcome = isTrue ? "true" : "false";
      return node.conditionOutcome === "true"
        ? `【条件判定：满足 (True)】${question} —— 校验通过，数据流已放行至 True 主干分支。`
        : `【条件判定：未满足 (False)】${question} —— 触发分流至 False 备选分支。`;
    }

    if (
      node.category === "logic" ||
      node.agentType === "loop_ctrl" ||
      node.agentType === "try_catch" ||
      node.agentType === "start" ||
      node.agentType === "gate_and" ||
      node.agentType === "gate_or" ||
      node.agentType === "gate_not" ||
      node.agentType === "and_gate" ||
      node.agentType === "or_gate"
    ) {
      return generateSmartSemanticOutput(node, wf);
    }

    // 普通 Agent 节点：真实任务（工具循环 / 权限门控 / AskUser / 可取消）
    return await runBackendNode(node, wf);
  }

  function generateSmartSemanticOutput(node, wf) {
    if (node.agentType === "condition_if") {
      const outcome = node.conditionOutcome || "true";
      return outcome === "true"
        ? "【条件判定：满足 (True)】校验通过，数据流已放行至 True 主干分支。"
        : "【条件判定：未满足 (False)】校验未通过，触发分流至 False 异常/备选分支。";
    }
    if (node.agentType === "loop_ctrl") {
      const cur = node.iteration || 1;
      const max = node.loopMax || 3;
      return cur < max
        ? `【循环控制：迭代中】轮次 ${cur}/${max} 未达收敛阈值，回环触发重试。`
        : `【循环控制：已达成】轮次 ${cur}/${max} 达标，跳出循环进入下游主流程。`;
    }
    if (node.agentType === "try_catch") {
      return "【异常捕获守护中】前置流程正常，主干未捕获严重异常。";
    }
    if (node.agentType === "start") {
      return node.output || "【工作流启动】初始上下文与用户指令就绪，分发至初始节点。";
    }
    if (node.agentType === "gate_and" || node.agentType === "and_gate") {
      return (node.input && node.input.trim()) ? node.input.trim() : "【与门同步完成】所有并行前置分支均已达成。";
    }
    if (node.agentType === "gate_or" || node.agentType === "or_gate") {
      return (node.input && node.input.trim()) ? node.input.trim() : "【或门同步完成】前置分支已激活，放行流转。";
    }
    if (node.agentType === "gate_not") {
      return (node.input && node.input.trim()) ? node.input.trim() : "【非门】前置条件取反完成，数据流已放行。";
    }

    // 【已移除伪语义生成兜底】非逻辑节点的输出只能来自真实模型调用：
    // 模型未配置或调用失败 → 抛错 → 节点如实标 failed，绝不生成看似真实的假报告。
    throw new Error(`节点【${node.name || node.id}】缺少真实模型输出（仅逻辑节点支持本地求值）`);
  }

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

    /** run the whole pipeline with conditional branching and edge flow animation */
    async start(convId) {
      const wf = WorkflowService.getForConversation(convId);
      if (!wf || wf.running) return;

      const runId = "run-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
      wf.currentRunId = runId;

      // 1. 全局重置状态（重置 status、清空历史 output 与 input，防止跨运行或节点间污染）
      wf.nodes.forEach(n => {
        n.status = "waiting";
        n.skipped = false;
        if (n.agentType !== "start") {
          n.output = "";
          if (!n.keepInput) {
            n.input = "";
          }
        }
      });
      wf.edges.forEach(e => {
        e.activeFlow = false;
        e.status = null;
      });
      wf.running = true;
      wf.executed = false;
      Store.notify("workflows");

      // 中断令牌：stop() 置 cancelled=true
      const token = { cancelled: false };
      runs.set(wf.id, token);

      // 同步向对话界面注入 Assistant 消息气泡，使对话界面能实时看到智能体思考轨迹与最终交付结果
      const conv = JIGSAW.ChatService && JIGSAW.ChatService.get(convId);
      let asstMsg = null;
      if (conv) {
        const activeAsst = conv.messages[conv.messages.length - 1];
        if (activeAsst && activeAsst.role === "assistant" && (activeAsst.status === "streaming" || activeAsst.status === "queued")) {
          asstMsg = activeAsst;
          asstMsg.status = "streaming";
          asstMsg.thinkingStatus = "running";
          asstMsg.thinkingText = "多 Agent 协同工作流启动中…";
          asstMsg.steps = asstMsg.steps || [];
        } else {
          asstMsg = {
            id: "m-" + Math.random().toString(36).slice(2, 9),
            role: "assistant",
            status: "streaming",
            thinkingStatus: "running",
            thinkingText: "多 Agent 协同工作流启动中…",
            steps: [],
            text: "",
            full: "",
            createdAt: new Date().toISOString()
          };
          conv.messages.push(asstMsg);
        }
        Store.notify("messages");
      }

      const speed = Store.get().settings.workflow.executionSpeed;
      const base = speed === "slow" ? 2200 : speed === "fast" ? 600 : 1200;

      try {
        // 构建有向图拓扑队列
        // 初始根节点：start 节点，或入度为 0 的节点
        const inDegree = new Map();
        const nonLoopInEdges = new Map();
        wf.nodes.forEach(n => {
          const inEdges = wf.edges.filter(e => e.to === n.id && !e.isLoop);
          inDegree.set(n.id, inEdges.length);
          nonLoopInEdges.set(n.id, inEdges);
        });

        // 队列中的准备执行节点
        const readyNodes = [];
        const startNode = wf.nodes.find(n => n.agentType === "start");
        if (startNode) {
          readyNodes.push(startNode.id);
        }
        wf.nodes.forEach(n => {
          if (n.id !== (startNode && startNode.id) && inDegree.get(n.id) === 0) {
            readyNodes.push(n.id);
          }
        });

        // 如果没有明确起点（孤立或环），兜底推入首个节点
        if (readyNodes.length === 0 && wf.nodes.length > 0) {
          readyNodes.push(wf.nodes[0].id);
        }

        const executedNodeIds = new Set();

        while (readyNodes.length > 0) {
          if (token.cancelled) break;

          // 1. 提取当前波次中可执行的节点（支持 OR 模式抢跑，以及 AND 模式全部前置终态就绪）
          const currentBatch = [];
          for (let i = readyNodes.length - 1; i >= 0; i--) {
            const nid = readyNodes[i];
            if (executedNodeIds.has(nid)) {
              readyNodes.splice(i, 1);
              continue;
            }
            const inEdges = nonLoopInEdges.get(nid) || [];
            const targetNode = wf.nodes.find(n => n.id === nid);
            const isOrMode = targetNode && (targetNode.joinRule === "any_or" || targetNode.agentType === "or_gate");

            // 检查前置入边是否已有终态结果（非 null / undefined 代表该前置已执行结束）
            const pendingEdges = inEdges.filter(e => e.status === null || e.status === undefined);

            let isReady = false;
            if (isOrMode) {
              // OR 模式：任意一条前置成功即可立即抢跑；或者当前置全部结束
              isReady = inEdges.some(e => e.status === "success") || pendingEdges.length === 0;
            } else {
              // AND 模式（包括默认的 tolerant_and 弹性汇合与 strict_and 严格汇合）：
              // 必须等待所有前置节点全部跑完，绝不中途死等挂起
              isReady = pendingEdges.length === 0;
            }

            if (isReady) {
              currentBatch.push(nid);
              readyNodes.splice(i, 1);
            }
          }

          if (currentBatch.length === 0) {
            // 若当前无立即可运行节点，稍作休眠等待前置，避免死锁
            if (readyNodes.length > 0) {
              await delay(60);
              const anyCanRun = readyNodes.some(nid => {
                const inEdges = nonLoopInEdges.get(nid) || [];
                const targetNode = wf.nodes.find(n => n.id === nid);
                const isOrMode = targetNode && (targetNode.joinRule === "any_or" || targetNode.agentType === "or_gate");
                if (isOrMode && inEdges.some(e => e.status === "success")) return true;
                return inEdges.every(e => e.status !== null && e.status !== undefined);
              });
              if (!anyCanRun) break;
              continue;
            }
            break;
          }

          // 2. 【核心亮点：Promise.all 真并发】同波次就绪节点同时进入 running 状态并同时向模型发起请求
          await Promise.all(currentBatch.map(async (nodeId) => {
            if (token.cancelled) return;
            const node = wf.nodes.find(n => n.id === nodeId);
            if (!node) return;

            const inEdges = nonLoopInEdges.get(nodeId) || [];
            const successEdges = inEdges.filter(e => e.status === "success");
            const failedEdges = inEdges.filter(e => e.status === "failed");
            const skippedEdges = inEdges.filter(e => e.status === "skipped");

            // 规则 1：【如果前面都失败了，直接结束/熔断】
            // 如果该节点有前置节点，但没有任何一条是 success（即全部都是 failed 或 skipped）
            if (inEdges.length > 0 && successEdges.length === 0) {
              node.status = "skipped";
              node.skipped = true;
              node.output = "【前置全失败熔断】上游前置节点全部执行失败或跳过，无可用数据流，本节点安全熔断。";
              executedNodeIds.add(nodeId);

              if (asstMsg) {
                asstMsg.steps.push({
                  name: node.name,
                  args: { 判定: "前置全失败·安全熔断" },
                  status: "done"
                });
                Store.notify("messages");
              }

              const outEdges = wf.edges.filter(e => e.from === nodeId);
              outEdges.forEach(e => {
                e.status = "skipped";
                if (!executedNodeIds.has(e.to) && !readyNodes.includes(e.to)) {
                  readyNodes.push(e.to);
                }
              });
              Store.notify("workflows");
              return;
            }

            // 规则 2：【严格 AND 模式（strict_and）】若有任一失败，拒绝通过
            if (node.joinRule === "strict_and" && failedEdges.length > 0) {
              node.status = "skipped";
              node.skipped = true;
              node.output = "【严格AND校验阻断】上游存在失败节点，严格模式下阻断下游执行。";
              executedNodeIds.add(nodeId);
              const outEdges = wf.edges.filter(e => e.from === nodeId);
              outEdges.forEach(e => {
                e.status = "skipped";
                if (!executedNodeIds.has(e.to) && !readyNodes.includes(e.to)) readyNodes.push(e.to);
              });
              Store.notify("workflows");
              return;
            }

            // 规则 3：【智能弹性 AND 模式 (默认 tolerant_and)】
            // 有成功有失败 -> pass 成功的！不管失败的，做兜底提示，正常继续执行！
            if (failedEdges.length > 0 && successEdges.length > 0) {
              const failedNames = failedEdges.map(e => {
                const fn = wf.nodes.find(n => n.id === e.from);
                return fn ? fn.name : e.from;
              }).join("、");
              const notice = `> ⚠️【上游部分容错兜底】：检测到上游节点 [${failedNames}] 执行异常，系统已自动隔离失败分支，仅采用成功节点的数据继续执行。\n\n`;
              node.input = notice + (node.input || "");
            }

            // 激活传入连线的脉冲动画（activeFlow），表现数据流向该节点
            const incomingActiveEdges = inEdges.filter(e => e.status === "success");
            if (incomingActiveEdges.length > 0) {
              incomingActiveEdges.forEach(e => { e.activeFlow = true; });
              Store.notify("workflows");
              await delay(node.category === "logic" ? 80 : 250);
              incomingActiveEdges.forEach(e => { e.activeFlow = false; });
            }

            // 状态变更：多个就绪节点在画布上【同时变黄 (running)】
            node.status = "running";
            if (asstMsg) {
              asstMsg.thinkingText = `智能体【${node.name}】正在执行…`;
              asstMsg.steps.push({
                name: node.name,
                args: { 类型: node.category === "logic" ? "逻辑控制" : "Agent 执行" },
                status: "running"
              });
              Store.notify("messages");
            }
            Store.notify("workflows");

            await delay(node.category === "logic" ? 60 : (base * 0.4 + Math.random() * 200));
            if (token.cancelled) { node.status = "failed"; return; }

            // 容错与异常处理策略
            if (node.simulateError) {
              if (node.onError === "skip") {
                node.status = "skipped";
                node.skipped = true;
                node.output = node.fallbackValue || "【容错策略生效】节点模拟异常，已自动跳过并放行下游。";
              } else if (node.onError === "fallback") {
                node.status = "skipped";
                node.skipped = true;
                node.output = node.fallbackValue || "【兜底数据】节点模拟异常，注入备选数据继续执行。";
              } else {
                node.status = "failed";
                node.skipped = false;
                node.output = "【异常报错】节点模拟异常且未配置降级。";
              }
            } else {
              try {
                // 真正的异步模型网络并发请求
                node.output = await callModelForNode(node, wf);
                node.status = "success";
                node.skipped = false;
              } catch (err) {
                console.error("Node execution failed:", err);
                node.status = "failed";
                node.skipped = false;
                node.output = `【调用异常】${err.message || "模型接口异常"}`;
              }
            }

            executedNodeIds.add(nodeId);

            if (asstMsg && asstMsg.steps.length > 0) {
              const curStep = asstMsg.steps.find(s => s.name === node.name && s.status === "running") || asstMsg.steps[asstMsg.steps.length - 1];
              if (curStep) {
                curStep.status = node.status === "failed" ? "error" : "done";
                curStep.args = {
                  状态: node.status === "failed" ? "执行异常" : "已完成",
                  摘要: (node.output || "").slice(0, 36)
                };
                Store.notify("messages");
              }
            }

            // 处理出边分支分流与数据管道传递 (Data Piping)
            const outEdges = wf.edges.filter(e => e.from === nodeId);

            function pipeDataToTarget(targetNode, sourceNode, prefix) {
              if (!targetNode) return;
              const isSourceLogicGate = sourceNode.category === "logic" ||
                sourceNode.agentType === "gate_and" ||
                sourceNode.agentType === "gate_or" ||
                sourceNode.agentType === "and_gate" ||
                sourceNode.agentType === "or_gate";

              let incomingData = "";
              if (isSourceLogicGate) {
                // 逻辑门向下游透明透传所汇聚的所有前置业务智能体的真实产出，严禁截断或吞没
                incomingData = (sourceNode.input && sourceNode.input.trim()) ? sourceNode.input.trim() : (sourceNode.output || "").trim();
              } else {
                const header = prefix || `【上游节点 [${sourceNode.name}] 交付数据】：`;
                incomingData = `${header}\n${(sourceNode.output || "").trim()}`;
              }

              if (incomingData) {
                targetNode.input = targetNode.input ? `${targetNode.input}\n\n${incomingData}` : incomingData;
              }
            }

            if (node.status === "failed") {
              // 失败节点将出边标记为 failed，放行下游参与 AND/OR 汇聚仲裁
              outEdges.forEach(e => {
                e.status = "failed";
                if (!executedNodeIds.has(e.to) && !readyNodes.includes(e.to)) {
                  readyNodes.push(e.to);
                }
              });
            } else if (node.status === "skipped") {
              outEdges.forEach(e => {
                e.status = "success";
                const targetNode = wf.nodes.find(n => n.id === e.to);
                pipeDataToTarget(targetNode, node, `【上游节点 [${node.name}] 兜底交付】：`);
                if (!executedNodeIds.has(e.to) && !readyNodes.includes(e.to)) {
                  readyNodes.push(e.to);
                }
              });
            } else if (node.status === "success") {
              if (node.agentType === "condition_if") {
                const outcome = node.conditionOutcome || "true";
                const activePort = outcome === "true" ? "true" : "false";
                const inactivePort = outcome === "true" ? "false" : "true";

                outEdges.forEach(e => {
                  if (e.fromPort === activePort || (!["true", "false"].includes(e.fromPort))) {
                    e.status = "success";
                    const targetNode = wf.nodes.find(n => n.id === e.to);
                    pipeDataToTarget(targetNode, node);
                    if (!executedNodeIds.has(e.to) && !readyNodes.includes(e.to)) {
                      readyNodes.push(e.to);
                    }
                  } else if (e.fromPort === inactivePort) {
                    e.status = "skipped";
                    if (!executedNodeIds.has(e.to) && !readyNodes.includes(e.to)) {
                      readyNodes.push(e.to);
                    }
                  }
                });
              } else if (node.agentType === "loop_ctrl") {
                node.iteration = (node.iteration || 0) + 1;
                const isLoop = node.iteration < (node.loopMax || 3);
                const activePort = isLoop ? "loop" : "done";
                const inactivePort = isLoop ? "done" : "loop";

                outEdges.forEach(e => {
                  if (e.fromPort === activePort) {
                    e.status = "success";
                    const targetNode = wf.nodes.find(n => n.id === e.to);
                    pipeDataToTarget(targetNode, node, `【迭代轮次 ${node.iteration}】：`);
                    if (isLoop) {
                      executedNodeIds.delete(e.to);
                    }
                    if (!readyNodes.includes(e.to)) readyNodes.push(e.to);
                  } else if (e.fromPort === inactivePort) {
                    e.status = "skipped";
                  }
                });
              } else {
                // 普通 Agent、START 节点或 Logic Gate：将数据灌入下游 input
                outEdges.forEach(e => {
                  e.status = "success";
                  const targetNode = wf.nodes.find(n => n.id === e.to);
                  pipeDataToTarget(targetNode, node);
                  if (!executedNodeIds.has(e.to) && !readyNodes.includes(e.to)) {
                    readyNodes.push(e.to);
                  }
                });
              }
            }

            Store.notify("workflows");
          }));

          Store.notify("workflows");
          await delay(120);
        }

        // 兜底校验：如果有未能触达的残留节点且其前置已被跳过，自动标记为 skipped
        wf.nodes.forEach(n => {
          if (!executedNodeIds.has(n.id) && n.status === "waiting") {
            const inE = nonLoopInEdges.get(n.id) || [];
            if (inE.length > 0 && inE.every(e => e.status === "skipped")) {
              n.status = "skipped";
              n.skipped = true;
              n.output = "【分支跳过】前置分支未命中，本节点已自动跳过。";
            }
          }
        });
      } finally {
        runs.delete(wf.id);
        wf.running = false;
        Store.notify("workflows");
      }

      if (!token.cancelled) {
        wf.executed = true;
        WorkflowService.persist(wf.id);   // 执行结束（节点终态）落盘
        Store.notify("workflows");

        // 为对话界面生成多 Agent 的最终综合交付报告与回复
        if (asstMsg) {
          const successNodes = wf.nodes.filter(n => n.status === "success" && n.agentType !== "start");

          let finalReport = `### 🎯 多 Agent 协同任务执行完成\n\n`;
          finalReport += `本次多智能体协同流水线已调度完毕，共 ${successNodes.length} 个专业智能体协同交付成果如下：\n\n`;

          successNodes.forEach((rn, idx) => {
            const prefix = successNodes.length > 1 ? `${idx + 1}️⃣ ` : "";
            finalReport += `---\n\n### ${prefix}【${rn.name}】交付成果：\n\n`;
            finalReport += `${(rn.output || "").trim() || "（数据处理完毕并流转至后续分支）"}\n\n`;
          });

          const skippedNodes = wf.nodes.filter(n => n.status === "skipped");
          if (skippedNodes.length > 0) {
            finalReport += `> 💡 **分支裁剪记录**：根据条件逻辑判定，本次已自动跳过未激活分支：${skippedNodes.map(n => `\`${n.name}\``).join("、")}\n`;
          }

          asstMsg.text = finalReport;
          asstMsg.full = finalReport;
          asstMsg.status = "done";
          asstMsg.thinkingStatus = "done";
          asstMsg.thinkingText = `已由 ${successNodes.length} 个智能体协同完成`;
          Store.notify("messages");

          // 同步持久化至后端会话存储（mode 一并带上，刷新后仍识别为工作流会话）
          if (JIGSAW.Http && JIGSAW.Http.isRemote()) {
            const curConv = JIGSAW.ChatService && JIGSAW.ChatService.get(convId);
            if (curConv && curConv.messages) {
              JIGSAW.Http.request("/api/chat/conversations/" + encodeURIComponent(convId) + "/messages", {
                method: "PUT",
                body: { messages: curConv.messages, mode: curConv.mode || "workflow" }
              }).catch(() => {});
            }
          }
        }
      }
    },

    /** soft stop: mark remaining waiting/running as failed and break the loop */
    stop(convId) {
      const wf = WorkflowService.getForConversation(convId);
      if (!wf) return;
      const token = runs.get(wf.id);
      if (token) token.cancelled = true;
      wf.nodes.forEach(n => { if (n.status === "waiting" || n.status === "running") n.status = "failed"; });
      wf.edges.forEach(e => { e.activeFlow = false; });
      wf.running = false;
      WorkflowService.persist(wf.id);     // 终止后的节点终态落盘
      Store.notify("workflows");

      const conv = JIGSAW.ChatService && JIGSAW.ChatService.get(convId);
      if (conv) {
        const lastMsg = conv.messages[conv.messages.length - 1];
        if (lastMsg && lastMsg.role === "assistant" && lastMsg.status === "streaming") {
          lastMsg.status = "done";
          lastMsg.thinkingStatus = "done";
          lastMsg.thinkingText = "工作流已被手动终止";
          lastMsg.text = "【任务已终止】多 Agent 协同工作流已被手动中断。";
          Store.notify("messages");
        }
      }
    },

    /** 启动自愈：页面刷新/切换导致上次运行中断时，解锁卡死的画布 */
    recover(convId) {
      const wf = WorkflowService.getForConversation(convId);
      if (!wf || !wf.running) return;
      if (!runs.has(wf.id)) {
        wf.running = false;
        wf.nodes.forEach(n => { if (n.status === "running") n.status = "waiting"; });
        wf.edges.forEach(e => { e.activeFlow = false; });
        Store.notify("workflows");
      }
    }
  };

  JIGSAW.ExecutionService = ExecutionService;
})();
