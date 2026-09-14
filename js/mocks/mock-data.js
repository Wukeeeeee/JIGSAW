/* ============================================================
   JIGSAW — Mock 数据层（中文界面文案）
   种子数据。将来替换 *Service 实现即可接入真实 AI。
   ============================================================ */
(function () {
  const now = Date.now();
  const H = 3600e3, D = 24 * H;
  const t = d => new Date(now - d).toISOString();

  const MODELS = [
    { id: "jigsaw-ultra", name: "JIGSAW Ultra", desc: "深度推理，支持多 Agent 协作", context: 256000, vision: true, tools: true },
    { id: "jigsaw-rapid", name: "JIGSAW Rapid", desc: "速度与质量均衡", context: 128000, vision: true, tools: true },
    { id: "jigsaw-mini",  name: "JIGSAW Mini",  desc: "低延迟，适合快速任务", context: 64000, vision: false, tools: false }
  ];

  /* Agent 模板 —— 用于实例化工作流节点
     ★ tools 必须是后端 tools/ 里真实注册的工具 id（后端 /api/tools 会返回同一批：
       get_current_time / websearch / fetch_url / shell / AskUser / editfile /
       apply_patch / calc / read_extra / knowledge_search / knowledge_info）。
       不要写不存在的工具名——勾了也不会有任何效果。 */
  const AGENTS = {
    research: {
      type: "research", name: "研究 Agent", icon: "globe",
      desc: "检索网络与本地知识库，为任务收集有据可依的素材。",
      defaultModel: "jigsaw-ultra", tools: ["websearch", "fetch_url", "knowledge_search", "read_extra"],
      systemPrompt: "你是一名研究专员。围绕用户任务收集真实、有来源的事实材料，输出结构化简报，附关键发现与来源链接。"
    },
    analysis: {
      type: "analysis", name: "分析 Agent", icon: "cpu",
      desc: "分析已收集的数据，提炼规律并产出结构化结论。",
      defaultModel: "jigsaw-ultra", tools: ["calc", "read_extra", "shell"],
      systemPrompt: "你是一名分析专员。把原始素材整理成清晰、结构化的洞察，优先使用表格与量化摘要。"
    },
    writer: {
      type: "writer", name: "写作 Agent", icon: "edit",
      desc: "把分析结果写成条理清晰的最终文稿。",
      defaultModel: "jigsaw-rapid", tools: ["editfile", "apply_patch"],
      systemPrompt: "你是一名写作专员。基于分析结果撰写结构清晰、措辞专业的最终回复，语气贴近资深分析师。"
    },
    final: {
      type: "final", name: "终审 Agent", icon: "check",
      desc: "复核、合并各环节结果，向用户交付最终答案。",
      defaultModel: "jigsaw-rapid", tools: ["read_extra", "knowledge_search"],
      systemPrompt: "你是终审环节。合并草稿、核对完整性，以恰当的排版向用户交付最终答案。"
    },
    gisCollect: {
      type: "gisCollect", name: "数据采集 Agent", icon: "layers",
      desc: "获取数据源：在线图层、本地文件与知识库资料。",
      defaultModel: "jigsaw-rapid", tools: ["fetch_url", "shell", "read_extra"],
      systemPrompt: "你是数据工程师。负责采集并校验任务所需的全部数据集。"
    },
    gisProcess: {
      type: "gisProcess", name: "数据加工 Agent", icon: "terminal",
      desc: "对原始数据做转换、裁剪与清洗。",
      defaultModel: "jigsaw-rapid", tools: ["shell", "calc", "apply_patch"],
      systemPrompt: "你是数据处理专家。正确使用工具完成格式转换、裁剪与数据清洗。"
    },
    gisMap: {
      type: "gisMap", name: "制图 Agent", icon: "bolt",
      desc: "产出成品文件与最终交付物。",
      defaultModel: "jigsaw-ultra", tools: ["editfile", "apply_patch", "get_current_time"],
      systemPrompt: "你是交付负责人。产出清晰、易读的最终交付物。"
    }
  };

  const WF_TEMPLATES = {
    default: [
      { agentType: "research", x: 0,    y: 0 },
      { agentType: "analysis", x: 320,  y: 0 },
      { agentType: "writer",   x: 640,  y: 0 },
      { agentType: "final",    x: 960,  y: 0 }
    ],
    gis: [
      { agentType: "gisCollect", x: 0,   y: 0 },
      { agentType: "gisProcess", x: 340, y: 0 },
      { agentType: "analysis",   x: 680, y: 0 },
      { agentType: "gisMap",     x: 1020, y: 0 }
    ]
  };



  /* 预置回复（Mock）。接入真实 LLM 后由后端返回，不再使用。 */
  const CANNED = {
    travel: "东京 5 日旅行建议：第 1 天浅草—上野，第 2 天皇居—银座，第 3 天镰仓一日游，第 4 天涩谷—原宿，第 5 天筑地—台场。需要我展开任意一天的详细安排吗？",
    satellite: "已对卫星影像完成初步解译：海岸带存在 3 处疑似变化区域，建议叠加历史影像对比确认。分析 Agent 会继续做波段运算，结论稍后写入工作流。",
    gis: "这是一个 GIS 数据管线工作流：数据 Agent 负责摄取与清洗，分析 Agent 执行栅格统计与矢量查询，写作 Agent 组织结果，终审 Agent 校验输出。你可以在工作流页查看和调整每个节点。",
    agent: "该任务已拆解为多 Agent 协作流程。打开工作流页可以实时查看每个 Agent 的执行状态；尚未执行的节点支持拖动、修改与重新连线。",
    default: "收到。我可以帮你规划行程、分析数据或搭建多 Agent 工作流。具体需求告诉我，我会把它编排进工作流页面，方便你随时查看和调整。"
  };

  function pickCanned(text) {
    const s = text.toLowerCase();
    if (s.includes("tokyo") || s.includes("travel") || s.includes("trip") || s.includes("东京") || s.includes("旅行") || s.includes("行程")) return CANNED.travel;
    if (s.includes("satellite") || s.includes("imagery") || s.includes("coastal") || s.includes("卫星") || s.includes("影像") || s.includes("海岸")) return CANNED.satellite;
    if (s.includes("gis") || s.includes("flood") || s.includes("workflow") || s.includes("洪水") || s.includes("工作流")) return CANNED.gis;
    if (s.includes("agent") || s.includes("orchestrat") || s.includes("编排") || s.includes("智能体")) return CANNED.agent;
    return CANNED.default;
  }

  /* ---------- 工作流工厂 ---------- */
  function buildWorkflow(convId, templateKey, executed) {
    const tpl = WF_TEMPLATES[templateKey] || WF_TEMPLATES.default;
    const nodes = tpl.map((n, i) => {
      const a = AGENTS[n.agentType];
      return {
        id: convId + "-n" + (i + 1),
        agentType: a.type,
        name: a.name,
        icon: a.icon,
        description: a.desc,
        modelId: a.defaultModel,
        systemPrompt: a.systemPrompt,
        tools: a.tools.slice(),
        input: i === 0 ? "用户请求" : "节点输出:" + convId + "-n" + i,
        output: "节点输出:" + convId + "-n" + (i + 1),
        status: executed ? "success" : "waiting",
        x: n.x, y: n.y
      };
    });
    const edges = nodes.slice(0, -1).map((n, i) => ({ id: convId + "-e" + (i + 1), from: n.id, to: nodes[i + 1].id }));
    return {
      id: "wf-" + convId,
      conversationId: convId,
      name: "默认管线",
      templateKey,
      nodes, edges,
      running: false,
      executed: !!executed
    };
  }

  /* ---------- 会话 ---------- */
  function msg(id, role, text, modelId, at) {
    return { id, role, text, modelId, status: "done", createdAt: at };
  }

  // 预置会话已全部移除：历史从空白开始，只显示用户自己创建的对话
  const CONVERSATIONS = [];

  /* ---------- 设置 ---------- */
  const SETTINGS = {
    general: { workspaceName: "JIGSAW", language: "system", density: "comfortable" },
    appearance: { theme: "dark", fontSize: "medium", showTimestamps: true, showHomeTagline: false },
    model: { defaultModel: "jigsaw-ultra", visionEnabled: true, toolsEnabled: true, temperature: 0.7, custom: [] },
    api: { provider: "openai", baseUrl: "http://127.0.0.1:8000", connected: false, mode: "mock" },
    workflow: { defaultTemplate: "default", executionSpeed: "normal", autoRun: false, gridSize: 40 },
    about: { version: "0.1.0", build: "本地构建" }
  };

  const TEMPLATE_META = {
    default: { name: "研究 → 分析 → 写作 → 终审", key: "default" },
    gis: { name: "GIS 数据管线", key: "gis" }
  };

  JIGSAW.Mock = { MODELS, AGENTS, WF_TEMPLATES, CONVERSATIONS, SETTINGS, TEMPLATE_META, buildWorkflow, pickCanned };
})();
