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
      if (!wf || wf.running) return false;
      const node = wf.nodes.find(n => n.id === nodeId);
      return !!node;
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

    /** 获取节点的所有输出端口定义（支持多端口分支） */
    getNodeOutputPorts(node) {
      if (!node) return [{ id: "out", label: "", name: "输出", title: "标准输出端口", color: "var(--line-strong)" }];
      if (node.agentType === "condition_if") {
        return [
          { id: "true", label: "T", name: "True (满足分支)", title: "条件满足分支 (True)", color: "var(--st-success)" },
          { id: "false", label: "F", name: "False (未满足分支)", title: "条件未满足分支 (False)", color: "var(--st-waiting)" }
        ];
      }
      if (node.agentType === "loop_ctrl") {
        return [
          { id: "loop", label: "⟲", name: "Loop (回环)", title: "回环迭代分支 (Loop)", color: "var(--st-running)" },
          { id: "done", label: "✓", name: "Done (退出)", title: "循环达标退出分支 (Done)", color: "var(--text-1)" }
        ];
      }
      if (node.agentType === "try_catch") {
        return [
          { id: "try", label: "OK", name: "Try (常规路径)", title: "常规流转分支 (Try)", color: "var(--st-success)" },
          { id: "catch", label: "ERR", name: "Catch (异常分支)", title: "异常接管兜底分支 (Catch)", color: "var(--st-failed)" }
        ];
      }
      return [{ id: "out", label: "", name: "输出", title: "标准输出端口", color: "var(--line-strong)" }];
    },

    addEdge(wfId, fromId, toId, fromPort = "out", toPort = "in") {
      const wf = this.get(wfId);
      if (!wf || wf.running) return false;
      if (fromId === toId) return false;
      const toNode = wf.nodes.find(n => n.id === toId);
      if (toNode && toNode.agentType === "start") return false; // 任务起点不能被输入连线
      if (!this.isEditable(wf, fromId) || !this.isEditable(wf, toId)) return false;
      // 规范化端口方向：目标端口永远为左侧输入端 "in"，起点必须为输出端口
      if (fromPort === "in") fromPort = "out";
      toPort = "in";
      // 相同起止节点和端口的连线不能重复
      if (wf.edges.some(e => e.from === fromId && e.to === toId && (e.fromPort || "out") === fromPort)) return false;
      const isLoop = fromPort === "loop" || this.createsCycle(wf, fromId, toId);

      let label = "";
      if (fromPort === "true") label = "True";
      else if (fromPort === "false") label = "False";
      else if (fromPort === "loop") label = "Loop";
      else if (fromPort === "done") label = "Done";
      else if (fromPort === "try") label = "Try";
      else if (fromPort === "catch") label = "Catch";

      wf.edges.push({
        id: uid(wfId + "-e"),
        from: fromId,
        to: toId,
        fromPort: fromPort || "out",
        toPort: toPort || "in",
        label,
        isLoop
      });
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
      wf.edges.forEach(e => {
        e.activeFlow = false;
        e.status = null;
      });
      wf.executed = false;
      Store.notify("workflows");
    },

    rename(wfId, name) {
      const wf = this.get(wfId);
      if (!wf) return;
      wf.name = name;
      Store.notify("workflows");
    },

    /**
     * Captain Agent 自主规划与动态建图 (Text-to-Workflow)
     * 接收用户自然语言需求，自动拆解子任务，并在画布上生成整齐排布的节点与连线
     */
    async autoPlanWorkflow(wfId, userPrompt, preferredModelId) {
      const wf = this.get(wfId);
      if (!wf) return false;
      const convId = wfId.replace(/^wf-/, "");
      const chosenModelId = preferredModelId || wf.captainModelId;

      // 1. 尝试调用真实大模型（如 DeepSeek）进行自主任务架构分解
      let planData = null;

      function isChatModel(m) {
        if (!m || !m.apiKey || !m.baseUrl) return false;
        const mid = (m.modelId || m.model || m.name || "").toLowerCase();
        const url = (m.baseUrl || "").toLowerCase();
        if (mid.includes("image") || mid.includes("flux") || mid.includes("dall-e") || url.includes("agnes-ai")) {
          return false;
        }
        return true;
      }

      // 提取所有可用于对话与任务编排的真实大模型候选（过滤掉纯生图模型如 Agnes/FLUX 等）
      const candidateModels = [];
      if (chosenModelId && JIGSAW.ModelService) {
        const pref = JIGSAW.ModelService.byId(chosenModelId);
        if (isChatModel(pref)) {
          candidateModels.push(pref);
          wf.captainModelId = pref.id;
        }
      }

      if (JIGSAW.ModelService) {
        const active = JIGSAW.ModelService.getActive();
        if (isChatModel(active) && !candidateModels.some(c => c.id === active.id)) candidateModels.push(active);
        const all = JIGSAW.ModelService.list() || [];
        all.forEach(m => {
          if (isChatModel(m) && !candidateModels.some(c => c.id === m.id)) {
            candidateModels.push(m);
          }
        });
      }
      const customs = (Store.get().settings && Store.get().settings.model && Store.get().settings.model.custom) || [];
      customs.forEach(c => {
        if (isChatModel(c) && !candidateModels.some(cm => cm.apiKey === c.apiKey && cm.baseUrl === c.baseUrl)) {
          candidateModels.push(c);
        }
      });

      // 依次尝试候选真实大模型（如 DeepSeek）进行 DAG 自主任务编排
      for (const model of candidateModels) {
        if (planData) break;
        try {
          let endpoint = model.baseUrl.trim().replace(/\/+$/, "");
          if (!endpoint.endsWith("/chat/completions")) {
            endpoint = endpoint.endsWith("/v1") ? endpoint + "/chat/completions" : endpoint + "/chat/completions";
          }
          let modelName = model.model || model.modelId || "deepseek-chat";
          if (model.baseUrl.includes("deepseek.com")) {
            if (!modelName.toLowerCase().includes("reasoner")) {
              modelName = "deepseek-chat";
            } else {
              modelName = "deepseek-reasoner";
            }
          }
          const controller = new AbortController();
          const tid = setTimeout(() => controller.abort(), 30000);
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${model.apiKey}`
            },
            body: JSON.stringify({
              model: modelName,
              messages: [
                {
                  role: "system",
                  content: `你是一个顶尖的多智能体工作流架构师（Captain Agent）。请深入剖析用户的真实任务目标与依赖关系，规划出符合人类逻辑常理的多智能体协作图（DAG 拓扑链路）。

【绝对红线（严禁犯逻辑死循环错误）】：
❌ 严禁把“最终交付动作”（如：生成图片/画图/输出方案/编写代码/撰写综合报告）误当成和前期素材采集“同时并行的子任务”！
   - 严重错误：若用户指令包含“搜集素材后生成图片/报告”，把“生成图片/报告”也当成起点分发的并行任务。此时图片/报告还没任何素材，同时启动属于严重逻辑错误！
   - 正确逻辑：
     1. 前置各素材采集/专项调研节点必须直接依赖任务起点（dependsOn: []）；
     2. 终极创作/总成报告节点必须依赖上述所有前置节点（dependsOn: ["node1_id", "node2_id", ...]），在上游素材全部到位后再聚合启动！

【任务复杂度自适应伸缩准则（Dynamic Complexity Scaling）】：
智能体数量和流水线深度必须根据用户任务的实际复杂度【自适应伸缩】，严禁对简单任务杀鸡用牛刀，也严禁对复杂任务浮于表面：
1. 极简/单点任务（如：润色一段文字、单一概念查询、单句翻译、单一简短问答）：
   - 节点规模：1 ~ 2 个节点；
   - 拓扑结构：单节点直出 或 起点 ➔ 执行节点 ➔ 交付；严禁滥用复杂的与门汇聚与多阶段。
2. 中等专项任务（如：单一实体资料调研、宣传配图绘制、两项事物基础对比）：
   - 节点规模：3 ~ 4 个节点；
   - 拓扑结构：2~3路并行前置探索 ➔ 终极总成交付。
3. 复杂长文本/重型课题任务（如：长篇需求、多约束业务命题、跨行业竞争推演、万字报告）：
   - 节点规模：5 ~ 7 个节点；
   - 拓扑结构：启动 3 ~ 4 阶纵深流水线（第一阶段事实数据 ➔ 第二阶段量化建模/壁垒解构 ➔ 第三阶段全景战略研报 ➔ 第四阶段下游实施路线图与落地预案）。

【多智能体纵深递进架构准则（针对中高复杂度任务打破单层扁平模式，具备向下深度拓展能力）】：
真正专业的高级工作流必须具备【纵向阶段递进（Multi-Stage Depth）】与【下游落地拓展（Downstream Extension）】的能力：

1. 纵深递进分层：
   - 第一阶段【多维数据与事实情报层】：（dependsOn: []，并行业务探索，必须明确配置 tools: ["websearch"] 或 ["websearch", "fetch_url"] 获取客观数据）；
   - 第二阶段【深度交叉分析与量化推演层】：（dependsOn: [第一阶段对应节点]，基于前期采集数据，展开技术壁垒深度解构、量化财务测算 tools: ["calc"]、竞品攻防博弈等深入推演）；
   - 第三阶段【全局战略研判与决策总成层】：（dependsOn: [第二阶段节点]，汇总各维深入成果，形成全景研报与核心判断）；
   - 第四阶段【下游方案落地与全景交付文档】：（dependsOn: [第三阶段节点]，进一步向下拓展：规划落地行动路线图 Roadmap、商业化策略落地方案与风险预案，输出一份排版严整、可直接交付的完整全景分析文档；仅在用户明确要求存库时才配置 tools: ["knowledge_write"]）。

2. 节点工具调用指令必须具体明确（Explicit Tool Directives）：
   - 在每个智能体的 desc 与 prompt 中，必须明确交代：
     - 本节点明确调用的工具名称（如 websearch / calc / generate_image / knowledge_write）；
     - 检索的具体关键词、指标定义或测算模型；
     - 明确交付物格式与结构，严禁泛泛空谈！

【系统可用工具库清单】：
- websearch: 网页实时搜索。必配场景：市场调研、竞品分析、最新行业资讯、事实数据核查、外部资料采集等任何需要联网获取客观信息的节点。
- fetch_url: 网页正文深度抓取。适用场景：抓取特定网页长文、深度研报或长文解析。
- generate_image: AI 图像/海报生成。必配场景：海报制作、画面构思、视觉概念图、插画、宣传配图与渲染图绘制节点。
- knowledge_search: 本地知识库检索。适用场景：查询私有资料、内部文档、行业白皮书等已收录资料。
- knowledge_write: 写入本地知识库。适用场景：将最终综合调研报告或结构化结论归档保存至知识库。
- calc: 精确计算器。适用场景：财务指标测算、复合年均增长率(CAGR)、估值建模、量化数据计算。
- get_current_time: 获取当前系统时间。适用场景：事件时间线梳理、最新时效性对比。

【智能体节点工具分配准则（非常重要！务必根据节点职责精准赋予 tools 数组，绝不可一律留空）】：
1. 专项调研 / 行业情报 / 竞品信息 / 外部数据采集节点：
   👉 必须配置 tools: ["websearch"] 或 tools: ["websearch", "fetch_url"]！赋予智能体实时的互联网检索能力，严禁无工具闭门造车！
2. 涉及生图 / 海报 / 概念图 / 视觉创作节点：
   👉 必须配置 tools: ["generate_image"]！
3. 涉及财务指标测算 / 复合增长率(CAGR) / 估值 / 精确统计节点：
   👉 必须配置 tools: ["calc"]！
4. 涉及企业内部私有资料 / 历史研报分析节点：
   👉 配置 tools: ["knowledge_search"]！
5. 最终综合决策研报 / 方案总成交付节点：
   👉 可配置 tools: ["knowledge_write"]（将最终研报归档入知识库）或兼配 tools: ["calc"]！
6. 纯逻辑控制 / 聚合汇总但无需额外工具的节点：可填 []。

【输出格式规范】：
必须直接返回纯 JSON 对象（无需 markdown 包裹）：
{
  "workflowName": "根据用户任务定制的工作流总体标题",
  "nodes": [
    {
      "id": "简短英文id",
      "name": "针对用户任务的智能体名称",
      "desc": "职责说明",
      "prompt": "专业系统提示词，规定其工作范畴与产出标准",
      "tools": ["websearch"],  // 根据上述规则精准配置，如 ["websearch"]、["generate_image"]、["calc"] 等
      "dependsOn": []
    }
  ]
}`
                },
                { role: "user", content: `用户任务需求：${userPrompt}` }
              ],
              temperature: 0.1
            }),
            signal: controller.signal
          });
          clearTimeout(tid);

          if (res.ok) {
            const data = await res.json();
            const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
            if (text) {
              const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
              const match = cleaned.match(/\{[\s\S]*\}/);
              if (match) {
                planData = JSON.parse(match[0]);
              }
            }
          }
        } catch (e) {
          console.warn("Captain Agent LLM 规划失败，尝试下一个候选模型：", e);
        }
      }

      // 2. 规范化为统一的抽象节点列表 rawPlanNodes (支持任意 DAG 拓扑：串行、并行、菱形汇聚)
      let rawPlanNodes = [];
      let workflowTitle = (planData && planData.workflowName) || "";

      if (planData && Array.isArray(planData.nodes) && planData.nodes.length >= 1) {
        rawPlanNodes = planData.nodes.map((n, idx) => ({
          id: n.id || `node_${idx + 1}`,
          name: n.name || `环节 ${idx + 1}`,
          desc: n.desc || n.description || "",
          prompt: n.prompt || n.systemPrompt || `你负责执行【${n.name}】。`,
          tools: Array.isArray(n.tools) ? n.tools : [],
          dependsOn: Array.isArray(n.dependsOn) ? n.dependsOn : []
        }));
      } else if (planData && Array.isArray(planData.subtasks) && planData.subtasks.length >= 1) {
        // 兼容旧格式 subtasks + summaryName
        const wIds = planData.subtasks.map((_, i) => `w_${i + 1}`);
        rawPlanNodes = planData.subtasks.map((st, i) => ({
          id: wIds[i],
          name: st.name || `子任务 ${i + 1}`,
          desc: st.desc || "",
          prompt: st.prompt || "",
          tools: Array.isArray(st.tools) ? st.tools : [],
          dependsOn: []
        }));
        if (planData.summaryName) {
          rawPlanNodes.push({
            id: "summary_node",
            name: planData.summaryName,
            desc: "汇总上游成果并最终交付",
            prompt: planData.summaryPrompt || "综合上游全部成果给出最终产出。",
            tools: Array.isArray(planData.summaryTools) ? planData.summaryTools : [],
            dependsOn: [...wIds]
          });
        }
      }

      // 3. 启发式意图兜底分析（当网络中断或大模型均不可用时，基于专业语义规则进行多领域精准解构，彻底杜绝切分错词或虚假营销套路）
      if (rawPlanNodes.length === 0) {
        const raw = (userPrompt || "").trim();
        const isDrawingTask = /(?:海报|宣传图|配图|视觉图|插画|壁纸|画图|绘图|生图|做图|出图|图片|图像|渲染图|概念图|效果图)/i.test(raw);
        const isComparison = /(?:vs|对比|比较|PK|谁更|优劣)/i.test(raw);

        // 提取核心研究课题或对象，去除一切助词、口语与请求套话（如“给我”、“帮我”、“生成一个报告”等）
        let cleanSubject = raw
          .replace(/^(?:帮我|请|给我|麻烦|我想|想要|需要|尝试)/gi, "")
          .replace(/(?:调研一下|调研|分析一下|分析|了解一下|了解|研究一下|研究|探讨一下|探讨|看一下|搜集一下|搜集|检索一下|整理一下|整理)/gi, "")
          .replace(/(?:生成一个报告|生成一份报告|给我生成一个报告|给我出个报告|写一份报告|出具报告|做个报告|做一份报告|生成报告|写报告|出报告|报告|研报)/gi, "")
          .replace(/(?:生成一个海报|生成一张海报|画一张图|做一张海报|生成海报|设计海报|海报方案|海报|画图|做图|绘图|出图|图片|图像)/gi, "")
          .replace(/(?:的市场情况|的市场|市场情况|的情况|现状与趋势|现状|相关资料|资料)/gi, "")
          .replace(/[，,。？！\?!~、\s]+/g, " ")
          .trim();

        if (!cleanSubject || cleanSubject.length < 2) {
          cleanSubject = "目标业务课题";
        }

        // 复杂度动态分级感知（极简单点任务 vs 中度任务 vs 复杂长文本重型任务）
        const isTrivialSimple = raw.length <= 15 && !/(?:调研|分析|对比|规划|方案|海报|研报|预测|模型|战略|深度|报告)/i.test(raw);

        if (isTrivialSimple) {
          // 场景 0：极简单点轻量级任务（如单句问答、简单润色、快速指令）➔ 拒绝杀鸡用牛刀，1个节点直达交付
          workflowTitle = `${cleanSubject}·单点任务快速执行`;
          rawPlanNodes = [
            {
              id: "direct_execution",
              name: `${cleanSubject}·直接执行`,
              desc: `轻量级单点任务，单节点快速执行并交付结果。`,
              prompt: `你是一名全能高效的 AI 专家。请针对用户的指令【${raw}】进行针对性解答与交付，表达清晰、准确精炼。`,
              tools: ["websearch"],
              dependsOn: []
            }
          ];
        } else if (isDrawingTask) {
          // 场景 1：画面构思与 AI 绘图创作工作流（引导真实出图，杜绝虚假海报Slogan）
          workflowTitle = `${cleanSubject}·画面构思与 AI 绘图工作流`;
          rawPlanNodes = [
            {
              id: "visual_subject",
              name: `${cleanSubject}·画面主体与视觉要素提炼`,
              desc: `提炼【${cleanSubject}】的画面核心主体特征、形态结构与视觉细节。`,
              prompt: `你是一名资深概念设计研究员。请精准提炼【${cleanSubject}】的核心画面主体、外观细节与关键视觉特征，为后续绘图提供真实准确的视觉要素。严禁虚构商业宣传套话。`,
              tools: ["websearch"],
              dependsOn: []
            },
            {
              id: "art_composition",
              name: `${cleanSubject}·艺术风格与光影构图设计`,
              desc: `构思【${cleanSubject}】的构图视角、光影基调、色彩体系与艺术媒介风格。`,
              prompt: `你是一名资深美术指导。请为【${cleanSubject}】规划最佳构图透视（如广角、微距、透视等）、环境光影与艺术风格定位，输出具体的画面构成设计。严禁编造广告标语。`,
              tools: ["websearch"],
              dependsOn: []
            },
            {
              id: "image_rendering",
              name: `${cleanSubject}·AI 画面渲染与图像生成`,
              desc: `整合前置所有画面要素与构图规范，生成专业级英文生图 Prompt，并调用生图模型绘制高品质成品图。`,
              prompt: `你是一名资深 AI 绘画工程师与 Prompt 专家。请结合上游交付的主体特征与美术构图，提炼出可直接用于文生图的高品质中英文 Prompt（详细刻画主体、环境光照、材质及渲染质感），并直接调用生图工具完成画面绘制！`,
              tools: ["generate_image"],
              dependsOn: ["visual_subject", "art_composition"]
            }
          ];
        } else if (isComparison) {
          // 场景 2：对比分析与决策研报（多阶段纵深递进）
          const entities = cleanSubject.split(/\s+(?:vs|和|与|跟)\s+|\s+/i).filter(s => s.length > 0);
          const entityA = entities[0] || "标的 A";
          const entityB = entities[1] || "标的 B";
          workflowTitle = `${entityA} vs ${entityB}·多维对比与决策研报工作流`;
          rawPlanNodes = [
            {
              id: "research_a",
              name: `${entityA}·专项事实与深度情报调研`,
              desc: `归集【${entityA}】的核心指标、关键优势、财务/市场表现与最新动态。`,
              prompt: `你是一名资深行业分析师。【明确工具调用】：调用 websearch 工具检索【${entityA}】的核心客观指标、主营业务数据、竞争优劣势及最新动态；调用 fetch_url 深入提取权威研报。`,
              tools: ["websearch", "fetch_url"],
              dependsOn: []
            },
            {
              id: "research_b",
              name: `${entityB}·专项事实与深度情报调研`,
              desc: `归集【${entityB}】的核心指标、关键优势、财务/市场表现与最新动态。`,
              prompt: `你是一名资深行业分析师。【明确工具调用】：调用 websearch 工具检索【${entityB}】的核心客观指标、主营业务数据、竞争优劣势及最新动态；调用 fetch_url 深入提取权威研报。`,
              tools: ["websearch", "fetch_url"],
              dependsOn: []
            },
            {
              id: "quant_comparison",
              name: `${entityA} vs ${entityB}·量化指标交叉测算`,
              desc: `交叉对齐两方数据，构建量化加权评估模型与成本效益测算。`,
              prompt: `你是一名量化分析专家。【明确工具调用】：基于上游获取的【${entityA}】与【${entityB}】数据，调用 calc 工具构建量化对比矩阵（性价比、性能参数比、市场份额及 ROI 测算），输出客观量化评分。`,
              tools: ["calc"],
              dependsOn: ["research_a", "research_b"]
            },
            {
              id: "decision_summary",
              name: `${entityA} vs ${entityB}·综合决策研报`,
              desc: `统合量化评分与战略事实，产出多维决策矩阵与分场景推荐建议。`,
              prompt: `你是一名咨询战略合伙人。整合量化测算模型与两方核心事实，输出高管级对比决策研报，明确在不同业务场景下的推荐选型决策。`,
              tools: ["knowledge_write"],
              dependsOn: ["quant_comparison"]
            },
            {
              id: "action_roadmap",
              name: `选型落地与实施路线图`,
              desc: `向下拓展实操落地建议，制定迁移/落地节奏与知识库归档。`,
              prompt: `你是一名落地实施专家。【明确工具调用】：将决策建议落地为具体实施路线图（试运行里程碑、资源配置及风险预案），并调用 knowledge_write 将研报归档至本地知识库。`,
              tools: ["knowledge_write"],
              dependsOn: ["decision_summary"]
            }
          ];
        } else {
          // 场景 3：行业/市场/业务调研与研报任务
          // 感知是否为长文本/深度重型课题（字数较长、或包含多维复合诉求）
          const isHeavyComplex = raw.length >= 35 || /(?:深度|全景|战略|量化|落地|路线图|商业计划|规划|全流程|系统性)/i.test(raw);

          if (!isHeavyComplex) {
            // 中等轻便调研任务：3个节点（2路并行调研 ➔ 综合研报交付），轻盈高效
            workflowTitle = `${cleanSubject}·核心调研与研报工作流`;
            rawPlanNodes = [
              {
                id: "market_landscape",
                name: `${cleanSubject}·市场格局与核心数据调研`,
                desc: `摸排【${cleanSubject}】的市场现状、核心指标与主要参与者。`,
                prompt: `你是一名产业分析师。【明确工具调用】：调用 websearch 工具检索【${cleanSubject}】的核心市场规模、增长率与头部参与者数据；对权威研报调用 fetch_url 提取客观数据。`,
                tools: ["websearch", "fetch_url"],
                dependsOn: []
              },
              {
                id: "product_tech",
                name: `${cleanSubject}·核心产品与技术能力分析`,
                desc: `解构【${cleanSubject}】的核心业务亮点、技术壁垒与应用场景。`,
                prompt: `你是一名产品技术架构专家。【明确工具调用】：调用 websearch 工具深度分析【${cleanSubject}】的核心功能、关键技术架构与典型应用场景。`,
                tools: ["websearch"],
                dependsOn: []
              },
              {
                id: "comprehensive_report",
                name: `${cleanSubject}·综合研报与决策建议`,
                desc: `整合上游市场与产品技术调研成果，撰写综合分析报告并沉淀归档。`,
                prompt: `你是一名战略咨询顾问。全面整合上游调研成果，输出一份逻辑清晰、重点突出、包含可落地建议的综合研报，并调用 knowledge_write 将研报沉淀至本地知识库。`,
                tools: ["calc", "knowledge_write"],
                dependsOn: ["market_landscape", "product_tech"]
              }
            ];
          } else {
            // 复杂长文本/战略级重型课题：6个节点，4阶纵向递进流水线 + 下游行动落地拓展
            workflowTitle = `${cleanSubject}·全景深度调研与落地规划工作流`;
            rawPlanNodes = [
              {
                id: "market_landscape",
                name: `${cleanSubject}·行业规模与竞品格局调研`,
                desc: `摸排【${cleanSubject}】的市场规模、出货量/营收、市场占有率及核心竞品动态。`,
                prompt: `你是一名产业与市场分析专家。【明确工具调用】：调用 websearch 工具检索【${cleanSubject}】所处领域的行业市场规模、近年增长趋势、市场份额分布以及主要竞争对手对比；调用 fetch_url 提取权威研报客观数据。`,
                tools: ["websearch", "fetch_url"],
                dependsOn: []
              },
              {
                id: "product_tech",
                name: `${cleanSubject}·核心产品矩阵与技术能力分析`,
                desc: `深入剖析【${cleanSubject}】的产品线布局、核心关键技术优势与供应链合作生态。`,
                prompt: `你是一名产品与技术架构专家。【明确工具调用】：调用 websearch 工具深度分析【${cleanSubject}】的核心产品矩阵、主打功能特性、关键技术壁垒及供应链合作模式，输出结构化技术剖析。`,
                tools: ["websearch"],
                dependsOn: []
              },
              {
                id: "quant_model",
                name: `${cleanSubject}·量化指标与财务测算模型`,
                desc: `基于上游产业与产品数据，进行市场渗透率、增长率与投入产出比量化测算。`,
                prompt: `你是一名量化产业建模师。【明确工具调用】：基于上游获取的产业数据，调用 calc 工具进行行业复合增长率(CAGR)、市场渗透空间、毛利率及研发投入产出比量化测算，建立数据模型。`,
                tools: ["calc"],
                dependsOn: ["market_landscape", "product_tech"]
              },
              {
                id: "strategic_deepdive",
                name: `${cleanSubject}·商业壁垒与竞争战略深度解构`,
                desc: `解构技术壁垒、合规政策风向与替代品威胁，完成 SWOT 与波特五力剖析。`,
                prompt: `你是一名商业战略研究员。【明确工具调用】：针对上游暴露的关键技术与格局，调用 websearch 针对性检索行业竞争壁垒、政策风向与替代品威胁，输出深度战略洞察。`,
                tools: ["websearch"],
                dependsOn: ["market_landscape", "product_tech"]
              },
              {
                id: "comprehensive_report",
                name: `${cleanSubject}·高管战略决策咨询研报`,
                desc: `统筹汇聚量化模型与战略解构全部成果，输出顶层高管决策研报。`,
                prompt: `你是一名顶尖咨询机构战略合伙人。全面整合上游量化测算模型与深度战略洞察成果，撰写一份逻辑严密、论据详实的高管战略咨询报告。`,
                tools: ["calc"],
                dependsOn: ["quant_model", "strategic_deepdive"]
              },
              {
                id: "action_roadmap",
                name: `${cleanSubject}·落地路线图与全景交付文档`,
                desc: `将研报结论向下拓展为可落地的实操路线图，并最终输出一份体系化、可直接交付的高清全景战略文档。`,
                prompt: `你是一名业务落地与战略实施专家。请整合前置全部量化模型、战略洞察与高管决策结论，输出一份体系完整、排版精致、涵盖关键里程碑（Milestones）、落地实施节奏、资源预算分配与极端风险应对预案的完整战略实施全景交付文档。`,
                tools: [],
                dependsOn: ["comprehensive_report"]
              }
            ];
          }
        }
      }

      // 4. 通用 DAG 图拓扑生成与自适应坐标计算 (支持任意拓扑：串行、分叉、汇聚门控)
      // 选取用于普通节点的默认模型 ID（优先纯文本对话模型，严禁绑定纯生图模型）
      const chatModel = candidateModels[0] || (JIGSAW.ModelService && JIGSAW.ModelService.getActive());
      const modelId = (chatModel && chatModel.id) || "deepseek-chat";

      const startNodeId = convId + "-n-start";
      const startNode = {
        id: startNodeId,
        agentType: "start",
        category: "logic",
        name: "START · 任务起点",
        icon: "play",
        description: "工作流唯一固定源头：接收 Prompt 并向后分发。",
        modelId: "",
        systemPrompt: "【任务起点】工作流源头输入。",
        tools: [],
        input: "用户输入 / 任务目标",
        output: userPrompt,
        status: "waiting",
        x: 60,
        y: 260
      };

      // 拓扑深度计算 (DAG Leveling)
      const idMap = new Map();
      rawPlanNodes.forEach((n, idx) => {
        idMap.set(n.id, `${convId}-n-${n.id || (idx + 1)}`);
      });

      const nodeDepth = new Map();
      nodeDepth.set(startNodeId, 0);

      function getDepth(nId) {
        if (nodeDepth.has(nId)) return nodeDepth.get(nId);
        const node = rawPlanNodes.find(rn => rn.id === nId);
        if (!node || !node.dependsOn || node.dependsOn.length === 0) {
          nodeDepth.set(nId, 1);
          return 1;
        }
        let maxD = 0;
        node.dependsOn.forEach(dId => {
          maxD = Math.max(maxD, getDepth(dId));
        });
        const d = maxD + 1;
        nodeDepth.set(nId, d);
        return d;
      }
      rawPlanNodes.forEach(rn => getDepth(rn.id));

      // 组装最终节点与连线，自动在多路依赖处注入与门 (AND Gate)
      const finalNodes = [startNode];
      const finalEdges = [];
      let gateCount = 0;

      // 尊重并执行 AI 大模型的工具规划决策（杜绝人工正则强加生图等非预期工具）
      const isFromLLM = !!(planData && planData.nodes && planData.nodes.length >= 1);
      rawPlanNodes.forEach(rn => {
        let tools = Array.isArray(rn.tools) ? [...rn.tools] : [];
        const text = (rn.name + " " + (rn.desc || "") + " " + (rn.prompt || "")).toLowerCase();

        // 仅在非 LLM 规划的离线启发式兜底模式下，才进行必要的基础检索与计算赋能
        if (!isFromLLM) {
          // 1. 调研类节点 ➔ 配 websearch
          const isResearch = /调研|分析|情报|竞品|搜集|检索|查阅|摸排|行情|现状|格局|趋势|技术|商业|政策|用户|生态|架构/i.test(text);
          if (isResearch && !tools.includes("websearch")) tools.push("websearch");

          // 2. 深度研报 ➔ 配 fetch_url
          const isDeepFetch = /抓取|长文|官网|研报|法规/i.test(text);
          if (isDeepFetch && !tools.includes("fetch_url")) tools.push("fetch_url");

          // 3. 财务与量化测算 ➔ 配 calc
          const isCalc = /测算|计算|财务|估值|增长率|cagr|收益|成本|数据量化/i.test(text);
          if (isCalc && !tools.includes("calc")) tools.push("calc");
        }

        // 每次配置工具时，自动附带当前时间工具 (get_current_time)，提供精准时效基准
        if (tools.length > 0 && !tools.includes("get_current_time")) {
          tools.push("get_current_time");
        }

        // 兜底：如果任何普通节点依然没有任何工具，默认赋予最核心的 websearch 检索能力与时间基准！
        if (tools.length === 0) {
          tools.push("websearch", "get_current_time");
        }

        rn.tools = tools;
      });

      rawPlanNodes.forEach(rn => {
        const mappedId = idMap.get(rn.id);
        // 100% 由 AI 规划决定：只有当 AI 为该节点分配了 generate_image 工具时，才认定为生图节点
        const isVisual = Array.isArray(rn.tools) && rn.tools.includes("generate_image");
        const activeImg = (isVisual && JIGSAW.ImageService) ? JIGSAW.ImageService.getActive() : null;
        const nodeTools = Array.isArray(rn.tools) ? rn.tools : [];

        const agentNode = {
          id: mappedId,
          agentType: "agent",
          category: "agent",
          name: rn.name,
          icon: isVisual ? "image" : "agent",
          description: rn.desc,
          modelId,
          imageModelId: activeImg ? activeImg.id : "",
          systemPrompt: rn.prompt,
          tools: nodeTools,
          input: "",
          output: "",
          status: "waiting",
          maxToolCalls: 5,
          onError: "abort",
          skipped: false,
          rawDepth: nodeDepth.get(rn.id)
        };

        const deps = (rn.dependsOn || []).filter(d => idMap.has(d));
        if (deps.length === 0) {
          // 直接依赖起点
          finalEdges.push({
            id: `${convId}-e-start-${rn.id}`,
            from: startNodeId,
            to: mappedId,
            fromPort: "out",
            toPort: "in"
          });
        } else if (deps.length === 1) {
          // 简单串行依赖
          finalEdges.push({
            id: `${convId}-e-${deps[0]}-${rn.id}`,
            from: idMap.get(deps[0]),
            to: mappedId,
            fromPort: "out",
            toPort: "in"
          });
        } else {
          // 多路汇聚依赖：自动注入与门 (AND Gate)
          gateCount++;
          const gateId = `${convId}-n-gate${gateCount}`;
          const andGateNode = {
            id: gateId,
            agentType: "gate_and",
            category: "logic",
            name: `与门 (${deps.length}路 AND 汇聚)`,
            icon: "gate-and",
            description: `同步栅栏：等待 ${deps.length} 个前置分支达成后再流转。`,
            modelId: "",
            systemPrompt: "【逻辑与门】前置依赖全部达成时放行后续节点。",
            tools: [],
            input: "",
            output: "",
            status: "waiting",
            gateType: "AND",
            rawDepth: agentNode.rawDepth - 0.5
          };
          finalNodes.push(andGateNode);

          deps.forEach(d => {
            finalEdges.push({
              id: `${convId}-e-${d}-g${gateCount}`,
              from: idMap.get(d),
              to: gateId,
              fromPort: "out",
              toPort: "in"
            });
          });
          finalEdges.push({
            id: `${convId}-e-g${gateCount}-${rn.id}`,
            from: gateId,
            to: mappedId,
            fromPort: "out",
            toPort: "in"
          });
        }

        finalNodes.push(agentNode);
      });

      // 5. 坐标优雅计算 (按 column 优雅居中排布)
      // 重新对所有节点依据拓扑排布列分配 column
      const sortedNodes = finalNodes.filter(n => n.id !== startNodeId).sort((a, b) => (a.rawDepth || 0) - (b.rawDepth || 0));
      const colMap = new Map();
      // 获取不同的 depth 值并依次分配列号
      const uniqueDepths = Array.from(new Set(sortedNodes.map(n => n.rawDepth))).sort((a, b) => a - b);
      uniqueDepths.forEach((d, colIdx) => colMap.set(d, colIdx + 1));

      const columns = new Map();
      columns.set(0, [startNode]);
      sortedNodes.forEach(n => {
        const c = colMap.get(n.rawDepth) || 1;
        if (!columns.has(c)) columns.set(c, []);
        columns.get(c).push(n);
      });

      let maxColCount = 1;
      columns.forEach(arr => { maxColCount = Math.max(maxColCount, arr.length); });

      const gapY = 170;
      const centerY = Math.max(260, 60 + ((maxColCount - 1) * gapY) / 2);
      startNode.y = centerY;

      columns.forEach((arr, colIdx) => {
        const colX = 60 + colIdx * 340;
        const colStart = centerY - ((arr.length - 1) * gapY) / 2;
        arr.forEach((n, idx) => {
          n.x = colX;
          n.y = Math.round(colStart + idx * gapY);
        });
      });

      // 6. 落盘至当前工作流
      wf.nodes = finalNodes;
      wf.edges = finalEdges;
      if (workflowTitle) wf.name = workflowTitle;
      wf.executed = false;
      wf.running = false;
      Store.notify("workflows");
      return true;
    },

    /**
     * 将指定工作流拓扑结构序列化为独立的矢量 SVG 字符串
     * @param {string|object} wfId - 工作流 ID 或工作流对象
     * @param {object} opts - 选项 { padding: 40 }
     * @returns {string} 标准 SVG XML 字符串
     */
    toSvg(wfId, opts = {}) {
      const wf = typeof wfId === "object" ? wfId : this.get(wfId);
      if (!wf || !wf.nodes || wf.nodes.length === 0) return "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='40'></svg>";

      const pad = opts.padding || 40;
      const nodeW = 230;
      const nodeH = 100;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      wf.nodes.forEach(n => {
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + nodeW);
        maxY = Math.max(maxY, n.y + nodeH);
      });

      const viewBoxX = Math.round(minX - pad);
      const viewBoxY = Math.round(minY - pad);
      const width = Math.round(maxX - minX + pad * 2);
      const height = Math.round(maxY - minY + pad * 2);

      const statusColors = {
        success: { fill: "#064e3b", text: "#34d399", border: "#059669" },
        running: { fill: "#1e3a8a", text: "#60a5fa", border: "#2563eb" },
        failed: { fill: "#7f1d1d", text: "#f87171", border: "#dc2626" },
        skipped: { fill: "#374151", text: "#9ca3af", border: "#4b5563" },
        waiting: { fill: "#1e293b", text: "#94a3b8", border: "#334155" }
      };

      const escapeXml = s => String(s || "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

      // 1. 连线
      let edgesXml = "";
      wf.edges.forEach(e => {
        const fromNode = wf.nodes.find(n => n.id === e.from);
        const toNode = wf.nodes.find(n => n.id === e.to);
        if (!fromNode || !toNode) return;

        const x1 = Math.round(fromNode.x + nodeW);
        const y1 = Math.round(fromNode.y + nodeH / 2);
        const x2 = Math.round(toNode.x);
        const y2 = Math.round(toNode.y + nodeH / 2);

        const dx = Math.max(40, (x2 - x1) * 0.5);
        const pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

        const isSuccess = fromNode.status === "success" && (toNode.status === "success" || toNode.status === "running");
        const strokeColor = isSuccess ? "#10b981" : (toNode.status === "running" ? "#3b82f6" : "#475569");
        const strokeWidth = isSuccess ? 2.2 : 1.5;
        const marker = isSuccess ? "url(#marker-success)" : "url(#marker-default)";

        edgesXml += `  <path d="${pathD}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}" marker-end="${marker}" />\n`;
      });

      // 2. 节点
      let nodesXml = "";
      wf.nodes.forEach(n => {
        const x = Math.round(n.x);
        const y = Math.round(n.y);
        const isStart = n.agentType === "start";
        const isLogic = n.category === "logic" || n.agentType.startsWith("gate_");

        const sc = statusColors[n.status] || statusColors.waiting;
        const cardBg = isStart ? "#18181b" : (isLogic ? "#111827" : "#0f172a");
        const cardBorder = isStart ? "#3f3f46" : (isLogic ? "#3b82f6" : (n.status === "success" ? "#059669" : "#334155"));

        const categoryLabel = isStart ? "TRIGGER 起点" : (isLogic ? "LOGIC 栅栏" : "AGENT 智能体");
        const categoryColor = isStart ? "#a1a1aa" : (isLogic ? "#60a5fa" : "#c084fc");

        const safeName = escapeXml(n.name.length > 15 ? n.name.slice(0, 14) + "…" : n.name);
        const safeDesc = escapeXml((n.description || "").slice(0, 24) + ((n.description || "").length > 24 ? "…" : ""));

        nodesXml += `
  <g transform="translate(${x}, ${y})" id="node-${escapeXml(n.id)}">
    <rect width="${nodeW}" height="${nodeH}" rx="8" ry="8" fill="${cardBg}" stroke="${cardBorder}" stroke-width="1.5" />
    <text x="14" y="24" font-size="10" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" font-weight="700" fill="${categoryColor}" letter-spacing="0.05em">${categoryLabel}</text>
    <rect x="${nodeW - 68}" y="12" width="56" height="18" rx="4" ry="4" fill="${sc.fill}" stroke="${sc.border}" stroke-width="1" />
    <text x="${nodeW - 40}" y="24.5" font-size="9.5" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" font-weight="600" fill="${sc.text}" text-anchor="middle">${n.status.toUpperCase()}</text>
    <line x1="12" y1="36" x2="${nodeW - 12}" y2="36" stroke="#334155" stroke-width="0.8" />
    <text x="14" y="58" font-size="12.5" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" font-weight="600" fill="#f8fafc">${safeName}</text>
    <text x="14" y="78" font-size="10.5" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" fill="#94a3b8">${safeDesc}</text>
  </g>\n`;
      });

      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBoxX} ${viewBoxY} ${width} ${height}" width="${width}" height="${height}" style="background-color:#090d16; border-radius:10px; max-width:100%; height:auto;">
  <defs>
    <marker id="marker-default" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M 0 1.5 L 8 5 L 0 8.5 Z" fill="#64748b" />
    </marker>
    <marker id="marker-success" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M 0 1.5 L 8 5 L 0 8.5 Z" fill="#10b981" />
    </marker>
  </defs>
  <g opacity="0.15">
    <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1" fill="#475569" />
    </pattern>
    <rect x="${viewBoxX}" y="${viewBoxY}" width="${width}" height="${height}" fill="url(#grid)" />
  </g>
  <g id="edges-layer">
${edgesXml}  </g>
  <g id="nodes-layer">
${nodesXml}  </g>
</svg>`;
    }
  };

  JIGSAW.WorkflowService = WorkflowService;
})();
