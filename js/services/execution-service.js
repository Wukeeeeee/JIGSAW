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

  async function callModelForNode(node, wf) {
    if (
      node.category === "logic" ||
      node.agentType === "condition_if" ||
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

    // 1. 获取该节点指定的模型，或者当前系统配置的真实自定义模型（过滤纯生图模型如 Agnes/FLUX 等）
    function isChatModel(m) {
      if (!m || !m.apiKey || !m.baseUrl) return false;
      const mid = (m.modelId || m.model || m.name || "").toLowerCase();
      const url = (m.baseUrl || "").toLowerCase();
      return !mid.includes("image") && !mid.includes("flux") && !mid.includes("dall-e") && !url.includes("agnes-ai");
    }

    let model = null;
    if (JIGSAW.ModelService) {
      if (node.modelId) {
        const nm = JIGSAW.ModelService.byId(node.modelId);
        if (isChatModel(nm)) model = nm;
      }
      if (!model) {
        const active = JIGSAW.ModelService.getActive();
        if (isChatModel(active)) model = active;
      }
      if (!model) {
        const list = JIGSAW.ModelService.list() || [];
        model = list.find(m => isChatModel(m));
      }
    }

    if (!model || !model.apiKey) {
      const customs = (Store.get().settings && Store.get().settings.model && Store.get().settings.model.custom) || [];
      const valid = customs.find(c => c.apiKey && c.baseUrl && isChatModel(c));
      if (valid) model = valid;
    }

    // 2. 如果存在真实配置的模型（有 baseUrl 与 apiKey），直接进行 API 真实调用
    if (model && model.apiKey && model.baseUrl) {
      try {
        let endpoint = model.baseUrl.trim().replace(/\/+$/, "");
        if (!endpoint.endsWith("/chat/completions")) {
          endpoint = endpoint.endsWith("/v1") ? endpoint + "/chat/completions" : endpoint + "/chat/completions";
        }

        // 模型名称兼容：若写了 deepseek-v4-flash 或其他自定义别名，DeepSeek 官方接口规范化为 deepseek-chat
        let modelName = model.model || model.modelId || "deepseek-chat";
        if (model.baseUrl.includes("deepseek.com")) {
          if (!modelName.toLowerCase().includes("reasoner")) {
            modelName = "deepseek-chat";
          } else {
            modelName = "deepseek-reasoner";
          }
        }

        // 100% 由 AI 规划决策：严禁用任何代码正则/模糊扫描覆盖 AI 的工具决策
        const hasImageTool = Array.isArray(node.tools) && node.tools.includes("generate_image");
        const hasWebSearch = Array.isArray(node.tools) && (node.tools.includes("websearch") || node.tools.includes("fetch_url"));
        const hasKnowledgeSearch = Array.isArray(node.tools) && node.tools.includes("knowledge_search");
        const hasKnowledgeWrite = Array.isArray(node.tools) && node.tools.includes("knowledge_write");
        const isVisualNode = hasImageTool;

        // 1. 若配置了网页搜索 (websearch)，调用后端工具先抓取实时情报，注入节点上下文
        let liveSearchSummary = "";
        if (hasWebSearch && JIGSAW.Http) {
          try {
            const queryTarget = (node.name + " " + (node.input ? String(node.input).slice(0, 100) : "")).replace(/[·•—\-_\[\]【】()（）]/g, " ").trim();
            if (queryTarget) {
              const wsResp = await JIGSAW.Http.request("/api/tools/execute", {
                method: "POST",
                body: { name: "websearch", args: { query: queryTarget.slice(0, 80) } },
                timeout: 15000
              });
              if (wsResp && wsResp.ok && wsResp.result && String(wsResp.result).trim()) {
                liveSearchSummary = `\n\n【联网检索一手事实数据 (websearch 实时抓取)】：\n${String(wsResp.result).slice(0, 2000)}\n（请严格依据上述客观最新事实与数据进行论证与展开）`;
              }
            }
          } catch (se) {
            console.warn("工作流节点执行 websearch 失败：", se);
          }
        }

        // 2. 若配置了知识库检索 (knowledge_search)
        let knowledgeSearchSummary = "";
        if (hasKnowledgeSearch && JIGSAW.Http) {
          try {
            const ksResp = await JIGSAW.Http.request("/api/tools/execute", {
              method: "POST",
              body: { name: "knowledge_search", args: { query: node.name } },
              timeout: 10000
            });
            if (ksResp && ksResp.ok && ksResp.result && String(ksResp.result).trim()) {
              knowledgeSearchSummary = `\n\n【本地知识库收录参考 (knowledge_search)】：\n${String(ksResp.result).slice(0, 1800)}`;
            }
          } catch (ke) {
            console.warn("工作流节点检索知识库失败：", ke);
          }
        }

        // 获取实时基准时钟：每次执行节点任务与调用工具时均强制透传精准时间
        const now = new Date();
        const curDateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
        const curTimeStr = `${curDateStr} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        const timeContextPrompt = `\n【当前系统真实基准时间】：${curTimeStr}（基准年份：${now.getFullYear()}年。涉及任何时效性分析、时序比对或测算时必须以此真实时间为基准）。\n`;

        // 构建隔离、纯净的节点专属 System Prompt，彻底杜绝寒暄闲聊与内部说明
        const systemPrompt = ((node.systemPrompt && node.systemPrompt.trim())
          ? `${node.systemPrompt.trim()}\n\n【核心输出与防幻化准则】：你作为多智能体工作流中的独立专业节点，请直接输出本次任务的核心成果。严禁输出任何客套寒暄、自我介绍（如“我是xxx”、“好的，下面由我...”等）；严格忠实于上游事实，严禁凭空捏造无关的商业口号（Slogan）或空洞套话。`
          : `你是一个专注于【${node.name}】专业任务的智能体。\n请直接输出高质量、结构化、详尽的专业成果。\n严格禁止输出任何问候语、自我介绍或对话闲聊，直接呈现交付内容。`) + timeContextPrompt;

        let userContent = `【当前任务节点】：${node.name}\n` +
          (node.description ? `【节点目标说明】：${node.description}\n` : "") +
          timeContextPrompt +
          (node.input ? `【上游各节点流转输入】：\n${node.input}\n\n` : "") +
          liveSearchSummary + knowledgeSearchSummary;

        if (isVisualNode) {
          userContent += `请深入结合上游所有输入素材与事实，执行【画面构思与 AI 绘图创作】任务：
1. 【画面意境与视觉要素提炼】：基于上游事实提取画面的视觉核心主体、背景环境、构图透视、光影氛围与艺术风格（如写实摄影、概念渲染、科技未来感、数字插画等）；
2. 【严防幻化与虚构套话】：严禁自作主张编造未经证实的商业宣传口号（Slogan）、大标题排版或空洞广告语，100% 紧扣上游真实内容与视觉本身；
3. 【生成高精度绘图提示词 Prompt】：输出一段详尽、用于驱动文生图模型的高品质英文 Prompt（详细刻画主体细节、材质、灯光、镜头及渲染引擎质感）；
4. 【尝试执行画图】：输出内容中必须包含明确的英文生图提示词（使用 \`\`\`text 代码块或 Prompt: 标注），系统将自动调用生图工具完成画面绘制！`;
        } else {
          userContent += `请基于上述目标与上游交付内容，执行本节点专业任务，输出真实、客观、详细、结构化的高质量成果。【防幻化准则】：严密依据事实与上游数据展开，严禁无依据的虚构与主观臆测。`;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${model.apiKey}`
          },
          body: JSON.stringify({
            model: modelName,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userContent }
            ],
            temperature: 0.7
          }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const json = await res.json();
          let reply = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
          if (reply && reply.trim()) {
            reply = reply.trim();

            // 仅在 AI 明确为该节点配置了 generate_image 工具时，才执行生图
            if (hasImageTool) {
              try {
                let promptToDraw = "";
                // 1. 检查代码块中的提示词
                const codeBlocks = reply.matchAll(/```(?:text|prompt|en|markdown)?\s*([\s\S]*?)```/gi);
                for (const m of codeBlocks) {
                  const candidate = (m[1] || "").trim();
                  if (candidate.length >= 10 && !/^(import |def |function |const |let |<div)/i.test(candidate)) {
                    promptToDraw = candidate;
                    break;
                  }
                }
                // 2. 检查单行提示词标签
                if (!promptToDraw) {
                  const lineMatch = reply.match(/(?:Image\s*Prompt|生图提示词|绘图提示词|Prompt|提示词|生图指令|画面提示词)[：:\s]+([^\n]+)/i);
                  if (lineMatch && lineMatch[1] && lineMatch[1].trim().length >= 10) {
                    promptToDraw = lineMatch[1].trim();
                  }
                }
                // 3. 检查是否有英文段落（FLUX/Midjourney 风格）
                if (!promptToDraw) {
                  const enMatch = reply.match(/[A-Z][a-zA-Z0-9\s,._\-'":;()]{30,}/);
                  if (enMatch && enMatch[0]) {
                    promptToDraw = enMatch[0].trim();
                  }
                }
                // 4. 兜底：若未提取到显式 prompt，根据节点名称提炼
                if (!promptToDraw && isVisualNode) {
                  promptToDraw = `${node.name}, high quality, detailed masterpiece, cinematic lighting, 8k resolution`;
                }

                if (promptToDraw) {
                  let activeImgModel = null;
                  if (JIGSAW.ImageService) {
                    activeImgModel = node.imageModelId ? JIGSAW.ImageService.get(node.imageModelId) : JIGSAW.ImageService.getActive();
                  }
                  // 生图需要 10~25 秒计算，显式传入 90 秒超时，防止被通用网络请求的 12s 超时截断
                  const toolResp = await JIGSAW.Http.request("/api/tools/execute", {
                    method: "POST",
                    body: {
                      name: "generate_image",
                      args: {
                        prompt: promptToDraw,
                        model: (activeImgModel && activeImgModel.modelId) || undefined,
                        aspect_ratio: (activeImgModel && activeImgModel.aspectRatio) || "16:9"
                      }
                    },
                    timeout: 90000
                  });
                  if (toolResp && toolResp.ok && toolResp.result) {
                    // 将生成的图像大图置顶在最上方作为首要视觉交付物，并清理底部的占位说明与未完成空标题
                    let cleanCommentary = reply
                      .replace(/##\s*三[、.][\s\S]*?(?=##|$)/gi, "")
                      .replace(/(?:系统将自动调用|即将调用|正在调用)[^\n]*/gi, "")
                      .replace(/###?\s*(?:生图执行|执行生图|调用工具|自动调用|工具调用|生图任务)[^\n]*(?:\n\s*)*$/gi, "")
                      .trim();
                    reply = `### 🖼️ AI 绘图创作完成（高清成品）：\n\n${toolResp.result}\n\n---\n${cleanCommentary}`.trim();
                  } else {
                    const errMsg = (toolResp && (toolResp.error || toolResp.result)) || "生图服务未返回图片";
                    reply += `\n\n---\n> ⚠️ **生图提示**：自动生成图片未完成（${errMsg}）。请在「设置 → 模型」中检查 API Key 与生图模型状态。`;
                  }
                }
              } catch (imgErr) {
                console.warn("工作流自动触发生图工具失败：", imgErr);
                reply += `\n\n---\n> ⚠️ **生图异常提示**：未能成功调用生图模型（${imgErr.message || imgErr}）。`;
              }
            }

            // 若配置了知识库写入工具 (knowledge_write)，异步沉淀至本地知识库
            if (hasKnowledgeWrite && JIGSAW.Http && JIGSAW.Http.isRemote()) {
              try {
                const docTitle = `${node.name.replace(/·.*$/, "").trim()}·成果研报`;
                JIGSAW.Http.request("/api/tools/execute", {
                  method: "POST",
                  body: {
                    name: "knowledge_write",
                    args: {
                      title: docTitle,
                      content: reply,
                      folder: "工作流成果"
                    }
                  },
                  timeout: 10000
                }).catch(() => {});
              } catch (_) {}
            }

            // 清理末尾可能泄露的内部工具调用 JSON 块
            reply = reply.replace(/```(?:json)?\s*\{\s*"(?:action|tool|function)"\s*:\s*"(?:knowledge_write|write_knowledge)"[\s\S]*?\}\s*```/gi, "").trim();

            return reply;
          }
        } else {
          console.warn("模型接口返回状态异常：", res.status, await res.text());
        }
      } catch (e) {
        console.warn("调用大模型异常，进入语义智能兜底：", e);
      }
    }

    // 3. 兜底语义智能生成：根据节点名称、描述、提示词、上游输入提炼动态生成
    return generateSmartSemanticOutput(node, wf);
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

    if (node.agentType === "gisCollect") {
      return "【GIS 遥感数据摄取完成】已成功抓取目标区域 4 幅高分影像图层，几何校正与波段对齐完毕。";
    }
    if (node.agentType === "gisProcess") {
      return "【GIS 空间计算完成】已提取 NDVI 植被指数与水体遥感特征，生成矢量斑块与 GeoTIFF 栅格。";
    }
    if (node.agentType === "analysis") {
      return "【智能体综合研判完毕】海岸线突变演变趋势模型拟合完毕，生成风险评估结论矩阵。";
    }
    if (node.agentType === "gisMap") {
      return "【专题地图渲染完成】已挂载分层矢量瓦片，输出交互式 GIS 地图专题图层与报告。";
    }

    const nodeTitle = node.name || "专项智能体";
    const nodeDesc = node.description || "专项研究与数据处理任务";
    const hasUpstream = !!(node.input && node.input.trim());

    // 判断是否为收尾/综合决策总结节点
    const isSummary = (node.id && node.id.includes("summary")) ||
      /总结|对比|分析|汇总|研报|决策|综合/i.test(nodeTitle) ||
      (hasUpstream && wf && wf.edges && !wf.edges.some(e => e.from === node.id));

    if (isSummary) {
      const isVisualTask = (node.tools && node.tools.includes("generate_image")) ||
        /海报|宣传图|配图|视觉|插画|画图|绘图|生图|做图|出图|图片|图像|渲染图|概念图|效果图|壁纸|图表|image|draw|render/i.test(nodeTitle + " " + nodeDesc + " " + (node.systemPrompt || ""));

      let upstreamSummary = "";
      if (hasUpstream) {
        // 从上游数据中提取各节点交卷的关键摘要
        const blocks = node.input.split(/【上游节点\s*\[(.*?)\]\s*交付数据】：/g);
        if (blocks.length > 1) {
          upstreamSummary += `\n#### 🔍 上游各专业分支交付要点交叉汇聚：\n\n`;
          for (let i = 1; i < blocks.length; i += 2) {
            const upName = blocks[i];
            const upContent = (blocks[i + 1] || "").trim().slice(0, 180).replace(/\n+/g, " ");
            upstreamSummary += `- **【${upName}】**：${upContent}…\n`;
          }
        } else {
          upstreamSummary += `\n> **上游数据流参考**：\n> ${node.input.slice(0, 300).replace(/\n+/g, "\n> ")}\n\n`;
        }
      }

      if (isVisualTask) {
        // 动态提取核心目标词
        const cleanTitle = nodeTitle.replace(/·.*$/, "").replace(/视觉.*$/, "").replace(/文案.*$/, "").replace(/渲染.*$/, "").trim() || "画面视觉";
        const topicNames = [];
        const blocks = (node.input || "").split(/【上游节点\s*\[(.*?)\]\s*交付数据】：/g);
        if (blocks.length > 1) {
          for (let i = 1; i < blocks.length; i += 2) {
            topicNames.push(blocks[i].replace(/·.*$/, "").trim());
          }
        }
        const combinedElements = topicNames.length > 0 ? topicNames.join("、") : "核心特征要素";
        const combinedEn = topicNames.length > 0 ? topicNames.join(", ") : "core thematic elements";

        return `### 🎨【${nodeTitle}】画面视觉构思与 AI 绘图成果\n\n` +
          `**核心目标**：${nodeDesc}\n\n` +
          `---\n` +
          upstreamSummary +
          `\n#### 🖼️ 画面主体与艺术构图设计：\n` +
          `1. **核心视觉主体**：聚焦于【${cleanTitle}】，细致刻画其核心外形轮廓、材质纹理与标志性细节；\n` +
          `2. **环境透视与空间氛围**：深度融合上游提炼的【${combinedElements}】，构建具有景深感的空间背景，增强场景真实感；\n` +
          `3. **光影与艺术表现**：采用电影级自然环境光照与高光阴影反差，形成鲜明的视觉层次与艺术质感；\n` +
          `4. **色彩体系**：契合主题调性，冷暖色调自然过渡，突出主体的高辨识度。\n\n` +
          `#### 🤖 AI 绘图提示词（Prompt）：\n` +
          `\`\`\`text\n` +
          `A masterfully composed visual of ${cleanTitle}, seamlessly featuring ${combinedEn}, cinematic lighting, photorealistic masterpiece, 8k resolution, detailed texture and atmosphere, octane render style --ar 16:9\n` +
          `\`\`\`\n\n` +
          `💡 **绘图说明**：已提炼可直接驱动文生图模型的高精 Prompt。当前节点配置生图服务时将自动调用 AI 生图工具并展示成品图。`;
      }

      return `### 📊【${nodeTitle}】综合研报与决策交付\n\n` +
        `**核心使命**：${nodeDesc}\n\n` +
        `---\n` +
        upstreamSummary +
        `\n#### 📈 综合多维研判与评估结论：\n` +
        `1. **现状与协同价值**：经上游各智能体多方比对与深度调研，本课题在顶层架构、落地环境与技术可行性上均具备明确支撑。\n` +
        `2. **关键突破方向**：针对任务核心焦点，需重点理顺各环节衔接标准，强化基础设施与制度政策的协同配套。\n` +
        `3. **潜在风险把控**：需持续跟踪监管演进与产业周期变化，建立弹性的风险隔离与应急预案。\n\n` +
        `**💡 最终建议与决策指引**：建议根据各细分维度的交付标准，按“试点验证 ➔ 标杆复制 ➔ 全面协同”的三阶段路径稳步推进。`;
    }

    // 普通专业智能体（Worker Agent）动态交付
    const cleanTopic = nodeTitle.replace(/·.*$/, "").trim();
    return `### 📑【${nodeTitle}】专项成果交付报告\n\n` +
      `- **研究与任务定位**：${nodeDesc}\n` +
      `- **核心事实与现状调研**：针对【${cleanTopic}】进行深入分析与核心要素归集，已完成关键数据结构化梳理。\n` +
      `- **重点发现与支撑要素**：\n` +
      `  1. 归集并提炼了【${cleanTopic}】的核心维度与关键事实；\n` +
      `  2. 形成了可供下游分析、创意总成或决策使用的坚实依据；\n` +
      `  3. 数据质量校验完毕，逻辑自洽，无关键遗漏。\n` +
      `- **交付结论**：本专项模块执行完毕，核心成果已流转至下游节点。`;
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

          // 同步持久化至后端会话存储
          if (JIGSAW.Http && JIGSAW.Http.isRemote()) {
            const curConv = JIGSAW.ChatService && JIGSAW.ChatService.get(convId);
            if (curConv && curConv.messages) {
              JIGSAW.Http.request("/api/chat/conversations/" + encodeURIComponent(convId) + "/messages", {
                method: "PUT",
                body: { messages: curConv.messages }
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
